/** Scryfall's query prefix limit, measured against the public API on 2026-09-27. */
export const MAX_SCRYFALL_QUERY_CHARACTERS = 1024;

/** Preserve the first 1,024 Unicode code points, including spaces and literal bytes. */
export function truncateScryfallQuery(query: string | undefined): string | undefined {
	if (query === undefined || query.length <= MAX_SCRYFALL_QUERY_CHARACTERS) return query;
	let end = 0;
	let count = 0;
	for (const character of query) {
		if (count++ === MAX_SCRYFALL_QUERY_CHARACTERS) break;
		end += character.length;
	}
	return query.slice(0, end);
}

/**
 * Apply the compatibility prefix before dispatch's byte guard and parameter binding.
 * Other routes and the native `query` alias retain their existing safety limits.
 */
export function prepareScryfallQueryParams(routeKey: string, params: URLSearchParams): URLSearchParams {
	if (routeKey !== "cards/search" && routeKey !== "cards/random") return params;
	const prepared = new URLSearchParams();
	for (const [key, value] of params) {
		prepared.append(key, key === "q" ? (truncateScryfallQuery(value) ?? "") : value);
	}
	return prepared;
}
