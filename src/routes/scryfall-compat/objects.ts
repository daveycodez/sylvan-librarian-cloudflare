// Scryfall response objects: card reconstruction and the envelopes around it.
// Port of api/scryfall_compat/objects.py (upstream #912).
//
// Everything here is pure — rows in, objects out — so the payload shape is testable without an
// engine or a request. routes.ts owns the HTTP side.
//
// DELIBERATE DEVIATION: upstream carries a second builder input, `sql_row_to_engine_row`, so its
// Postgres fallback can reach the same `to_scryfall_card`. This port has no SQL (see the README's
// "Deviations from upstream"), so there is one input shape — an engine row keyed by
// JSON_FIELD_TABLE name — and `_EngineMiss` has no counterpart: a miss IS a 404.
//
// The rule that runs through the whole file: **absent stays absent**. Scryfall OMITS a key it has
// no value for rather than sending null, so a card that sprouts nulls Scryfall never sent differs
// from Scryfall on every row, which is the one thing a drop-in replacement cannot do. The engine
// renders an absent field as JSON `null` (see JSON_FIELD_TABLE), so `null` is the wire form of
// "was not there" and every read below has to drop it rather than pass it through.

/** An engine row: JSON_FIELD_TABLE names to values, absent rendered as null. */
export type EngineRow = Record<string, unknown>;

/** Sizes Scryfall serves under `image_uris`, and the `version` vocabulary of `format=image`. */
export const IMAGE_VERSIONS = ["small", "normal", "large", "png", "art_crop", "border_crop"] as const;
export const DEFAULT_IMAGE_VERSION = "large";

/**
 * Scryfall pages every card list at 175, and clients page by following `next_page` rather than by
 * computing offsets, so this has to match or a client's page count silently disagrees with ours.
 */
export const PAGE_SIZE = 175;

/** Scryfall caps a collection POST at 75 identifiers and 422s past it. */
export const MAX_COLLECTION_IDENTIFIERS = 75;

/** Scryfall caps an autocomplete catalog at 20 names. */
export const MAX_AUTOCOMPLETE_VALUES = 20;

/** Scryfall's card back, one image for every normal card. */
export const CARD_BACK_ID = "0aeebaf5-8c7d-4636-9e82-8c27447861f7";

/** The file extension each image size is served as. */
const IMAGE_EXTENSIONS: Record<string, string> = {
	small: "jpg",
	normal: "jpg",
	large: "jpg",
	png: "png",
	art_crop: "jpg",
	border_crop: "jpg",
};

/**
 * Every field the engine must return for a card object to be assembled. Passed as `fields=` on
 * each lookup, so the engine emits exactly this and nothing is fetched that is never read.
 *
 * Two more than upstream's list: `border_color` and `frame`. Upstream's `to_scryfall_card` reads
 * both but never asks for them, so on its engine path every card carries `border_color: null` and
 * no `frame` at all — see the FIELD_TABLE note in card_engine's lib.rs.
 */
export const CARD_OBJECT_FIELDS: readonly string[] = [
	"name",
	"scryfall_id",
	"oracle_id",
	"layout",
	"mana_cost",
	"cmc",
	"type_line",
	"oracle_text",
	"power",
	"toughness",
	"colors",
	"color_identity",
	"card_keywords",
	"set_code",
	"set_name",
	"collector_number",
	"rarity",
	"flavor_text",
	"artist",
	"illustration_id",
	"released_at",
	"legalities",
	"edhrec_rank",
	"price_usd",
	"price_eur",
	"price_tix",
	"watermark",
	"card_frame_data",
	"card_is_tags",
	"border_color",
	"frame",
	"lang",
	"image_status",
	"set_type",
	"security_stamp",
	"set_id",
	"arena_id",
	"mtgo_id",
	"mtgo_foil_id",
	"tcgplayer_id",
	"tcgplayer_etched_id",
	"cardmarket_id",
	"penny_rank",
	"image_updated_at",
	"price_usd_foil",
	"price_usd_etched",
	"price_eur_foil",
	"multiverse_ids",
	"promo_types",
	"frame_effects",
	"games",
	"finishes",
	"booster",
	"digital",
	"foil",
	"nonfoil",
	"full_art",
	"highres_image",
	"oversized",
	"promo",
	"reprint",
	"story_spotlight",
	"textless",
	"variation",
	"card_faces",
	"all_parts",
];

// ─── reading an engine row ───────────────────────────────────────────────────
// `null` is the wire form of "Scryfall omitted this", so every accessor collapses it to undefined
// rather than letting it reach a response.

function str(row: EngineRow, key: string): string | undefined {
	const v = row[key];
	return typeof v === "string" && v !== "" ? v : undefined;
}

function num(row: EngineRow, key: string): number | undefined {
	const v = row[key];
	return typeof v === "number" ? v : undefined;
}

function bool(row: EngineRow, key: string): boolean {
	return row[key] === true;
}

function list(row: EngineRow, key: string): unknown[] {
	const v = row[key];
	return Array.isArray(v) ? v : [];
}

/** A list, or undefined when empty — for the keys Scryfall omits rather than sending `[]`. */
function listOrAbsent(row: EngineRow, key: string): unknown[] | undefined {
	const v = list(row, key);
	return v.length > 0 ? v : undefined;
}

// ─── derived values ──────────────────────────────────────────────────────────

/**
 * The CDN URLs for one face.
 *
 * Scryfall's paths are a pure function of the card id: its first two hex digits become directory
 * levels, and `image_updated_at` rides as a cache-buster. Nothing about these is stored.
 *
 * This is also where this port already sources card images (see noscript.ts's buildImageUrl), so
 * the card object and the rendered page agree on the same origin.
 */
export function imageUris(
	scryfallId: string,
	updatedAt?: number,
	face: "front" | "back" = "front",
): Record<string, string> {
	if (!scryfallId) return {};
	const suffix = updatedAt ? `?${updatedAt}` : "";
	const [first, second] = [scryfallId[0], scryfallId[1]];
	const out: Record<string, string> = {};
	for (const [size, ext] of Object.entries(IMAGE_EXTENSIONS)) {
		out[size] = `https://cards.scryfall.io/${size}/${face}/${first}/${second}/${scryfallId}.${ext}${suffix}`;
	}
	return out;
}

/** Scryfall's URL slug for a card name: lowercase, non-alphanumerics collapsed to hyphens. */
export function slug(name: string): string {
	// Python's str.isalnum() is Unicode-aware, so `\p{L}\p{N}` rather than [a-z0-9] — "Æther" and
	// "Jötun" must slug the same way here as they do upstream.
	return name
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]/gu, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

/**
 * Scryfall's `related_uris`, pointing at the destinations directly.
 *
 * Scryfall wraps the TCGplayer entries in `partner.tcgplayer.com/...?u=<encoded real URL>` with its
 * own affiliate code. The destination is the same page, and emitting the wrapper from this host
 * would route another service's affiliate revenue to Scryfall.
 */
function relatedUris(name: string): Record<string, string> {
	// Python's quote_plus, which encodes a space as `+` where encodeURIComponent gives `%20`.
	const quoted = encodeURIComponent(name)
		.replace(/%20/g, "+")
		.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return {
		tcgplayer_infinite_articles: `https://www.tcgplayer.com/search/articles?productLineName=magic&q=${quoted}`,
		tcgplayer_infinite_decks: `https://www.tcgplayer.com/search/decks?productLineName=magic&q=${quoted}`,
		edhrec: `https://edhrec.com/route/?cc=${quoted}`,
	};
}

/** Scryfall's `purchase_uris`, rebuilt from the marketplace ids. Same affiliate reasoning. */
function purchaseUris(row: EngineRow): Record<string, string> {
	const out: Record<string, string> = {};
	const tcg = num(row, "tcgplayer_id");
	const cm = num(row, "cardmarket_id");
	const mtgo = num(row, "mtgo_id");
	if (tcg) out.tcgplayer = `https://www.tcgplayer.com/product/${tcg}?page=1`;
	if (cm) out.cardmarket = `https://www.cardmarket.com/en/Magic/Products?idProduct=${cm}`;
	if (mtgo) out.cardhoarder = `https://www.cardhoarder.com/cards/${mtgo}`;
	return out;
}

/** Scryfall's `prices` object: the three price fields plus the three residue variants. */
function prices(row: EngineRow): Record<string, string | null> {
	const fmt = (key: string): string | null => {
		const v = num(row, key);
		return v === undefined ? null : v.toFixed(2);
	};
	return {
		usd: fmt("price_usd"),
		usd_foil: fmt("price_usd_foil"),
		usd_etched: fmt("price_usd_etched"),
		eur: fmt("price_eur"),
		eur_foil: fmt("price_eur_foil"),
		tix: fmt("price_tix"),
	};
}

/**
 * The card's faces, with the two keys the engine deliberately does not store re-added.
 *
 * `object` is the constant "card_face", and a face's `image_uris` is the card's CDN function with
 * front/back swapped, so neither is worth archive space.
 */
function faces(row: EngineRow, scryfallId: string): Record<string, unknown>[] {
	const stored = list(row, "card_faces") as Record<string, unknown>[];
	return stored.map((face, index) => {
		const built: Record<string, unknown> = { object: "card_face" };
		// Same absent-stays-absent filter upstream applies: a null, an empty string and an empty
		// list are all "Scryfall did not send this face that key".
		for (const [key, value] of Object.entries(face)) {
			if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) continue;
			built[key] = value;
		}
		if (stored.length > 1) {
			built.image_uris = imageUris(scryfallId, num(row, "image_updated_at"), index === 0 ? "front" : "back");
		}
		return built;
	});
}

/**
 * Build the Scryfall card object for one engine row.
 *
 * BUILDS rather than unwraps a stored copy, which is the whole reason /cards/* can be served at
 * all here: an object assembled from stored fields is answerable from the archive, while one
 * recovered from a `raw_card_blob` would be answerable only from a Postgres this deployment does
 * not have.
 *
 * Three sources, and every one of Scryfall's keys comes from exactly one: the stored fields, the
 * derived keys (every `*_uri` and `image_uris`, pure functions of the id/set/collector
 * number/oracle id), and the compat residue.
 */
export function toScryfallCard(row: EngineRow, baseUrl = "https://api.scryfall.com"): Record<string, unknown> {
	const scryfallId = str(row, "scryfall_id") ?? "";
	const oracleId = str(row, "oracle_id") ?? "";
	const name = str(row, "name") ?? "";
	const setCode = str(row, "set_code") ?? "";
	const number = str(row, "collector_number") ?? "";
	const setId = str(row, "set_id");
	const built = faces(row, scryfallId);

	const card: Record<string, unknown> = {
		object: "card",
		id: scryfallId,
		oracle_id: oracleId,
		multiverse_ids: list(row, "multiverse_ids"),
		name,
		lang: str(row, "lang") ?? "en",
		released_at: str(row, "released_at") ?? null,
		uri: `${baseUrl}/cards/${scryfallId}`,
		scryfall_uri: `https://scryfall.com/card/${setCode}/${number}/${slug(name)}?utm_source=api`,
		layout: str(row, "layout") ?? null,
		highres_image: bool(row, "highres_image"),
		image_status: str(row, "image_status") ?? null,
		cmc: num(row, "cmc") ?? null,
		type_line: str(row, "type_line") ?? null,
		colors: list(row, "colors"),
		color_identity: list(row, "color_identity"),
		keywords: list(row, "card_keywords"),
		games: list(row, "games"),
		reserved: (list(row, "card_is_tags") as string[]).includes("reserved"),
		finishes: list(row, "finishes"),
		oversized: bool(row, "oversized"),
		promo: bool(row, "promo"),
		reprint: bool(row, "reprint"),
		variation: bool(row, "variation"),
		set_id: setId ?? null,
		set: setCode,
		set_name: str(row, "set_name") ?? null,
		set_type: str(row, "set_type") ?? null,
		set_uri: setId ? `${baseUrl}/sets/${setId}` : null,
		set_search_uri: `${baseUrl}/cards/search?order=set&q=e%3A${setCode}&unique=prints`,
		scryfall_set_uri: `https://scryfall.com/sets/${setCode}?utm_source=api`,
		rulings_uri: `${baseUrl}/cards/${scryfallId}/rulings`,
		prints_search_uri: `${baseUrl}/cards/search?order=released&q=oracleid%3A${oracleId}&unique=prints`,
		collector_number: number,
		digital: bool(row, "digital"),
		rarity: str(row, "rarity") ?? null,
		card_back_id: CARD_BACK_ID,
		artist: str(row, "artist") ?? null,
		illustration_id: str(row, "illustration_id") ?? null,
		border_color: str(row, "border_color") ?? null,
		full_art: bool(row, "full_art"),
		textless: bool(row, "textless"),
		booster: bool(row, "booster"),
		story_spotlight: bool(row, "story_spotlight"),
		prices: prices(row),
		related_uris: relatedUris(name),
		purchase_uris: purchaseUris(row),
	};

	// A multi-face card carries its faces and NOT the top-level text they replace; a single-faced
	// one carries the text and no `card_faces`. Which keys sit at top level varies by LAYOUT, which
	// is why this is a branch rather than a fixed key set.
	if (built.length > 0) {
		card.card_faces = built;
	} else {
		card.mana_cost = str(row, "mana_cost") ?? null;
		card.oracle_text = str(row, "oracle_text") ?? null;
		card.image_uris = imageUris(scryfallId, num(row, "image_updated_at"));
	}

	// Keys Scryfall sends only when the card HAS them. Emitting null instead would differ from
	// Scryfall on every card that lacks them, which for most of these is most cards.
	const optional: [string, unknown][] = [
		["power", str(row, "power")],
		["toughness", str(row, "toughness")],
		["flavor_text", str(row, "flavor_text")],
		["watermark", str(row, "watermark")],
		["frame", str(row, "frame")],
		["security_stamp", str(row, "security_stamp")],
		["edhrec_rank", num(row, "edhrec_rank")],
		["penny_rank", num(row, "penny_rank")],
		["arena_id", num(row, "arena_id")],
		["mtgo_id", num(row, "mtgo_id")],
		["mtgo_foil_id", num(row, "mtgo_foil_id")],
		["tcgplayer_id", num(row, "tcgplayer_id")],
		["tcgplayer_etched_id", num(row, "tcgplayer_etched_id")],
		["cardmarket_id", num(row, "cardmarket_id")],
		["promo_types", listOrAbsent(row, "promo_types")],
		["frame_effects", listOrAbsent(row, "frame_effects")],
		["all_parts", listOrAbsent(row, "all_parts")],
		["legalities", row.legalities ?? undefined],
	];
	for (const [key, value] of optional) {
		if (value !== undefined) card[key] = value;
	}

	return card;
}

// ─── envelopes ───────────────────────────────────────────────────────────────

export interface ScryfallError extends Record<string, unknown> {
	object: "error";
	code: string;
	status: number;
	details: string;
	warnings?: string[];
}

/** Scryfall's error object. */
export function errorObject(code: string, status: number, details: string, warnings?: string[]): ScryfallError {
	const error: ScryfallError = { object: "error", code, status, details };
	if (warnings && warnings.length > 0) error.warnings = warnings;
	return error;
}

export function notFoundError(details: string): ScryfallError {
	return errorObject("not_found", 404, details);
}

export function badRequestError(details: string, warnings?: string[]): ScryfallError {
	return errorObject("bad_request", 400, details, warnings);
}

export interface CardListOptions {
	totalCards?: number;
	hasMore?: boolean;
	nextPage?: string;
	notFound?: unknown[];
	warnings?: string[];
}

/**
 * Scryfall's List object.
 *
 * Key order follows Scryfall's own so a byte-comparing client sees the same document.
 */
export function cardList(cards: unknown[], opts: CardListOptions = {}): Record<string, unknown> {
	const result: Record<string, unknown> = { object: "list" };
	if (opts.totalCards !== undefined) result.total_cards = opts.totalCards;
	if (opts.notFound !== undefined) result.not_found = opts.notFound;
	result.has_more = opts.hasMore ?? false;
	if (opts.nextPage !== undefined) result.next_page = opts.nextPage;
	if (opts.warnings && opts.warnings.length > 0) result.warnings = opts.warnings;
	result.data = cards;
	return result;
}

/** Scryfall's Catalog object. */
export function catalogObject(values: string[]): Record<string, unknown> {
	return { object: "catalog", total_values: values.length, data: values };
}

/**
 * The absolute `next_page` URL for a search result.
 *
 * Scryfall spells every EFFECTIVE parameter into `next_page` rather than echoing only what the
 * client sent, and clients follow the URL verbatim, so the query string is rebuilt from the
 * resolved values.
 */
export function buildPageUrl(baseUrl: string, params: Record<string, string>, page: number): string {
	const pairs: [string, string][] = [...Object.entries(params), ["page", String(page)]];
	pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	const query = new URLSearchParams(pairs);
	return `${baseUrl}?${query.toString()}`;
}

// ─── format=text and format=image ────────────────────────────────────────────

/** The requested face of a card, falling back to the card itself. */
function faceOf(card: Record<string, unknown>, face: string): Record<string, unknown> {
	const list_ = (card.card_faces as Record<string, unknown>[] | undefined) ?? [];
	const back = list_[1];
	if (face === "back" && back !== undefined) return back;
	return card;
}

/** The image URL for a card at a given size and face, or undefined when it has none. */
export function imageUri(card: Record<string, unknown>, version: string, face: string): string | undefined {
	const selected = faceOf(card, face);
	const uris = (selected.image_uris ?? card.image_uris ?? {}) as Record<string, string>;
	return uris[version];
}

/** One card face in Scryfall's plain-text format. */
function renderFace(face: Record<string, unknown>): string {
	const name = (face.name as string | undefined) ?? "";
	const manaCost = face.mana_cost as string | undefined;
	const lines = [manaCost ? `${name} ${manaCost}` : name];
	if (face.type_line) lines.push(face.type_line as string);
	if (face.oracle_text) lines.push(face.oracle_text as string);
	if (face.power !== undefined && face.toughness !== undefined) {
		lines.push(`${face.power}/${face.toughness}`);
	} else if (face.loyalty !== undefined) {
		lines.push(`Loyalty: ${face.loyalty}`);
	} else if (face.defense !== undefined) {
		lines.push(`Defense: ${face.defense}`);
	}
	return lines.join("\n");
}

/** A card in Scryfall's `format=text` layout; multi-face cards render every face. */
export function cardToText(card: Record<string, unknown>): string {
	const list_ = (card.card_faces as Record<string, unknown>[] | undefined) ?? [];
	if (list_.length > 0) return list_.map(renderFace).join("\n\n");
	return renderFace(card);
}
