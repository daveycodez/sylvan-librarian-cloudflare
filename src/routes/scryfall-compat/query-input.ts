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
 * Collapse every run of whitespace in a query to ONE SPACE and trim the ends — everywhere, inside a
 * quoted phrase and inside a regex as much as between terms.
 *
 * api.scryfall.com does this to the whole query before it parses anything (its `next_page` echoes
 * `q` that way), so a tab or a line break typed inside a pattern is a space by the time the pattern
 * is read. Measured 2026-10-04 on Abomination ("Whenever this creature blocks or becomes blocked
 * by…", one line), each scoped `!"Abomination"`, `<LF>` and `<TAB>` being the raw characters:
 *
 *   o:/blocks or/           1
 *   o:/blocks<LF>or/        1     a raw line break matches the SPACE
 *   o:/blocks<TAB>or/       1
 *   o:/blocks  or/          1     two spaces
 *   o:/blocks<LF><LF>or/    1     a run is one space
 *   o:"blocks<LF>or"        1     a quoted phrase too
 *   o:/blocks[<LF>]or/      1     `[ ]`
 *   o:/blocks[^<LF>]or/     404   `[^ ]`
 *   o:/blocks[^,.<LF>]or/   404   `[^,. ]`
 *
 * and from the other side, on Tiller Engine, whose text really has a line break after "choose one
 * —": `o:/choose one —<LF>• untap/` is 404 where the ESCAPE `\n` in that position is 1. A raw
 * newline in a query never means a newline.
 *
 * mtg-seeker's report R29 is this rule: `o:/Whenever [^,.<LF>]* (blocks|becomes blocked)[^,.<LF>]*,/`
 * was written to stop at a line break and instead stops at every SPACE on Scryfall — 53 cards
 * there, 335 here, where the line break stayed a line break.
 *
 * ASCII whitespace only (space, tab, LF, VT, FF, CR): those are the characters measured.
 *
 * AFTER the 1,024 cut, not before: `lightning` + 1,100 spaces + `bolt` answers the 67 cards of
 * `lightning` there, so the spaces counted toward the prefix and `bolt` was cut off.
 */
export function collapseScryfallQueryWhitespace(query: string): string {
	return query.replace(/[ \t\n\v\f\r]+/g, " ").trim();
}

/**
 * Apply the compatibility prefix and whitespace rule before dispatch's byte guard and parameter
 * binding. Other routes and the native `query` alias retain their existing safety limits.
 */
export function prepareScryfallQueryParams(routeKey: string, params: URLSearchParams): URLSearchParams {
	if (routeKey !== "cards/search" && routeKey !== "cards/random") return params;
	const prepared = new URLSearchParams();
	for (const [key, value] of params) {
		prepared.append(key, key === "q" ? collapseScryfallQueryWhitespace(truncateScryfallQuery(value) ?? "") : value);
	}
	return prepared;
}
