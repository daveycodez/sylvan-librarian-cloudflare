// Continent → Durable Object location hint, shared by the engine and rate
// limiter routing: one regional instance each, created near its callers.

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
	const continent = (request.cf as { continent?: string } | undefined)?.continent ?? "NA";
	return CONTINENT_TO_HINT[continent] ?? "wnam";
}
