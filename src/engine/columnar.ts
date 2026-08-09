// Wire shaping for card results, applied where the rows already are: inside
// the Durable Object that ran the query.
//
// Both shapes are produced next to the engine rather than in the request
// isolate. The isolate's CPU is metered against the free plan's 10ms per
// request; the DO's is not (a DO invocation gets 30s), so every byte of
// card-shaped work moved across this boundary is budget the serving path
// gets back. See Engine.searchSerialized in types.ts.

/**
 * Upstream _columnarize_cards: invert a list of card dicts into one list per
 * field. Every card carries the same keys, so keys come from the first card.
 */
export function columnarizeCards(cards: Record<string, unknown>[]): Record<string, unknown[]> {
	const keys = cards.length > 0 ? Object.keys(cards[0] as Record<string, unknown>) : [];
	return Object.fromEntries(keys.map((k) => [k, cards.map((c) => c[k])]));
}

/** The envelope's `cards` value, serialized in the requested shape. */
export function serializeCards(rows: Record<string, unknown>[], shape: "rows" | "columnar"): string {
	return JSON.stringify(shape === "columnar" ? columnarizeCards(rows) : rows);
}
