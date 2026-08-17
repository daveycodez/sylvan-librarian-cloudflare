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
 * The dumps a run fetches, IN FETCH ORDER — only what the pipeline consumes.
 *
 * all_cards is the transform corpus (every printing in every language) and
 * default_cards supplies the canonical id set. all_cards leads because it is the
 * largest download and the one a rotated dump restarts from zero, so a failure
 * there is cheapest discovered first. The tail order is its own argument:
 * oracle_cards near the end so a failure costs the representative pin rather
 * than the run, rulings last so a bad dump costs only the rulings refresh.
 */
export const DUMP_KINDS = ["all_cards", "default_cards", "oracle_tags", "art_tags", "oracle_cards", "rulings"] as const;

export type DumpKind = (typeof DUMP_KINDS)[number];

/** The corpus the transform phase streams: every row of this dump becomes a draft. */
export const TRANSFORM_KIND: DumpKind = "all_cards";

/**
 * Where the chain goes when a dump finishes fetching: the recode detour for
 * all_cards, the next fetch, or the canonical phase once the last dump is
 * staged.
 *
 * Only all_cards is recoded — its ~392MB single gzip stream is what makes every
 * later resume quadratic (see import-recode.ts); default_cards is small enough
 * to re-stream.
 */
export function phaseAfterFetch(kind: DumpKind): string {
	if (kind === "all_cards") return "recode:all_cards";
	return phaseAfterStaged(kind);
}

/** Where the chain goes once a dump is fully STAGED (fetched, and recoded when it is recoded). */
export function phaseAfterStaged(kind: DumpKind): string {
	const next = DUMP_KINDS[DUMP_KINDS.indexOf(kind) + 1];
	return next ? `fetch:${next}` : "canonical";
}
