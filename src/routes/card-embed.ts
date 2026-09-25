// PORT-ONLY: the card page's two /search answers, computed by the server and handed to card.js
// from the HTML (backlog n4).
//
// card.js (public/static/card.js, upstream's file plus two LOCAL PATCHes) renders
// /card/:set/:number by fetching, in sequence:
//
//   1. /search?q=<set:S cn:"N">&unique=printing&fields=<CARD_FIELDS>
//        -> data.cards.find(exact number) ?? data.cards[0]            (the card)
//   2. /search?q=<oracleid:ID, or !"Name">&unique=printing&fields=<printingFields>
//        -> data.cards, minus this printing                           (the printings strip)
//
// The first is a gather over every partition — `cn:` is not routable — and the page cost three
// browser requests. Rather than change card.js (an upstream PR, and both trees, for a server
// upstream does not have), the page carries both answers keyed by the EXACT URL string card.js
// will pass to fetch(), and a few lines of inline script ahead of the deferred card.js answer those
// two calls from the map, once each. Any other call — or either of these, if a key does not match
// byte for byte — goes to the network untouched: a mismatch costs the saving, never correctness.
//
// The URL builders below are TRANSCRIPTIONS of card.js's template literals, and
// tests/routes/card-embed.test.ts runs card.js itself against them, so an upstream sync that
// changes either fetch fails loudly instead of silently turning the embed off.
//
// ONE PARTITION FOR THE FIRST ANSWER. `cn:` matches loosely (`set:war cn:"2"` also returns 2★), so
// only the rows AT the page's address are trustworthy from one partition. Every printing at an
// address lives in one partition (set_number_routing_key, engine/builder/src/transform.rs), in the
// order a gather returns them, so when the partition the routing filter names holds an exact row,
// it is the row card.js's find() picks from the whole answer. Otherwise — no filter yet, a hint
// that misses, a number with no exact printing — the server runs card.js's own query whole and
// applies card.js's own `?? cards[0]`.

import { concatBytes, decodeUtf8, encodeUtf8, escapeLtBytes } from "../engine/bytes";
import { setNumberKey } from "../engine/routing-filter";
import { checkSearchParamLengths, QueryBudgetExceeded } from "../parser";
import type { CardRow } from "./noscript";
import type { RouteContext } from "./registry";
import { type RunSearchOptions, runSearchParts, runSearchPartsAtAddress, SearchBadRequest } from "./search";

/** card.js's `CARD_FIELDS.join(',')`, after its LOCAL PATCH pushes `scryfall_id`. */
export const CARD_JS_CARD_FIELDS =
	"name,set_code,collector_number,power,toughness,mana_cost,oracle_text,set_name,type_line,oracle_id,scryfall_id";

/** card.js's `printingFields`, verbatim. */
export const CARD_JS_PRINTING_FIELDS =
	"scryfall_id,set_code,collector_number,set_name,illustration_id,price_usd,prefer_score";

/** card.js's escapeExactName, verbatim. */
export function escapeExactName(name: string): string {
	return name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export interface CardJsTarget {
	/** card.js's `setCode`: the RAW path segment, lowercased (never decoded). */
	setCode: string;
	/** card.js's `collectorNumber`: the path segment DECODED, or raw when it is a malformed escape. */
	collectorNumber: string;
	/** The URL string card.js passes to fetch() first. */
	cardUrl: string;
}

/**
 * What card.js will ask for first, from the request's RAW pathname — the percent-encoded form
 * `location.pathname` gives card.js. Dispatch's positional args are already decoded, which is right
 * for the collector number and wrong for the set code, so neither is taken from there.
 */
export function cardJsTarget(rawPathname: string): CardJsTarget | null {
	const parts = rawPathname.split("/").filter(Boolean);
	if (parts.length < 3 || parts[0] !== "card") return null;
	const [, rawSetCode = "", rawCollectorNumber = ""] = parts;
	const setCode = rawSetCode.toLowerCase();
	let collectorNumber = rawCollectorNumber;
	try {
		collectorNumber = decodeURIComponent(rawCollectorNumber);
	} catch {
		// card.js searches a malformed escape as written.
	}
	const query = `set:${setCode} cn:"${escapeExactName(collectorNumber)}"`;
	return {
		setCode,
		collectorNumber,
		cardUrl: `/search?q=${encodeURIComponent(query)}&unique=printing&fields=${CARD_JS_CARD_FIELDS}`,
	};
}

/**
 * The URL string card.js passes to fetch() second, for the card it picked — null where card.js
 * sends nothing (a card with neither an oracle id nor a name makes its escapeExactName throw, and
 * card.js swallows that).
 */
export function printingsUrl(card: CardRow): string | null {
	let query: string;
	if (card.oracle_id) query = `oracleid:${String(card.oracle_id)}`;
	else if (typeof card.name === "string") query = `!"${escapeExactName(card.name)}"`;
	else return null;
	return `/search?q=${encodeURIComponent(query)}&unique=printing&fields=${CARD_JS_PRINTING_FIELDS}`;
}

/** One embedded answer: the URL card.js fetches, and the `cards` JSON array /search would send. */
export interface EmbeddedAnswer {
	url: string;
	cards: Uint8Array;
}

/**
 * /search's options for one of card.js's URLs, read back out of the URL the way dispatch and
 * searchHandler read them — so the server answers the URL, not its own idea of what the URL meant.
 * Throws QueryBudgetExceeded exactly where dispatch would answer that URL with a 400.
 */
function searchOptionsOf(url: string): RunSearchOptions {
	const params = new URL(url, "https://card.invalid").searchParams;
	checkSearchParamLengths(params);
	const fields = (params.get("fields") ?? "")
		.split(",")
		.map((f) => f.trim())
		.filter((f) => f.length > 0);
	return {
		query: params.get("q"),
		orderby: "edhrec",
		direction: "asc",
		unique: "printing",
		prefer: "default",
		fields,
	};
}

function rowsOf(cardsBytes: Uint8Array): CardRow[] {
	return JSON.parse(decodeUtf8(cardsBytes)) as CardRow[];
}

/**
 * card.js's answers for this card page, in fetch order. Never throws: an answer that cannot be
 * computed is left out and card.js fetches it itself, which is exactly the page before the embed.
 * `transient` is set when an answer was left out for an ENGINE reason (unloaded, faulting, a bug),
 * which must not stand at the edge for an hour in place of the embedded page; a query /search
 * itself rejects with a 400 is a property of the URL, and card.js gets that 400 on its own.
 */
export async function cardJsAnswers(ctx: RouteContext): Promise<{ answers: EmbeddedAnswer[]; transient: boolean }> {
	const answers: EmbeddedAnswer[] = [];
	let target: CardJsTarget | null;
	let card: CardRow | undefined;
	try {
		target = cardJsTarget(new URL(ctx.request.url).pathname);
		if (target === null) return { answers, transient: false };
		const { collectorNumber } = target;
		const isExact = (c: CardRow): boolean => c.collector_number === collectorNumber;
		const opts = searchOptionsOf(target.cardUrl);
		const routed = await runSearchPartsAtAddress(ctx, opts, "rows", setNumberKey(target.setCode, collectorNumber));
		card = routed === null ? undefined : rowsOf(routed.cardsBytes).find(isExact);
		if (card === undefined) {
			const all = rowsOf((await runSearchParts(ctx, opts, "rows")).cardsBytes);
			card = all.find(isExact) ?? all[0];
		}
		// card.js reads `data.cards` and nothing else, and one row picks the same card as the page.
		answers.push({ url: target.cardUrl, cards: encodeUtf8(JSON.stringify(card === undefined ? [] : [card])) });
	} catch (err) {
		return { answers, transient: noteFailure("card", err) };
	}
	try {
		const url = card === undefined ? null : printingsUrl(card);
		if (url === null) return { answers, transient: false };
		const found = await runSearchParts(ctx, searchOptionsOf(url), "rows");
		answers.push({ url, cards: found.cardsBytes });
	} catch (err) {
		return { answers, transient: noteFailure("printings", err) };
	}
	return { answers, transient: false };
}

/** Whether a lookup's failure is transient (engine) rather than a property of the URL. */
function noteFailure(which: string, err: unknown): boolean {
	if (err instanceof SearchBadRequest || err instanceof QueryBudgetExceeded) {
		return false;
	}
	console.error(`card page: the ${which} lookup failed, card.js will fetch it (${err})`);
	return true;
}

/**
 * The inline script, as bytes: the answers, and a fetch() that serves each one ONCE for its exact
 * URL string — a real Response, so card.js's `resp.json()` (all it calls) behaves exactly as over
 * the network. The rows are spliced as the engine wrote them, `<` escaped for the script context.
 */
export function embeddedFetchScript(answers: readonly EmbeddedAnswer[]): Uint8Array {
	const parts: Uint8Array[] = [encodeUtf8("<script>(function(){var m={")];
	answers.forEach(({ url, cards }, i) => {
		parts.push(encodeUtf8(`${i > 0 ? "," : ""}${JSON.stringify(url).replaceAll("<", "\\u003c")}:{"cards":`));
		parts.push(escapeLtBytes(cards), encodeUtf8("}"));
	});
	parts.push(
		encodeUtf8(
			"};var f=window.fetch;window.fetch=function(u){" +
				"if(typeof u==='string'&&Object.prototype.hasOwnProperty.call(m,u)){var b=m[u];delete m[u];" +
				"return Promise.resolve(new Response(JSON.stringify(b),{status:200,headers:{'content-type':'application/json'}}));}" +
				"return f.apply(this,arguments);};})();</script>\n    ",
		),
	);
	return concatBytes(parts);
}
