// Where the card store lives: Workers KV, as a handful of large chunks plus a
// manifest pointing at them.
//
// This replaces a content-addressed 40,000-byte grid in D1. That grid existed
// for one reason — D1's 100,000-byte SQL statement limit, with hex doubling
// every blob — and it dragged a whole dedup scheme behind it (~1,800 rows per
// store, reuse accounting, prune-by-reference) purely to keep row writes under
// the free plan's daily quota.
//
// KV removes the constraint that created all of it. A 25 MiB value cap means a
// ~75MB store is THREE chunks, so:
//
//   - a full publish is 5 writes against a 1,000/day free allowance — three
//     store chunks, the residue archive's one, and the manifest — with no
//     incremental publish, no dedup, no resume bookkeeping
//   - a cold `/search` load is 4 reads against 100,000/day (manifest + three
//     store chunks); `/cards/*` adds the residue archive's one, for 5
//   - one copy serves every colo, instead of one 75MB SQLite copy per
//     Durable Object against a 5GB pool
//
// Chunk count is not cosmetic. The loader below pulls chunks STRICTLY IN
// SEQUENCE, one awaited get each (and must — see kvStoreStream), so a chunk is
// a serialized network round trip on the cold path, not just a meter tick.
// Crossing a boundary is a latency change: generation 3 added 6.25MB of tag
// alias keys, went 3 chunks to 4, and the production median store load went
// 337ms to 691ms. Generation 4 took them back out.
//
// Chunks are keyed by the store key, which is unique per build, so a publish
// never overwrites bytes a reader might still be streaming. Retention is
// handled by deleting the previous store's chunks once a newer manifest has
// been live long enough (see the publisher).
//
// CHUNKS ARE GZIPPED. The cut is still on RAW bytes at KV_CHUNK_BYTES, and each
// cut is then compressed as its own gzip member, so the chunk COUNT is what it
// always was and the value KV holds is ~43% of it. Two things bought that, and
// neither is the meter:
//
//   - the cold path is I/O-bound, not read-count-bound. Measured on production
//     over 3 days (n=121 cold loads): wall p50 915ms against DO CPU p50 164ms,
//     so ~750ms of a cold load was waiting for 76.6MB to arrive.
//   - a chunk is materialised whole while it is copied into wasm, and that sum
//     against 128MB is the real ceiling. Holding the ~13MB compressed chunk
//     instead of the 26MB raw one takes peak from ~102.6MB to ~89.6MB.
//
// It is not free, and the ~190ms this comment used to budget for decompression
// was WRONG BY ROUGHLY 5x. Measured across the deploy that introduced it
// (2026-08-12), cold DO CPU went 322ms -> 1252ms at the median and 1050ms ->
// 2504ms at the max, and cold wall time went 1606ms -> 2263ms — so compression
// did not buy back the I/O it cost in CPU, which is exactly the number this
// comment named as the one that would undo the trade.
//
// It stands anyway, for a reason that has nothing to do with the original
// argument: the fix was to stop paying it so often rather than to stop paying
// it. Engine DOs are now named per REGION rather than per colo, so the ~45 cold
// loads a day that made this expensive collapse to a handful, and store-cache.ts
// holds the DECOMPRESSED archive locally so most of the remaining wakes skip it
// too. Reverting to uncompressed chunks would cost ~13MB of the 128MB isolate
// (the resident chunk doubles) to save a cost that is now rare.
//
// Note also what is NOT the cause, so it is not retried: the piece count. Gzip
// took production from 3 pieces to 18,713 (DecompressionStream emits 4KB), and
// 58cfbe7 gathered those back into 19 blocks with no change in cold CPU at all.
//
// Both halves are now measured, same account and window: a cold load reading the
// DECOMPRESSED archive out of store-cache.ts costs 445ms of DO CPU and waits
// 124ms, against 3466-4204ms of CPU and 2596-3543ms of wait from KV. Note those
// KV figures are the COLD-KV-cache case (they followed a republish); against a
// warm colo cache the gap narrows to roughly the decompression alone. See
// store-cache.ts.

import type { Env, StoreManifest } from "./types";
import { EngineUnavailableError } from "./types";

/**
 * Bytes per KV chunk — the RAW cut, whose gzip member is what KV actually stores.
 *
 * Chunk count is `ceil(store_bytes / this)`, and a chunk is a SERIALIZED NETWORK
 * ROUND TRIP on the cold path (the loader pulls them strictly in sequence, one
 * awaited get each — see kvStoreStream), so the count is a latency number, not
 * just a meter tick. Measured in the other direction: generation 3 added 6.25MB,
 * went 3 chunks to 4, and the production median store load went 337ms to 691ms.
 *
 * RAISED from 26,000,000 to take the 76.6MB store from three chunks to two.
 *
 * WHAT THE OLD VALUE GUARANTEED, AND WHAT THIS ONE DOES NOT. 26,000,000 was the
 * largest cut that could not exceed KV_VALUE_CAP_BYTES *even if the data were
 * entirely incompressible* — gzip's worst case is ~0.02% expansion plus a header,
 * so ~26,005,000 against a 26,214,400 cap. It needed no assumption about the
 * data. This value does: it is safe only while the store compresses better than
 * 1.46x. Measured on the generation-12 build, by region:
 *
 *   raw 26.0MB -> 8.5MB stored   3.06x
 *   raw 26.0MB -> 8.3MB stored   3.13x
 *   raw 24.6MB -> 14.5MB stored  1.70x   <- the tail is the least compressible
 *   whole store                  2.45x
 *
 * A two-way cut puts ~12.4MB and ~18.9MB in KV, so the binding chunk sits at 72%
 * of the cap with 28% headroom, and the whole archive would have to compress
 * worse than its worst quarter currently does before it breached.
 *
 * THE FAILURE MODE IS LOUD AND NON-CORRUPTING, which is what makes the trade
 * acceptable. Every publisher compresses and then checks against
 * KV_VALUE_CAP_BYTES before writing, so a build that compressed badly cannot
 * truncate a store — and both publishers fall back to KV_CHUNK_BYTES_SAFE and
 * republish rather than failing the run. The cost of being wrong is a slower
 * publish, not a broken one.
 *
 * The 128MB isolate no longer constrains this the way it did. The old comment
 * here argued against raising it because a bigger raw cut meant a bigger scratch
 * allocation inside wasm — but the loader now feeds wasm in fixed 4MB blocks
 * (load-blocks.ts) regardless of chunk size, so the only size that scales with
 * this constant is the compressed chunk resident in the JS heap: ~14.5MB before,
 * ~18.9MB now, against 78.7MB of linear memory. Peak goes ~93MB -> ~98MB.
 *
 * Growth is not the thing to watch. Holding these ratios the store would have to
 * reach ~99.6MB to fill the cap, against ~19KB/day of Scryfall drift. What to
 * watch is a FORMAT CHANGE that adds poorly-compressing data in bulk — which is
 * exactly what generation 3 did.
 */
export const KV_CHUNK_BYTES = 38_400_000;

/**
 * The cut that needs no assumption about the data: safe even if incompressible.
 *
 * Publishers fall back to this when a chunk cut at KV_CHUNK_BYTES compresses past
 * the cap, so the ambitious value above can never cost more than one wasted
 * compression pass.
 */
export const KV_CHUNK_BYTES_SAFE = 26_000_000;

/**
 * KV's own per-value cap, 25 MiB. `KV_CHUNK_BYTES` sits below it with margin;
 * this is the hard number a STORED value is checked against, which matters now
 * that a stored value is a gzip member rather than the raw cut itself.
 *
 * A 26,000,000-byte raw chunk cannot exceed this even if it were incompressible:
 * gzip's worst case is ~0.02% expansion plus a small header, so ~26,005,000
 * bytes against 26,214,400. The publisher asserts it anyway — the day that stops
 * being true is the day a publish must fail loudly rather than truncate.
 */
export const KV_VALUE_CAP_BYTES = 26_214_400;

/**
 * Prefix under which a live engine object records its own name.
 *
 * The publisher needs to know WHICH objects exist, and there is no API to ask. Without this it
 * would have to guess — notifying every possible region name, which CREATES the ones that do not
 * exist yet. That is the part worth avoiding: `locationHint` places an object at creation, so an
 * object created by the coordinator is placed relative to a hint the coordinator supplied rather
 * than by a real request at the edge. If the hint were ever not honoured, the object would be
 * permanently misplaced and every request from that region would cross the planet to reach it.
 *
 * So objects announce themselves instead. An engine writes this key when it loads a store — a rare
 * event, off the request path — and the publisher notifies exactly the set that answers. Creation
 * stays where it belongs: with the isolate serving a real user, in that user's region.
 */
export const REGION_LIVE_PREFIX = "engine:live:";

/**
 * Put an engine object into the publisher's live set, and make sure the write actually lands.
 *
 * Visibility is the entire basis of the notify contract. `stepNotify` fans out to exactly the
 * objects under this prefix, an object missing from it is never notified, and `refreshNow` has ONE
 * caller — `notifyPublish`. With the manifest poll deleted there is no other path by which a warm
 * object learns a publish happened, so an object that fails to announce keeps serving the old store
 * while `stepPurge` empties the edge cache in front of it. The next request refills that cache with
 * a stale answer and `/cards/*` holds it for 16 hours. Nothing raises.
 *
 * The repair for a dropped announcement is the next cold load, so the exposure window is "failed
 * announce -> next deploy or eviction". The nightly cron publish lands inside that window and
 * involves no deploy, so deploy frequency does not close it.
 *
 * Hence the shape at the call site: `loadStore` starts this BEFORE the archive fetch and awaits it
 * after, so the write overlaps seconds of I/O and costs nothing measurable, but the engine is never
 * committed on the strength of an announcement still in flight. One retry covers a transient KV
 * failure. Exhausting it is an ERROR rather than a warning, because the object is then in the one
 * state this design cannot see — and it deliberately does not throw, since refusing to serve would
 * turn a stale-answer risk into an outage.
 */
export async function announceSelf(env: Env, label?: string): Promise<void> {
	if (!label) return;
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			await env.STORE_KV.put(`${REGION_LIVE_PREFIX}${label}`, "1");
			return;
		} catch (err) {
			if (attempt === 2) {
				console.error(
					`[${label}] COULD NOT ANNOUNCE ITSELF to the publisher after ${attempt} attempts: ${err}. ` +
						`This object is invisible to the publish fan-out and will serve its current store ` +
						`until it reloads, even across a publish.`,
				);
			}
		}
	}
}

/** The manifest key: the one mutable pointer in the namespace. */
export const MANIFEST_KEY = "store:manifest";

/** A one-shot stream over bytes already in memory, without a Blob's extra copy. */
function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

/**
 * gzip one chunk for storage.
 *
 * `CompressionStream` takes NO level parameter, so this is whatever Workers'
 * zlib is configured for — measured at 33,342,732 bytes over the 76,636,456-byte
 * store, which is fractionally worse than native `gzip -1` (33,163,964) and far
 * off `-6` (31,088,463). That is not a knob this code can turn, and it does not
 * want to: `-6` costs 2.67s against `-1`'s 0.65s natively for ~7% fewer bytes,
 * and the chunk count is the same either way.
 *
 * The Node/Bun publishers (scripts/seed-*.ts) are free to use any zlib level —
 * gzip is gzip, and a deploy-published store and a nightly-published one load
 * through the identical path.
 */
export async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
	const out = new Response(bytesStream(bytes).pipeThrough(new CompressionStream("gzip")));
	return new Uint8Array(await out.arrayBuffer());
}

/**
 * What the BUILDER puts in the archive, versioned separately from
 * `format_version` (which describes the archive's struct LAYOUT and comes from
 * the Rust engine).
 *
 * A change here is a change in the VALUES a structurally-identical store holds,
 * so no header check can catch it: the store loads fine and answers wrongly.
 * The deploy compares this against the published manifest and rebuilds on a
 * mismatch — this repo's equivalent of the data migrations upstream ships next
 * to such changes (e.g. api/db/2026-08-06-01-lowercase-keywords.sql).
 *
 * BUMP THIS whenever transform.rs/tags.rs change what a card's stored fields
 * contain, even though the schema is untouched. History:
 *   1 — initial
 *   2 — keywords stored lowercase (upstream #869); card_is_tags carries the
 *       boolean-backed reserved/gamechanger (upstream #888)
 *   3 — card_oracle_tags / card_art_tags carry alias keys, and aliases ride
 *       along on ancestors (upstream #914). Bumped together with #913's
 *       ARCHIVE_FORMAT_VERSION 2026080601 -> 2026080901 (Printing gains
 *       set_rank/artist_rank), because they rebuild together: the format bump
 *       makes the old store unloadable, and this makes store-age.ts FORCE the
 *       rebuild at deploy rather than leaving the port dark until the nightly.
 *   4 — the alias keys from 3 are GONE again, resolved at query time instead
 *       (src/parser/tag-aliases.gen.ts). They cost 6,252,880 bytes and bought
 *       the store a 4th chunk; see KV_CHUNK_BYTES. No format change — the
 *       layout is identical and generation 3 stores still load, they just
 *       carry duplicate keys nothing asks for any more. That is what makes
 *       this rollout safe in either order: the new parser resolves `flames`
 *       to `fire`, and `fire` is present in both generations.
 *   5 — the card-face merge (upstream #400/#873). A multi-face card is now ONE
 *       row carrying every face's searchable data (type/subtype/colour/keyword
 *       unions, joined oracle text) instead of silently being its BACK face,
 *       and each face is stored structurally besides. Paired with
 *       ARCHIVE_FORMAT_VERSION 2026080901 -> 2026081001, so the old store is
 *       unloadable and the rebuild is forced rather than deferred to the
 *       nightly. Two visible consequences: `t:battle` matches for the first
 *       time (every battle is a transform front), and a multi-face card's
 *       illustration_id is now its FRONT face's, which shifts prefer_score's
 *       artwork-set component and so which printing represents such a card.
 *   6 — memorabilia printings are no longer imported, and `is:oversized` joins
 *       the boolean-backed is: tags (upstream #918). Scryfall hides
 *       `set_type: memorabilia` — World Championship decks, Collectors'
 *       Edition, 30th Anniversary, the oversized promos, 99 sets — from any
 *       search that does not name their set, and importing them made ordinary
 *       queries disagree: they supplied the CHEAPEST printing for 184 cards,
 *       which is exactly the printing a price ordering returns. 2,672 of
 *       97,803 printings go away and the store SHRINKS; no card is lost (0 of
 *       31,724 are printed only in memorabilia sets), so this changes which
 *       printing represents a card, never whether the card is findable.
 *
 *       NO format change — the layout is untouched and a generation-5 store
 *       still loads. That is what makes the rollout safe in either order, and
 *       it is also why this bump is load-bearing on its own: nothing in the
 *       header can see that the VALUES changed, so without it store-age.ts
 *       would keep serving a store that still carries the memorabilia rows.
 *
 *       The deviation it buys: `set:cei` and its 98 siblings return nothing
 *       here, where Scryfall returns them. See README's deviations list.
 *   7 — a missing sort value sorts LOWEST rather than last (upstream #919), so
 *       `order=power dir=asc` leads with the null-power cards instead of
 *       trailing with them, matching Scryfall. Paired with
 *       ARCHIVE_FORMAT_VERSION 2026081001 -> 2026081101, because the stored
 *       ASCENDING sort permutations for the five nullable permuted columns
 *       encode the old polarity: the format bump makes the old store
 *       unloadable and this makes store-age.ts FORCE the rebuild at deploy
 *       rather than leaving the port dark until the nightly. Also carries
 *       upstream #913's `order=artist` fix, where an artistless printing sat at
 *       the wrong end descending.
 *   8 — prefer_score's `extended_art` component goes +12 -> -6 (upstream #920),
 *       so an extended-art printing scores BELOW the base printing of its set
 *       instead of above it. That changes which printing represents a card
 *       wherever the two differ, which was 2,800 cards.
 *
 *       Measured against Scryfall's own representative choice — its
 *       `oracle_cards` bulk file is one card object per oracle_id, so it is
 *       31,724 free external labels — agreement goes 66.2% -> 73.9%, and
 *       66.4% -> 74.0% on a 30% holdout that was never fitted against.
 *
 *       NO format change: prefer_score is a stored VALUE, the layout is
 *       untouched, and a generation-7 store still loads. Which is exactly why
 *       this bump is load-bearing — nothing in the header can see that every
 *       card's score moved, so without it store-age.ts would keep serving a
 *       store whose representatives were chosen by the old weight.
 *   9 — the printing Scryfall's `oracle_cards` dump names as a card's
 *       representative is now PINNED as ours (+1000 to prefer_score; see
 *       transform.rs PIN_BONUS). That dump is one card object per oracle_id and
 *       that object IS Scryfall's chosen printing, so it is ~38k free external
 *       labels rather than a heuristic.
 *
 *       Representative agreement with Scryfall goes 73.9% -> 96.6% (measured on
 *       the rebuild, 30,658 of 31,724). The ceiling is the ~3.4% of labels
 *       naming a printing this corpus does not import (format-legal only, no
 *       memorabilia). prefer_score still ranks everything beneath the pin,
 *       which is what those cards, the per-artwork-group representatives
 *       `unique=artwork` needs, and every filtered query fall back on.
 *
 *       DELIBERATELY UNCONDITIONAL, unlike the version proposed upstream: on
 *       213 cards Scryfall's pick is licensed-crossover art that upstream's
 *       `art_style` component demotes on purpose. Upstream optimises "the
 *       version that looks like Magic"; this port optimises "what Scryfall
 *       would have said", so here the label wins outright.
 *
 *       Both import paths carry it: the native builder fetches the dump
 *       directly, and the Durable Object import stages it as a fourth
 *       DUMP_KIND and feeds it into the same TagData the tag dumps fill — which
 *       is what gives it export/restore continuity across DO evictions without
 *       a second persistence path that could drift.
 *
 *       NO format change: prefer_score is a stored VALUE. Which is exactly why
 *       this bump is load-bearing — nothing in the header can see the scores
 *       moved, so without it the nightly would keep serving unpinned rows.
 *  10 — the Scryfall card-object surface (upstream #912). Every printing now
 *       carries the `card_compat_blob` residue packed into 128 bytes
 *       (marketplace ids, the three extra prices, lang/image_status/set_type/
 *       security_stamp/set_id interned, games/finishes/twelve booleans as
 *       bitsets, multiverse_ids/promo_types/frame_effects), every card carries
 *       Scryfall's `all_parts`, and a sparse (namespace, id) -> printing index
 *       answers the five external-id routes. Together they are what lets
 *       `/cards/*` answer with a Scryfall card object instead of a row.
 *
 *       Paired with ARCHIVE_FORMAT_VERSION 2026081101 -> 2026081102: both
 *       archived struct sizes move (Printing 176 -> 256, OracleCard 288 ->
 *       304), so the header rejects a generation-9 store outright and the
 *       rebuild is forced at deploy rather than deferred to the nightly.
 *
 *       THE SEARCH STORE STAYS AT THREE CHUNKS, because the residue does not
 *       live in it. Inlined it measured 76,571,408 -> 87,989,816 bytes, past
 *       the 78,000,000-byte three-chunk ceiling AND 15.3 MiB past the import's
 *       112 MiB wasm cap, where the build phase died outright. So the residue
 *       became a second archive instead (0d19d29): search store 76,636,456
 *       bytes in 3 chunks, residue 11,839,272 bytes in 1. The 4th KV value is
 *       real, but it is the residue's own chunk and only `/cards/*` reads it —
 *       a search-only colo still pays three sequential round trips, not four.
 *       Two lossless compactions ran before the split was reached for, worth
 *       10,128,264 bytes together, and without them the inlined store is
 *       98,118,080:
 *         - the eleven sparse marketplace/price ids are niched with
 *           `NicheInto<Zero>` (CompatFields 128 -> 84 bytes). rkyv 0.8 does
 *           NOT niche an `Option<NonZeroU32>` on its own — measured at 8 bytes
 *           without the attribute — so upstream #912's own "8 becomes 4"
 *           reasoning does not hold on this rkyv version.
 *         - the external-id index drops from `(u8, u64, u32)` triples, which
 *           rkyv pads to 24 bytes each, to `(u32, u32)` pairs plus a
 *           five-entry namespace offset table: 8 bytes an entry over 347,625
 *           entries.
 *  11 — `loyalty` and `defense` reach the card object. Upstream excludes
 *       `loyalty` from the residue because it holds a loyalty TEXT column; this
 *       port kept only the integer `planeswalker_loyalty` that `loy:` filters
 *       on, so the key was excluded from the blob AND held by no column, and
 *       every planeswalker's card object came back without it. It is now an
 *       interned `CompatFields.loyalty_id`. `defense` is the face-side twin:
 *       Scryfall prints it on a battle's front face, upstream's
 *       `_FACE_OBJECT_FIELDS` omits it, so `OracleFace` gains `defense_text_id`
 *       and the builder's face list gains the key.
 *
 *       Paired with ARCHIVE_FORMAT_VERSION 2026081102 -> 2026081103. Note the
 *       header alone would NOT catch the face half: `OracleFace` sits behind a
 *       Vec, so its size is not one of the two the header records. The version
 *       constant is what forces the rebuild, and this generation is what makes
 *       the deploy notice the stored VALUES changed.
 *  12 — a mana value is a DECIMAL, and half of one rounded to zero (upstream
 *       #923). `TransformedRow.cmc` goes `Option<i64>` -> `Option<f64>` and the
 *       cast that fills it goes `maybe_int` -> `maybe_float`, mirroring
 *       upstream's `integer` -> `real` column change; the engine stores it as an
 *       `Option<f32>` instead of an `Option<u8>`.
 *
 *       CAPABILITY, NOT CORPUS. transform.rs still drops `set_type: "funny"`,
 *       so the one card in all of Scryfall with a fractional mana value (Little
 *       Girl, `{HW}`, cmc 0.5) is still not imported, and every value a
 *       generation-12 store actually holds is numerically identical to what
 *       generation 11 held. What changes is that the TYPE is no longer the thing
 *       that would lose the fraction if the corpus filter ever moved.
 *
 *       Paired with ARCHIVE_FORMAT_VERSION 2026081103 -> 2026081104, and that
 *       pairing is the load-bearing part rather than a formality: store-age.ts
 *       forces a rebuild on a GENERATION mismatch, not on a format mismatch, so
 *       bumping the format alone would deploy a Worker whose only store in KV is
 *       one it cannot load — dark until the nightly cron. Same reasoning as
 *       generations 7 and 11.
 *  13 — NO CONTENT CHANGE AT ALL, and that is the point worth writing down. Every
 *       value a generation-13 store holds is byte-identical to what 12 held; what
 *       changed is how the archive is CUT across KV values (KV_CHUNK_BYTES
 *       26,000,000 -> 38,400,000, three chunks to two).
 *
 *       The bump is therefore a deliberate use of this constant as a re-publish
 *       trigger rather than as a description of contents. Chunking is applied at
 *       PUBLISH time, so a store already in KV keeps its old cut until something
 *       republishes it, and store-age.ts forces a rebuild on a generation
 *       mismatch — which is the only lever that makes the new cut take effect at
 *       deploy instead of waiting for the nightly cron.
 *
 *       Safe in either direction: chunk_count rides in the manifest and the
 *       reader has always looped over it, so a two-chunk store and a three-chunk
 *       store load through the identical path. Nothing would have broken by
 *       waiting; this only makes it immediate.
 *  14 — again NO CONTENT CHANGE, and again the bump is being used as a re-publish
 *       trigger rather than as a description of contents (see 13).
 *
 *       This one exists to force a fresh store key so the next cold load in every
 *       region MISSES the archive cache, which is the only way to exercise — and
 *       measure — the tee that now fills it during the load instead of re-fetching
 *       the archive a second time under waitUntil. A cache HIT measures the path
 *       that did not change.
 *
 *       It also fires the publish `notify` phase in production for the first time.
 *       That phase has never run outside tests, and it WILL run at the next
 *       nightly regardless, so running it now — while someone is watching the
 *       logs — is strictly safer than discovering a fault at 17:11 unattended.
 *  15 — NO CONTENT CHANGE either. Same use as 13 and 14: a re-publish trigger.
 *
 *       Generation 14 never actually rebuilt. store-age only forces a build when
 *       the PUBLISHED manifest's generation differs from this constant, and by
 *       the time 14 shipped a store already carried it, so the last two builds
 *       skipped the import and reused the live store. Everything 14 was meant to
 *       exercise on a fresh key went unexercised with it.
 *
 *       What this one is for, specifically: `archive_section_stats` (75f62d5)
 *       prints the per-section breakdown of the archive from the NATIVE builder,
 *       and so only emits from a build that genuinely runs the import. It has
 *       never executed. The breakdown is what makes "shrink the store" — the one
 *       lever with real headroom left — actionable rather than guesswork, and an
 *       independent per-field measurement now exists to reconcile it against.
 *
 *       Also worth watching on this publish: `chunk_count` must still come back
 *       2. The archive is 76,656,360 bytes against a 76,800,000 two-chunk
 *       ceiling — 0.19% — and crossing it silently yields 3 chunks with no
 *       warning, quietly restoring the KV round trip that was taken off the cold
 *       path. Nothing in the publisher compares the count.
 */
export const STORE_CONTENT_GENERATION = 15;

/** Chunk key for a store. Keyed by store_key, so publishes never collide. */
export function chunkKey(storeKey: string, seq: number): string {
	return `store:${storeKey}:${seq}`;
}

/**
 * Store builds kept in KV: the live one and its predecessor.
 *
 * The predecessor stays addressable so a reader that started streaming it finishes, and so a bad
 * build can be rolled back by republishing the older manifest. More than that is storage nobody
 * reads — at ~38MB a build against a 1GB namespace, which is what made a broken sweep expensive.
 */
export const KEEP_STORES_IN_KV = 2;

/**
 * The store keys that retention should delete: everything but the newest `keep` BUILDS.
 *
 * Derived from the key names rather than from recorded history, and that is the fix rather than an
 * implementation detail. Retention used to read a `kv_store_history` list out of the coordinator's
 * `meta` table — which `metaClear()` wipes at the start of every run, so `previous` was always
 * empty, nothing was ever retired, and each night added another ~38MB. Production was holding 15
 * store builds and 3 residue builds, ~510MB of a 1GB namespace, against a policy of 2.
 *
 * A key name carries everything the decision needs (`store:card-store-v<format>-<built_at>.store:<n>`),
 * so the sweep is a pure function of what is actually in KV. It cannot drift from reality, it
 * self-heals a namespace that already leaked, and it costs one list operation.
 *
 * Both families go together: a build's residue archive is keyed by its own name, so a sweep that
 * only knew about `card-store-` would leave every `card-compat-` behind.
 */
export function staleStoreKeys(names: string[], keep: number, currentBuiltAt?: string): string[] {
	const parsed = names.flatMap((name) => {
		const at = /^store:card-(?:store|compat)-v\d+-(\d+)\.store:\d+$/.exec(name);
		return at ? [{ name, builtAt: at[1] as string }] : [];
	});
	const builds = [...new Set(parsed.map((k) => k.builtAt))].sort((a, b) => Number(b) - Number(a));
	// The live build is kept whatever its age says — the manifest points at it, and a sweep that
	// deleted it would take the site down rather than tidy it.
	const keptBuilds = new Set(builds.slice(0, Math.max(keep, 1)));
	if (currentBuiltAt) keptBuilds.add(currentBuiltAt);
	return parsed.filter((k) => !keptBuilds.has(k.builtAt)).map((k) => k.name);
}

/** How many chunks a store of this size occupies on the grid. */
export function chunkCountFor(storeBytes: number, cut: number = KV_CHUNK_BYTES): number {
	return Math.ceil(storeBytes / cut);
}

/** Split a whole store buffer onto the KV grid. */
export function splitStore(store: Uint8Array, cut: number = KV_CHUNK_BYTES): Uint8Array[] {
	const chunks: Uint8Array[] = [];
	for (let at = 0; at < store.length; at += cut) {
		chunks.push(store.subarray(at, Math.min(at + cut, store.length)));
	}
	return chunks;
}

/**
 * Cut an in-memory archive into gzipped KV values, backing off if any of them
 * would exceed the cap.
 *
 * The ambitious cut (KV_CHUNK_BYTES) is safe only while the store compresses,
 * so the check is not an assertion about a belief — it is the mechanism. Try the
 * cut, compress, and if any member is over the cap, redo the whole thing at
 * KV_CHUNK_BYTES_SAFE, which cannot be over it for any input. The caller gets a
 * publishable set of chunks either way and never has to reason about ratios.
 *
 * Only the in-memory publishers can do this — the Durable Object assembles one
 * chunk per alarm from staged rows and cannot re-cut what it has already
 * written, so it detects the same condition and restarts its publish phase
 * instead (see stepPublish).
 */
export function chunkForKv(
	archive: Uint8Array,
	gzip: (bytes: Uint8Array) => Uint8Array,
): { chunks: Uint8Array[]; cut: number } {
	for (const cut of [KV_CHUNK_BYTES, KV_CHUNK_BYTES_SAFE]) {
		const chunks = splitStore(archive, cut).map(gzip);
		const worst = chunks.reduce((n, c) => Math.max(n, c.length), 0);
		if (worst <= KV_VALUE_CAP_BYTES) return { chunks, cut };
		console.warn(
			`A ${cut}-byte cut compressed to ${worst} bytes, over KV's ${KV_VALUE_CAP_BYTES} cap — ` +
				`re-cutting at ${KV_CHUNK_BYTES_SAFE}. This store compresses worse than KV_CHUNK_BYTES assumes.`,
		);
	}
	// Unreachable for any real input: a KV_CHUNK_BYTES_SAFE cut cannot exceed the
	// cap even if gzip expanded it. Throwing beats returning a store KV will reject.
	throw new Error(`archive of ${archive.length} bytes cannot be cut under KV's ${KV_VALUE_CAP_BYTES} value cap`);
}

/** One staged row as the publisher hands it over. */
export interface StagedRow {
	seq: number;
	bytes: Uint8Array;
}

/** Where a partially-consumed staging stream left off. */
export interface StagingCursor {
	/** The next staged row to read. */
	seq: number;
	/** Bytes already consumed from THAT row. */
	off: number;
}

/**
 * Fill one KV-sized buffer from staged rows, resuming from `cursor`.
 *
 * The publisher stages the store in rows sized for the DO's 2MB per-value cap
 * and then re-cuts them onto KV's much larger grid, so the two grids do not
 * align and a KV chunk boundary routinely falls INSIDE a staged row. Hence a
 * (seq, offset) cursor rather than a row range: a slice can stop 40% into row
 * 31 and the next one resumes exactly there.
 *
 * `readRows(fromSeq, limit)` returns staged rows in seq order starting at
 * `fromSeq`; returning fewer than asked is fine, returning none before the
 * buffer is full is a short store and throws.
 */
export function assembleChunk(
	want: number,
	cursor: StagingCursor,
	readRows: (fromSeq: number, limit: number) => StagedRow[],
): { bytes: Uint8Array; cursor: StagingCursor } {
	let { seq, off } = cursor;
	const bytes = new Uint8Array(want);
	let filled = 0;
	while (filled < want) {
		const rows = readRows(seq, 8);
		if (rows.length === 0) {
			throw new Error(`chunk staging ran out at seq ${seq} with ${filled}/${want} bytes filled`);
		}
		for (const row of rows) {
			if (filled >= want) break;
			const take = Math.min(row.bytes.length - off, want - filled);
			bytes.set(row.bytes.subarray(off, off + take), filled);
			filled += take;
			if (off + take >= row.bytes.length) {
				seq = row.seq + 1;
				off = 0;
			} else {
				off += take;
			}
		}
	}
	return { bytes, cursor: { seq, off } };
}

/**
 * Read the manifest. A namespace with no manifest is "no index published yet",
 * reported as null; anything else (binding gone, KV unreachable) becomes an
 * EngineUnavailableError carrying the platform's own message so the reason
 * reaches the response instead of a generic 500.
 */
export async function readManifest(env: Env): Promise<StoreManifest | null> {
	try {
		// cacheTtl is deliberately short: the manifest is the ONE mutable key,
		// and a nightly publish should reach isolates within minutes, not hours.
		const json = await env.STORE_KV.get(MANIFEST_KEY, { type: "text", cacheTtl: 60 });
		if (!json) return null;
		return JSON.parse(json) as StoreManifest;
	} catch (err) {
		throw new EngineUnavailableError(`Cannot read the store manifest from KV: ${err}`);
	}
}

/**
 * Stream a store's chunks out of KV in order.
 *
 * One `get` per chunk, pulled lazily so at most one chunk is resident: the
 * whole point of the 128MB isolate discipline is that the store exists once,
 * inside wasm linear memory, and never as a second JS-side copy.
 *
 * DO NOT convert this to `type: "stream"` with the reads issued in parallel.
 * It was tried, deployed, and reverted. KV hands a ~70MB store over in ~17,900
 * pieces, and paying JS for each of them cost far more than the serialised
 * network wait it removed — Durable Object CPU on a load-carrying invocation
 * went from ~120ms to ~900ms, a clean 7x step at the deploy that introduced it.
 *
 * It looked like a win for an hour because of how it was measured. The load
 * logs "in NNNms" from Date.now() deltas, and Workers FREEZE THE CLOCK during
 * synchronous execution — so that number only ever measured I/O wait. Streaming
 * moved work out of I/O and into CPU, which made the number fall from ~2200ms
 * to ~123ms while total request time got worse. Any future attempt here has to
 * be judged on cpuTimeMs from the invocation's own event, not on that log line.
 *
 * `cacheTtl` is a week because chunk keys are immutable — a given store key's
 * bytes never change — so a colo that has loaded this store once serves later
 * loads from its own cache without a metered read.
 */
export function kvStoreStream(env: Env, manifest: StoreManifest): ReadableStream<Uint8Array> {
	return kvArchiveStream(
		env,
		manifest.store_key,
		manifest.store_bytes,
		manifest.chunk_count,
		manifest.store_gzip_bytes,
	);
}

/**
 * The same stream over the paired residue archive (see StoreManifest.compat_key).
 *
 * Separate keys, same immutable-chunk contract. A manifest without one is a store built before
 * the split: `/cards/*` reports the archive as unavailable rather than answering with every
 * residue field missing, which would look like a card Scryfall sent no language or prices for.
 */
export function kvCompatStream(env: Env, manifest: StoreManifest): ReadableStream<Uint8Array> {
	if (!manifest.compat_key || !manifest.compat_bytes) {
		throw new EngineUnavailableError(
			`Store ${manifest.store_key} has no card-object archive; /cards/* needs one (rebuild the store)`,
		);
	}
	return kvArchiveStream(
		env,
		manifest.compat_key,
		manifest.compat_bytes,
		manifest.compat_chunk_count,
		manifest.compat_gzip_bytes,
	);
}

/**
 * The chunk sequence as one continuous stream of ARCHIVE bytes.
 *
 * `expected` is always the archive's decompressed length — what the wasm buffer
 * is preallocated from. `gzipBytes` is what KV actually holds, and it is present
 * exactly when the archive was published compressed; that presence IS the format
 * flag, which is what lets one reader serve both and makes a revert a code-only
 * change with no data migration.
 *
 * Each chunk is its own gzip member with its OWN DecompressionStream, because
 * workerd rejects members concatenated into one stream ("Trailing bytes after
 * end of compressed data") where the gunzip CLI accepts them. That per-chunk
 * shape is also what keeps the publisher resumable: a chunk is compressed and
 * put inside a single alarm, so the compression unit equals the publish unit.
 *
 * ONE PIECE PER PULL, deliberately. Decompressing a whole chunk and enqueueing
 * its pieces at once would put the full 26MB decompressed chunk back in the JS
 * heap and throw away the reason for doing this: only the ~13MB COMPRESSED chunk
 * is resident, and the decompressed pieces flow into wasm and are released as
 * they arrive. Peak goes ~102.6MB -> ~89.6MB against the 128MB isolate.
 */
function kvArchiveStream(
	env: Env,
	storeKey: string,
	expected: number,
	chunkCount?: number,
	gzipBytes?: number,
): ReadableStream<Uint8Array> {
	const compressed = gzipBytes !== undefined;
	// Bytes KV holds, which is what the integrity check can actually count.
	const expectedStored = gzipBytes ?? expected;
	// A compressed archive's chunk count cannot be derived from either byte
	// count — the cut is on RAW bytes and the stored values are smaller — so the
	// manifest must carry it. Every publisher writes it; only pre-generation
	// manifests omit it, and those are uncompressed by construction.
	if (compressed && chunkCount === undefined) {
		throw new EngineUnavailableError(`Store ${storeKey} is gzipped but its manifest carries no chunk_count`);
	}
	const total = chunkCount ?? chunkCountFor(expected);
	let seq = 0;
	let seen = 0;
	let current: ReadableStreamDefaultReader<Uint8Array> | null = null;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			for (;;) {
				if (current) {
					const { done, value } = await current.read();
					if (!done) {
						controller.enqueue(value);
						return;
					}
					current = null;
				}
				if (seq >= total) {
					if (seen !== expectedStored) {
						controller.error(
							new EngineUnavailableError(`Store ${storeKey} incomplete in KV: ${seen}/${expectedStored} bytes`),
						);
						return;
					}
					controller.close();
					return;
				}
				const key = chunkKey(storeKey, seq);
				const body = await env.STORE_KV.get(key, { type: "arrayBuffer", cacheTtl: 604_800 });
				if (!body) {
					// A manifest naming chunks KV does not have means a publish was
					// interrupted between chunks and manifest, or retention deleted a
					// store still referenced. Never serve a short store: fail the load
					// and leave the previously loaded engine in place.
					controller.error(new EngineUnavailableError(`Store ${storeKey} is missing chunk ${seq} in KV`));
					return;
				}
				const bytes = new Uint8Array(body);
				// Counted BEFORE decompression: `seen` measures what KV handed over,
				// so the check catches a truncated or missing value. The decompressed
				// total is checked independently, and better, by finish_store_load —
				// it fills a buffer preallocated to exactly `expected`.
				seen += bytes.byteLength;
				seq += 1;
				if (!compressed) {
					controller.enqueue(bytes);
					return;
				}
				current = bytesStream(bytes).pipeThrough(new DecompressionStream("gzip")).getReader();
			}
		},
	});
}
