// Request → Durable Object location hint, shared by the engine's relay
// fallback and the rate limiter: one regional instance per hint, created
// near its callers.
//
// NA and EU split east/west by the request's longitude — the fallback must
// be a SHORT hop, and a cold Boston colo relaying to a west-coast regional
// DO would pay ~60-80ms of avoidable cross-country RTT. Thresholds sit in
// the sparse middle of each landmass (-100° ≈ the Great Plains, 15° ≈ the
// Berlin/Vienna meridian); requests without a longitude take the map's
// continent default.

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
