// How many partitions the store is cut into — sized on its LARGEST partition, projected from the
// staged drafts' own layout under each candidate N (backlog x28).
//
// The line-for-line twin of engine/builder/src/sizing.rs (the deploy path's native builder). Both
// builders see the same (partition hash, draft JSON length) for every staged draft and run the
// same integer arithmetic over them, so they choose the same N: tests/engine/
// partition-sizing-vectors.json pins that for both languages, and the import harness checks it end
// to end (the native builder's `--partitions auto` against the nightly's manifest).
//
// ── WHY THE LARGEST PARTITION ────────────────────────────────────────────────
//
// The rule this replaces sized N on the MEAN — `ceil(staged x 0.24 / 43MB)` — and trusted the 7%
// between that 43MB target and the 46MB KV chunk cut to absorb everything the mean does not see.
// What it does not see is the hash: fnv1a64 of the oracle id spreads CARDS evenly, but a card's
// printings (every language of every reprint) travel with it, so a partition that drew a few
// heavily reprinted cards is heavier than its share. On the 2026-09-26 real corpus the mean was
// 43.06MB and the largest partition 45.34MB, 1.4% under the cut; and because the mean rule steps N
// only when the MEAN crosses its target, every corpus just short of a step sits exactly there. How
// heavy the heaviest partition is depends on N itself — the same drafts' largest partition is
// 1.08x the mean at N=10, 1.13x at N=11 — so no fixed skew allowance is both safe and cheap. This
// projects every partition of each candidate N and takes the smallest N whose largest fits.
//
// ── THE PROJECTION ───────────────────────────────────────────────────────────
//
// A partition's archive is projected from the two things that build it: its CARDS (distinct oracle
// ids — each carries oracle-level text, names, the card-level indexes) and its framed DRAFT BYTES
// (every printing's own fields). Draft bytes alone mispredict by ±4%, because a heavily reprinted
// card's drafts repeat text the archive stores once; with the card count beside them the residual
// is under 1% (PARTITION_PROJECTION_ERROR_PCT). Both are computable before anything is built, from
// the staged (hash, length) pairs — the hash IS the oracle id's, so distinct hashes are cards.
//
// Integer arithmetic throughout, in units of 1/STORE_PER_DRAFT_BYTE_DEN of a byte: the two
// builders are different languages and must not disagree on a rounding.

import { KV_CHUNK_BYTES } from "./engine/store-kv";
import { MAX_PARTITION_COUNT, MIN_PARTITION_COUNT } from "./import-publish";

/**
 * Bytes of framing counted around each staged draft: the 8-byte partition hash the wasm import
 * emits in front of every draft's JSON. The native builder's spill counts the same 8 (its own
 * 4-byte length prefix is private framing and not counted).
 *
 * NOT `draft_batches.raw_len`'s framing, which is each draft's 4-byte length prefix within its
 * staged group: the rule this replaces summed raw_len (Σ 4 + JSON) on the nightly while the native
 * builder summed Σ 8 + JSON, so the "twin" projections differed by 4 bytes a draft (2.2MB of
 * drafts, ~0.5MB of projected store, on the 2026-09-26 corpus) and could fall on different sides
 * of a step.
 */
export const DRAFT_FRAME_BYTES = 8;

/**
 * The projection's coefficients: a partition's archive bytes are
 *
 *   STORE_BYTES_PER_PARTITION + STORE_BYTES_PER_CARD x cards + (NUM / DEN) x framed draft bytes
 *
 * FITTED 2026-09-26 by least squares over 181 real partitions — the 2026-08-16 all_cards corpus
 * (540,484 drafts, 38,626 cards) built natively at N = 8, 10, 11, 12, 16, 20, 24, 32 and 48,
 * format 2026092601 — weighted to the partitions that matter, the 41 between 30 and 60MB (the
 * sizes a partition near the ceiling has): residuals -0.77% .. +0.62%, rms 0.36%. Over all 181
 * (9-55MB) the fit holds to +0.6%; the small partitions of N=24-48 come in UNDER it by up to 6%,
 * the safe side. Draft bytes alone, the old rule's single ratio, miss by -4% .. +4% in the same
 * window: a heavily reprinted card's drafts repeat text the archive stores once.
 *
 * OUT OF SAMPLE, the 2026-09-26 dump (542,704 drafts, 38,690 cards): -0.17% .. +0.76% against the
 * ten partitions the mean rule built that morning, and -0.36% .. +0.78% against the eleven this
 * rule builds (largest 42,443,712 bytes built, 42,480,196 projected).
 *
 * The intercept is real: every partition carries its own copy of the corpus-wide tables (set
 * vocabulary, artist entities, tag slugs), ~1.1MB of archive whatever it holds — which is also why
 * the old single ratio drifted upward with N (0.239 at N=8, 0.247 at N=32).
 *
 * Re-fit after a FORMAT change that adds per-printing or per-card bytes: both builders log each
 * partition against its projection, and warn when one lands more than PARTITION_PROJECTION_ERROR_PCT
 * above it.
 */
export const STORE_BYTES_PER_PARTITION = 1_141_000;
export const STORE_BYTES_PER_CARD = 3_770;
export const STORE_PER_DRAFT_BYTE_NUM = 1_527;
export const STORE_PER_DRAFT_BYTE_DEN = 10_000;

/** The largest partition's required distance under the KV chunk cut, in percent of the cut. */
export const PARTITION_SAFETY_MARGIN_PCT = 5;

/**
 * The projection's error allowance, in percent: above the worst residual measured on the side that
 * matters — a partition landing ABOVE its projection — +0.62% in the fit, +0.78% out of sample.
 */
export const PARTITION_PROJECTION_ERROR_PCT = 1;

/**
 * The most a partition may PROJECT to: the 46MB chunk cut less the 5% margin (43.7MB), less the
 * projection's own error allowance on top (43,267,326) — so a partition that lands at the worst
 * residual allowed is still the full margin under the cut.
 */
export const PARTITION_CEILING_BYTES = Math.floor(
	(KV_CHUNK_BYTES * (100 - PARTITION_SAFETY_MARGIN_PCT)) / (100 + PARTITION_PROJECTION_ERROR_PCT),
);

/** The meta key the tags phase records each partition's projection under, for its build to answer. */
export const PARTITION_PROJECTION_META = "partition_projection";

/** One partition's projected archive bytes, from its card count and its framed draft bytes. */
export function projectPartitionBytes(cards: number, framedDraftBytes: number): number {
	return Math.floor(scaledProjection(cards, framedDraftBytes) / STORE_PER_DRAFT_BYTE_DEN);
}

/** The projection in 1/DEN-byte units — exact integers in a double far past any corpus (2^53). */
function scaledProjection(cards: number, framedDraftBytes: number): number {
	return (
		(STORE_BYTES_PER_PARTITION + STORE_BYTES_PER_CARD * cards) * STORE_PER_DRAFT_BYTE_DEN +
		STORE_PER_DRAFT_BYTE_NUM * framedDraftBytes
	);
}

/**
 * The line a partition's build logs when it lands further ABOVE its projection than the fit
 * allows — the coefficients need re-measuring — or null. Landing below is the safe side.
 */
export function projectionDriftWarning(partition: number, actual: number, projected: number): string | null {
	if (!(projected > 0) || actual * 100 <= projected * (100 + PARTITION_PROJECTION_ERROR_PCT)) return null;
	return (
		`Partition sizing: p${partition} built ${actual} bytes, ${(((actual - projected) / projected) * 100).toFixed(2)}% ` +
		`above its projection of ${projected} — more than the ${PARTITION_PROJECTION_ERROR_PCT}% the sizing fit allows. ` +
		"Re-measure the coefficients in src/import-sizing.ts and engine/builder/src/sizing.rs before a partition reaches the KV chunk cut."
	);
}

/**
 * Store bytes per framed draft byte over a WHOLE corpus (430.6MB of archives from 1,785MB of
 * framed drafts on 2026-09-26; 428.6MB from 1,778MB on the 2026-08-16 dump) — for the mean
 * projection below, never for choosing N where the drafts are at hand.
 */
export const MEAN_STORE_PER_FRAMED_DRAFT_BYTE = 0.2412;

/**
 * The largest partition over the mean, allowed for by the mean projection. Measured on the layout
 * the rule actually chooses: 1.08 on the 2026-09-26 corpus (N=11); 1.07 / 1.07 / 1.10 / 1.06 when
 * that corpus is grown 1.5x / 2x / 3x / 4x by copying every card under a fresh hash (N = 17 / 23 /
 * 34 / 43). A partition near the ceiling holds ~3,500 cards whatever N is, so the ratio does not
 * drift with the corpus; 1.12 is the worst of those with room.
 */
export const MEAN_PROJECTION_SKEW = 1.12;

/**
 * N estimated from a corpus's framed draft bytes alone, without its layout: enough partitions
 * that the MEAN, grown by MEAN_PROJECTION_SKEW, fits the ceiling. Two callers, neither of which has
 * the layout: the run-budget model projecting the corpus forward (tests/import/run-budget.test.ts),
 * and a nightly whose staging predates part_lens (one run, across the deploy that added it). It
 * lands at or above the layout's answer on the real corpus — 12 where the layout says 11 — which is
 * the direction a fallback should err.
 */
export function projectedPartitionCount(framedDraftBytes: number, ceiling: number = PARTITION_CEILING_BYTES): number {
	if (!Number.isFinite(framedDraftBytes) || framedDraftBytes < 0) {
		throw new Error(`cannot size partitions from ${framedDraftBytes} staged draft bytes`);
	}
	if (!Number.isFinite(ceiling) || ceiling <= 0) throw new Error(`cannot size partitions against ${ceiling} bytes`);
	const wanted = Math.ceil((framedDraftBytes * MEAN_STORE_PER_FRAMED_DRAFT_BYTE * MEAN_PROJECTION_SKEW) / ceiling);
	return Math.min(MAX_PARTITION_COUNT, Math.max(MIN_PARTITION_COUNT, wanted));
}

/** What `choosePartitionCount` decided, and the numbers it decided on. */
export interface SizingChoice {
	n: number;
	/** Projected archive bytes of each partition at `n`. */
	projected: number[];
	/** The largest of them, and where. */
	largest: number;
	largestAt: number;
	/** Distinct oracle ids (cards) and framed draft bytes in the whole corpus. */
	cards: number;
	framedBytes: number;
	drafts: number;
	/** The ceiling the largest was held to. */
	ceiling: number;
	/** No N in range brought the largest partition under the ceiling; `n` is MAX_PARTITION_COUNT. */
	clamped: boolean;
}

const TWO_32 = 4294967296;

/** `hash % n` for a u64 held as two u32 halves: (hi mod n)(2^32 mod n) + lo mod n stays tiny and exact. */
function modHalves(hi: number, lo: number, n: number): number {
	return ((hi % n) * (TWO_32 % n) + (lo % n)) % n;
}

/**
 * The corpus as the projection needs it: one entry per CARD (distinct oracle hash), with the framed
 * bytes of all its drafts. Every draft of a card lands in the card's partition, so per-partition
 * sums over cards are exactly the sums over drafts — and a candidate N costs one pass over ~39k
 * cards rather than ~540k drafts.
 *
 * Built in two passes over the drafts so the coordinator never holds more than one 8-byte hash per
 * draft at once (4.3MB today, 13MB at 3x, beside the tags phase's wasm): `distinct` the hashes
 * (sorted and deduped in place), then `add` every (hash, length) against them.
 */
export class CardBytes {
	private readonly hi: Uint32Array;
	private readonly lo: Uint32Array;
	private readonly bytes: Float64Array;
	private draftCount = 0;
	private byteCount = 0;

	/** From every draft's hash, in any order; `hashes` is sorted in place. */
	static distinct(hashes: BigUint64Array): CardBytes {
		hashes.sort();
		let m = 0;
		for (let i = 0; i < hashes.length; i++) {
			if (i === 0 || hashes[i] !== hashes[m - 1]) hashes[m++] = hashes[i] as bigint;
		}
		return new CardBytes(hashes.subarray(0, m));
	}

	private constructor(sortedDistinct: BigUint64Array) {
		const m = sortedDistinct.length;
		this.hi = new Uint32Array(m);
		this.lo = new Uint32Array(m);
		this.bytes = new Float64Array(m);
		for (let i = 0; i < m; i++) {
			const h = sortedDistinct[i] as bigint;
			this.hi[i] = Number(h >> 32n);
			this.lo[i] = Number(h & 0xffffffffn);
		}
	}

	/** Count one draft of `jsonLength` bytes whose oracle id hashes to `partHash` (one of `distinct`'s). */
	add(partHash: bigint, jsonLength: number): void {
		const hi = Number(partHash >> 32n);
		const lo = Number(partHash & 0xffffffffn);
		let a = 0;
		let b = this.hi.length - 1;
		while (a <= b) {
			const mid = (a + b) >>> 1;
			const mh = this.hi[mid] as number;
			const ml = this.lo[mid] as number;
			if (mh === hi && ml === lo) {
				const framed = DRAFT_FRAME_BYTES + jsonLength;
				(this.bytes[mid] as number) += framed;
				this.draftCount += 1;
				this.byteCount += framed;
				return;
			}
			if (mh < hi || (mh === hi && ml < lo)) a = mid + 1;
			else b = mid - 1;
		}
		throw new Error(`draft hash ${partHash} was not among the corpus's distinct hashes`);
	}

	get cards(): number {
		return this.hi.length;
	}

	get drafts(): number {
		return this.draftCount;
	}

	/** Σ (8 + draft JSON) over every draft added. */
	get framedBytes(): number {
		return this.byteCount;
	}

	/** Each partition's projection at `n`, in 1/DEN-byte units. */
	scaledAt(n: number): number[] {
		const bytes = new Array<number>(n).fill(0);
		const cards = new Array<number>(n).fill(0);
		for (let i = 0; i < this.hi.length; i++) {
			const k = modHalves(this.hi[i] as number, this.lo[i] as number, n);
			bytes[k] = (bytes[k] as number) + (this.bytes[i] as number);
			cards[k] = (cards[k] as number) + 1;
		}
		return bytes.map((b, k) => scaledProjection(cards[k] as number, b));
	}
}

/** Every partition's projected archive bytes when the corpus is cut into `n`. */
export function projectPartitions(corpus: CardBytes, n: number): number[] {
	return corpus.scaledAt(n).map((s) => Math.floor(s / STORE_PER_DRAFT_BYTE_DEN));
}

/**
 * The partition count for a corpus: the smallest N in [MIN, MAX] whose every partition projects to
 * at most `ceiling` bytes — MAX_PARTITION_COUNT, `clamped`, when none does.
 *
 * The search starts at the first N whose MEAN fits (the projection is linear in each partition's
 * counts, so a partition count whose mean overflows cannot have a largest that fits) and walks up.
 */
export function choosePartitionCountFor(corpus: CardBytes, ceiling: number = PARTITION_CEILING_BYTES): SizingChoice {
	if (!Number.isFinite(ceiling) || ceiling <= 0) throw new Error(`cannot size partitions against ${ceiling} bytes`);
	const scaledCeiling = ceiling * STORE_PER_DRAFT_BYTE_DEN;
	const project = (n: number): SizingChoice => {
		const scaled = corpus.scaledAt(n);
		// The FIRST largest, as the Rust twin takes it.
		let largestAt = 0;
		for (let k = 1; k < n; k++) if ((scaled[k] as number) > (scaled[largestAt] as number)) largestAt = k;
		const largestScaled = scaled[largestAt] as number;
		return {
			n,
			projected: scaled.map((v) => Math.floor(v / STORE_PER_DRAFT_BYTE_DEN)),
			largest: Math.floor(largestScaled / STORE_PER_DRAFT_BYTE_DEN),
			largestAt,
			cards: corpus.cards,
			framedBytes: corpus.framedBytes,
			drafts: corpus.drafts,
			ceiling,
			clamped: largestScaled > scaledCeiling,
		};
	};
	const total = scaledProjection(corpus.cards, corpus.framedBytes);
	const start = Math.min(MAX_PARTITION_COUNT, Math.max(MIN_PARTITION_COUNT, Math.ceil(total / scaledCeiling)));
	for (let n = start; n < MAX_PARTITION_COUNT; n++) {
		const choice = project(n);
		if (!choice.clamped) return choice;
	}
	return project(MAX_PARTITION_COUNT);
}

/**
 * `choosePartitionCountFor` over drafts in hand: `hashes[i]` is draft i's fnv1a64(oracle_id),
 * `lengths[i]` its JSON length (without framing). `hashes` is left as it was.
 */
export function choosePartitionCount(
	hashes: BigUint64Array,
	lengths: Uint32Array,
	ceiling: number = PARTITION_CEILING_BYTES,
): SizingChoice {
	if (hashes.length !== lengths.length) {
		throw new Error(`sizing input has ${hashes.length} hashes but ${lengths.length} lengths`);
	}
	const corpus = CardBytes.distinct(hashes.slice());
	for (let i = 0; i < hashes.length; i++) corpus.add(hashes[i] as bigint, lengths[i] as number);
	return choosePartitionCountFor(corpus, ceiling);
}
