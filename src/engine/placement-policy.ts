// g1: which location hints Cloudflare can host right now, and where the ones it cannot are routed
// instead. PURE — the nightly coordinator feeds it probe colos (placement-probe.ts) and writes its
// answer into the manifest (StoreManifest.placement); isolates apply that answer with
// effectiveRegion at no extra KV cost, and the publish fan-out retires what no request can reach.
//
// A hint is UNSERVED when the objects created with it land off its own continent: Cloudflare's
// data-location docs say sam, afr and me "spawn in a nearby location which does support Durable
// Objects", and DeckGen's engine-sam-* objects all report colo=EWR (2026-09-24). Such a region is
// not dropped or merged — it is ALIASED to the served hint whose objects already share its spawn
// pool, so its users reach that hint's warm objects instead of a duplicate, mostly cold copy in the
// same colos. It keeps its name, it keeps being probed nightly, and when its probes land on its
// own continent on two consecutive runs the alias is removed and its GENERATION bumped, so its
// users create FRESH objects at the edge (`engine-sam-g1-p*`), placed where Cloudflare can now put
// them — never the old ones, which sit wherever they were put while the hint was unserved.
//
// WHY POOL OVERLAP AND NOT hintForColo(probeColo): me's pool is FRA 25% MXP 22% WAW 17% ARN 10%
// OTP 9% PRG 9% VIE 8% (where.durableobjects.live, 2026-09-25). By longitude FRA/MXP/PRG are weur
// and the rest eeur, so a per-probe mapping sends me to weur on ~56% of nights and to eeur on the
// rest — a flapping alias. The same pool is eeur's own, and it is disjoint from weur's (AMS LHR CDG
// MAD MRS LIS), so "which served hint's probes land in the same colos" is decisive. Likewise sam's
// pool is enam's (EWR ATL IAD MIA ORD), afr's is weur's, and oc landing at SIN/HKG is apac-se.

import { COLOS } from "./colos.gen";
import { REGIONS } from "./region";

export type Hint = DurableObjectLocationHint;

export interface PlacementAlias {
	/** The served hint whose objects this hint's users are sent to. */
	to: Hint;
	/** built_at of the first manifest that carried this alias ("seed" for the shipped default). */
	since: string;
}

/** `StoreManifest.placement`. Every field optional so an absent one is the zero state. */
export interface PlacementBlock {
	v: 1;
	/** Object-name generation per hint (`engine-<hint>-g<k>-…`); 0 is omitted. */
	gens?: Partial<Record<Hint, number>>;
	/** Hints Cloudflare cannot host yet, and where their traffic goes instead. */
	alias?: Partial<Record<Hint, PlacementAlias>>;
	/**
	 * Probe colos per hint for the last two runs that probed it, newest first. The hysteresis memory
	 * rides the manifest rather than the coordinator's SQLite because a run start clears the meta
	 * table and a watchdog failover starts a coordinator with an empty database.
	 */
	obs?: Partial<Record<Hint, string[][]>>;
	/**
	 * built_at of the first run whose probes passed the FIRST-RUN GATE. Until one has, a night on
	 * which any served hint's probe lands off its continent changes nothing: nothing in-house has
	 * yet shown that an object created by a hint from inside a Durable Object (the coordinator)
	 * lands where one created at the edge does (report 28).
	 */
	checked?: string;
}

/**
 * What applies before any probe run has written a block: the docs' own statement that sam, afr and
 * me spawn elsewhere, with the targets whose spawn pools match (where.durableobjects.live, and the
 * measured colo=EWR of every DeckGen engine-sam-* object). Probes take over from here.
 */
export const UNSERVED_SEED: PlacementBlock = {
	v: 1,
	alias: {
		sam: { to: "enam", since: "seed" },
		afr: { to: "weur", since: "seed" },
		me: { to: "eeur", since: "seed" },
	},
};

/** The continent each hint promises, in the colo table's region codes. */
export function continentOfHint(hint: Hint): string {
	return REGIONS[hint].continent;
}

/** A colo's continent from the generated table, or undefined for a colo it does not know. */
export function continentOfColo(colo: string): string | undefined {
	return COLOS[colo]?.[3];
}

function blockOf(placement: PlacementBlock | undefined): PlacementBlock {
	return placement?.v === 1 ? placement : UNSERVED_SEED;
}

function isHint(value: unknown): value is Hint {
	return typeof value === "string" && Object.hasOwn(REGIONS, value);
}

/**
 * The region whose objects serve a request that maps to `hint`. One hop only, and never onto a hint
 * that is itself aliased: a malformed block degrades to "no alias" — today's behaviour, a separate
 * region — never to a loop and never to a region that does not exist.
 */
export function effectiveRegion(hint: Hint, placement: PlacementBlock | undefined): Hint {
	const alias = blockOf(placement).alias ?? {};
	const to = alias[hint]?.to;
	if (!isHint(to) || to === hint || alias[to]) return hint;
	return to;
}

/** The regions requests can reach under `placement` — every hint after its alias, once each (x1's pool cap counts these). */
export function routableRegions(placement: PlacementBlock | undefined): Hint[] {
	return [...new Set((Object.keys(REGIONS) as Hint[]).map((h) => effectiveRegion(h, placement)))];
}

/**
 * Where a slow engine call is HEDGED (remote-engine.ts ENGINE_HEDGE_MS): the neighbouring regions to
 * try, nearest first, continent before ocean. Every region holds the same store, so partition k of
 * any of them answers a call to partition k identically; this only decides which one is closest.
 * The second choice is what a neighbour that is not served (aliased) falls back to — a hedge that
 * crosses an ocean still answers in ~100ms of extra round trip, against the 10–36s it replaces.
 */
const HEDGE_NEIGHBOURS: Record<Hint, readonly Hint[]> = {
	enam: ["wnam", "weur"],
	wnam: ["enam"],
	weur: ["eeur", "enam"],
	eeur: ["weur", "enam"],
	apac: ["apac-se", "apac-ne"],
	"apac-se": ["apac", "apac-ne"],
	"apac-ne": ["apac-se", "apac"],
	oc: ["apac-se", "apac"],
	// Aliased by the seed (onto enam, weur, eeur); these apply only once probes find them served.
	sam: ["enam", "wnam"],
	afr: ["weur", "eeur"],
	me: ["eeur", "weur"],
};

/**
 * The region a slow call to `region`'s objects is hedged to, or null for no hedge. Only ever a
 * SERVED region (one no alias redirects — its objects exist at the edge and the pool budget already
 * counts them, since routableRegions is what manifestPoolShardCap divides by), and never `region`
 * itself: a second call to the object that is not answering waits on the same teardown.
 */
export function hedgeRegionFor(region: Hint, placement: PlacementBlock | undefined): Hint | null {
	for (const h of HEDGE_NEIGHBOURS[region] ?? []) {
		if (h !== region && effectiveRegion(h, placement) === h) return h;
	}
	return null;
}

/** The generation a region's object names carry. */
export function generationOf(region: Hint, placement: PlacementBlock | undefined): number {
	const g = blockOf(placement).gens?.[region];
	return Number.isInteger(g) && (g as number) > 0 ? (g as number) : 0;
}

/**
 * Whether no request can reach an object any more: its hint is aliased to another region, or its
 * generation is not the hint's current one. The publish fan-out RETIRES these (storage released,
 * announcement deleted) instead of preparing them.
 */
export function unreachableEngine(
	parsed: { region: string; generation?: number },
	placement: PlacementBlock | undefined,
): boolean {
	if (!isHint(parsed.region)) return false;
	if (effectiveRegion(parsed.region, placement) !== parsed.region) return true;
	return (parsed.generation ?? 0) !== generationOf(parsed.region, placement);
}

/**
 * Why the publish fan-out should RETIRE an announced object instead of notifying it, or null to
 * notify it.
 *
 * `unreachable`: see unreachableEngine. `unpartitioned`: a name with no `-p<k>` — the single-store
 * region objects (`engine-enam`, `engine-wnam`, …) from before the store was partitioned. No request
 * addresses one any more (every serving path names a partition), but their announcements outlived
 * them, so every nightly notified them, and each logged "REFUSING a pushed manifest this object
 * cannot serve" at ERROR — five a night on DeckGen, noise that looked like a failure. Retiring
 * releases their old store and deletes the announcement, so it happens once.
 *
 * `beyond`: a partition object whose index the published build no longer has — N shrank. Since
 * x28 N is re-chosen every build from the corpus's own layout (src/import-sizing.ts), and a corpus
 * whose largest partition sits at the sizing ceiling can step 11 -> 12 one night and back the next
 * (draft bytes move with prices). No route addresses p11 under an 11-partition manifest, and
 * preparing it would ask it to load a partition the manifest holds no record for
 * (archiveOfManifest refuses) — so it is released instead, and re-created by its first request if
 * N grows back.
 */
export function notifyRetireReason(
	parsed: { region: string; generation?: number; partition?: number },
	manifest: { placement?: PlacementBlock; partition_count?: number } | null | undefined,
): "unreachable" | "unpartitioned" | "beyond" | null {
	if (unreachableEngine(parsed, manifest?.placement)) return "unreachable";
	// Only against a partitioned manifest: were the published store ever unpartitioned, these would
	// be the objects that serve it, not leftovers.
	if (manifest?.partition_count !== undefined && parsed.partition === undefined) return "unpartitioned";
	if (
		manifest?.partition_count !== undefined &&
		parsed.partition !== undefined &&
		parsed.partition >= manifest.partition_count
	)
		return "beyond";
	return null;
}

type Verdict = "on" | "off" | "unknown";

function verdict(hint: Hint, colos: readonly string[] | undefined, continentOf: (colo: string) => string | undefined) {
	const known = (colos ?? []).map(continentOf).filter((c): c is string => c !== undefined);
	if (known.length === 0) return "unknown" as Verdict;
	if (known.every((c) => c === continentOfHint(hint))) return "on" as Verdict;
	if (known.every((c) => c !== continentOfHint(hint))) return "off" as Verdict;
	return "unknown" as Verdict;
}

function majority(values: readonly string[]): string | undefined {
	const counts = new Map<string, number>();
	for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
	let best: string | undefined;
	for (const [v, n] of counts) if (best === undefined || n > (counts.get(best) ?? 0)) best = v;
	return best;
}

export interface PlacementDecision {
	/** The block to publish. Undefined only when there was none and the night changed nothing. */
	placement: PlacementBlock | undefined;
	/** One line per change or refusal, for the run log. Empty on a quiet night. */
	changes: string[];
	/** True when the first-run gate (or an empty night) held everything as it was. */
	held: boolean;
}

/**
 * Tonight's placement block from the previous one and tonight's probes.
 *
 * - FIRST-RUN GATE: until a run has passed it (`checked`), a night on which any SERVED hint's probe
 *   lands off its own continent changes nothing and records nothing — the probe mechanism itself
 *   is what would be wrong.
 * - A hint with no answered probe tonight keeps its state and its history untouched.
 * - Alias a hint after two consecutive runs where every probe lands off its continent; remove the
 *   alias after two where every probe lands on it, bumping its generation at the same time. A
 *   mixed night keeps the current state.
 * - `mayBump` is the pool guard: when a fresh generation would not fit, the alias stays and the
 *   flip-back is retried next night — the hint keeps being served from the aliased region, never
 *   dropped.
 * - The target of an alias is the served hint on the continent the probes land on whose probe
 *   colos overlap them most (Jaccard); the current target is kept unless another strictly beats
 *   it, and a night with no overlap at all keeps it (or falls back to the seed's target).
 */
export function nextPlacement(input: {
	previous: PlacementBlock | undefined;
	/** Tonight's probe colos per hint (every hint probed; an empty list is a hint none answered for). */
	probes: Partial<Record<Hint, readonly string[]>>;
	continentOf: (colo: string) => string | undefined;
	builtAt: string;
	hints: readonly Hint[];
	mayBump: boolean;
}): PlacementDecision {
	const prev = blockOf(input.previous);
	const changes: string[] = [];
	const known = (h: Hint) => (input.probes[h] ?? []).filter((c) => input.continentOf(c) !== undefined);
	const fresh = (h: Hint) => known(h).length > 0;
	if (!input.hints.some(fresh)) {
		return { placement: input.previous, changes: ["no probe answered tonight; placement unchanged"], held: true };
	}

	let checked = prev.checked;
	if (!checked) {
		const prevAlias = prev.alias ?? {};
		const strays = input.hints.filter(
			(h) => !prevAlias[h] && fresh(h) && known(h).some((c) => input.continentOf(c) !== continentOfHint(h)),
		);
		if (strays.length > 0) {
			const detail = strays.map((h) => `${h} at ${known(h).join(",")}`).join("; ");
			return {
				placement: input.previous,
				changes: [
					`first-run gate: served hint(s) probed off their continent (${detail}) — probes created by the ` +
						"coordinator are not yet shown to land like edge-created objects; no placement change tonight",
				],
				held: true,
			};
		}
		checked = input.builtAt;
		changes.push("first-run gate passed: every served hint's probes landed on its own continent");
	}

	const obs: Partial<Record<Hint, string[][]>> = {};
	for (const h of input.hints) {
		const last = prev.obs?.[h]?.[0];
		if (!fresh(h)) {
			if (prev.obs?.[h]) obs[h] = prev.obs[h];
			continue;
		}
		const tonight = [...(input.probes[h] ?? [])];
		obs[h] = last ? [tonight, last] : [tonight];
	}
	const alias: Partial<Record<Hint, PlacementAlias>> = { ...(prev.alias ?? {}) };
	const gens: Partial<Record<Hint, number>> = { ...(prev.gens ?? {}) };
	const nights = (h: Hint) => (obs[h] ?? []).map((colos) => verdict(h, colos, input.continentOf));
	const twice = (h: Hint, v: Verdict) => {
		const n = nights(h);
		return fresh(h) && n.length === 2 && n[0] === v && n[1] === v;
	};

	// 1. Served again: drop the alias, bump the generation (fresh edge-created objects).
	for (const h of input.hints) {
		if (!alias[h] || !twice(h, "on")) continue;
		if (!input.mayBump) {
			changes.push(
				`${h}: probes on its continent twice, but a fresh generation would not fit the pool — still ${alias[h]?.to}`,
			);
			continue;
		}
		delete alias[h];
		gens[h] = (gens[h] ?? 0) + 1;
		changes.push(`${h}: served again — alias removed, generation ${gens[h]} (engine-${h}-g${gens[h]}-*)`);
	}
	// 2. Newly unserved: mark for a target.
	for (const h of input.hints) if (!alias[h] && twice(h, "off")) alias[h] = { to: h, since: input.builtAt };

	// 3. Targets.
	const served = input.hints.filter((h) => !alias[h] && nights(h)[0] !== "off");
	const coloSet = (h: Hint) => new Set((obs[h] ?? []).flat());
	for (const h of input.hints) {
		const current = alias[h];
		if (!current) continue;
		const placeholder = current.to === h;
		const valid = !placeholder && served.includes(current.to);
		// Re-target only on fresh evidence that the hint is still unserved, or when the target
		// itself stopped being a place to send anyone.
		if (valid && (!fresh(h) || nights(h)[0] !== "off")) continue;
		const own = [...coloSet(h)];
		const landed = majority(own.map(input.continentOf).filter((c): c is string => c !== undefined));
		const candidates = served.filter((c) => landed === undefined || continentOfHint(c) === landed);
		const score = (c: Hint) => {
			const theirs = coloSet(c);
			const shared = own.filter((colo) => theirs.has(colo)).length;
			return shared / (new Set([...own, ...theirs]).size || 1);
		};
		let best: Hint | undefined = valid && candidates.includes(current.to) ? current.to : undefined;
		for (const c of candidates) if (score(c) > 0 && (best === undefined || score(c) > score(best))) best = c;
		if (best === undefined || score(best) === 0) {
			// No served hint shares a single probe colo tonight: keep a working target, else the seed's.
			const seed = UNSERVED_SEED.alias?.[h]?.to;
			best = valid ? current.to : seed && served.includes(seed) ? seed : undefined;
		}
		if (best === undefined) {
			delete alias[h];
			changes.push(`${h}: not served yet, but no served hint shares its spawn pool — left a separate region`);
		} else if (best !== current.to) {
			alias[h] = { to: best, since: placeholder ? input.builtAt : current.since };
			changes.push(`${h}: routed to ${best} (probe colos ${own.join(",") || "none"})`);
		}
	}

	const placement: PlacementBlock = { v: 1, obs, checked };
	if (Object.keys(alias).length) placement.alias = alias;
	const nonzero = Object.entries(gens).filter(([, g]) => (g ?? 0) > 0);
	if (nonzero.length) placement.gens = Object.fromEntries(nonzero) as Partial<Record<Hint, number>>;
	return { placement, changes, held: false };
}
