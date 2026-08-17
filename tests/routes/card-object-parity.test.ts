// The gate on building Scryfall card objects in the engine.
//
// `toScryfallCard` (TypeScript) is the implementation this port has shipped and every /cards/*
// test pins. `card_object.rs` (Rust) is the replacement, which exists because building 175 card
// objects per page in the Durable Object costs it a parse and a re-encode of the whole payload —
// and the Durable Object's CPU is very nearly a pure function of payload bytes.
//
// A replacement that is "basically the same" is not good enough here: the route splices the
// engine's bytes straight into a response envelope without parsing them, so any divergence ships
// to clients unexamined. So this compares them BYTE FOR BYTE, including key order, over rows built
// to break each part in turn.
//
// Unlike the rest of tests/, this one instantiates the real wasm engine. It can, because the
// builder is a pure function of a row and a base URL and needs no store loaded.

import { describe, expect, test } from "bun:test";
import * as bg from "../../engine/wasm/pkg/sylvan_engine_wasm_bg.js";
import { CARD_OBJECT_FIELDS, toScryfallCard } from "../../src/routes/scryfall-compat/objects";
import { stringifyScryfall } from "../../src/routes/scryfall-compat/respond";

// Instantiated here rather than through src/engine/wasm-shim.ts: that shim's `.wasm` import
// resolves to a WebAssembly.Module only under wrangler's CompiledWasm rule, and Bun hands back
// something else. Same two steps the shim performs, against bytes read from disk.
const wasmBytes = await Bun.file(
	new URL("../../engine/wasm/pkg/sylvan_engine_wasm_bg.wasm", import.meta.url),
).arrayBuffer();
// `WebAssembly.Module` is typed abstract by bun-types, so the constructor is reached through the
// namespace value rather than the type. Runtime behaviour is the ordinary one.
const WasmModule = (WebAssembly as unknown as { Module: new (b: ArrayBuffer) => WebAssembly.Module }).Module;
const instance = new WebAssembly.Instance(new WasmModule(wasmBytes), {
	"./sylvan_engine_wasm_bg.js": bg,
});
(bg as { __wbg_set_wasm: (e: unknown) => void }).__wbg_set_wasm(instance.exports);
(instance.exports as { __wbindgen_start?: () => void }).__wbindgen_start?.();
const scryfall_card_from_row = (bg as unknown as { scryfall_card_from_row: (r: string, b: string) => string })
	.scryfall_card_from_row;

const BASE = "https://sylvan.example/api";

/** A minimal row: almost everything absent, which is the case that decides omit-vs-null. */
const MINIMAL: Record<string, unknown> = {
	scryfall_id: "aaaaaaaa-0000-0000-0000-000000000001",
	oracle_id: "bbbbbbbb-0000-0000-0000-000000000001",
	name: "Llanowar Elves",
	set_code: "m19",
	collector_number: "314",
};

/**
 * Everything present, including all six prices and every optional key — for an ENGLISH printing.
 * `lang: "en"` is deliberate, not an oversight: the printed triple is absent by contract on
 * English rows (Scryfall never stores one), so "every optional key" here means every key an
 * English card can carry. FULL_FOREIGN below is the foreign twin that adds the printed triple.
 */
const FULL: Record<string, unknown> = {
	...MINIMAL,
	layout: "normal",
	mana_cost: "{G}",
	cmc: 1.0,
	type_line: "Creature — Elf Druid",
	oracle_text: "{T}: Add {G}.",
	power: "1",
	toughness: "1",
	colors: ["G"],
	color_identity: ["G"],
	card_keywords: ["Flying", "Haste"],
	games: ["paper", "mtgo"],
	finishes: ["nonfoil", "foil"],
	card_is_tags: ["reserved", "reprint"],
	set_id: "cccccccc-0000-0000-0000-000000000001",
	set_name: "Core Set 2019",
	set_type: "core",
	rarity: "common",
	artist: "Chris Rahn",
	illustration_id: "dddddddd-0000-0000-0000-000000000001",
	border_color: "black",
	frame: "2015",
	image_status: "highres_scan",
	lang: "en",
	released_at: "2018-07-13",
	highres_image: true,
	oversized: false,
	promo: true,
	reprint: true,
	variation: false,
	digital: false,
	full_art: false,
	textless: false,
	booster: true,
	story_spotlight: false,
	flavor_text: "Elves of the Llanowar forest.",
	// A creature with a loyalty is not a real card, but FULL's contract is "every optional key
	// present" — and while it silently lacked this one, both assertions below passed over a key
	// the Rust builder never wrote. See the planeswalker case for the shape a real card has.
	loyalty: "3",
	watermark: "set",
	security_stamp: "oval",
	edhrec_rank: 42,
	penny_rank: 7,
	arena_id: 1001,
	mtgo_id: 2002,
	mtgo_foil_id: 3003,
	tcgplayer_id: 4004,
	tcgplayer_etched_id: 5005,
	cardmarket_id: 6006,
	multiverse_ids: [12345, 12346],
	produced_mana: ["G"],
	promo_types: ["boosterfun"],
	frame_effects: ["extendedart"],
	image_updated_at: 1700000000,
	price_usd: 0.5,
	price_usd_foil: 1.25,
	price_usd_etched: 2,
	price_eur: 0.4,
	price_eur_foil: 1.1,
	price_tix: 0.03,
	legalities: { standard: "not_legal", modern: "legal", commander: "legal" },
	all_parts: [{ object: "related_card", id: "eeeeeeee-0000-0000-0000-000000000001", component: "token" }],
};

/**
 * FULL's foreign twin: a ja printing carrying the whole printed triple, its own multiverse ids,
 * and CJK text with fullwidth punctuation, a newline and quotes — the JSON-escaping surface where
 * the Rust writer (serde_json, raw UTF-8) and `stringifyScryfall` (JSON.stringify, raw UTF-8)
 * must agree byte for byte.
 */
const FULL_FOREIGN: Record<string, unknown> = {
	...FULL,
	lang: "ja",
	printed_name: "ラノワールのエルフ",
	printed_type_line: "クリーチャー — エルフ・ドルイド",
	printed_text: "（Ｔ）：（緑）を加える。\n「森は我らの言葉を話す。」",
	multiverse_ids: [503618],
};

const CASES: [string, Record<string, unknown>][] = [
	["minimal row, almost everything absent", MINIMAL],
	["full row, every optional present", FULL],

	// Vanguard, the only layout carrying `life_modifier`/`hand_modifier` — 119 printings and 107
	// oracle cards over the whole 2026-08-16 all_cards bulk, and nothing else in the corpus. Its
	// own case rather than two more keys on FULL, because these two are layout-coupled where every
	// FULL key is not, and because the values are SIGNED STRINGS whose sign is always printed:
	// "+0" is the zero, never a bare "0", so a writer that reformatted them would round-trip the
	// negatives and lose the plus.
	[
		"vanguard, life/hand modifiers",
		{ ...MINIMAL, name: "Akroma, Angel of Wrath Avatar", layout: "vanguard", life_modifier: "+7", hand_modifier: "+1" },
	],
	[
		"vanguard, negative and signed-zero modifiers",
		{ ...MINIMAL, name: "Sisters of Stone Death Avatar", layout: "vanguard", life_modifier: "-8", hand_modifier: "+0" },
	],

	// The slug and quote_plus paths, which are where a careless port drifts. Non-ASCII must
	// percent-encode identically in the slug (j%C3%B6tun) while quote_plus keeps its own safe set
	// (`!'()*` escape, `~` does not); apostrophes and periods DELETE from slugs rather than
	// hyphenating (erayos-essence, shield — the live rule, see slug() in objects.ts).
	["non-ASCII name (Æ, ö)", { ...FULL, name: "Æther Vial // Jötun Grunt" }],
	["name with quote_plus-sensitive punctuation", { ...FULL, name: "Yawgmoth's Will (Alt!) ~ *test*" }],
	["apostrophes delete from the slug", { ...FULL, name: "Erayo, Soratami Ascendant // Erayo's Essence" }],
	["deleted-set punctuation (periods, quotes)", { ...FULL, name: 'S.H.I.E.L.D. "Toolbox", Mk. II' }],
	["kept-set punctuation and literal hyphens", { ...FULL, name: "Summon: Choco/Mog & Co. - Deluxe!" }],
	["name of nothing but punctuation", { ...FULL, name: "!!! ??? ---" }],
	["name with runs of separators", { ...FULL, name: "  Fire  //  Ice  " }],

	// Prices: the formatting is `.2f`, so integers, long decimals and zero all matter, and a
	// missing price is null rather than "0.00".
	["prices needing rounding and padding", { ...FULL, price_usd: 1, price_eur: 0.005, price_tix: 12.999 }],
	["zero price is a price, not an absence", { ...FULL, price_usd: 0, price_eur: 0 }],
	["no prices at all", { ...MINIMAL, name: "Llanowar Elves" }],

	// Faces: single-face gets top-level text and image_uris; multi-face gets neither, and each
	// face gets its own front/back image_uris. Empty values inside a face stay absent.
	[
		"two faces",
		{
			...FULL,
			card_faces: [
				{ name: "Delver of Secrets", mana_cost: "{U}", oracle_text: "At the beginning...", power: "1" },
				{ name: "Insectile Aberration", mana_cost: "", oracle_text: "Flying", colors: [], watermark: null },
			],
		},
	],
	[
		"one face only — no image_uris on the face",
		{ ...FULL, card_faces: [{ name: "Adventure Half", mana_cost: "{1}{G}" }] },
	],
	["empty card_faces behaves as single-faced", { ...FULL, card_faces: [] }],

	// ─── layout classes ──────────────────────────────────────────────────────────
	//
	// WHERE a multi-face card's picture lives — and with it its colors, power, illustration and
	// flavor — is a property of the LAYOUT, not of the face count. The five two-image layouts put
	// all of it on the faces and send no top-level copy and no card_back_id; the one-image layouts
	// send one picture, one joined mana_cost and one set of top-level values, and their faces carry
	// text only. Each fixture below is shaped like the live object it is named for (see the
	// TWO_IMAGE_LAYOUTS note in objects.ts for the corpus-wide verification).
	[
		"split — one image, joined mana_cost, faceless colors",
		{
			...FULL,
			layout: "split",
			name: "Fire // Ice",
			colors: ["R", "U"],
			mana_cost: "{1}{R}",
			type_line: "Instant // Instant",
			illustration_id: "dddddddd-0000-0000-0000-00000000000f",
			power: undefined,
			toughness: undefined,
			loyalty: undefined,
			card_faces: [
				{ name: "Fire", mana_cost: "{1}{R}", type_line: "Instant", oracle_text: "Fire deals 2 damage." },
				{ name: "Ice", mana_cost: "{1}{U}", type_line: "Instant", oracle_text: "Tap target permanent." },
			],
		},
	],
	[
		"flip — a costless back face keeps its empty mana_cost",
		{
			...FULL,
			layout: "flip",
			name: "Erayo, Soratami Ascendant // Erayo's Essence",
			card_faces: [
				{ name: "Erayo, Soratami Ascendant", mana_cost: "{1}{U}", oracle_text: "Flying", power: "1", toughness: "1" },
				{ name: "Erayo's Essence", mana_cost: "", oracle_text: "Counter that spell." },
			],
		},
	],
	[
		"adventure — edhrec takes the front face, tcgplayer the joined name",
		{
			...FULL,
			layout: "adventure",
			name: "Brazen Borrower // Petty Theft",
			card_faces: [
				{ name: "Brazen Borrower", mana_cost: "{1}{U}{U}", type_line: "Creature — Faerie Rogue", power: "3" },
				{ name: "Petty Theft", mana_cost: "{1}{U}", type_line: "Instant — Adventure", oracle_text: "Return it." },
			],
		},
	],
	[
		"transform — two images, nothing hoisted to the top level",
		{
			...FULL,
			layout: "transform",
			name: "Delver of Secrets // Insectile Aberration",
			card_faces: [
				{ name: "Delver of Secrets", mana_cost: "{U}", colors: ["U"], power: "1", toughness: "1" },
				{
					name: "Insectile Aberration",
					mana_cost: "",
					colors: ["U"],
					power: "3",
					toughness: "2",
					flavor_text: "I feel no fear.",
					illustration_id: "dddddddd-0000-0000-0000-000000000002",
				},
			],
		},
	],
	[
		"modal_dfc — a colorless back face still carries its empty colors",
		{
			...FULL,
			layout: "modal_dfc",
			name: "Agadeem's Awakening // Agadeem, the Undercrypt",
			colors: ["B"],
			color_identity: ["B"],
			produced_mana: ["B"],
			card_faces: [
				{ name: "Agadeem's Awakening", mana_cost: "{X}{B}{B}{B}", colors: ["B"], type_line: "Sorcery" },
				{ name: "Agadeem, the Undercrypt", mana_cost: "", colors: [], type_line: "Land" },
			],
		},
	],
	[
		"prepare (es) — printed name on the front face only",
		{
			...FULL,
			layout: "prepare",
			lang: "es",
			name: "Emeritus of Conflict // Lightning Bolt",
			mana_cost: "{1}{R}",
			card_faces: [
				{ name: "Emeritus of Conflict", mana_cost: "{1}{R}", printed_name: "Emérita del conflicto", power: "2" },
				{ name: "Lightning Bolt", mana_cost: "{R}", oracle_text: "Deals 3 damage to any target." },
			],
		},
	],
	[
		"double_faced_token — two images AND the joined edhrec name",
		{
			...FULL,
			layout: "double_faced_token",
			name: "Punchcard // Punchcard",
			card_faces: [
				{ name: "Punchcard", mana_cost: "", colors: [], type_line: "Token" },
				{ name: "Punchcard", mana_cost: "", colors: [], type_line: "Token" },
			],
		},
	],
	[
		"reversible_card — joined edhrec name, per-face art",
		{
			...FULL,
			layout: "reversible_card",
			name: "Temple Garden // Temple Garden",
			produced_mana: ["G", "W"],
			card_faces: [
				{ name: "Temple Garden", mana_cost: "", colors: [], illustration_id: "dddddddd-0000-0000-0000-000000000003" },
				{ name: "Temple Garden", mana_cost: "", colors: [], illustration_id: "dddddddd-0000-0000-0000-000000000004" },
			],
		},
	],
	[
		"art_series — two images but the FRONT-face edhrec name",
		{
			...FULL,
			layout: "art_series",
			name: "Iceman and Firestar // Iceman and Firestar",
			card_faces: [
				{ name: "Iceman and Firestar", mana_cost: "", oracle_text: "", colors: [] },
				{ name: "Iceman and Firestar", mana_cost: "", oracle_text: "", colors: [] },
			],
		},
	],
	[
		"meld — single-faced, so every value stays at the top level",
		{
			...FULL,
			layout: "meld",
			name: "Hanweir Garrison",
			all_parts: [
				{ object: "related_card", id: "eeeeeeee-0000-0000-0000-000000000002", component: "meld_part" },
				{ object: "related_card", id: "eeeeeeee-0000-0000-0000-000000000003", component: "meld_result" },
			],
		},
	],
	// The printed colour dot: present on a meld result whose mana cost cannot state its colours,
	// and OMITTED at top level on a two-image layout, where it belongs to a face.
	[
		"meld back — a printed color_indicator",
		{
			...FULL,
			layout: "meld",
			name: "Mishra, Lost to Phyrexia",
			mana_cost: undefined,
			colors: ["B", "R"],
			color_indicator: ["B", "R"],
			type_line: "Legendary Artifact Creature — Phyrexian Artificer",
		},
	],
	[
		"transform — the color_indicator rides the face, not the card",
		{
			...FULL,
			layout: "transform",
			name: "Delver of Secrets // Insectile Aberration",
			color_indicator: ["U"],
			card_faces: [
				{ name: "Delver of Secrets", mana_cost: "{U}", colors: ["U"] },
				{ name: "Insectile Aberration", mana_cost: "", colors: ["U"], color_indicator: ["U"] },
			],
		},
	],
	// The empty string is a VALUE, not an absence, on the three keys Scryfall always sends: a basic
	// land's mana_cost and oracle_text and, on 965 printings, the artist. All three used to come out
	// of both builders as `null`.
	[
		"basic land — empty mana_cost and oracle_text are values",
		{
			...FULL,
			name: "Forest",
			type_line: "Basic Land — Forest",
			mana_cost: "",
			oracle_text: "",
			power: undefined,
			toughness: undefined,
		},
	],
	["artist is an empty string, not an absence", { ...FULL, artist: "" }],
	// A card's `artist` and its FACES' artists are independent values, and both builders must emit
	// them that way. The store used to conflate them: the multi-face merge overlays each face on
	// the parent dict with the face winning, so face 0's artist overwrote the card's and Fire //
	// Ice went out as "David Martin" instead of Scryfall's "David Martin & Franz Vohwinkel"
	// (generation 27). The row arrives correct now, so what these two pin is that nothing
	// downstream re-derives the top-level value from the faces — a joined credit passes through
	// whole, and a shared one is NOT doubled into "Nils Hamm & Nils Hamm".
	[
		"two artists: the card's joined credit and each face's own",
		{
			...FULL,
			name: "Fire // Ice",
			layout: "split",
			type_line: "Instant // Instant",
			artist: "David Martin & Franz Vohwinkel",
			card_faces: [
				{ name: "Fire", mana_cost: "{1}{R}", artist: "David Martin" },
				{ name: "Ice", mana_cost: "{1}{U}", artist: "Franz Vohwinkel" },
			],
		},
	],
	[
		"one artist across two faces is never doubled",
		{
			...FULL,
			name: "Delver of Secrets // Insectile Aberration",
			layout: "transform",
			artist: "Nils Hamm",
			card_faces: [
				{ name: "Delver of Secrets", mana_cost: "{U}", artist: "Nils Hamm" },
				{ name: "Insectile Aberration", mana_cost: "", artist: "Nils Hamm" },
			],
		},
	],
	// ...while an ABSENT key on the same three is still null, which is what a hand-built row gives.
	["absent mana_cost and oracle_text are still null", { ...MINIMAL, artist: undefined }],
	// produced_mana on the card that actually has it, and its absence on the card that does not:
	// the key is omitted, never sent empty.
	[
		"a land's produced_mana",
		{ ...FULL, name: "Ancient Tomb", type_line: "Land", produced_mana: ["C"], colors: [], mana_cost: undefined },
	],
	["no produced_mana at all", { ...FULL, produced_mana: [] }],

	// The printed triple, in every presence shape the corpus has (varies per face per printing —
	// absence must round-trip exactly, never English-filled), plus the foreign scryfall_uri form:
	// `/{set}/{number}/{lang}/{slug(printed)}-({slug(english)})` with the whole slug
	// percent-encoded, and gatherer's `&printed=true` for non-en.
	["foreign printing, full printed triple (ja)", FULL_FOREIGN],
	["printed_name only, no printed type or text", { ...FULL, lang: "es", printed_name: "Elfos de Llanowar" }],
	[
		"printed name and text without printed type line",
		{ ...FULL, lang: "pt", printed_name: "Elfos de Llanowar", printed_text: "{T}: Adicione {G}." },
	],
	["foreign row with no printed fields at all", { ...FULL, lang: "zhs" }],
	// An ARENA-ONLY printing omits `purchase_uris` — no marketplace sells one, and Scryfall sends
	// the key on no such card (khm/A-198, ymid/59, measured 2026-08-16). The MTGO-only twin below
	// is the other half of the rule: cardhoarder does sell those, so prm/80925 keeps the key, and
	// a `digital`-based rule would have dropped it. Reachable at all only because these printings
	// are imported now; see passes_filters.
	["arena-only printing omits purchase_uris", { ...FULL, digital: true, games: ["arena"] }],
	["mtgo-only printing keeps purchase_uris", { ...FULL, digital: true, games: ["mtgo"] }],
	// `flavor_name`: the alternate SOLD-AS name, which sits immediately before `lang` on every one
	// of the 669 top-level occurrences in the 2026-08-16 all_cards bulk — after `printed_name`
	// when there is one (sld/2236/ja) and after `name` when there is not (prm/80925). Both shapes
	// are here because the position is the whole parity contract for a key with no other behavior.
	["flavor name, no printed name (the Godzilla shape)", { ...FULL, flavor_name: "Godzilla, Primeval Champion" }],
	[
		"flavor name beside a printed name",
		{ ...FULL, lang: "ja", printed_name: "原初の潮流、ネザール", flavor_name: "海洋の支配者ラギアクルス" },
	],
	// ph/qya glyph printings: production ignores the stored glyph printed_name and drops the lang
	// path segment (one/414's ph Elesh Norn serves the plain English slug).
	["phyrexian printing ignores its glyph printed name", { ...FULL, lang: "ph", printed_name: "|Ceghm." }],
	// A printed name of only deleted characters slugs to nothing; the fallback to the plain
	// English slug (keeping the /fr/ segment) is LIVE-UNPINNED — no such printing exists in the
	// 2026-08-16 corpus — chosen to match the pinned no-printed-name fallback (ody/243/zhs).
	["printed name that slugs to nothing", { ...FULL, lang: "fr", printed_name: '"..."' }],
	// FACE-level `flavor_name`: Scryfall puts it on the faces of a `transform` or
	// `reversible_card` printing (vow/338 is "Dracula, Lord of Blood" // "Dracula, Lord of Bats"),
	// never beside a card-level one. Presence is per FACE, like the printed triple.
	[
		"face-level flavor names on a transform printing",
		{
			...FULL,
			layout: "transform",
			card_faces: [
				{ name: "Voldaren Bloodcaster", flavor_name: "Dracula, Lord of Blood", mana_cost: "{1}{B}", power: "1" },
				{ name: "Bloodbat Summoner", flavor_name: "Dracula, Lord of Bats", type_line: "Creature — Vampire" },
			],
		},
	],
	// ...and only one face carrying one, which is the shape the absence filter has to keep exact.
	[
		"face-level flavor name on the front face only",
		{
			...FULL,
			layout: "transform",
			card_faces: [
				{ name: "Voldaren Bloodcaster", flavor_name: "Dracula, Lord of Blood", mana_cost: "{1}{B}" },
				{ name: "Bloodbat Summoner", type_line: "Creature — Vampire" },
			],
		},
	],
	[
		"two es faces, both fully printed (transform shape)",
		{
			...FULL,
			lang: "es",
			layout: "transform",
			name: "Delver of Secrets // Insectile Aberration",
			card_faces: [
				{
					name: "Delver of Secrets",
					mana_cost: "{U}",
					oracle_text: "At the beginning of your upkeep...",
					printed_name: "Descifrador de secretos",
					printed_type_line: "Criatura — Hechicero humano",
					printed_text: "Al comienzo de tu mantenimiento...",
				},
				{
					name: "Insectile Aberration",
					oracle_text: "Flying",
					printed_name: "Aberración insectil",
					printed_type_line: "Criatura — Aberración humana",
					printed_text: "Vuela.",
				},
			],
		},
	],
	// The es printing of sos/113: the first face has ONLY a printed name, the second nothing —
	// and the joined printed slug uses only the faces that have one (verified live:
	// em%C3%A9rita-del-conflicto-(emeritus-of-conflict-lightning-bolt)).
	[
		"es prepare faces: first printed-name-only, second nothing",
		{
			...FULL,
			lang: "es",
			layout: "prepare",
			name: "Emeritus of Conflict // Lightning Bolt",
			card_faces: [{ name: "Emeritus of Conflict", printed_name: "Emérita del conflicto" }, { name: "Lightning Bolt" }],
		},
	],
	// gatherer: FULL pins the en form (printed=false, FIRST of its two multiverse ids) and
	// FULL_FOREIGN the non-en form; an empty id list emits no gatherer at all, distinct from
	// MINIMAL where the key is absent entirely.
	["no multiverse ids — no gatherer", { ...FULL, multiverse_ids: [] }],

	// Loyalty, in the shape a real card has it: a planeswalker carries one and has no creature
	// stats, so this pins that the key survives on its own rather than only trailing a toughness.
	// The printed value is a STRING — "X" and "1+*" are real, and the integer column that answers
	// `loy:` cannot round-trip either.
	[
		"planeswalker — loyalty, no power/toughness",
		{
			...FULL,
			name: "Jace Beleren",
			type_line: "Legendary Planeswalker — Jace",
			power: undefined,
			toughness: undefined,
			loyalty: "3",
		},
	],
	["loyalty that is not a number", { ...FULL, power: undefined, toughness: undefined, loyalty: "1+*" }],

	// Ids: purchase_uris only carries the ones present, and a zero id is not an id.
	["no marketplace ids", { ...FULL, tcgplayer_id: undefined, cardmarket_id: undefined, mtgo_id: undefined }],
	["zero marketplace ids", { ...FULL, tcgplayer_id: 0, cardmarket_id: 0, mtgo_id: 0 }],

	// Absent vs empty: an empty string, an empty list and a null all mean "not answered".
	["empty strings are absent", { ...FULL, watermark: "", flavor_text: "", frame: "", security_stamp: "" }],
	["empty lists are absent", { ...FULL, promo_types: [], frame_effects: [], all_parts: [] }],
	["no set_id — set_uri is null", { ...FULL, set_id: undefined }],
	["no image_updated_at — no cache-buster", { ...FULL, image_updated_at: undefined }],
	["no id at all — image_uris is empty", { ...FULL, scryfall_id: "" }],

	// Text that has to survive JSON escaping identically on both sides.
	["oracle text with quotes, newlines and a backslash", { ...FULL, oracle_text: 'Draw "a" card.\nThen \\ discard.' }],
];

describe("card objects: Rust engine vs the TypeScript reference", () => {
	/**
	 * A fixture as the ENGINE would hand it over.
	 *
	 * Two normalizations, both matching what a real row is rather than making the test easier:
	 *
	 *   - `undefined` means "key absent", which is what an engine row does; JSON.stringify drops it.
	 *   - Object keys are sorted at every depth. `card_to_json` builds rows with `serde_json::Map`,
	 *     which is a `BTreeMap` in this build (no `preserve_order` feature), so every object in a
	 *     real row — `legalities`, each `all_parts` entry, each face — arrives alphabetical, and the
	 *     TypeScript reference copies those through verbatim. A fixture written by hand in source
	 *     order would compare an input the engine cannot produce.
	 */
	const asRow = (row: Record<string, unknown>): Record<string, unknown> => {
		const sortDeep = (value: unknown): unknown => {
			if (Array.isArray(value)) return value.map(sortDeep);
			if (value !== null && typeof value === "object") {
				return Object.fromEntries(
					Object.entries(value as Record<string, unknown>)
						.filter(([, v]) => v !== undefined)
						.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
						.map(([k, v]) => [k, sortDeep(v)]),
				);
			}
			return value;
		};
		return sortDeep(JSON.parse(JSON.stringify(row))) as Record<string, unknown>;
	};

	test.each(CASES)("%s", (_label, row) => {
		const clean = asRow(row);
		const fromRust = scryfall_card_from_row(JSON.stringify(clean), BASE);
		// `stringifyScryfall`, not `JSON.stringify`: the routes serialize card objects through it,
		// and it is what writes `cmc` as the DECIMAL Scryfall types it as. Comparing against a plain
		// stringify would hold the engine to bytes this port never actually sends.
		const fromTs = stringifyScryfall(toScryfallCard(clean, BASE));
		expect(fromRust).toBe(fromTs);
	});

	// The key SET is what a client actually observes; asserting it separately means a failure says
	// "these keys differ" rather than only "these 4KB of JSON differ".
	test.each(CASES)("%s — same keys, same order", (_label, row) => {
		const clean = asRow(row);
		const rustKeys = Object.keys(JSON.parse(scryfall_card_from_row(JSON.stringify(clean), BASE)));
		const tsKeys = Object.keys(toScryfallCard(clean, BASE));
		expect(rustKeys).toEqual(tsKeys);
	});

	// ─── the one assertion that is not "the two writers agree" ───────────────────
	//
	// Everything above holds the two builders TO EACH OTHER, which is what this file is for and also
	// its blind spot: both can be wrong the same way and stay green forever. They were. Scryfall
	// serves ELEVEN keys under `image_uris` and both builders served six, missing `thumb`, `grid`,
	// `display`, `art` and `crop` on every card object and every face either one had ever built —
	// and this file, the live-parity harness and the 759-object sweep were all green throughout.
	//
	// So this constant is SCRYFALL'S, not ours: read off api.scryfall.com and confirmed against all
	// 540,484 printings in the 2026-08-16 all_cards bulk, where `image_uris` is either wholly absent
	// or exactly these eleven keys in exactly this order — no layout, no `image_status` and no face
	// position produces a partial set. Written down here so that changing our table alone cannot
	// make the suite agree with itself again.

	/** Scryfall's `image_uris` key set, in Scryfall's order. Their shape, not ours. */
	const SCRYFALL_IMAGE_KEYS = [
		"small",
		"normal",
		"large",
		"png",
		"art_crop",
		"border_crop",
		"thumb",
		"grid",
		"display",
		"art",
		"crop",
	];

	test("image_uris carries Scryfall's eleven keys in Scryfall's order, top level and per face", () => {
		const imagesOf = (built: Record<string, unknown>): string[][] => {
			const found: string[][] = [];
			const top = built.image_uris;
			if (top && typeof top === "object") found.push(Object.keys(top));
			for (const face of (built.card_faces ?? []) as Record<string, unknown>[]) {
				const faceImages = face.image_uris;
				if (faceImages && typeof faceImages === "object") found.push(Object.keys(faceImages));
			}
			return found;
		};

		let topLevel = 0;
		let perFace = 0;
		for (const [label, row] of CASES) {
			const clean = asRow(row);
			const ts = imagesOf(toScryfallCard(clean, BASE) as Record<string, unknown>);
			const rust = imagesOf(JSON.parse(scryfall_card_from_row(JSON.stringify(clean), BASE)));
			// The empty `image_uris` an id-less row produces is the documented no-id case, not a
			// short key set — it has no keys at all rather than some of them.
			for (const keys of ts) {
				if (keys.length === 0) continue;
				expect(keys, `${label}: TypeScript image_uris`).toEqual(SCRYFALL_IMAGE_KEYS);
			}
			for (const keys of rust) {
				if (keys.length === 0) continue;
				expect(keys, `${label}: Rust image_uris`).toEqual(SCRYFALL_IMAGE_KEYS);
			}
			const built = toScryfallCard(clean, BASE) as Record<string, unknown>;
			if (built.image_uris && Object.keys(built.image_uris).length > 0) topLevel++;
			perFace += ((built.card_faces ?? []) as Record<string, unknown>[]).filter(
				(f) => f.image_uris && Object.keys(f.image_uris as object).length > 0,
			).length;
		}
		// Both placements were checked, not just whichever one the fixtures happen to reach — the
		// gap was per-face as well as top-level, so a run that only saw one proves half of it.
		expect(topLevel, "fixtures reaching a top-level image_uris").toBeGreaterThan(0);
		expect(perFace, "fixtures reaching a per-face image_uris").toBeGreaterThan(0);
	});

	// ─── guard the guard ─────────────────────────────────────────────────────────
	//
	// The byte comparison above can only catch a divergence a fixture REACHES. Commit 1cea214's
	// lesson: FULL silently lacked `loyalty`, so both builders were compared over a key neither
	// wrote, and the suite was green while the key was broken. This closes that class structurally:
	// every key either builder can emit must be exercised by some fixture, and the emittable set is
	// DERIVED from CARD_OBJECT_FIELDS rather than written down twice — a field added to the
	// builders without a fixture, or to CARD_OBJECT_FIELDS without a classification here, fails.

	/** Output keys computed from other fields rather than carried by one (the *_uri family etc.). */
	const DERIVED_KEYS: readonly string[] = [
		"object",
		"uri",
		"scryfall_uri",
		"set_uri",
		"set_search_uri",
		"scryfall_set_uri",
		"rulings_uri",
		"prints_search_uri",
		"card_back_id",
		"prices",
		"related_uris",
		"purchase_uris",
		"image_uris",
	];

	/**
	 * Every CARD_OBJECT_FIELDS entry, classified: the output keys it becomes. An empty list is a
	 * field that feeds a derived key or is requested only for upstream parity and never emitted.
	 */
	const FIELD_TO_KEYS: Record<string, readonly string[]> = {
		name: ["name"],
		scryfall_id: ["id"],
		oracle_id: ["oracle_id"],
		layout: ["layout"],
		mana_cost: ["mana_cost"],
		cmc: ["cmc"],
		type_line: ["type_line"],
		oracle_text: ["oracle_text"],
		printed_name: ["printed_name"],
		flavor_name: ["flavor_name"],
		printed_type_line: ["printed_type_line"],
		printed_text: ["printed_text"],
		life_modifier: ["life_modifier"],
		hand_modifier: ["hand_modifier"],
		power: ["power"],
		toughness: ["toughness"],
		loyalty: ["loyalty"],
		colors: ["colors"],
		color_identity: ["color_identity"],
		card_keywords: ["keywords"],
		set_code: ["set"],
		set_name: ["set_name"],
		collector_number: ["collector_number"],
		rarity: ["rarity"],
		flavor_text: ["flavor_text"],
		artist: ["artist"],
		illustration_id: ["illustration_id"],
		released_at: ["released_at"],
		legalities: ["legalities"],
		edhrec_rank: ["edhrec_rank"],
		price_usd: [], // the six price columns fold into the derived `prices`
		price_eur: [],
		price_tix: [],
		price_usd_foil: [],
		price_usd_etched: [],
		price_eur_foil: [],
		watermark: ["watermark"],
		card_frame_data: [], // requested for upstream parity; never read by either builder
		card_is_tags: ["reserved"],
		border_color: ["border_color"],
		frame: ["frame"],
		lang: ["lang"],
		image_status: ["image_status"],
		set_type: ["set_type"],
		security_stamp: ["security_stamp"],
		set_id: ["set_id"],
		arena_id: ["arena_id"],
		mtgo_id: ["mtgo_id"],
		mtgo_foil_id: ["mtgo_foil_id"],
		tcgplayer_id: ["tcgplayer_id"],
		tcgplayer_etched_id: ["tcgplayer_etched_id"],
		cardmarket_id: ["cardmarket_id"],
		penny_rank: ["penny_rank"],
		image_updated_at: [], // the cache-buster inside the derived image_uris
		multiverse_ids: ["multiverse_ids"], // also gatherer, inside the derived related_uris
		promo_types: ["promo_types"],
		frame_effects: ["frame_effects"],
		games: ["games"],
		finishes: ["finishes"],
		booster: ["booster"],
		digital: ["digital"],
		foil: [], // requested for upstream parity; not stored, never emitted (ledgered Scryfall-only)
		nonfoil: [],
		full_art: ["full_art"],
		highres_image: ["highres_image"],
		oversized: ["oversized"],
		promo: ["promo"],
		reprint: ["reprint"],
		story_spotlight: ["story_spotlight"],
		textless: ["textless"],
		variation: ["variation"],
		card_faces: ["card_faces"],
		all_parts: ["all_parts"],
		produced_mana: ["produced_mana"],
		color_indicator: ["color_indicator"],
	};

	test("every CARD_OBJECT_FIELDS entry is classified, and only those", () => {
		expect(Object.keys(FIELD_TO_KEYS).sort()).toEqual([...CARD_OBJECT_FIELDS].sort());
	});

	test("the fixtures exercise every emittable key, and the builders emit no unclassified key", () => {
		const emittable = new Set<string>([...DERIVED_KEYS, ...Object.values(FIELD_TO_KEYS).flat()]);
		const tsSeen = new Set<string>();
		const rustSeen = new Set<string>();
		for (const [, row] of CASES) {
			const clean = asRow(row);
			for (const key of Object.keys(toScryfallCard(clean, BASE))) tsSeen.add(key);
			for (const key of Object.keys(JSON.parse(scryfall_card_from_row(JSON.stringify(clean), BASE)))) {
				rustSeen.add(key);
			}
		}
		// No builder invents a key the classification does not know about...
		expect([...tsSeen].filter((k) => !emittable.has(k)).sort()).toEqual([]);
		expect([...rustSeen].filter((k) => !emittable.has(k)).sort()).toEqual([]);
		// ...and no emittable key escapes the fixtures — the 1cea214 assertion.
		expect([...emittable].filter((k) => !tsSeen.has(k)).sort()).toEqual([]);
		expect([...emittable].filter((k) => !rustSeen.has(k)).sort()).toEqual([]);
	});
});
