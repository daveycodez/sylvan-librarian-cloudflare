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
//   - a full publish is 4 writes against a 1,000/day free allowance — no
//     incremental publish, no dedup, no resume bookkeeping
//   - a full load is 4 reads against 100,000/day
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
 * came back. At 26,000,000 the ceiling is 78,000,000 and the margin is 3.2MB.
 *
 * Do not read the remaining 214,400 bytes of cap as free: a chunk is
 * materialised whole as an ArrayBuffer during load, on top of wasm linear
 * memory that already holds the store, and that sum is what the 128MB limit
 * actually governs.
 */
export const KV_CHUNK_BYTES = 26_000_000;

/** The manifest key: the one mutable pointer in the namespace. */
export const MANIFEST_KEY = "store:manifest";

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
 *       THIS IS THE STORE THAT BUYS THE 4TH CHUNK. 76,571,408 -> 87,989,816
 *       bytes, measured, against the 78,000,000-byte three-chunk ceiling. A
 *       4th chunk is one extra sequential KV round trip on cold load; it is
 *       not a meter tick and not a failure, and it was taken deliberately
 *       rather than arrived at by drift. Two lossless compactions already ran
 *       first, worth 10,128,264 bytes together, and without them the store is
 *       98,118,080 and the in-Worker nightly import no longer fits its 112 MiB
 *       cap at all:
 *         - the eleven sparse marketplace/price ids are niched with
 *           `NicheInto<Zero>` (CompatFields 128 -> 84 bytes). rkyv 0.8 does
 *           NOT niche an `Option<NonZeroU32>` on its own — measured at 8 bytes
 *           without the attribute — so upstream #912's own "8 becomes 4"
 *           reasoning does not hold on this rkyv version.
 *         - the external-id index drops from `(u8, u64, u32)` triples, which
 *           rkyv pads to 24 bytes each, to `(u32, u32)` pairs plus a
 *           five-entry namespace offset table: 8 bytes an entry over 347,625
 *           entries.
 */
export const STORE_CONTENT_GENERATION = 10;

/** Chunk key for a store. Keyed by store_key, so publishes never collide. */
export function chunkKey(storeKey: string, seq: number): string {
	return `store:${storeKey}:${seq}`;
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
	const storeKey = manifest.store_key;
	const expected = manifest.store_bytes;
	const total = manifest.chunk_count ?? chunkCountFor(expected);
	let seq = 0;
	let seen = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (seq >= total) {
				if (seen !== expected) {
					controller.error(new EngineUnavailableError(`Store ${storeKey} incomplete in KV: ${seen}/${expected} bytes`));
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
			seen += bytes.byteLength;
			seq += 1;
			controller.enqueue(bytes);
		},
	});
}
