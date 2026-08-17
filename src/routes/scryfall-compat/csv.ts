// `GET /cards/search?format=csv` — the one Scryfall response that is not JSON-shaped.
//
// Scryfall serves CSV on `/cards/search` AND NOWHERE ELSE. Measured against api.scryfall.com on
// 2026-08-16, one request per row:
//
//   /cards/search?format=csv           text/csv                          THE ONLY ONE
//   /cards/named?format=csv            application/json — parameter ignored
//   /cards/:id?format=csv              application/json — parameter ignored
//   /cards/:set/:number[/:lang]        application/json — parameter ignored
//   /cards/random?format=csv           application/json — parameter ignored
//   POST /cards/collection?format=csv  application/json — parameter ignored
//   /sets, /catalog/*, /symbology      application/json — parameter ignored
//
// and it is CASE-SENSITIVE: `format=CSV` serves JSON. The mirror image holds for the other two
// formats — `format=text` and `format=image` are honoured on the SINGLE-CARD routes and ignored on
// `/cards/search`, which is why this module has no text or image branch. A format parameter naming
// a rendering the route does not have is not an error anywhere: it is silently JSON.
//
// PAGING: CSV pages exactly like JSON, at 175 rows. `q=t:goblin&format=csv` returns 175 data rows
// plus a header row, `&page=2` returns the next 175 with the header row REPEATED, and `&page=99` is
// the same `422 validation_error` JSON body the JSON format answers with. There is no "whole result
// set" mode and no cap to discover — which is what makes this implementable over a partitioned
// store without touching the gather at all: the rows are the page the engine already produced, and
// only their serialization differs. The one thing a CSV client loses is the envelope, so Scryfall
// puts the missing bit in a header (`x-scryfall-has-more`) and this does too.
//
// An empty result is NOT an empty CSV: it is the ordinary `404 not_found` JSON body, because the
// decision happens before the format does (see emptyPageResponse).

/** The header row, verbatim and in Scryfall's order. Its bytes ARE the contract. */
export const CSV_COLUMNS = [
	"multiverse_id",
	"mtgo_id",
	"set",
	"collector_number",
	"lang",
	"rarity",
	"name",
	"mana_cost",
	"cmc",
	"type_line",
	"artist",
	"usd_price",
	"usd_foil_price",
	"eur_price",
	"tix_price",
	"image_uri",
	"scryfall_uri",
	"scryfall_id",
] as const;

/** The image size CSV links to — `large`, not the card object's whole `image_uris` map. */
const CSV_IMAGE_VERSION = "large";

/** Content type Scryfall sends, WITHOUT a charset — unlike every JSON response here. */
export const CSV_CONTENT_TYPE = "text/csv";

/** Scryfall names the download after the route, so a browser save-as lands on `search.csv`. */
export const CSV_CONTENT_DISPOSITION = 'attachment; filename="search.csv"';

/**
 * The header carrying the fact the CSV body cannot: is there another page?
 *
 * A JSON client reads `has_more` out of the envelope. A CSV client has no envelope, so Scryfall
 * hangs the same boolean off a response header and this does the same — without it, paginating a
 * CSV export means guessing, or asking for the JSON first.
 */
export const CSV_HAS_MORE_HEADER = "x-scryfall-has-more";

const CSV_NEWLINE = "\n";

/**
 * One CSV cell, RFC 4180 with MINIMAL quoting — which is what Scryfall emits.
 *
 * Verified on real rows: `Alrund, God of the Cosmos // Hakka, Whispering Raven` is quoted (commas),
 * `Henzie ""Toolbox"" Torre` is quoted with its own quotes doubled, `Edward P. Beard, Jr.` is quoted,
 * `Legendary Creature — God // Legendary Creature — Bird` is NOT (em dash and slashes are ordinary
 * bytes), and `Volkan Baǵa` is not either — non-ASCII is raw UTF-8, never escaped.
 *
 * `null` and `""` are DIFFERENT cells, which is the one rule a naive implementation gets wrong: an
 * ABSENT value writes nothing at all (a null price, a printing with no multiverse id), while a
 * value that IS the empty string writes `""`. Every basic land is the proof — Scryfall's JSON gives
 * it `"mana_cost": ""` and the CSV row reads `A-Bretagard Stronghold,"",0.0,Land`, two bytes where
 * the price columns beside it have none. So absence is spelled with `null` here rather than being
 * flattened into an empty string on the way in.
 */
function cell(value: string | null): string {
	if (value === null) return "";
	if (value === "") return '""';
	if (!/[",\r\n]/.test(value)) return value;
	return `"${value.replace(/"/g, '""')}"`;
}

/**
 * A price, as CSV writes it: the JSON string parsed as a float and printed back.
 *
 * The JSON carries two decimal places always (`"60.00"`, `"0.10"`), the CSV does not (`60.0`,
 * `0.1`) — so this is a float round-trip, not the string. `null` is the EMPTY cell, never `0`.
 */
function priceCell(value: unknown): string | null {
	if (typeof value !== "string" || value === "") return null;
	const n = Number(value);
	if (!Number.isFinite(n)) return null;
	return Number.isInteger(n) ? `${n}.0` : String(n);
}

/** `cmc` as a decimal, matching the JSON's own decimal typing: `1` is `1.0`, `0.5` stays `0.5`. */
function cmcCell(value: unknown): string | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Number.isInteger(value) ? `${value}.0` : String(value);
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The faces array, when the card has one. */
function facesOf(card: Record<string, unknown>): Record<string, unknown>[] {
	const faces = card.card_faces;
	return Array.isArray(faces) ? faces.filter(isObject) : [];
}

/**
 * The printed cost, joined across faces when the card object keeps it there.
 *
 * A one-image multi-face layout (split, flip, adventure) carries `mana_cost` at top level already
 * joined (`{1}{R} // {1}{U}`), so that value is used as it stands. A two-image layout (transform,
 * modal_dfc) has no top-level cost and each face carries its own — and there the join DROPS THE
 * EMPTY ONES rather than leaving a separator with nothing after it. Measured 2026-08-16:
 *
 *   Delver of Secrets // Insectile Aberration   faces {U} + ""       cell `{U}`
 *   Boggart Trawler // Boggart Bog              faces {2}{B} + ""    cell `{2}{B}`
 *   Barkchannel Pathway // Tidechannel Pathway  faces "" + ""        cell `""`
 *   Fire // Ice (top-level, one image)          `{1}{R} // {1}{U}`   cell unchanged
 *
 * A naive join produced `{U} // ` for the first two — a separator announcing a second cost that is
 * not there — and `" // "` for the third, where Scryfall writes the empty string. The last row is
 * also why this returns `""` rather than `null` when every face is free: the card HAS a printed
 * cost and it is empty, which the CSV spells `""`, not as an absent cell.
 */
function manaCostCell(card: Record<string, unknown>): string | null {
	const top = card.mana_cost;
	if (typeof top === "string") return top;
	const faces = facesOf(card);
	if (faces.length === 0) return null;
	return faces
		.map((face) => (typeof face.mana_cost === "string" ? face.mana_cost : ""))
		.filter((cost) => cost !== "")
		.join(" // ");
}

/**
 * The `large` image, front face.
 *
 * Top-level `image_uris` on every layout that has one; a two-image layout has none, and its FRONT
 * face's map is the one CSV links to (a row is one line and cannot carry two pictures).
 */
function imageCell(card: Record<string, unknown>): string | null {
	const top = card.image_uris;
	if (isObject(top) && typeof top[CSV_IMAGE_VERSION] === "string") return top[CSV_IMAGE_VERSION] as string;
	const front = facesOf(card)[0];
	if (front !== undefined && isObject(front.image_uris) && typeof front.image_uris[CSV_IMAGE_VERSION] === "string") {
		return front.image_uris[CSV_IMAGE_VERSION] as string;
	}
	return null;
}

/**
 * `scryfall_uri` WITHOUT the tracking query api.scryfall.com decorates the JSON one with.
 *
 * The card object's value ends in `?utm_source=api`; the CSV cell does not. Cutting at the first
 * `?` rather than parsing: the slug is percent-encoded and may contain anything else, but a
 * scryfall.com card URL has never carried a query of its own.
 */
function scryfallUriCell(card: Record<string, unknown>): string | null {
	const uri = card.scryfall_uri;
	if (typeof uri !== "string") return null;
	const at = uri.indexOf("?");
	return at < 0 ? uri : uri.slice(0, at);
}

/**
 * Rarity as its INITIAL, uppercased: common `C`, uncommon `U`, rare `R`, mythic `M`, special `S`,
 * bonus `B`. Scryfall's own abbreviation, and the reason this is derived rather than tabled — a
 * rarity added upstream abbreviates the same way instead of silently emitting nothing.
 */
function rarityCell(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? (value[0] as string).toUpperCase() : null;
}

/** A string field, or `null` when the card does not carry one — see `cell` on why that differs. */
function str(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

/** One card as its CSV row (no trailing newline). */
function cardToCsvRow(card: Record<string, unknown>): string {
	const multiverseIds = card.multiverse_ids;
	const firstMultiverse =
		Array.isArray(multiverseIds) && typeof multiverseIds[0] === "number" ? String(multiverseIds[0]) : null;
	const prices = isObject(card.prices) ? card.prices : {};
	const setCode = str(card.set);
	const values: (string | null)[] = [
		firstMultiverse,
		typeof card.mtgo_id === "number" ? String(card.mtgo_id) : null,
		setCode === null ? null : setCode.toUpperCase(),
		str(card.collector_number),
		str(card.lang),
		rarityCell(card.rarity),
		str(card.name),
		manaCostCell(card),
		cmcCell(card.cmc),
		str(card.type_line),
		str(card.artist),
		priceCell(prices.usd),
		priceCell(prices.usd_foil),
		priceCell(prices.eur),
		priceCell(prices.tix),
		imageCell(card),
		scryfallUriCell(card),
		str(card.id),
	];
	return values.map(cell).join(",");
}

/**
 * A page of card objects as Scryfall's CSV document: header row, then one row per card.
 *
 * The header is emitted even when the page is short; it is not emitted for an empty result, because
 * an empty result never reaches here (it is a 404 before the format is consulted).
 */
export function cardsToCsv(cards: Record<string, unknown>[]): string {
	const lines = [CSV_COLUMNS.join(",")];
	for (const card of cards) lines.push(cardToCsvRow(card));
	return `${lines.join(CSV_NEWLINE)}${CSV_NEWLINE}`;
}
