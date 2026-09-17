// The nightly run's dump list and phase chain — ONE pipeline, no modes.
//
// This module was `import-mode.ts`, and it existed to hold the fork between a
// default_cards/single-archive pipeline and the partitioned one while an env
// var chose between them per run. That dual window is deleted: the
// partitioned multilingual store is the setup, so there is one dump list, one
// chain, and nothing to persist about which pipeline a run picked.
//
// Everything here is pure (kind in, phase out), so the chain is testable without
// a Durable Object — tests/import/phase-chain.test.ts pins it.

/**
 * Every dump a run reads — listed once at the top of the run (stage_files
 * holds each one's download URI) — in the order the chain meets them.
 *
 * all_cards is the transform corpus (every printing in every language) and
 * default_cards supplies the canonical id set. The tail order is its own
 * argument: oracle_cards near the end so a failure costs the representative
 * pin rather than the run, rulings last so a bad dump costs only the rulings
 * refresh.
 */
export const DUMP_KINDS = ["all_cards", "default_cards", "oracle_tags", "art_tags", "oracle_cards", "rulings"] as const;

export type DumpKind = (typeof DUMP_KINDS)[number];

/** The corpus the transform phase streams: every row of this dump becomes a draft. */
export const TRANSFORM_KIND: DumpKind = "all_cards";

/**
 * The dumps that are NEVER staged: the phase that reads each one streams it
 * straight from Scryfall with ranged requests, resuming a checkpointed gzip
 * decoder at the exact compressed offset it stopped at (canonical reads
 * default_cards, transform reads all_cards).
 *
 * Staging them was the single biggest thing the coordinator pushed through
 * Durable Object storage: ~392MB of fetched all_cards, ~400MB more of it
 * re-compressed into seekable members, ~80MB of default_cards — every byte
 * written and then deleted again, on the storage whose backlog left the
 * object billed for hours between alarms (import-budget.ts, PACE_START_BPS).
 */
export const STREAMED_KINDS: readonly DumpKind[] = ["all_cards", "default_cards"];

/** The dumps a run downloads into stage_blobs, in fetch order: the small ones. */
export const FETCHED_KINDS: readonly DumpKind[] = DUMP_KINDS.filter((kind) => !STREAMED_KINDS.includes(kind));

/** The phase the chain enters after listing. */
export function firstFetchPhase(): string {
	return `fetch:${FETCHED_KINDS[0]}`;
}

/** Where the chain goes when a dump finishes fetching: the next fetch, or the canonical phase after the last. */
export function phaseAfterFetch(kind: DumpKind): string {
	return phaseAfterStaged(kind);
}

/** Where the chain goes once a fetched dump is fully staged. */
export function phaseAfterStaged(kind: DumpKind): string {
	const next = FETCHED_KINDS[FETCHED_KINDS.indexOf(kind) + 1];
	return next ? `fetch:${next}` : "canonical";
}
