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

export const CONTINENT_TO_HINT: Record<string, DurableObjectLocationHint> = {
	AF: "afr",
	AN: "oc",
	AS: "apac",
	EU: "weur",
	NA: "wnam",
	OC: "oc",
	SA: "sam",
};

export function regionHint(request: Request): DurableObjectLocationHint {
	const cf = request.cf as { continent?: string; longitude?: string } | undefined;
	const continent = cf?.continent ?? "NA";
	const lon = Number.parseFloat(cf?.longitude ?? "");
	if (continent === "NA" && Number.isFinite(lon)) return lon >= -100 ? "enam" : "wnam";
	if (continent === "EU" && Number.isFinite(lon)) return lon >= 15 ? "eeur" : "weur";
	return CONTINENT_TO_HINT[continent] ?? "wnam";
}
