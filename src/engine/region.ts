// Request → Durable Object location hint, shared by the engine and the rate
// limiter: one instance per hint, placed near its callers.
//
// THIS IS NOW THE ENGINE'S ROUTING KEY, not just a placement hint. `engine-<hint>`
// is the object that serves the request, so this function decides which store a
// user's search runs against — where it used to decide only where a cold colo
// relayed to. Two consequences worth keeping in mind: it must be deterministic
// (a flapping answer would split one region's traffic across two objects, each
// holding its own ~76.6MB copy), and it must never return anything but a valid
// hint (the caller builds a DO name from it unconditionally).
//
// NA and EU split east/west by the request's longitude, so placement stays near
// the traffic on landmasses too wide for one object to serve well. Thresholds sit
// in the sparse middle of each (-100° ≈ the Great Plains, 15° ≈ the Berlin/Vienna
// meridian); requests without a longitude take the map's continent default.
//
// That longitude split is also why the shard controller keys its state by region:
// one isolate serves users on both sides of a meridian, so it addresses two
// regions and must not pool their load signals.

import { COLOS } from "./colos.gen";

export const CONTINENT_TO_HINT: Record<string, DurableObjectLocationHint> = {
	AF: "afr",
	AN: "oc",
	AS: "apac",
	EU: "weur",
	NA: "wnam",
	OC: "oc",
	SA: "sam",
};

/** What a region is, for the reader of the table below. */
interface RegionSpec {
	/** Where Cloudflare places a Durable Object created with this hint. */
	readonly where: string;
}

/**
 * EVERY location hint Cloudflare offers, one entry each — and the type makes that a rule, not a
 * habit: `satisfies Record<DurableObjectLocationHint, …>` fails typecheck the day the runtime
 * types gain a hint this table does not name. That is how apac-ne and apac-se (added June 2026)
 * went unnoticed until 09-25: the list was a plain array, so nothing forced it to be complete.
 * The weekly platform-drift workflow regenerates the types from the newest wrangler to trip it.
 * (backlog g2)
 */
export const REGIONS = {
	wnam: { where: "Western North America" },
	enam: { where: "Eastern North America" },
	sam: { where: "South America" },
	weur: { where: "Western Europe" },
	eeur: { where: "Eastern Europe" },
	apac: { where: "Asia-Pacific" },
	"apac-ne": { where: "Northeast Asia (Japan, Korea)" },
	"apac-se": { where: "Southeast Asia (Singapore, Indonesia)" },
	oc: { where: "Oceania" },
	afr: { where: "Africa" },
	me: { where: "Middle East" },
} as const satisfies Record<DurableObjectLocationHint, RegionSpec>;

/**
 * Every region an engine DO can exist in — derived from REGIONS, so it is complete by
 * construction.
 *
 * This list is the whole reason push-notify is possible at all. Colo-named
 * objects could not be notified: `engine-LAX` exists only if LAX saw traffic,
 * there is no registry, and Cloudflare has ~330 locations, so a publisher had no
 * way to enumerate its readers and they had to poll instead. A handful of names
 * can just be walked.
 */
export const REGION_HINTS = Object.keys(REGIONS) as readonly DurableObjectLocationHint[];

/**
 * The region for a Cloudflare location (colo), by where that colo IS (backlog p4). North America
 * and Europe split at the same meridians as the client rule below; the rest go by Cloudflare's
 * own region for the colo. Null for a colo the generated table does not know.
 */
export function hintForColo(colo: string): DurableObjectLocationHint | null {
	const entry = COLOS[colo];
	if (!entry) return null;
	const [, lon, , region] = entry;
	switch (region) {
		case "NA":
			return lon >= -100 ? "enam" : "wnam";
		case "EU":
			return lon >= 15 ? "eeur" : "weur";
		case "SA":
			return "sam";
		case "AF":
			return "afr";
		case "ME":
			return "me";
		case "OC":
			return "oc";
		case "AP":
			return "apac";
	}
}

/**
 * The region that serves this request — chosen by the COLO the isolate runs in, since every engine
 * call starts from the isolate: a request that enters Cloudflare at SIN runs its engine calls from
 * SIN whatever the client's country, and routing it by the client (a US reader → wnam) paid
 * 250 ms+ per engine call — ~480 requests a day, measured 09-23..24 (backlog p4). The rate limiter
 * follows too; its objects store nothing, so they are simply placed afresh.
 *
 * Deterministic per colo, so one colo never splits a region's traffic. A colo the table does not
 * know (added since the last regeneration) falls back to the client rule below.
 */
export function regionHint(request: Request): DurableObjectLocationHint {
	const cf = request.cf as { colo?: string; continent?: string; longitude?: string } | undefined;
	const byColo = cf?.colo ? hintForColo(cf.colo) : null;
	if (byColo) return byColo;
	const continent = cf?.continent ?? "NA";
	const lon = Number.parseFloat(cf?.longitude ?? "");
	if (continent === "NA" && Number.isFinite(lon)) return lon >= -100 ? "enam" : "wnam";
	if (continent === "EU" && Number.isFinite(lon)) return lon >= 15 ? "eeur" : "weur";
	return CONTINENT_TO_HINT[continent] ?? "wnam";
}
