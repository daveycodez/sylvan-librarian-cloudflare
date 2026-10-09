// Whether the one reply a ROUTED name got is the whole store's answer (backlog n6). Its own module
// because both ends of the partition RPC read it: the router (partitioned-engine.ts), to stop at the
// routed partition's reply, and the partition object (search-engine-do.ts, x47), to see which routed
// names of a collection batch its reply does not settle and say where they live instead.

import type { NameHint } from "./routing-filter";
import type { NameRank } from "./types";

/**
 * Whether the ONE reply a routed name got — from the partition its hint names — is the whole
 * store's answer, so no other partition need be asked (backlog n6).
 *
 * The filter's word is exact only for a key it was built with; for any other it is an arbitrary
 * byte. So the reply has to PROVE the key was real before the word is trusted:
 *
 *   sole p     p answered (it holds the name, so it emitted the key, so the value is exact and no
 *              other partition holds it) — or it missed, but holds the name without the set
 *              (`present`): the same proof, and every other partition misses too.
 *   served s   s answered (it holds the name, so the value is exact: s is its one served holder,
 *   rival t    and every other partition holds it only as an extra — on tier t at most, 0 when
 *              only as an art series, which ranks below everything), and s's `[tier, name, served,
 *              …]` beats every one of theirs whatever their names and scores: a HIGHER tier than
 *              t, or the whole-name tier served under the NEEDLE'S OWN NAME (no whole-name rival
 *              sorts before it: a double-faced token's face that would is spelled served by the
 *              builders, so the filter holds no single served partition for it; see
 *              `name_routing_keys_of` in engine/builder/src/transform.rs). `delver of secrets` (a
 *              face of the served card, its art-series faces elsewhere, t = 0) settles; `chaos`
 *              (Order // Chaos's face, t = 3 from the fj25 front card Chaos) and `day` (Night //
 *              Day's face, t = 3 from the Day // Night token) do not, and the merge answers the
 *              extra — `night`, whose token name comes first, has no served route at all. A served
 *              double-faced token answering under its own joined name (Undercity // The Initiative
 *              for `undercity`) does not settle either: an extra named the needle would sort
 *              before it.
 *   served s   a filter built before the builders spelled tiers (no `rival`): s answered SERVED —
 *              the rule before x26, when served led the rank. Until the next build publishes a
 *              tiered filter it answers exactly as it did, a whole-name extra in another
 *              partition included (`chaos`); a reply it does not settle is merged tier-first.
 *
 * Anything else — a miss from a served route, a reply another partition's extras can beat, an
 * absent name under a garbage hint — settles nothing, and the caller asks the rest and merges
 * every reply.
 */
export function nameReplySettles(hint: NameHint, rank: NameRank | null, present: boolean): boolean {
	if ("sole" in hint) return rank !== null || present;
	if (rank === null) return false;
	const tier = Number(rank[0] ?? 0);
	const served = Number(rank[2] ?? 0);
	if (hint.rival === undefined) return served === 1;
	if (tier > hint.rival) return true;
	// On the whole-name tier every rival is named the needle or sorts after it, so the served card
	// named the needle beats them all — and only that card: `needle` is absent only from a caller
	// that routes no key, which settles nothing here.
	return (
		tier === hint.rival &&
		tier === NAME_TIER_WHOLE &&
		served === 1 &&
		hint.needle !== undefined &&
		rank[1] === hint.needle
	);
}

/** The engine's whole-name tier (core_api's `TIER_WHOLE_NAME`): on it a candidate's name is the
 * needle, or a double-faced token's own name, so of two replies named the needle the served one wins. */
const NAME_TIER_WHOLE = 3;
