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

/**
 * The `version` vocabulary of `format=image` — SIX names, not the eleven `image_uris` carries.
 *
 * The two lists used to be the same list, and are not any more: Scryfall's `image_uris` gained five
 * webp sizes (see IMAGE_EXTENSIONS) that `version=` does not accept. Measured against
 * api.scryfall.com on 2026-08-16 — `?format=image&version=thumb` redirects to the LARGE jpg, byte
 * for byte the same fallback `version=bogus` gets, and the same for grid/display/art/crop. So these
 * five are emitted as URLs and refused as parameters, and widening this tuple to match the other
 * would silently change five 302 targets.
 */
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

/**
 * The file extension each `image_uris` size is served as, in Scryfall's own key order.
 *
 * ELEVEN, not the six this port shipped with. Scryfall added five webp sizes — `thumb`, `grid`,
 * `display`, `art`, `crop` — and every card object it serves carries all eleven; a six-key
 * `image_uris` differed from Scryfall on every card object this mirror has ever emitted.
 *
 * Unconditional, and measured that way: across all 540,484 printings in the 2026-08-16 all_cards
 * bulk, `image_uris` is either wholly ABSENT (8,444 cards, 7,641 faces — the layouts whose picture
 * lives on the other level) or carries exactly these eleven keys in exactly this order. Not one
 * card, face, layout or `image_status` carries a partial set, so there is no per-key conditionality
 * to round-trip the way `printed_*` has.
 *
 * Derived, not stored: the same scan confirms all eleven URLs are the same pure function of the id
 * and the face on every one of the 548,604 objects that has them — `art_crop` and `art` are
 * different sizes of the same path, not a stored pair. Adding them costs zero archive bytes, which
 * is why this is a table and not a column.
 *
 * The one exception is not an exception to the KEY set: 29 `image_status: "missing"` printings serve
 * `https://errors.scryfall.com/soon.jpg` for all eleven values. That placeholder is a pre-existing
 * divergence of this mirror's derived URLs (it predates these five keys and applies equally to the
 * original six), not something the extra sizes introduce.
 */
const IMAGE_EXTENSIONS: Record<string, string> = {
	small: "jpg",
	normal: "jpg",
	large: "jpg",
	png: "png",
	art_crop: "jpg",
	border_crop: "jpg",
	thumb: "webp",
	grid: "webp",
	display: "webp",
	art: "webp",
	crop: "webp",
};

/** The same table pre-entried, because imageUris() walks it once per card and once per face. */
const IMAGE_EXTENSION_ENTRIES: readonly (readonly [string, string])[] = Object.entries(IMAGE_EXTENSIONS);

/**
 * Every field the engine must return for a card object to be assembled. Passed as `fields=` on
 * each lookup, so the engine emits exactly this and nothing is fetched that is never read.
 *
 * Two more than upstream's list: `border_color` and `frame`. Upstream's `to_scryfall_card` reads
 * both but never asks for them, so on its engine path every card carries `border_color: null` and
 * no `frame` at all — see the FIELD_TABLE note in card_engine's lib.rs.
 */
/**
 * Whether SOME marketplace sells this printing — the condition `purchase_uris` is emitted under.
 *
 * `paper` covers tcgplayer and cardmarket, `mtgo` covers cardhoarder, and nothing sells Arena.
 * An absent `games` list emits, because the omission is a positive claim about the printing.
 */
function soldSomewhere(row: EngineRow): boolean {
	const games = list(row, "games");
	return games.length === 0 || games.some((g) => g === "paper" || g === "mtgo");
}

export const CARD_OBJECT_FIELDS: readonly string[] = [
	"name",
	"scryfall_id",
	"oracle_id",
	"layout",
	"mana_cost",
	"cmc",
	"type_line",
	"oracle_text",
	"printed_name",
	"printed_type_line",
	"printed_text",
	"flavor_name",
	"life_modifier",
	"hand_modifier",
	"power",
	"toughness",
	"loyalty",
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
	"produced_mana",
	"color_indicator",
];

/**
 * The layouts whose faces each get their OWN image — and, with it, their own copy of every value
 * the one-image layouts keep at the top level.
 *
 * This is the single fact the whole multi-face branch turns on, and it is a property of the
 * LAYOUT, not of anything the row carries: a transform card's front and back are two photographs,
 * so Scryfall puts `image_uris`, `colors`, `power`, `illustration_id`, `flavor_text` and the rest
 * on the faces and sends NO top-level copy (and no `card_back_id` — there is no shared back). A
 * split or adventure card is ONE photograph of one piece of cardboard, so Scryfall sends one
 * top-level `image_uris` and one top-level `colors`, and its faces carry only text.
 *
 * Verified exhaustively against the 2026-08-16 all_cards bulk: of 540,484 printings, every row of
 * these five layouts has per-face `image_uris` and no top-level one, and every row of every other
 * layout has the reverse — zero exceptions in either direction. This port used to serve per-face
 * URLs for all multi-face cards, which invented a `.../back/...` URL with no image behind it on
 * every split, flip, adventure and prepare printing.
 */
const TWO_IMAGE_LAYOUTS = new Set(["art_series", "double_faced_token", "modal_dfc", "reversible_card", "transform"]);

/**
 * The multi-face layouts whose `related_uris.edhrec` link keeps the JOINED name.
 *
 * EDHREC files a transforming or adventuring card under its front face (`cc=Delver+of+Secrets`,
 * `cc=Brazen+Borrower`, `cc=Erayo%2C+Soratami+Ascendant`, `cc=Agadeem%27s+Awakening`) and a split
 * or double-backed card under both halves (`cc=Fire+%2F%2F+Ice`, `cc=Wear+%2F%2F+Tear`,
 * `cc=Temple+Garden+%2F%2F+Temple+Garden`, `cc=Punchcard+%2F%2F+Punchcard`) — all eight verified
 * against api.scryfall.com. `art_series` sits with the front-face group, not with the other
 * two-image layouts. The `tcgplayer_infinite_*` links in the same object keep the joined name on
 * EVERY layout, split included, so this rule is deliberately scoped to `edhrec` alone.
 */
const EDHREC_JOINED_LAYOUTS = new Set(["double_faced_token", "reversible_card", "split"]);

/**
 * Top-level keys a two-image layout does not carry, because they belong to a face there.
 *
 * `watermark` is deliberately NOT here — it is face-owned on EVERY faced layout, not only the
 * two-image ones. See FACED_OWNED_KEYS.
 */
const FACE_OWNED_KEYS = new Set([
	"colors",
	"card_back_id",
	"illustration_id",
	"power",
	"toughness",
	"loyalty",
	"flavor_text",
	"color_indicator",
]);

/**
 * Top-level keys ANY card with `card_faces` omits, two-image or not — the Rust twin is
 * `is_faced_owned_key` in card_object.rs.
 *
 * Just `watermark`, measured rather than reasoned: over the whole 2026-08-16 all_cards bulk
 * api.scryfall.com sends a top-level `watermark` on 36,437 printings and on 0 of the 12,098 with
 * `card_faces`. A split card like `Research // Development` (dis/155) is ONE image and one piece
 * of cardboard, so it never reached the two-image gate, and this port emitted a key Scryfall
 * sends on no faced printing at all — on all 156 of them that carry a face watermark.
 */
const FACED_OWNED_KEYS = new Set(["watermark"]);

// ─── reading an engine row ───────────────────────────────────────────────────
// `null` is the wire form of "Scryfall omitted this", so every accessor collapses it to undefined
// rather than letting it reach a response.

function str(row: EngineRow, key: string): string | undefined {
	const v = row[key];
	return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * Like `str`, but an empty string is a VALUE rather than an absence.
 *
 * Scryfall distinguishes the two and this port collapsed them: a basic land's `mana_cost` is `""`
 * on 61,908 of the 540,484 printings in the 2026-08-16 bulk, its `oracle_text` is `""` on 7,266,
 * and `artist` is `""` on 965 — and all three came out of here as `null`. The distinction is safe
 * to draw because the three keys are always PRESENT where they are emitted at all: `mana_cost` is
 * on every one of the 532,040 rows that is not a two-image layout, `oracle_text` on every one of
 * the 528,386 that is not multi-faced, and `artist` on all 540,484. An `undefined` from this
 * accessor is a row that carried no key at all, which only a hand-built one does.
 */
function strPresent(row: EngineRow, key: string): string | undefined {
	const v = row[key];
	return typeof v === "string" ? v : undefined;
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
	// IMAGE_EXTENSION_ENTRIES, not Object.entries(IMAGE_EXTENSIONS): this runs once per card and
	// again per face, so a /cards/search page called it 175+ times and allocated the same eleven
	// pairs every time.
	for (const [size, ext] of IMAGE_EXTENSION_ENTRIES) {
		out[size] = `https://cards.scryfall.io/${size}/${face}/${first}/${second}/${scryfallId}.${ext}${suffix}`;
	}
	return out;
}

// Characters Scryfall DELETES from a slug rather than hyphenating. Live-derived: "Erayo's
// Essence" slugs to `erayos-essence` (not `erayo-s-essence`), "S.H.I.E.L.D." to `shield`,
// `Henzie "Toolbox" Torre` to `henzie-toolbox-torre`, and the zhs printings of Kongming/Pang Tong
// pin the curly quotes. U+201E („) is NOT deleted — `Henzie „Der Beschaffer" Torre` (de) keeps it.
const SLUG_DELETED = new Set(["'", '"', ",", ".", "/", "“", "”"]);

// Slug bytes served literally; every other byte is UTF-8 percent-encoded, uppercase hex. The
// literal set is exactly what appears un-encoded across the bulk corpus (`!&()+-:;=_`); `?` is the
// one ASCII special observed encoded. Unobserved characters encode, which can never break a URL.
const SLUG_LITERAL = /[A-Za-z0-9!&()+\-:;=_]/;

/**
 * Scryfall's URL slug for a card name.
 *
 * NOT the folklore "non-alphanumerics collapse to hyphens" rule this port first shipped — that rule
 * hyphenates apostrophes (`erayo-s-essence`) and serves raw UTF-8 (`jötun-grunt`) where production
 * Scryfall deletes the apostrophe and percent-encodes the bytes. The real rule, verified against
 * the `scryfall_uri` of all 540,484 printings in the 2026-08-16 all_cards bulk (zero mismatches):
 *
 *   1. lowercase;
 *   2. DELETE `' " , . /` and the curly quotes U+201C/U+201D;
 *   3. each run of ASCII spaces becomes one hyphen — literal hyphens pass through and may stack
 *      (ru "Пламенник - военный разведчик" keeps `---`), and nothing is trimmed ("Humming-" and
 *      "With Great Power . . ." both keep their trailing hyphen);
 *   4. everything else survives verbatim (`:`, `!`, `&`, `、`, `・`, fullwidth punctuation, U+00A0)
 *      and is then UTF-8 percent-encoded per SLUG_LITERAL.
 */
export function slug(name: string): string {
	let cleaned = "";
	for (const ch of name.toLowerCase()) {
		if (SLUG_DELETED.has(ch)) continue;
		cleaned += ch;
	}
	const hyphenated = cleaned.replace(/ +/g, "-");
	let out = "";
	for (const byte of new TextEncoder().encode(hyphenated)) {
		const ch = String.fromCharCode(byte);
		out += SLUG_LITERAL.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return out;
}

/**
 * The languages Scryfall writes into the scryfall_uri path — its ten print localizations, exactly.
 * The glyph and novelty languages (ph, qya, he, la, grc, ar, sa, dw) get NO path segment: a ph
 * Elesh Norn lives at `/card/one/414/elesh-norn-mother-of-machines`, English form.
 */
const SLUG_LANG_SEGMENTS = new Set(["de", "es", "fr", "it", "ja", "ko", "pt", "ru", "zhs", "zht"]);

/**
 * Languages whose printed name never reaches the slug even when stored: the Phyrexian and Quenya
 * printings carry glyph-font `printed_name`s ("|Ceghm.", U+E0xx runs) and production serves them
 * the plain English slug. Every other non-English language — including he/grc/ar/sa, which lack
 * the path segment — keeps the `printed-(english)` slug form.
 */
const SLUG_PRINTED_IGNORED = new Set(["en", "ph", "qya"]);

/**
 * `scryfall_uri`: `https://scryfall.com/card/{set}/{number}[/{lang}]/{slug}?utm_source=api`.
 *
 * A foreign printing's slug is `slug(printed full name)-(slug(english full name))`, parentheses
 * literal. The printed full name is the top-level `printed_name` or, on a multi-face card, the
 * faces' `printed_name`s joined " // " — ONLY the faces that have one: the es printing of
 * sos/113, whose second face has no printed_name, slugs as
 * `em%C3%A9rita-del-conflicto-(emeritus-of-conflict-lightning-bolt)` (verified live). A foreign
 * printing with no printed name at all falls back to the plain English slug, keeping the language
 * segment (ody/243/zhs → `/zhs/holistic-wisdom`, verified live); one whose printed name slugs to
 * nothing takes the same fallback (live-unpinned — no such printing exists in the corpus).
 */
function scryfallUri(row: EngineRow, name: string, setCode: string, number: string, lang: string): string {
	const segment = SLUG_LANG_SEGMENTS.has(lang) ? `${lang}/` : "";
	let printedFull: string | undefined;
	if (!SLUG_PRINTED_IGNORED.has(lang)) {
		printedFull = str(row, "printed_name");
		if (printedFull === undefined) {
			const parts = (list(row, "card_faces") as EngineRow[])
				.map((face) => face.printed_name)
				.filter((v): v is string => typeof v === "string" && v !== "");
			if (parts.length > 0) printedFull = parts.join(" // ");
		}
	}
	const english = slug(name);
	const printed = printedFull === undefined ? "" : slug(printedFull);
	const path = printed === "" ? english : `${printed}-(${english})`;
	return `https://scryfall.com/card/${setCode}/${number}/${segment}${path}?utm_source=api`;
}

/**
 * Scryfall's `related_uris`, pointing at the destinations directly.
 *
 * Scryfall wraps the TCGplayer entries in `partner.tcgplayer.com/...?u=<encoded real URL>` with its
 * own affiliate code. The destination is the same page, and emitting the wrapper from this host
 * would route another service's affiliate revenue to Scryfall.
 *
 * `gatherer` LEADS the object when the printing has multiverse ids, built from the FIRST id, with
 * `printed=true` for every non-English printing and `printed=false` for English — verified against
 * the bulk corpus at 540,430 of 540,484 printings. The 54 exceptions are foreign-only promos
 * (dd2-ja, snc launch, one-ph, ltc-qya) whose Gatherer entries carry no translation; that fact
 * lives on Scryfall's side of the wire and is not derivable from the row, so they stay a known
 * limit rather than a rule.
 */
/** Python's `quote_plus`, which encodes a space as `+` where `encodeURIComponent` gives `%20`. */
function quotePlus(value: string): string {
	return encodeURIComponent(value)
		.replace(/%20/g, "+")
		.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * `edhrec` takes `edhrecName`, which is the front face's on most multi-face layouts — see
 * EDHREC_JOINED_LAYOUTS. The two tcgplayer searches take the joined name on every layout.
 */
function relatedUris(name: string, edhrecName: string, multiverseIds: unknown[], lang: string): Record<string, string> {
	const out: Record<string, string> = {};
	const firstId = multiverseIds[0];
	if (typeof firstId === "number") {
		const printed = lang === "en" ? "false" : "true";
		out.gatherer = `https://gatherer.wizards.com/Pages/Card/Details.aspx?multiverseid=${firstId}&printed=${printed}`;
	}
	const quoted = quotePlus(name);
	out.tcgplayer_infinite_articles = `https://www.tcgplayer.com/search/articles?productLineName=magic&q=${quoted}`;
	out.tcgplayer_infinite_decks = `https://www.tcgplayer.com/search/decks?productLineName=magic&q=${quoted}`;
	out.edhrec = `https://edhrec.com/route/?cc=${quotePlus(edhrecName)}`;
	return out;
}

/**
 * Scryfall's `purchase_uris`, rebuilt from the marketplace ids — or, for a key whose id this
 * printing does not have, from a NAME SEARCH on that marketplace. Same affiliate reasoning.
 *
 * All three keys are always present. The fallback is per KEY, not per card: an English printing
 * with TCGplayer and Cardmarket ids but no MTGO id gets two product links and a cardhoarder
 * search (verified live across khm). Every foreign printing takes the search form on all three —
 * marketplace product ids belong to the English printing and never reach an annex row.
 *
 * The search text is the FRONT FACE name (`Invasion of Alara`, not
 * `Invasion of Alara // Awaken the Maelstrom`): the joined name matches no product. Note that
 * `related_uris`' tcgplayer_infinite_* links do carry the joined name — verified live — so the
 * two are deliberately not the same string.
 */
function purchaseUris(row: EngineRow, name: string): Record<string, string> {
	const tcg = num(row, "tcgplayer_id");
	const cm = num(row, "cardmarket_id");
	const mtgo = num(row, "mtgo_id");
	const q = quotePlus(name.split(" // ")[0] as string);
	return {
		tcgplayer: tcg
			? `https://www.tcgplayer.com/product/${tcg}?page=1`
			: `https://www.tcgplayer.com/search/magic/product?productLineName=magic&q=${q}&view=grid`,
		cardmarket: cm
			? `https://www.cardmarket.com/en/Magic/Products?idProduct=${cm}`
			: `https://www.cardmarket.com/en/Magic/Products/Search?searchString=${q}`,
		cardhoarder: mtgo
			? `https://www.cardhoarder.com/cards/${mtgo}`
			: `https://www.cardhoarder.com/cards?data%5Bsearch%5D=${q}`,
	};
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
 * The joined top-level `mana_cost` a one-image multi-face card carries.
 *
 * Scryfall's rule, checked against all 3,654 split/flip/adventure/prepare printings in the
 * 2026-08-16 bulk with zero misses: `" // "` between the faces that HAVE a cost, skipping the ones
 * that do not. Fire // Ice is `"{1}{R} // {1}{U}"`; flipped Erayo, whose back face carries
 * `"mana_cost": ""`, is `"{1}{U}"` and not `"{1}{U} // "`.
 *
 * STILL DERIVED, though `mana_cost_text` now holds this exact string (`joined_face_cost` in the
 * builder, added for `mana:/…/`). Reading the column here would be wrong in the one direction that
 * matters: the column carries the join on EVERY faced layout because Scryfall's search index does,
 * while the card object carries it only on the one-image ones — so a column read would emit
 * `mana_cost` on transform/MDFC/reversible/art-series cards, where Scryfall sends no such key.
 * The two agree wherever the key exists (949 of 949 faced printings with a top-level `mana_cost`
 * in the 2026-08-28 bulk), and the caller's `twoImage` gate is what decides that they are asked.
 */
function joinedManaCost(stored: Record<string, unknown>[]): string {
	return stored
		.map((face) => face.mana_cost)
		.filter((v): v is string => typeof v === "string" && v !== "")
		.join(" // ");
}

/**
 * The card's faces, with the two keys the engine deliberately does not store re-added.
 *
 * `object` is the constant "card_face", and a face's `image_uris` is the card's CDN function with
 * front/back swapped — on the two-image layouts, which are the only ones whose faces have their
 * own picture.
 */
function faces(
	row: EngineRow,
	scryfallId: string,
	twoImage: boolean,
	// The card's `oracle_id` and `cmc`, written on EVERY face — passed only for a reversible
	// printing, which is the one layout whose faces carry them (and whose top-level object omits
	// them). Both faces of all 81 send the card's own values, never a second one.
	cardIds?: { oracle_id: string; cmc: number | null },
): Record<string, unknown>[] {
	const stored = list(row, "card_faces") as Record<string, unknown>[];
	return stored.map((face, index) => {
		const built: Record<string, unknown> = { object: "card_face", ...(cardIds ?? {}) };
		for (const [key, value] of Object.entries(face)) {
			// `colors` is a face key only where the faces own their own art: every face of every
			// two-image printing carries one, empty included (Agadeem, the Undercrypt is colorless
			// and still sends `"colors": []`), and no face of a split, flip, adventure or prepare
			// printing carries one at all. The engine always writes the key, so both halves of that
			// are decided here.
			if (key === "colors") {
				if (twoImage) built[key] = value;
				continue;
			}
			// Absent stays absent, the same filter upstream applies: a null, an empty string and an
			// empty list are all "Scryfall did not send this face that key" — EXCEPT for `mana_cost`
			// and `oracle_text`, where "" is a value Scryfall does send. Every face of every
			// multi-face printing in the corpus carries both keys (8,620 of 8,620 transform faces,
			// 4,356 of them with an empty cost), so an empty string there is a costless back face,
			// never an omission.
			if (value === null) continue;
			if (value === "" && key !== "mana_cost" && key !== "oracle_text") continue;
			if (Array.isArray(value) && value.length === 0) continue;
			built[key] = value;
		}
		if (twoImage) {
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
	const lang = str(row, "lang") ?? "en";
	const layout = str(row, "layout");
	const hasFaces = list(row, "card_faces").length > 0;
	// Only ever true for a card that HAS faces: the two-image layouts are all multi-face.
	const twoImage = hasFaces && layout !== undefined && TWO_IMAGE_LAYOUTS.has(layout);
	// A REVERSIBLE printing keeps NOTHING of the card at top level — not even the three keys every
	// other multi-face layout keeps. Measured across the whole 2026-08-16 all_cards bulk: all 81 of
	// them omit `oracle_id`, `cmc` and `type_line`, where a `transform` printing sends all three
	// (verified live on Delver of Secrets // Insectile Aberration). Its FACES carry their own
	// `oracle_id` and `cmc` instead — the card's, on both faces, 0 of 81 disagreeing — which is why
	// omitting the top-level pair loses nothing. Mirrors `REVERSIBLE_LAYOUT` in card_object.rs.
	const reversible = layout === "reversible_card";
	// The joined name everywhere except edhrec on the layouts EDHREC files by front face.
	const edhrecName =
		hasFaces && !(layout !== undefined && EDHREC_JOINED_LAYOUTS.has(layout)) ? (name.split(" // ")[0] as string) : name;
	const built = faces(
		row,
		scryfallId,
		twoImage,
		reversible ? { oracle_id: oracleId, cmc: num(row, "cmc") ?? null } : undefined,
	);

	const card: Record<string, unknown> = {
		object: "card",
		id: scryfallId,
		...(reversible ? {} : { oracle_id: oracleId }),
		multiverse_ids: list(row, "multiverse_ids"),
		name,
		// Between `name` and `lang`, where api.scryfall.com puts it (verified on grn/212/pt and
		// khm/1/ja) — and PRESENT only when the printing carries one, which is why these are
		// conditional spreads mid-literal rather than entries in the optional tail: the tail would
		// put them after `legalities`, and key position is part of the parity contract here the
		// same way security_stamp's position was (see the note in the tail below).
		...(str(row, "printed_name") !== undefined ? { printed_name: str(row, "printed_name") } : {}),
		// Scryfall's `flavor_name` — the alternate name a printing is SOLD under (Godzilla,
		// Stranger Things, the Secret Lair crossovers), which is a different thing from a
		// printed_name and can sit beside one. Its position is "immediately before `lang`" on all
		// 669 top-level occurrences in the 2026-08-16 all_cards bulk, verified live on prm/80925
		// (no printed_name) and sld/2236/ja (one). The FACE-level variant rides `card_faces`.
		...(str(row, "flavor_name") !== undefined ? { flavor_name: str(row, "flavor_name") } : {}),
		lang,
		released_at: str(row, "released_at") ?? null,
		uri: `${baseUrl}/cards/${scryfallId}`,
		scryfall_uri: scryfallUri(row, name, setCode, number, lang),
		layout: str(row, "layout") ?? null,
		highres_image: bool(row, "highres_image"),
		image_status: str(row, "image_status") ?? null,
		...(reversible ? {} : { cmc: num(row, "cmc") ?? null, type_line: str(row, "type_line") ?? null }),
		// Directly after the oracle `type_line` it translates, per the live objects.
		...(str(row, "printed_type_line") !== undefined ? { printed_type_line: str(row, "printed_type_line") } : {}),
		// Vanguard's two starting-total deltas, in Scryfall's own key position: measured on the live
		// object for `Akroma, Angel of Wrath Avatar` (61b07ae0), the order is
		// `oracle_text -> life_modifier -> hand_modifier -> colors`. Spread conditionally rather than
		// added to the optional tail for the reason `printed_name` is, one block up — the tail would
		// put them after `legalities`. Absent on every other layout, and all 119 printings that carry
		// them are `vanguard` and carry BOTH.
		...(str(row, "life_modifier") !== undefined ? { life_modifier: str(row, "life_modifier") } : {}),
		...(str(row, "hand_modifier") !== undefined ? { hand_modifier: str(row, "hand_modifier") } : {}),
		// `colors` is one of the values a two-image layout keeps on its faces alone (see
		// TWO_IMAGE_LAYOUTS); `color_identity` is the card's and stays at top level on every layout.
		...(twoImage ? {} : { colors: list(row, "colors") }),
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
		// No shared card back on a two-image layout, and no card-level illustration: both belong to
		// a face there, and Scryfall omits the top-level keys entirely.
		...(twoImage ? {} : { card_back_id: CARD_BACK_ID }),
		artist: strPresent(row, "artist") ?? null,
		...(twoImage ? {} : { illustration_id: str(row, "illustration_id") ?? null }),
		border_color: str(row, "border_color") ?? null,
		full_art: bool(row, "full_art"),
		textless: bool(row, "textless"),
		booster: bool(row, "booster"),
		story_spotlight: bool(row, "story_spotlight"),
		prices: prices(row),
		related_uris: relatedUris(name, edhrecName, list(row, "multiverse_ids"), lang),
		// A printing NO MARKETPLACE SELLS omits the key rather than carrying three dead links.
		// The rule is the marketplaces, not `digital` — measured 2026-08-16:
		//
		//   prm/80925   games ["mtgo"]   digital true    purchase_uris PRESENT  (cardhoarder)
		//   ymid/59     games ["arena"]  digital true    purchase_uris ABSENT
		//   khm/A-198   games ["arena"]  digital true    purchase_uris ABSENT
		//   msc/806     games paper,…    digital false   purchase_uris PRESENT
		//
		// so it is "paper or mtgo" — tcgplayer and cardmarket sell cardboard, cardhoarder sells
		// MTGO, and nothing sells Arena. `digital` would have dropped the key on prm/80925 too.
		// The mirror only meets this case because Arena printings are imported now (the `games`
		// clause left `passes_filters`); before that it could not have been wrong here.
		// ABSENT `games` emits: the omission is a positive statement ("this printing is sold
		// nowhere"), and a row that never carried the column has made no such statement.
		...(soldSomewhere(row) ? { purchase_uris: purchaseUris(row, name) } : {}),
	};

	// A multi-face card carries its faces and NOT the top-level ORACLE TEXT they replace; a
	// single-faced one carries the text and no `card_faces`. Which keys sit at top level varies by
	// LAYOUT, which is why this is a branch rather than a fixed key set.
	//
	// `mana_cost` and `image_uris` are the two the multi-face branch keeps, on the one-image
	// layouts only: one piece of cardboard has one picture and one printed cost, so Scryfall sends
	// both at top level for split/flip/adventure/prepare — and neither for transform/modal_dfc,
	// where each face has its own.
	if (built.length > 0) {
		card.card_faces = built;
		if (!twoImage) {
			card.mana_cost = joinedManaCost(list(row, "card_faces") as Record<string, unknown>[]);
			card.image_uris = imageUris(scryfallId, num(row, "image_updated_at"));
		}
	} else {
		// An empty string is a VALUE for both of these — every basic land carries
		// `"mana_cost": ""` and 7,266 printings carry `"oracle_text": ""` — so they read through
		// `strPresent` rather than the empty-is-absent `str`.
		card.mana_cost = strPresent(row, "mana_cost") ?? null;
		card.oracle_text = strPresent(row, "oracle_text") ?? null;
		// Directly after the `oracle_text` it translates — single-face only, like the text it
		// shadows; a multi-face printing's printed text rides its face objects.
		const printedText = str(row, "printed_text");
		if (printedText !== undefined) card.printed_text = printedText;
		card.image_uris = imageUris(scryfallId, num(row, "image_updated_at"));
	}

	// Keys Scryfall sends only when the card HAS them. Emitting null instead would differ from
	// Scryfall on every card that lacks them, which for most of these is most cards.
	const optional: [string, unknown][] = [
		["power", str(row, "power")],
		["toughness", str(row, "toughness")],
		// Where Scryfall puts it, right after the creature stats it is the planeswalker analogue of.
		// A STRING, because "X" and "1+*" are real printed loyalties — the `planeswalker_loyalty`
		// column that answers `loy:` is the integer parse of this and cannot round-trip either.
		["loyalty", str(row, "loyalty")],
		["flavor_text", str(row, "flavor_text")],
		["watermark", str(row, "watermark")],
		["frame", str(row, "frame")],
		["edhrec_rank", num(row, "edhrec_rank")],
		["penny_rank", num(row, "penny_rank")],
		["arena_id", num(row, "arena_id")],
		["mtgo_id", num(row, "mtgo_id")],
		["mtgo_foil_id", num(row, "mtgo_foil_id")],
		["tcgplayer_id", num(row, "tcgplayer_id")],
		["tcgplayer_etched_id", num(row, "tcgplayer_etched_id")],
		["cardmarket_id", num(row, "cardmarket_id")],
		// After the ids, where upstream's dict literal puts it. This sat up with the other strings
		// here, which made the two implementations disagree on key order for every card that has a
		// security stamp — cosmetic, but upstream is the reference for a port, so this moved.
		["security_stamp", str(row, "security_stamp")],
		// `produced_mana` joins them: the engine has always stored the mana a card can make (the
		// `produces:` filter reads the same byte) and no card object ever carried it, so every land
		// this port served was missing a key Scryfall sends. On a modal DFC it is the union over the
		// faces, which is what the store already holds.
		// ...and `color_indicator` beside it, the printed colour dot on a card whose mana cost cannot
		// state its colours (a meld result, a coloured back). 546 printings carry one; this port
		// emitted the key on none of them.
		["color_indicator", listOrAbsent(row, "color_indicator")],
		["produced_mana", listOrAbsent(row, "produced_mana")],
		["promo_types", listOrAbsent(row, "promo_types")],
		["frame_effects", listOrAbsent(row, "frame_effects")],
		["all_parts", listOrAbsent(row, "all_parts")],
		["legalities", row.legalities ?? undefined],
	];
	for (const [key, value] of optional) {
		// Four of the string keys above belong to a face on a two-image layout; `frame` is the
		// printing's and stays. See FACE_OWNED_KEYS.
		if (twoImage && FACE_OWNED_KEYS.has(key)) continue;
		// ...and `watermark` belongs to a face on EVERY faced layout. See FACED_OWNED_KEYS.
		if (hasFaces && FACED_OWNED_KEYS.has(key)) continue;
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
	warnings?: string[] | null;
}

/**
 * Scryfall's error object.
 *
 * `warnings` sits BEFORE `details`, which is Scryfall's own key order — measured on every error
 * body that carries one (`/cards/search?q=f:notaformat` and `/cards/search` with no `q` at all,
 * 2026-08-16): `{object, code, status, warnings, details}`. This used to append it last, so a
 * client comparing bodies byte for byte saw a different document for the same answer.
 *
 * `null` and `undefined` are DIFFERENT arguments. Scryfall writes `"warnings": null` on a
 * `bad_request` from `/cards/search` even when nothing was warned about, and writes no key at all
 * on a `not_found`, a `validation_error`, or `/cards/named`'s missing-parameter 400 — so the
 * caller says which shape it means rather than having it inferred from emptiness.
 */
export function errorObject(code: string, status: number, details: string, warnings?: string[] | null): ScryfallError {
	const error: Record<string, unknown> = { object: "error", code, status };
	if (warnings !== undefined) error.warnings = warnings !== null && warnings.length > 0 ? warnings : null;
	error.details = details;
	return error as ScryfallError;
}

export function notFoundError(details: string): ScryfallError {
	return errorObject("not_found", 404, details);
}

export function badRequestError(details: string, warnings?: string[] | null): ScryfallError {
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
 * The one definition of a List's key order, for both envelopes Scryfall answers with.
 *
 * `has_more` is written IFF the caller supplies one. That is the ONLY difference between the two,
 * and it is a difference in the key set rather than in the value — see `collectionList`. Every
 * other key keeps its position here so the two envelopes cannot drift apart.
 */
function listObject(cards: unknown[], opts: CardListOptions): Record<string, unknown> {
	const result: Record<string, unknown> = { object: "list" };
	if (opts.totalCards !== undefined) result.total_cards = opts.totalCards;
	if (opts.notFound !== undefined) result.not_found = opts.notFound;
	if (opts.hasMore !== undefined) result.has_more = opts.hasMore;
	if (opts.nextPage !== undefined) result.next_page = opts.nextPage;
	if (opts.warnings && opts.warnings.length > 0) result.warnings = opts.warnings;
	result.data = cards;
	return result;
}

/**
 * Scryfall's paginated List object.
 *
 * Key order follows Scryfall's own so a byte-comparing client sees the same document. `has_more`
 * is always present — a paginated list says whether there is more even when there is not.
 */
export function cardList(cards: unknown[], opts: CardListOptions = {}): Record<string, unknown> {
	return listObject(cards, { ...opts, hasMore: opts.hasMore ?? false });
}

/**
 * The List `POST /cards/collection` answers with: `{object, not_found, data}` and NO `has_more`.
 *
 * Measured against api.scryfall.com on 2026-08-16 — every collection response's key set is exactly
 * those three, whether or not anything was found. It is the one List Scryfall does not paginate:
 * the request carries at most 75 identifiers and the answer carries all of them, so there is no
 * further page for a `has_more` to describe.
 *
 * A separate entry point rather than a `hasMore: undefined` at the call site, because omitting a
 * key is the kind of thing an options bag hides: `cardList(found, { notFound })` used to read as
 * correct and quietly emitted `has_more: false`. Both build the same object through `listObject`,
 * so the key ORDER still has exactly one definition.
 */
export function collectionList(cards: unknown[], notFound: unknown[]): Record<string, unknown> {
	return listObject(cards, { notFound });
}

/**
 * Scryfall's Catalog object.
 *
 * `uri` is present IFF the caller passes one, and the two callers genuinely differ — measured
 * against api.scryfall.com on 2026-08-12: `/catalog/battle-types` answers
 * `{"object":"catalog","uri":"…","total_values":1,"data":["Siege"]}` while `/cards/autocomplete`
 * answers the same object with no `uri` at all. Upstream's `catalog_object` takes no uri, so its
 * `/catalog/*` responses are missing the key; reported against #922.
 *
 * The uri points at api.scryfall.com rather than at this host, which is the rule the card objects
 * already follow: a self-referencing URI is part of the payload, not pagination.
 */
export function catalogObject(values: string[], uri?: string): Record<string, unknown> {
	const result: Record<string, unknown> = { object: "catalog" };
	if (uri !== undefined) result.uri = uri;
	result.total_values = values.length;
	result.data = values;
	return result;
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

/**
 * `next_page` with `include_multilingual` set to what the query RESOLVED to.
 *
 * Scryfall echoes the effective value, not the one the client sent: a `lang:` leaf in `q` widens
 * the query on its own and its `next_page` then says `include_multilingual=true` even though the
 * request carried no such parameter (measured 2026-08-16 on `e:khm lang:ja unique=cards`).
 *
 * The route cannot decide this for itself. Whether a query widens is settled inside the engine at
 * filter-compile time — `include_multilingual` OR a `card_lang` leaf in the BOUND filter — and
 * re-implementing that detection in TypeScript is exactly the drift the one-implementation rule
 * exists to prevent. So the engine reports what it did (`QueryOutput::widened`, on the search
 * envelope's header line) and this rewrites the one parameter.
 *
 * A targeted replacement rather than a rebuild: the URL was already built with every other
 * resolved value, and `buildPageUrl` sorts its parameters, so re-deriving it here would mean
 * carrying the whole parameter set across the engine boundary to change one flag.
 */
export function withResolvedMultilingual(url: string | undefined, widened: boolean): string | undefined {
	if (url === undefined || !widened) return url;
	return url.replace("include_multilingual=false", "include_multilingual=true");
}

// ─── format=text and format=image ────────────────────────────────────────────

/** The requested face of a card, falling back to the card itself. */
function faceOf(card: Record<string, unknown>, face: string): Record<string, unknown> {
	const list_ = (card.card_faces as Record<string, unknown>[] | undefined) ?? [];
	const back = list_[1];
	if (face === "back" && back !== undefined) return back;
	return card;
}

/**
 * The image URL for a card at a given size and face, or undefined when it has none.
 *
 * An UNRECOGNIZED `version` falls back to the default size rather than missing: measured
 * 2026-08-16, `?format=image&version=bogus` 302s to the same `large` front image `?format=image`
 * alone does, and `&face=sideways` likewise redirects to the front. This port answered
 * `404 "No image is available for this card in that version."` to the first of those — a sentence
 * about the CARD, for a mistake in the URL, on a card whose image is right there. `faceOf` already
 * had the face half of the rule; only the version half was missing.
 *
 * The 404 stays for the case it was written for: a card that genuinely carries no image map, where
 * even the default size has nothing to point at.
 */
export function imageUri(card: Record<string, unknown>, version: string, face: string): string | undefined {
	const selected = faceOf(card, face);
	const uris = (selected.image_uris ?? card.image_uris ?? {}) as Record<string, string>;
	return uris[version] ?? uris[DEFAULT_IMAGE_VERSION];
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
