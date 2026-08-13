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
import { toScryfallCard } from "../../src/routes/scryfall-compat/objects";
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

/** Everything present, including all six prices and every optional key. */
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

const CASES: [string, Record<string, unknown>][] = [
	["minimal row, almost everything absent", MINIMAL],
	["full row, every optional present", FULL],

	// The slug and quote_plus paths, which are where a careless port drifts. Non-ASCII must fold
	// the same way in both, and `!'()*` must escape while `~` must not.
	["non-ASCII name (Æ, ö)", { ...FULL, name: "Æther Vial // Jötun Grunt" }],
	["name with quote_plus-sensitive punctuation", { ...FULL, name: "Yawgmoth's Will (Alt!) ~ *test*" }],
	["name that slugs to nothing but hyphens", { ...FULL, name: "!!! ??? ---" }],
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
});
