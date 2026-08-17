// Where the card store lives: Workers KV, as a handful of large chunks plus a
// manifest pointing at them.
//
// This replaces a content-addressed 40,000-byte grid in D1. That grid existed
// for one reason — D1's 100,000-byte SQL statement limit, with hex doubling
// every blob — and it dragged a whole dedup scheme behind it (~1,800 rows per
// store, reuse accounting, prune-by-reference) purely to keep row writes under
// the free plan's daily quota.
//
// KV removes the constraint that created all of it. At KV_CHUNK_BYTES below,
// the ~84MB store — ONE archive since generation 19, card-object residue
// included — is TWO chunks, so:
//
//   - a full publish is 3 writes against a 1,000/day free allowance — two
//     store chunks and the manifest — with no incremental publish, no dedup,
//     no resume bookkeeping
//   - a cold load is 3 reads against 100,000/day (manifest + two chunks), and
//     it is the SAME load for /search and /cards/* — no second archive, no
//     second round trip
//   - one copy serves every colo, instead of one 84MB SQLite copy per
//     Durable Object against a 5GB pool
//
// Chunk count is not cosmetic. The loader below pulls chunks STRICTLY IN
// SEQUENCE, one awaited get each (and must — see kvSourceStream), so a chunk is
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

import type { Env, StoreManifest, StoreManifestPartition } from "./types";
import { EngineUnavailableError } from "./types";

/**
 * Bytes per KV chunk — the RAW cut, whose gzip member is what KV actually stores.
 *
 * Chunk count is `ceil(store_bytes / this)`, and a chunk is a SERIALIZED NETWORK
 * ROUND TRIP on the cold path (the loader pulls them strictly in sequence, one
 * awaited get each — see kvSourceStream), so the count is a latency number, not
 * just a meter tick. Measured in the other direction: generation 3 added 6.25MB,
 * went 3 chunks to 4, and the production median store load went 337ms to 691ms.
 *
 * RAISED from 38,400,000 for generation 19: the residue archive folded back into
 * the store (one archive, upstream's shape), taking it to 83,902,632 bytes, and
 * this cut keeps that at TWO chunks with 8.1MB of RAW growth room before a
 * third (a 42MB cut left 97KB — five days of Scryfall drift). Safe only while
 * the store compresses better than ~1.76x. Measured on the real generation-19
 * archive (2026-08-13):
 *
 *   chunk 0: raw 46.0MB -> 15.3MB stored   (58% of the value cap)
 *   chunk 1: raw 37.9MB -> 17.8MB stored   (71.2% of the cap — the binding one)
 *
 * so the binding chunk carries ~29% headroom, and the whole archive would have
 * to compress worse than its worst part currently does before it breached.
 *
 * THE FAILURE MODE IS LOUD AND NON-CORRUPTING, which is what makes the trade
 * acceptable. Every publisher compresses and then checks against
 * KV_VALUE_CAP_BYTES before writing, so a build that compressed badly cannot
 * truncate a store — and both publishers fall back to KV_CHUNK_BYTES_SAFE and
 * republish rather than failing the run. The cost of being wrong is a slower
 * publish, not a broken one.
 *
 * The 128MB isolate does not constrain this: the loader feeds wasm in fixed 4MB
 * blocks (load-blocks.ts) regardless of chunk size, so the only size that scales
 * with this constant is the compressed chunk resident in the JS heap (~17.8MB),
 * against ~84MB of linear memory.
 *
 * Growth is not the thing to watch (~19KB/day of Scryfall drift). What to watch
 * is a FORMAT CHANGE that adds poorly-compressing data in bulk — which is
 * exactly what generation 3 did.
 */
export const KV_CHUNK_BYTES = 46_000_000;

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

/**
 * THE manifest key. There is exactly one, and it always holds a PARTITIONED
 * manifest.
 *
 * There was briefly a second pointer (`store:manifest2`) so a partitioned store
 * and an unpartitioned one could be live at once behind an env flag. That dual
 * window is deleted: the partitioned store is the setup, not a mode, so there is
 * one pointer, one shape, and no shape-to-key derivation to get wrong.
 * writeManifest refuses an unpartitioned manifest outright and readManifest
 * refuses to hand one back.
 */
export const MANIFEST_KEY = "store:manifest";

/**
 * Whether an object serving `partition` can serve `manifest` at all — the guard
 * on every PUSHED manifest (the publish fan-out, which does not go through
 * readManifest and so has no other shape check in front of it).
 *
 * Both halves are assertions about a single-path deployment rather than a choice
 * between paths: every engine object is `engine-<region>[-<n>]-p<k>`, so a label
 * that parsed to no partition is a naming bug, and every published manifest is
 * partitioned, so an unpartitioned one is a builder bug. An object that recorded
 * either would wedge its next cold load on archiveOfManifest's refusal, so
 * notifyPublish/preparePublish check THIS before recordLiveManifest and refuse
 * loudly (ack, log, cache nothing) on a mismatch.
 */
export function manifestServableBy(partition: number | undefined, manifest: StoreManifest): boolean {
	return partition !== undefined && isPartitionedManifest(manifest);
}

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
 *  16 — NO CONTENT CHANGE. A repair, not a description.
 *
 *       Generation 15's publish exposed a race between the residue pre-cache and
 *       the attach on the same cold request: two writers on one cache key, rows
 *       deleted and re-inserted under each other, and both counting a full
 *       archive so `commit()` wrote a meta row over the mixture. The result was a
 *       copy that was READABLE and wrong, which `isCached` then answered yes to
 *       forever — every `/cards/*` on that object 500'd, permanently, because the
 *       retry read the same rows.
 *
 *       The race is fixed (residueFills) and the trap is fixed (dropCached, and
 *       an attach that invalidates a copy that fails to load). But a cache
 *       already poisoned on a live object is only repaired by a reader noticing —
 *       and a new store key repairs it outright, since the bad rows are keyed by
 *       the OLD archive name and get pruned. That is what this bump is for.
 *
 *       It also re-exercises the path that broke, on a genuine KV cold load,
 *       which is the only way to prove the fix rather than assert it.
 *  17 — the five collection indexes store dense values as bitmaps instead of
 *       posting lists (ARCHIVE_FORMAT_VERSION 2026081104 -> 2026081301). Paired,
 *       as always: the format bump alone makes the old store unloadable, and
 *       this is what makes store-age.ts force the rebuild at deploy rather than
 *       leaving the port dark until the nightly.
 *
 *       This is a SIZE change, not a behaviour one. Every read goes through
 *       len_of/ids_of/bits, which answer identically for both representations,
 *       so no value changes which narrowing path it takes or which selectivity
 *       gate applies to it — deliberately unlike frame_data, whose dense values
 *       take a bitmap path with its own gate.
 *  18 — three layout changes batched into one generation (ARCHIVE_FORMAT_VERSION
 *       2026081301 -> 2026081401), paired as always so store-age.ts forces the
 *       rebuild at deploy rather than leaving the port dark until the nightly.
 *
 *       `card_name_folded` becomes an interned id (OracleCard 304 -> 240 bytes),
 *       the residue's three list fields become CSR on CompatData (CompatFields
 *       84 -> 60), and a `printing_by_illustration_id` permutation replaces the
 *       last by-id linear scan. Batched because the rebuild is ~3 minutes and the
 *       version-pair dance is the part worth not repeating three times.
 *  19 — ONE ARCHIVE, upstream's shape exactly (ARCHIVE_FORMAT_VERSION
 *       2026081401 -> 2026081402). The residue archive is gone: `compat` rides on
 *       `Printing` (with its three Vec list fields, upstream's CompatFields
 *       field-for-field), `all_parts` and the new card-level
 *       `planeswalker_loyalty_text_id` ride on `OracleCard`, and
 *       `external_id_index` moves into `CardIndexes`. The manifest loses its
 *       compat_* fields and a publish is one chunk family plus the manifest.
 *  20 — TWO CHANGES THAT SHIP AS ONE, because each makes the other necessary
 *       (the combined multilingual + partitioning program):
 *
 *       MULTILINGUAL FOREIGN ROWS. The corpus is `all_cards`, not
 *       `default_cards`: every printing in every language (~540k rows against
 *       ~95k), foreign printings as native engine rows in the annex
 *       (printed_name/printed_type_line/printed_text interned per face,
 *       lang promoted to an indexed plane, PrintedNameIndex for the name
 *       routes), canonical printings marked by id-membership in default_cards.
 *
 *       PARTITIONED ARCHIVES. That corpus does not fit one archive inside a
 *       128MB isolate — the single-archive build peak was already 120.9MiB
 *       against the 124MiB cap English-only — so the store is now N archives
 *       cut by fnv1a64(oracle_id) % N, N auto-scaled per build (Decision 3b)
 *       and recorded in the manifest, never a constant. The manifest gains
 *       partition_count + partition_hash + partitions[], with totals at top
 *       level; chunk families carry a `-p<k>` suffix.
 *
 *       NO DUAL WINDOW, DELIBERATELY (and this is the recorded cost): the
 *       partitioned store is THE store, so there is no second manifest key and
 *       no unpartitioned serving path. The deploy that ships this overwrites
 *       `store:manifest` while the previous Worker is still live, and that
 *       Worker cannot parse the new shape — a few minutes of errors, once,
 *       accepted in exchange for deleting the rollout machinery. See
 *       scripts/import-store.sh's header.
 *
 *       Paired with ARCHIVE_FORMAT_VERSION 2026081402 -> 2026081603. ONE
 *       generation covers the whole unshipped format stack — 2026081501 (annex
 *       schema + printed interning + lang planes), 2026081601 (collector_rank,
 *       `order=set`'s collector-number key), 2026081602 (all_parts per printing,
 *       printed keywords, printed color_indicator, games order) and 2026081603
 *       (Scryfall's name collation, the name tiebreak, the corrected rarity
 *       ladder) — because generation 19 is what is live: none of those four was
 *       ever published, so they land as one step rather than as four generations
 *       KV never held.
 *
 *       The 601/602 pairing is upstream #927's, which vendor was renumbered to
 *       match: the two landed concurrently in the two trees and took the numbers
 *       in opposite orders. Upstream is the copy other people read, so it won.
 *
 *       The pairing is the load-bearing part: store-age.ts forces a rebuild
 *       on a GENERATION mismatch, not a format mismatch, so bumping the format
 *       alone would deploy a Worker whose only store in KV is one it cannot
 *       load — dark until the nightly. Same reasoning as generations 7/11/12.
 *  21 — THE ROUTING FILTER JOINS THE PUBLISH (no ARCHIVE_FORMAT_VERSION change —
 *       the archives are byte-identical; what changed is what a publish WRITES).
 *
 *       A build now also puts `store:card-routing-v<fmt>-<built_at>.store:0`, a
 *       ~740KB XOR retrieval filter mapping every non-oracle id in the corpus
 *       (scryfall_id, illustration_id, the five external namespaces — 1.23M keys)
 *       to the partition that owns it. `/cards/<uuid>`, `/cards/multiverse/<n>`,
 *       the illustration lookup and collection `{id}` stop fanning out N ways and
 *       ask ONE partition; a filter miss falls back to the fan-out, so it can be
 *       unhelpful and never wrong.
 *
 *       IT IS A GENERATION BUMP PRECISELY BECAUSE IT IS OPTIONAL. The serving
 *       path treats a missing filter as "fan out", so nothing would ever force
 *       the store that predates it to be republished — store-age.ts would report
 *       the live generation as current and skip the rebuild, and the deployment
 *       would keep paying nine Durable Object requests per point lookup with the
 *       code to avoid it already deployed. The bump is what makes the next deploy
 *       actually publish one.
 *
 *       ...and the `is:` tag VOCABULARY rides in the same generation, for the same reason and with
 *       no format change: BOOLEAN_IS_TAGS grew and ARRAY_IS_TAGS is new (upstream #926), taking the
 *       stored vocabulary from 3 entries to 30, so a build now WRITES values an older archive does
 *       not carry. No bump of its own — 19 is what is live, so the 19 -> 21 mismatch already forces
 *       the republish that materializes them.
 *
 *       THE RULE THAT LEAVES BEHIND, for whoever adds the thirty-first: **the tag vocabulary is
 *       part of what this constant covers, and adding a tag is a generation bump.** A tag is stored
 *       data, so an older archive simply does not have it, and nothing about the archive FORMAT
 *       changes to say so. That is worse than an ordinary stale store: the parser reads the same
 *       table to decide which `is:` values it reports as SUPPORTED, so a Worker deployed against a
 *       store predating the tag answers zero WITH NO WARNING — precisely the failure
 *       `SUPPORTED_IS_VALUES` exists to remove. The generation is the only thing that makes the
 *       store catch up with the parser.
 *
 *       ...and so do the last two parity gaps, ARCHIVE_FORMAT_VERSION 2026081603 -> 2026081604.
 *       Folded into 21 rather than given a 22 for the same reason 20 batched four format
 *       versions: 19 is what is live, so the whole unshipped stack lands as ONE step.
 *
 *       `flavor_name` IS STORED. Scryfall's alternate SOLD-AS name — the Godzilla series,
 *       Stranger Things, the Secret Lair crossovers — had no column here, so the key was missing
 *       from every card object and `/cards/named?exact=Godzilla, Primeval Champion` answered 404
 *       where Scryfall answers prm/80925. `Printing` gains `flavor_name_id` +
 *       `flavor_name_folded_id` and `CardIndexes` a second `PrintedNameIndex` (`flavor_names`,
 *       ~546 records). 669 of 540,484 all_cards rows participate; the distinct strings are
 *       10.4 KB, so the archive cost is noise.
 *
 *       THE IMPORT FILTER STOPPED DROPPING NON-PAPER PRINTINGS. 9,119 Arena and MTGO exclusives
 *       that Scryfall serves from a bare `/cards/search` with default parameters are now
 *       imported (517,746 -> 526,865 staged rows, +1.76%) — the one clause of `passes_filters`
 *       that made an ordinary query disagree with Scryfall rather than mirroring its own
 *       query-time `include_extras` exclusion. The projected store grows 1.62% and
 *       `partitionCountFor` still returns 9; N=10 needs +8.9%.
 *
 *       ...and so do the two SEARCH-SEMANTICS gaps, ARCHIVE_FORMAT_VERSION 2026081604 ->
 *       2026081605. Same reasoning again: 19 is live, the stack ships as one step.
 *
 *       `t:` IS A SUBSTRING OF THE TYPE LINE. A single token resolved to type/subtype MEMBERSHIP,
 *       so `t:creat cmc<=2 e:khm` answered 0 where Scryfall answers 39; the quoted phrase had
 *       already been rerouted to a type-line regex, correctly but with no narrowing arm at all.
 *       Both now compile to one predicate resolved against `CardIndexes.type_lines`, a new index
 *       over the corpus's 3,965 distinct type lines (~33 KB/partition of index) whose CSR expands the
 *       winners to the exact card set. Stored data, not format: an archive without the index
 *       answers every `t:` query with zero rows, and no struct size moves to say so.
 *
 *       `o:` SEARCHES ORACLE TEXT WITH REMINDER TEXT STRIPPED. `oracle_text_lower_id` is now the
 *       reminder-stripped form rather than a plain `to_lowercase()`, which is what Scryfall's `o:`
 *       reads (`o:"damage dealt by this creature also causes"` is 0 there and was 68 here). The
 *       EMITTED `oracle_text` is unchanged — this is a second representation, not a rewrite of the
 *       card object — but the interned strings, the oracle trigram index and its word dictionary
 *       are all different bytes for the same card, so an archive built before it searches reminder
 *       text again with nothing to signal it.
 *
 *       THE ARCHIVE GETS SMALLER, measured over the 526,865-row corpus: the searchable oracle
 *       column goes 30,259 distinct texts / 5,196,005 bytes -> 30,063 / 4,199,590, so the
 *       stripped form is 973 KB CHEAPER than the plain lowercase one it replaces (cards with no
 *       reminder text intern to the id they already had, and the oracle trigram index built over
 *       it shrinks with it). Against that, `type_lines` costs ~33 KB per partition
 *       (4 bytes per distinct line, per line boundary and per card) — ~330 KB across the ten.
 *       Net: the pair of fixes REMOVES roughly 650 KB from the store.
 *
 *       ...and so do the last two ORDERING gaps, ARCHIVE_FORMAT_VERSION
 *       2026081605 -> 2026081606. Same reasoning once more: 19 is live, so the
 *       whole stack still ships as one generation step.
 *
 *       `order=artist` COLLATED ON RAW BYTES. It follows `order=name`'s rule --
 *       accents aside, every non-alphanumeric dropped -- measured at 0 violations
 *       over 348 adjacent pairs against 4 for byte order, each of the four a pair
 *       a space decides (`Alexander Mokhov` before `Alex Konstad`). Those four
 *       were the last `ordering-primary` findings left in the sweep.
 *
 *       THE ANNEX IS STORED IN LANGUAGE ORDER. `e:khm cn:1
 *       include_multilingual=true` answers en, de, es, fr, it, ja, ko, pt, ru,
 *       zhs, zht; English rows are canonical and sort ahead by vpid, so the
 *       stored annex only has to carry the alphabetical tail. A stored ORDER
 *       rather than a fifth sort-key lane: `page_cmp` reaches vpid as its last
 *       tiebreak, so arranging the rows is enough and the key stays four lanes.
 *
 *       ...and so does the LAST ordering gap, ARCHIVE_FORMAT_VERSION 2026081606
 *       -> 2026081607. Still one generation step: 19 is live.
 *
 *       `order=artist` NOW FOLDS ACCENTS. Stripping the punctuation closed three
 *       of the four `ordering-primary` findings; the fourth was `Néstor Ossandón
 *       Leal` sorting after `Nils Hamm` because the artist vocab is lowercased
 *       but not folded, and the engine has no NFKD. The builder now supplies the
 *       fold with the row and `CardData.artist_vocab_folded` holds it parallel
 *       by vid (~40KB). 116 of the corpus's 2,540 artists carry an accent. `a:`
 *       predicates still bind against the unfolded vocab, so only the sort moves.
 *
 *       ...and so does the LAST of the silent-zero `is:` values, ARCHIVE_FORMAT_VERSION
 *       2026081608 -> 2026081609. Still one generation step: 19 is live.
 *
 *       `is:unique` IS A SET COUNT AND IT SPANS LANGUAGES. `OracleCard` gains `single_set`, set at
 *       build over the card's canonical printings AND its annex rows. Scryfall's syntax page
 *       defines the predicate as "cards that have only been in a single set", which is not
 *       `prints=1` (2,847 of its own 16,318 matches have more than one printing), and the count
 *       spans every language: 130 cards have one English set plus a second set that exists only in
 *       another language — the Salvat inserts, ps11, pmei — and api.scryfall.com calls none of the
 *       130 unique. A canonical-only walk would have answered "unique" for all 130. Stored rather
 *       than derived because the verifier holds one card and one printing and can see neither the
 *       card's other rows nor the annex. The bool is free — it lands in padding
 *       `legality_divergent` already left, so no row grows and no struct size moves, which is also
 *       why only ARCHIVE_FORMAT_VERSION can catch an archive built before it.
 *
 *       `is:localizedname` rides the same generation with NO archive change of its own: it is
 *       `Printing.printed_name_folded_id != NONE_STR`, a field the annex already carries. It is
 *       listed here because it is the third thing in this generation that a store predating the
 *       ANNEX cannot answer, and because — like `lang:` — its presence widens a query to the annex,
 *       which is how api.scryfall.com answers 31,294 cards for it with no `lang:` term written.
 *
 * 22    `name:` IS TWO SEARCHES, ARCHIVE_FORMAT_VERSION 2026081610 -> 2026081611. A GENERATION of
 *       its own rather than a fold into 21, because 21 has not shipped either but this one changes
 *       what THE most-used surface answers — a bare word in the search box — and the two want
 *       separate history if either has to be rolled back.
 *
 *       A BARE `name:` word is matched against the card name with diacritics folded AND every
 *       non-alphanumeric character removed; a QUOTED value is matched literally, case-insensitively
 *       and nothing else. Measured on api.scryfall.com 2026-08-16:
 *
 *         name:ft     1,628   name:"ft"      362    name:'ft'       362   name:*ft*   1,628
 *         name:ofthe  1,109   name:"ofthe"     0    name:"of the" 1,109
 *         name:eowyn      3   name:"eowyn"     0    name:"éowyn"      3
 *         name:limdul     8   name:"limdul"    0    name:"lim-dûl"    8
 *
 *       This port answered 359 for `ft` — a single accent-folded substring search for both
 *       spellings, so the bare word could not cross a space and "Sword **of the** Ages" was
 *       unreachable, while the quoted spelling reached accents it should not have. `OracleCard`
 *       gains `card_name_collated_id` and `name_trigram`/`name_bigrams`/`name_unigrams` are all
 *       rebuilt over that string, which is what keeps the common form indexed rather than scanned.
 *
 *       `!"…"` IS COLLATED TOO, on the same evidence: `!"Lim-Dûl's Vault"`, `!"lim-dul's vault"`,
 *       `!"limduls vault"` and `!"Lim-Dul's Vault"` all answer the same one card on Scryfall, and
 *       this port answered only the first. `name:/…/` keeps the literal reading — `name:/lim-dul/`
 *       answers 0 there and `name:/Lim-D.l/` answers 8 — which it gets by lowering to the quoted
 *       form rather than to the bare one.
 *
 *  23 — THE EXTRAS CLASS IS CORRECTED, FOLDED PER SET, AND THE TEXT FOLDS WIDEN. Three changes to
 *       stored VALUES, all archive-visible, all shipped together because they land in one rebuild.
 *
 *       `is:extra` gains `content_warning` printings (91 rows, 25 English — Crusade and its
 *       fifteen-set family) and LOSES `host`/`augment` (46 rows across ust/und/ulst). Both were
 *       measured against api.scryfall.com on 2026-08-16: `is:extra e:lea` answers 1 there and 0
 *       here, `is:extra e:ust` answers 0 there and 32 here. The class is what `include_extras`
 *       hides, so both errors were visible as results, not just as a tag.
 *
 *       `CardIndexes.sets_with_extras` is the per-set fold of that corrected class — the table
 *       `cardsSearchHandler` reads to decide Scryfall's `include_extras` AUTO-ENABLE. It could
 *       not have been added first: a fold of the wrong class is a wrong table.
 *
 *       `fold_accents` expands the Latin letters NFKD leaves whole (æ œ ß ø ł đ þ ð ħ ŋ ŧ ı ĸ), so
 *       `name:æther` answers Scryfall's 90 instead of nothing, and 86 artist names spelled with
 *       `ł`/`Ø` become reachable without them. Every folded and collated name changes, which moves
 *       `name_rank` and `artist_rank` — the default ordering. `fold_ae` expands `æ` in the
 *       interned `*_lower` text columns, for `o:æther` (9) and `ft:æther` (80).
 *
 *  24 — TWO SCRYFALL VALUES THAT ARRIVE AS STRINGS ARE FINALLY READ. No layout change, so
 *       ARCHIVE_FORMAT_VERSION does NOT move; the same fields simply stop being empty.
 *
 *       `prices.usd_foil`, `prices.usd_etched` and `prices.eur_foil` were null on EVERY card ever
 *       served. They come out of `card_compat_blob["prices"]`, whose members Scryfall sends as
 *       decimal STRINGS ("60.00"), and the reader (`jv_opt_price_cents` / `opt_price_cents`) took
 *       only the f64 and i64 arms. `price_usd`/`price_eur`/`price_tix` were never affected: they
 *       are their own columns, filled by the importer's `maybe_float`, which has had a string arm
 *       all along. Measured 2026-08-16: `q=t:goblin` served `prices.usd` on 163 of 175 rows and
 *       the three foil variants on ZERO, against `"60.00"` on api.scryfall.com's apc Fire // Ice.
 *
 *       `image_updated_at` was null on every card for the same reason — Scryfall sends it as an
 *       ISO-8601 timestamp ("2026-07-13T00:36:48Z") and it was read by `opt_nonzero_u32`. It is
 *       the cache-buster on every image URL, so every `image_uris` value this API served came out
 *       bare where Scryfall's carry `?1783903008`. 0 of 175 `t:goblin` rows had a `?` in
 *       `image_uris.large`.
 *
 *       Both are pre-existing English-corpus defects, unrelated to the multilingual work they ship
 *       beside, and both are invisible to the parity harnesses by construction: prices and the
 *       image query string are stripped as VOLATILE. scripts/volatile-shape.ts is the structural
 *       guard added with the fix.
 *
 *  25 — A FUNNY SET DECIDES ITS OWN EXTRAS. No layout change, so ARCHIVE_FORMAT_VERSION does NOT
 *       move (same rule as 24) — the `card_is_tags` VALUES change, and with them the per-set
 *       `sets_with_extras` fold that generation 23 added, which is why this needs a generation of
 *       its own: an archive built before it answers `is:extra` and the `include_extras` auto-enable
 *       from the old class, and only the generation compare forces the rebuild that fixes it.
 *
 *       `is:extra e:ulst` answered 62 on api.scryfall.com and 0 here. Nothing on the printing says
 *       so: The List's Unstable reprints were diffed field by field against their own ust twins
 *       across the whole 2026-08-16 bulk and the only ulst-exclusive values are `highres_image`
 *       and `image_status` — scan quality. The split is a property of the SET, and it is total:
 *       all 22 funny sets answer `is:extra e:<code>` with either their full card count or zero.
 *       `FUNNY_EXTRA_SETS` (engine/builder/src/transform.rs) is that list, and making the funny
 *       answer TOTAL also retires the false positive und/unh carried — "Look at Me, I'm R&D", a
 *       real Un-card the `playtest` clause was calling an extra while `is:extra e:und` answers 0.
 *
 *       Three more classes came out of the same sweep, each with no false positive anywhere in the
 *       English corpus: digital and legal in NO format (117 — hbg 104, past 12, prm 1), a silver
 *       border in a promo set (10 — pal04, j17, p30m, punh, pust), and a "Stickers" type line
 *       (5 — sld/335-339). Against Scryfall's own 10,818 English `is:extra` printings the class
 *       goes from 10,482 with 308 misses and 2 false positives to 10,732 with 45 misses and none.
 *       The 45 are Arena-only duplicate printings (hbg 18, j21 16, ydmu 9, ybro 1) plus one Secret
 *       Lair poster, with nothing separating them from their own set-mates either.
 *  26 — THE PRINTING A FILTER PICKS WHEN IT EXCLUDES THE PINNED ONE IS NOW MEASURED, NOT GUESSED.
 *       No layout change, so ARCHIVE_FORMAT_VERSION does NOT move — `prefer_score` is a stored
 *       VALUE and a generation-25 store still loads. Which is exactly why this bump carries the
 *       change on its own: nothing in the header can see that every card's printing ORDER moved.
 *
 *       Generation 9 pinned the printing Scryfall's `oracle_cards` dump names, and that answer is
 *       exact (.9999 measured). It says nothing about a query whose filter EXCLUDES that printing
 *       — `e:khm` for a card whose global representative lives in another set — where the port
 *       fell back on the raw component score and agreed with Scryfall on .6594 of the class.
 *
 *       The fallback rule was harvested rather than guessed: `unique=cards` hands Scryfall's own
 *       answer over in bulk, so 156 scopes (`e:<set>`, `a:"<artist>"`, filter-shaped) yielded
 *       16,045 labelled observations, each candidate set validated against that scope's own
 *       `total_cards`. The rule is `pin, then released_at DESC, then collector number ASC`, and
 *       it is encoded as a per-card RANK because `(released_at, collector number)` needs ~37 bits
 *       and an f32 has 24 — see engine/builder/src/ranks.rs for the accuracy table, the
 *       overfitting the holdout rejected, and the residual classes.
 *
 *         pin-excluded class  .6594 -> .9624      all observations  .8493 -> .9833
 *         pin in scope        .9999 -> .9999 (unchanged, and that is the point)
 *
 *  27 — A CARD DRAWN BY TWO PEOPLE FINALLY SAYS SO. No layout change, so ARCHIVE_FORMAT_VERSION
 *       does NOT move (same rule as 24, 25 and 26) — `card_artist` is a stored VALUE, and a
 *       generation-26 store still loads while answering with the wrong one.
 *
 *       The multi-face branch of `transform_row` merges each face over the parent dict with the
 *       FACE winning, so face 0's `artist` overwrote the card's before the column was read. Fire
 *       // Ice (dmr/215) is credited "David Martin & Franz Vohwinkel" by Scryfall and was served
 *       as "David Martin"; Delver of Secrets (sld/2367) is "Florey & Scott Okumura" and was
 *       served as "Florey". 1,158 printings carry a two-artist credit.
 *
 *       THREE surfaces read this one column, and all three were wrong together — which is why an
 *       emit-time patch in the card-object writers was rejected in favour of fixing the store:
 *
 *         card object   `artist` is the joined credit (the reported symptom, found by putting it
 *                       in a `format=csv` column).
 *         order=artist  ranks on `collate_name(card_artist_folded)`. Measured on api.scryfall.com
 *                       2026-08-16: `set:dmr order:artist` puts Fire // Ice AFTER all six plain
 *                       "David Martin" cards, and Illusion // Reality ("John Avon & David
 *                       Martin") after all three "John Avon" ones — Scryfall sorts on the JOINED
 *                       string, so a card-object-only fix would have left the ordering diverged.
 *         a:            artist search covers NON-FRONT faces there — `a:"franz vohwinkel"`
 *                       returns Fire // Ice, and `-a:"franz vohwinkel"` excludes it. This falls
 *                       out of the same value for free: `a:` compares the COLLATED artist, which
 *                       drops the " & ", so each artist's collated name is a substring of the
 *                       joined one.
 *
 *       The stored value is Scryfall's own string, never a join computed over the faces, and that
 *       is what makes the two degenerate shapes correct without a special case: 4,951 multi-faced
 *       cards whose faces share one artist keep the single name (never "X & X"), and 1,158
 *       SINGLE-faced cards already arrive pre-joined ("Greg Hildebrandt & Tim Hildebrandt") on a
 *       branch this change does not touch. Measured over the whole 2026-08-16 default_cards bulk:
 *       the separator is " & ", no card anywhere has a third artist (max `artist_ids` 2), and
 *       every comma in an artist string belongs to a name ("Ken Meyer, Jr.") rather than
 *       separating two. The string is also not re-splittable after the fact — "Hari & Deepti" is
 *       ONE artist, credited on ten printings — which is the second reason the value is taken
 *       from Scryfall rather than reconstructed.
 *
 *       Upstream's `card_processing.py` has the identical defect; per Decision 8d the engine
 *       follows Scryfall and the fix ships to #927 with this evidence attached.
 *
 *  28 — A BACK FACE'S NUMBERS BECOME SEARCHABLE. Paired with ARCHIVE_FORMAT_VERSION
 *       2026081612 -> 2026081613, and the pairing is load-bearing for the usual reason:
 *       store-age.ts rebuilds on a GENERATION mismatch, so a format bump alone deploys a Worker
 *       whose only store in KV is one it cannot load.
 *
 *       `_merge_processed_faces` copies a whole `_FACE_STAT_GROUPS` group from ONE face and the
 *       mana cost from the front alone, so a `//` card's other face was printable and
 *       unsearchable. `OracleFace` now carries the parsed `creature_power` /
 *       `creature_toughness` / `planeswalker_loyalty` and its own `mana_cost` (with its OWN cmc:
 *       Fire's 2, not Fire // Ice's 4), and the `power` / `toughness` numeric indexes and the
 *       joint `arith_tuple` postings are built over every face's value.
 *
 *       The RULE is measured against api.scryfall.com, 2026-08-16, not inferred from the merge:
 *
 *         pow>=3          Delver of Secrets (1/1 // 3/2)        1     back only
 *         pow=1 tou=2     Delver                                1     no face is 1/2
 *         pow>=3 pow<=1   Delver                                1     one column, two faces
 *         pow>tou         Huntmaster of the Fells (2/2 // 4/4)  1     no face has p>t
 *         pow=tou         Thing in the Ice (0/4 // 7/8)         404   no pair is equal
 *         m:{R}           Valki // Tibalt                       1     the BACK's {5}{B}{R}
 *         m={1}{R}        Fire // Ice                           1     one half's own cost
 *         m=0             Delver                                404   a costless back is not 0
 *         mv=0 / mv=2     Delver / Fire // Ice                  404   mana value stays CARD-level
 *
 *       The last row is why `cmc` is deliberately not face-scoped, and the two before it are why
 *       the model is a card holding a SET of values per column rather than a row per face: a
 *       per-face row answers 404 to `pow>tou` on Huntmaster, and a max-vs-max model answers 1 to
 *       `pow=tou` on Thing in the Ice.
 *
 *       Measured effect on this corpus: `f:pauper t:creature pow>=3 cmc<=2 r:common` 104 -> 115
 *       against Scryfall's 115 (223 in `unique=prints`), and `is:dfc c:u f:modern` 116 -> 124.
 *
 *  29 — A FACE'S COLOURS BECOME SEARCHABLE, AND THE UNION STOPS BEING. Paired with
 *       ARCHIVE_FORMAT_VERSION 2026081613 -> 2026081614, same pairing rule as 28.
 *
 *       The sibling of 28 and NOT the same shape, which is the whole finding. A stat column's
 *       merged value is COPIED from one face, so the merge only ever LOST values. A colour
 *       column's merged value is a UNION — `_FACE_FLAG_UNIONS` — so the merge also INVENTED one,
 *       and the port was over-matching as often as it was under-matching. Measured against
 *       api.scryfall.com, 2026-08-16, scoped with `!"Full // Name"` so each answer is 1 or 404:
 *
 *         c=b     Valki, God of Lies // Tibalt (B // BR)      1     the FRONT's mask alone
 *         c:c     Kabira Takedown // Kabira Plateau (W // []) 1     the land back is colourless
 *         c=wb    Extus // Awaken the Blood Avatar (WB // BR) 1     one face exactly
 *         c=br    Extus                                       1     the other face exactly
 *         c:brw   Extus                                       404   NO face is {W,B,R}
 *         c=3     Extus                                       404   only the union has three
 *         c<=b    Valki // Tibalt                             1     B is a subset of B
 *         c:c     Fire // Ice (split: faces declare NO colours) 404 the faces are the card's
 *         id=wbr / id=wb / id=2   Extus              1 / 404 / 404  IDENTITY stays card-level
 *
 *       The last two rows are the shape, not the semantics. A split or flip face carries no
 *       `colors` key at all, so `OracleFace.card_colors` is now `Option<u8>`: absent inherits the
 *       card's mask, `[]` means colourless. Reading both as the mask 0 would answer
 *       `!"Fire // Ice" c:c` with 1 — a card that works correctly today.
 *
 *       Colour identity and produced mana were measured too and are card-level, like mana value.
 *
 *       Measured effect on this corpus: `is:mdfc c:c` 12 -> 61 (Scryfall 61), `is:mdfc c=1`
 *       50 -> 77 (77), `is:transform c=1` 268 -> 314 (314), `e:znr c:c` 29 -> 59 (59).
 *
 *       Riding along, because it changes a stored value and so needs the same pair: every
 *       `reversible_card` printing carried the wrong `card_layout`. Scryfall puts `layout` on the
 *       FACES of those 81 cards and on nothing else, and the face overlay in `transform_row` was
 *       letting it overwrite the printing's — 77 stored as `normal`, 3 as `adventure`, 1 as
 *       `token`, and the corpus reporting zero reversible cards.
 *
 *  30 — LAYOUT IS A PROPERTY OF A PRINTING, AND IS NOW STORED AS ONE.
 *       ARCHIVE_FORMAT_VERSION 2026081614 -> 2026081615, same pairing rule as 28 and 29.
 *
 *       The other half of 29, and the half that made 29 unable to finish its own job.
 *       `card_layout_id` lived on `OracleCard`, so a card had ONE layout no matter how many
 *       printings it had. 29 fixed the value the 81 `reversible_card` rows carried; it could not
 *       make `is:reversible` answer, because all 71 oracle ids behind those 81 printings ALSO
 *       carry ordinary printings of the same card — Temple Garden by 63 of them — so whichever
 *       printing the group committed decided the card, and it was never the reversible one.
 *
 *       The field now lives on `Printing`. Measured against api.scryfall.com, 2026-08-16, and
 *       Scryfall answers per printing in the one place the two storages differ observably:
 *
 *         is:reversible          71 cards / 81 prints    not the ~4,000 prints those 71 cards have
 *         layout:reversible_card 71 cards / 81 prints    the same, via the un-rewritten spelling
 *         is:dfc                 2,895 cards             ours read 2,824 — exactly those 71 short
 *         is:dfc c:u f:modern    124 cards               ours read 114
 *
 *       Three stored things had to move together, and the third is the one a struct change does
 *       not force: the two archived rows, and `ValueTotals::layout`, which is rebuilt off the
 *       printing. That table SHORT-CIRCUITS the result total, so a card-keyed table read under a
 *       printing-keyed filter would have reported a count no result page could produce. Layout has
 *       no posting index and no bit plane, so nothing else in the store moves.
 *
 *  31 — A CARD'S ART TAGS ARE THE UNION OVER EVERY FACE IT SHOWS, NOT ITS FRONT'S.
 *
 *       NO ARCHIVE_FORMAT_VERSION change, and that is exactly what makes this bump load-bearing:
 *       `card_art_tags` is a stored VALUE, the layout is untouched, and a generation-30 store
 *       still loads — so nothing in the header can see that the values moved, and without this
 *       bump store-age.ts would keep serving a store whose double-faced cards answer only for
 *       their front art. Same reason as generations 6, 8 and 9.
 *
 *       Upstream's `_sync_card_tags` matches `card_art_tags` on the row's one `illustration_id`
 *       column. Since generation 5's face merge that column is the FRONT face's, so a tag on the
 *       BACK face's art was unreachable by any query. Scryfall answers otherwise — measured
 *       against api.scryfall.com, 2026-08-16:
 *
 *         arttag:snow e:khm              75    ours 73    missing Birgi // Harnfel and
 *                                                         Esika // The Prismatic Bridge,
 *                                                         whose snow is on the BACK art
 *         -art:human e:khm t:creature   135    ours 136   the extra is Valki // Tibalt:
 *                                                         Tibalt is the human, Tibalt is the back
 *
 *       `transform::art_tags_of` is now the one definition, called by all three import paths
 *       (native `finalize`, the spill aggregation, the wasm import), so no path can attach a
 *       different tag set than another. Scope on the 2026-08-16 bulk: 9,368 printings carry more
 *       than one illustration and 5,491 of them gain at least one tag from a non-front face.
 *
 *       `prefer_score` reads the union too, deliberately: `is_off_style` is a question about the
 *       art a printing shows, and a printing shows all of it. Measured cost of not splitting the
 *       two readings: THREE printings corpus-wide flip `is_off_style` (Tribute to Horobi // Echo
 *       of Death's Wail neo/356 en and de, `anime` on the back; Thaumatic Compass // Spires of
 *       Orazca pxtc/249, `line-art` on the back). One rule for both readings is worth three rows.
 *
 *       WHAT THIS DOES NOT FIX, measured at the same time so the next attempt starts from data
 *       rather than from the same guess: `unique=art` does NOT group by card, and it does not key
 *       on the front illustration either. Scryfall dedupes the RESULT SET on the ordered tuple of
 *       every face's illustration_id, across cards. Two proofs, both 2026-08-16:
 *
 *         - `e:khm t:god unique=art` is 25 there and 26 here. The extra row is `A-Alrund` (khm
 *           A-40), whose two faces carry the SAME illustration ids as khm 40 — a different
 *           oracle_id, a different name, and still one artwork. `unique=cards` (13) and
 *           `unique=prints` (26) agree exactly, so the dedupe is not card-scoped.
 *         - `name:"Growing Rites of Itlimoc" include:extras unique=art` keeps BOTH alci/26 and
 *           lci/188, which share a front illustration and differ on the back — so the key is the
 *           whole tuple, not the front. Same shape for `name:"Clearwater Pathway"`.
 *
 *       `assign_artwork_groups` keys on the printing's single `illustration_id` and groups WITHIN
 *       a card, which is wrong in both directions. On the 2026-08-16 bulk the front-only key
 *       merges 12 within-card rows Scryfall keeps, and the per-card scope keeps 333 rows Scryfall
 *       merges (296 shared tuples, 215 of them an Alchemy `A-` card against its original). Closing
 *       it needs a corpus-wide dense artwork id in place of `artwork_base[card] + gid` AND a
 *       cross-partition dedupe in the gather, because cards are partitioned by oracle_id and two
 *       cards sharing an artwork have different ones. That is a store-shape change and a gather
 *       change, so it is not this generation.
 */
export const STORE_CONTENT_GENERATION = 31;

/** Chunk key for a store. Keyed by store_key, so publishes never collide. */
export function chunkKey(storeKey: string, seq: number): string {
	return `store:${storeKey}:${seq}`;
}

/**
 * The partition-assignment function's NAME, recorded in every v2 manifest:
 * algorithm / key / vector version. FNV-1a-64 over the ASCII bytes of the
 * lowercase hyphenated oracle_id, modded by the manifest's partition_count —
 * implemented twice (card_engine's Rust, src/engine/partition.ts) and pinned to
 * each other by tests/engine/partition-hash-vectors.json.
 *
 * A loader must REFUSE a manifest naming a hash it does not implement. Loading
 * anyway and routing by the wrong function makes cards silently vanish from
 * oracle-keyed routes; the version string converts that into a loud failure,
 * and a future change to the function is a new string, not a new behavior
 * under the old one.
 */
export const PARTITION_HASH_ALGO = "fnv1a64/oracle_id/v1";

/** Chunk-family key for one partition's archive: `card-store-v<fmt>-<built_at>-p<k>.store`. */
export function partitionStoreKey(formatVersion: number, builtAt: string, partition: number): string {
	return `card-store-v${formatVersion}-${builtAt}-p${partition}.store`;
}

/** The v2 store_key stem — names the BUILD (retention family), holds no chunks itself. */
export function storeKeyStem(formatVersion: number, builtAt: string): string {
	return `card-store-v${formatVersion}-${builtAt}.store`;
}

/**
 * The build's id→partition routing filter (src/engine/routing-filter.ts).
 *
 * SHAPED LIKE A CHUNK KEY ON PURPOSE. It is not a chunk — it is one ~740 KB
 * value per build — but naming it `store:card-routing-v<fmt>-<built_at>.store:0`
 * puts it inside the retention family of its own generation, so `staleStoreKeys`
 * retires it with the archives it describes and no second sweep exists to be
 * forgotten. A key under `store:card-` that the retention pattern did NOT match
 * would be listed on every prune and never deleted, which is the leak this
 * naming avoids rather than a detail of it.
 *
 * Immutable per build, like the chunks, so readers can cache it hard.
 */
export function routingFilterKey(formatVersion: number, builtAt: string): string {
	return `store:card-routing-v${formatVersion}-${builtAt}.store:0`;
}

/** The routing-filter key for a manifest's own generation, or null when the
 * manifest does not carry the stamps to name one. */
export function routingFilterKeyFor(manifest: StoreManifest): string | null {
	if (!manifest.format_version || !manifest.built_at) return null;
	return routingFilterKey(manifest.format_version, String(manifest.built_at));
}

/**
 * How long an isolate's colo may serve a cached routing filter.
 *
 * A week, like the archive chunks and for the same reason: the key names its
 * build, so the value under it never changes and a stale read is impossible.
 * When a new generation publishes, the key changes with it.
 */
const ROUTING_FILTER_CACHE_TTL = 604_800;

/** Read a build's routing filter, or null when none was published for it. */
export async function readRoutingFilter(env: Env, manifest: StoreManifest): Promise<Uint8Array | null> {
	const key = routingFilterKeyFor(manifest);
	if (!key) return null;
	const buf = await env.STORE_KV.get(key, { type: "arrayBuffer", cacheTtl: ROUTING_FILTER_CACHE_TTL });
	return buf === null ? null : new Uint8Array(buf);
}

/**
 * Publish a build's routing filter.
 *
 * Deliberately NOT gated on the manifest: this runs before the manifest exists
 * (the nightly writes it right after the corpus-wide scores pass, the deploy
 * path right before the manifest put), and a filter for a build that never
 * publishes is simply a key nobody names, swept with its family.
 */
export async function writeRoutingFilter(
	env: Env,
	formatVersion: number,
	builtAt: string,
	bytes: Uint8Array,
): Promise<void> {
	if (bytes.byteLength > KV_VALUE_CAP_BYTES) {
		throw new Error(`routing filter is ${bytes.byteLength} bytes, over the ${KV_VALUE_CAP_BYTES} KV value cap`);
	}
	await env.STORE_KV.put(routingFilterKey(formatVersion, builtAt), bytes);
}

/**
 * Shape assertion: every published manifest carries partition_count. A manifest
 * without one predates the partitioned store and nothing here can serve it.
 */
export function isPartitionedManifest(manifest: StoreManifest): boolean {
	return manifest.partition_count !== undefined;
}

/**
 * The message a reader gives when KV hands it a manifest from before the
 * partitioned store. Shared by readManifest and archiveOfManifest so the reason
 * is worded once: the store is not servable, and the fix is a rebuild, not a
 * fallback path (there is none by design).
 */
function unpartitionedManifestMessage(storeKey: string): string {
	return (
		`The manifest at ${MANIFEST_KEY} (${storeKey}) carries no partition_count, so it was published by a ` +
		`builder that predates the partitioned store. This deployment serves partitioned archives only — there ` +
		`is no unpartitioned path to fall back to. The next import (scripts/import-store.sh, or the nightly ` +
		`coordinator) replaces it.`
	);
}

/**
 * The ONE archive this object should load: which chunk family, how many bytes,
 * cut how.
 *
 * This is where the loader's shape decisions live, so every consumer (loadStore,
 * the prefetch, the wedged-object confirm) agrees by construction. All three
 * refusals below are ASSERTIONS about a single-path deployment, not a choice
 * between paths — each names a bug that would otherwise be silent:
 *
 *   partitioned manifest + partition k → `partitions[k]`, the only good case
 *   manifest with no partition_count   → REFUSED: nothing here can read it (see
 *     unpartitionedManifestMessage).
 *   NO partition on the label          → REFUSED. Every engine object is
 *     `engine-<region>[-<n>]-p<k>`; a label without `-p` reaching the loader is
 *     a routing bug, and serving one partition as the whole store would answer
 *     with 1/N of the corpus without a word.
 *   a partition_hash this build does not implement → REFUSED (routing by the
 *     wrong hash makes cards silently vanish; see PARTITION_HASH_ALGO).
 *
 * Every refusal is an EngineUnavailableError: routes turn it into the loud 503,
 * never an empty result.
 */
export interface ArchiveSource {
	/** Chunk-family key holding the bytes (carries `-p<k>` when partitioned). */
	storeKey: string;
	/** Decompressed archive length — what the wasm buffer is preallocated from. */
	storeBytes: number;
	/** Bytes KV holds. Present iff the chunks are gzipped (the format flag). */
	gzipBytes?: number;
	chunkCount?: number;
	cardCount: number;
}

export function archiveOfManifest(manifest: StoreManifest, partition?: number): ArchiveSource {
	if (!isPartitionedManifest(manifest)) {
		throw new EngineUnavailableError(unpartitionedManifestMessage(manifest.store_key));
	}
	if (manifest.partition_hash !== PARTITION_HASH_ALGO) {
		throw new EngineUnavailableError(
			`Manifest ${manifest.store_key} names partition hash ${JSON.stringify(manifest.partition_hash)}, which ` +
				`this build does not implement (it speaks ${PARTITION_HASH_ALGO}). Refusing to load: routing by the ` +
				`wrong hash makes cards silently vanish from oracle-keyed routes.`,
		);
	}
	if (partition === undefined) {
		throw new EngineUnavailableError(
			`The live manifest (${manifest.store_key}) is partitioned into ${manifest.partition_count}, but this ` +
				`object's label carries no -p<k> partition. That is a NAMING BUG, not a state to serve through: ` +
				`every engine object is engine-<region>[-<n>]-p<k>, and loading one partition as the whole store ` +
				`would silently answer with 1/${manifest.partition_count} of the corpus.`,
		);
	}
	const part = manifest.partitions?.[partition];
	if (!part) {
		throw new EngineUnavailableError(
			`Manifest ${manifest.store_key} holds no record for partition ${partition} ` +
				`(partition_count ${manifest.partition_count}); this object's name is stale for this generation.`,
		);
	}
	return {
		storeKey: part.store_key,
		storeBytes: part.store_bytes,
		...(part.store_gzip_bytes !== undefined ? { gzipBytes: part.store_gzip_bytes } : {}),
		chunkCount: part.chunk_count,
		cardCount: part.card_count,
	};
}

/**
 * Why this manifest must not be published, or null when it is publishable.
 *
 * Producer-side validation shared by every publisher (the ImportCoordinator via
 * writeManifest, the seed scripts directly): the manifest is the commit point
 * readers act on, so a malformed one is a served outage, not a build failure.
 * Loader-side validation (refusing an unknown partition_hash, task 9) is the
 * consumer's own defense; this is the writer refusing to create the problem.
 */
export function manifestShapeProblem(manifest: StoreManifest): string | null {
	if (!manifest.store_key || !manifest.store_bytes || !manifest.chunk_count) {
		return `incomplete manifest (store_key=${manifest.store_key}, store_bytes=${manifest.store_bytes}, chunk_count=${manifest.chunk_count})`;
	}
	if (!isPartitionedManifest(manifest)) {
		// A BUG IN THE BUILDER, not an older mode to accommodate. Both publishers
		// emit partitions: the native builder only when run with `--partitions auto`
		// (scripts/import-store.sh step 3), and the coordinator's build loop always.
		// A manifest without partition_count therefore means one of them was changed
		// or invoked wrong, and publishing it would take the site dark.
		return (
			`the manifest carries no partition_count. Every publisher emits a partitioned manifest — the native ` +
			`builder via \`sylvan-store-builder --partitions auto\` (scripts/import-store.sh) and the ` +
			`ImportCoordinator via its partition loop — so this is a builder bug, and readers have no ` +
			`unpartitioned path to serve it through`
		);
	}
	const n = manifest.partition_count as number;
	if (!Number.isInteger(n) || n < 1) return `partition_count ${n} is not a positive integer`;
	if (manifest.partition_hash !== PARTITION_HASH_ALGO) {
		return `partition_hash ${JSON.stringify(manifest.partition_hash)} is not ${PARTITION_HASH_ALGO}`;
	}
	const parts = manifest.partitions;
	if (!Array.isArray(parts) || parts.length !== n) {
		return `partitions[] holds ${parts?.length ?? "no"} records against partition_count ${n}`;
	}
	for (let k = 0; k < parts.length; k++) {
		const p = parts[k];
		if (!p?.store_key || !p.store_bytes || !p.chunk_count) {
			return `partition ${k} record is incomplete (store_key=${p?.store_key}, store_bytes=${p?.store_bytes}, chunk_count=${p?.chunk_count})`;
		}
	}
	// The totals are what store-age and the meters read; a sum that disagrees with
	// its parts means one of them lies, and there is no way to know which.
	const sum = (f: (p: StoreManifestPartition) => number) => parts.reduce((t, p) => t + f(p), 0);
	if (manifest.store_bytes !== sum((p) => p.store_bytes)) {
		return `store_bytes ${manifest.store_bytes} is not the sum of its partitions (${sum((p) => p.store_bytes)})`;
	}
	if (manifest.chunk_count !== sum((p) => p.chunk_count)) {
		return `chunk_count ${manifest.chunk_count} is not the sum of its partitions (${sum((p) => p.chunk_count)})`;
	}
	return null;
}

/**
 * Write the manifest — the commit point — refusing a malformed one.
 *
 * Every earlier write in a publish is invisible to readers (chunk keys are
 * per-build); THIS write is what makes them act, so it is the one place a shape
 * check must gate. ONE KEY, ONE SHAPE: an unpartitioned manifest is refused
 * here as a builder bug (see manifestShapeProblem) rather than routed to a
 * second pointer — there is no second pointer, and no reader that could serve
 * such a store.
 */
export async function writeManifest(env: Env, manifest: StoreManifest): Promise<void> {
	const problem = manifestShapeProblem(manifest);
	if (problem) throw new Error(`refusing to publish the manifest: ${problem}`);
	await env.STORE_KV.put(MANIFEST_KEY, JSON.stringify(manifest));
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
 * A key name carries everything the decision needs (`store:card-store-v<format>-<built_at>.store:<n>`,
 * or `...-<built_at>-p<k>.store:<n>` for a partitioned build's chunk families),
 * so the sweep is a pure function of what is actually in KV. It cannot drift from reality, it
 * self-heals a namespace that already leaked, and it costs one list operation.
 *
 * Every family of one build goes together. The `-p<k>` suffix is OPTIONAL in the pattern and
 * deliberately not captured: a partitioned build's N chunk families share one built_at, so they
 * group as ONE build and retire all-or-nothing — retiring some partitions of a generation while
 * keeping others would leave a manifest pointing at a store with holes.
 *
 * THE SUFFIX-LESS FAMILIES MATCH TOO, and that is load-bearing exactly once: the
 * pre-partition generation-19 build (and the long-gone `card-compat-` residue
 * family) is an un-suffixed family that no manifest names any more, so the first
 * partitioned publish leaves it orphaned in KV. Because the pattern groups it by
 * built_at like any other build, it simply ages out of the newest-`keep` set and
 * the ordinary sweep collects it — no one-off cleanup script.
 * (tests/engine/store-kv.test.ts pins this.)
 *
 * `protect` names built_ats that are NEVER retired, however old: the build just
 * published, and the build the live manifest points at. The second half stops an
 * age-only sweep from deleting the store readers are actively serving when a
 * publish did not advance built_at.
 */
export function staleStoreKeys(names: string[], keep: number, protect?: string | readonly string[]): string[] {
	const parsed = names.flatMap((name) => {
		// `routing` joins `store` and `compat` here so a build's routing filter
		// (routingFilterKey) retires with the archives it describes. It is not a
		// chunk family, but it IS part of the generation, and a `store:card-` key
		// this pattern misses would be listed forever and deleted never.
		const at = /^store:card-(?:store|compat|routing)-v\d+-(\d+)(?:-p\d+)?\.store:\d+$/.exec(name);
		return at ? [{ name, builtAt: at[1] as string }] : [];
	});
	const builds = [...new Set(parsed.map((k) => k.builtAt))].sort((a, b) => Number(b) - Number(a));
	// Protected builds are kept whatever their age says — a manifest points at
	// them, and a sweep that deleted one would take a live path down rather than tidy it.
	const keptBuilds = new Set(builds.slice(0, Math.max(keep, 1)));
	for (const builtAt of typeof protect === "string" ? [protect] : (protect ?? [])) {
		if (builtAt) keptBuilds.add(builtAt);
	}
	return parsed.filter((k) => !keptBuilds.has(k.builtAt)).map((k) => k.name);
}

/** How many chunks a store of this size occupies on the grid. */
export function chunkCountFor(storeBytes: number, cut: number = KV_CHUNK_BYTES): number {
	return Math.ceil(storeBytes / cut);
}

/**
 * How close the store is to needing one more chunk.
 *
 * CROSSING A BOUNDARY IS SILENT. `splitStore` is a bare `ceil` loop, and the only
 * check anywhere near it — `chunkForKv`'s fallback to `KV_CHUNK_BYTES_SAFE` —
 * asks whether a single gzipped member exceeds KV's per-VALUE cap, which is a
 * different question from how many members there are. So a store that grows past
 * `n * cut` simply becomes n+1 chunks: no throw, no warning, no failed publish,
 * and every cold load quietly pays another KV read. The manifest records
 * `chunk_count`, but nothing has ever compared it to the last one.
 *
 * That is worth a guard because the margin is thin and growth is lumpy. Measured
 * 2026-08-12, the store was 76,656,360 bytes against a two-chunk ceiling of
 * 76,800,000 — 143,640 bytes, 0.19%. Scryfall drift is ~19KB/day, so the trend
 * alone gives about a week; a single set release (~300 printings and ~280 new
 * oracle cards, roughly 500KB once their text and index entries land) crosses it
 * in one nightly import.
 */
export function chunkHeadroom(
	storeBytes: number,
	cut: number = KV_CHUNK_BYTES,
): { chunks: number; nextBoundary: number; headroomBytes: number; headroomPct: number } {
	const chunks = chunkCountFor(storeBytes, cut);
	// A store sitting exactly on a boundary has a full chunk of room, not zero:
	// `ceil` has already given it the chunk it fills.
	const nextBoundary = Math.max(chunks, 1) * cut;
	const headroomBytes = nextBoundary - storeBytes;
	// Relative to the STORE, not to a chunk: the question this answers is "how much
	// more store can we afford", and growth arrives as cards, not as a fraction of
	// the cut. 143,640 bytes on a 76.6MB store reads as 0.19%, which is the shape of
	// the problem; the same bytes over the 38.4MB cut would read as a roomier 0.37%.
	return {
		chunks,
		nextBoundary,
		headroomBytes,
		headroomPct: storeBytes > 0 ? (100 * headroomBytes) / storeBytes : 0,
	};
}

/**
 * Headroom below which a publish says so.
 *
 * ~4 set releases at the ~500KB apiece the 2026-08-12 corpus measurement implies,
 * or ~100 days of ordinary drift — enough notice to land a reduction before the
 * boundary arrives rather than reading about it afterwards in a latency chart.
 */
export const CHUNK_HEADROOM_WARN_BYTES = 2_000_000;

/**
 * The line a publish logs about its chunk count, or `null` when there is nothing
 * to say. Separated from the publisher so the wording is testable without a
 * Durable Object, and so the thresholds live beside the constants they compare.
 */
export function chunkHeadroomWarning(storeBytes: number, cut: number = KV_CHUNK_BYTES): string | null {
	const { chunks, headroomBytes, headroomPct } = chunkHeadroom(storeBytes, cut);
	if (headroomBytes >= CHUNK_HEADROOM_WARN_BYTES) return null;
	return (
		`Store chunking: ${storeBytes} bytes is ${chunks} chunk(s) at a ${cut}-byte cut, with only ` +
		`${headroomBytes} bytes (${headroomPct.toFixed(2)}%) before it becomes ${chunks + 1}. ` +
		`Crossing is SILENT — every cold load would just start paying another KV read.`
	);
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
 *
 * What comes back is ALWAYS the partitioned shape. An unpartitioned manifest
 * found at the key is a store that predates the partitioned format, and it is
 * reported as a loud, specific error rather than served: there is no
 * unpartitioned reader left to hand it to, and quietly returning it would push
 * the failure into whichever caller forgot to check. The next import replaces
 * it — see unpartitionedManifestMessage.
 */
export async function readManifest(env: Env): Promise<StoreManifest | null> {
	let manifest: StoreManifest | null;
	try {
		// cacheTtl is deliberately short: the manifest is the ONE mutable key,
		// and a nightly publish should reach isolates within minutes, not hours.
		const json = await env.STORE_KV.get(MANIFEST_KEY, { type: "text", cacheTtl: 60 });
		manifest = json ? (JSON.parse(json) as StoreManifest) : null;
	} catch (err) {
		throw new EngineUnavailableError(`Cannot read the store manifest from KV: ${err}`);
	}
	if (manifest && !isPartitionedManifest(manifest)) {
		throw new EngineUnavailableError(unpartitionedManifestMessage(manifest.store_key));
	}
	return manifest;
}

/**
 * Stream ONE archive's chunks out of KV in order — one partition's, which is
 * every archive there is (archiveOfManifest picks the source).
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
 *
 * `onStoredChunk`, when given, sees each KV value AS STORED (the gzip member,
 * before decompression), in sequence. It exists for the compressed archive
 * cache: a partitioned load tees the COMPRESSED bytes into local storage (see
 * store-cache.ts and plan reconciliation 2 — N decompressed copies do not fit
 * the 5GB DO pool), and this hook is the one place those bytes exist whole.
 * Callback faults must be the caller's to swallow — a cache is never a reason
 * to fail a load — so the loader wraps its sink, not this stream.
 *
 * Chunks still arrive STRICTLY IN SEQUENCE, one awaited get each; partitions
 * load in parallel only because each partition is its own Durable Object
 * running its own copy of this stream.
 */
export function kvSourceStream(
	env: Env,
	source: ArchiveSource,
	onStoredChunk?: (seq: number, bytes: Uint8Array) => void,
): ReadableStream<Uint8Array> {
	return kvArchiveStream(env, source.storeKey, source.storeBytes, source.chunkCount, source.gzipBytes, onStoredChunk);
}

/**
 * One stored chunk, exactly as KV holds it (compressed when the store was
 * published compressed). The prepare-side prefetch uses this to fill the local
 * COMPRESSED cache without paying a decompression it would throw away.
 * Immutable key, so the week-long cacheTtl mirrors the loader's.
 */
export async function fetchStoredChunk(env: Env, storeKey: string, seq: number): Promise<Uint8Array> {
	const body = await env.STORE_KV.get(chunkKey(storeKey, seq), { type: "arrayBuffer", cacheTtl: 604_800 });
	if (!body) {
		throw new EngineUnavailableError(`Store ${storeKey} is missing chunk ${seq} in KV`);
	}
	return new Uint8Array(body);
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
	onStoredChunk?: (seq: number, bytes: Uint8Array) => void,
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
				// The stored-bytes tee (compressed archive cache) — before any
				// decompression, while the whole stored value is in hand.
				onStoredChunk?.(seq, bytes);
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
