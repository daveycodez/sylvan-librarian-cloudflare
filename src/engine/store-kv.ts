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

import type { Env, StoreManifest } from "./types";
import { EngineUnavailableError } from "./types";

/**
 * Bytes per KV chunk: just under KV's 25 MiB (26,214,400 byte) value cap.
 *
 * Bigger is better until that cap — every chunk is one metered read on load
 * and one metered write on publish, and there is no dedup to preserve, so a
 * ~75MB store wants as few chunks as it can have (three, here).
 *
 * The binding constraint is NOT the cap, though: it is the 128MB isolate the
 * nightly publisher assembles chunks in. That only leaves room for a value
 * this large because the build now releases the wasm group (~75MB of linear
 * memory that never shrinks) before publish runs.
 *
 * RAISED from 25,000,000 with generation 4, and the reason is headroom rather
 * than throughput. Chunk count is `ceil(store_bytes / this)`, so the number
 * that matters is the 3-chunk ceiling it implies. Dropping the alias keys puts
 * the store at 74.8MB, which cleared the old 75,000,000 ceiling by 184,272
 * bytes — and two same-format builds a day apart differ by ~19KB, so that
 * margin was about ten days of ordinary Scryfall drift before the 4th chunk
 * came back. At 26,000,000 the ceiling is 78,000,000.
 *
 * MARGIN TODAY IS 1,363,536 BYTES. The live generation-10 store is 76,636,464
 * bytes (production logs it loading "from 3 pieces"), so at ~19KB/day of drift
 * that is roughly ten weeks, not the 3.2MB this comment used to claim against
 * the smaller generation-4 store.
 *
 * This is a RAW cut, and the value KV holds is its gzip member — so the 25 MiB
 * cap is no longer what this constant is pressed against. What it still governs
 * is the 128MB isolate: one chunk is materialised whole during load, on top of
 * wasm linear memory that already holds the store, and that sum is the real
 * ceiling. Compressed, the materialised chunk is ~13MB rather than 26MB, which
 * took peak from ~102.6MB to ~89.6MB.
 *
 * That is also why this constant should not simply be RAISED now that the stored
 * value is smaller. A bigger raw cut means a bigger COMPRESSED chunk resident
 * during load: cutting to fill 26MB compressed needs ~55-60MB raw, whose member
 * is ~24MB, and peak goes back to ~100MB. The chunk-count headroom that would
 * buy is real but costs the memory this change exists for.
 */
export const KV_CHUNK_BYTES = 26_000_000;

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
 */
export const STORE_CONTENT_GENERATION = 12;

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
export function chunkCountFor(storeBytes: number): number {
	return Math.ceil(storeBytes / KV_CHUNK_BYTES);
}

/** Split a whole store buffer onto the KV grid. */
export function splitStore(store: Uint8Array): Uint8Array[] {
	const chunks: Uint8Array[] = [];
	for (let at = 0; at < store.length; at += KV_CHUNK_BYTES) {
		chunks.push(store.subarray(at, Math.min(at + KV_CHUNK_BYTES, store.length)));
	}
	return chunks;
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
