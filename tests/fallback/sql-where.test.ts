// D1 SQL fallback: WHERE compiler tests.
//
// Two gates:
//  1. Corpus coverage — every wire tree the parser produced for upstream's
//     own query corpus compiles (the fallback must accept anything the
//     parser emits; regex needles compile to post-filter markers).
//  2. Execution semantics — real query strings through the REAL parser, the
//     compiler, and an actual SQLite database (bun:sqlite — the same dialect
//     D1 executes), against hand-built cards rows with known answers.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { calculateDevotion, cardsRowValues, fnv1a64 } from "../../src/fallback/cards-sync";
import { compileWhere, SqlUnsupportedError } from "../../src/fallback/sql-where";
import { parseScryfallQuery } from "../../src/parser";
import corpus from "../parser/fixtures/corpus.json";

// ── corpus coverage ──────────────────────────────────────────────────────────

describe("corpus coverage", () => {
	test("every corpus tree compiles or is a deliberate boolean-position decline", () => {
		let compiled = 0;
		const declined: string[] = [];
		for (const item of corpus as { query: string; tree?: string }[]) {
			if (!item.tree) continue;
			const tree = JSON.parse(item.tree);
			try {
				const out = compileWhere(tree);
				expect(out.sql.length).toBeGreaterThan(0);
				compiled++;
			} catch (err) {
				if (!(err instanceof SqlUnsupportedError) || !String(err).includes("boolean position")) {
					throw err;
				}
				// Degenerate arithmetic/value roots (`1`, `cmc+power`, ...):
				// Postgres rejects a non-boolean WHERE, so upstream errors on
				// these too — the fallback declines rather than inventing
				// SQLite truthiness semantics.
				declined.push(item.query);
			}
		}
		expect(compiled).toBeGreaterThan(500);
		expect(declined.length).toBeLessThanOrEqual(15);
	});
});

// ── execution semantics ──────────────────────────────────────────────────────

/** A minimal ENGINE_COLUMNS row (the finalize output shape). */
function engineRow(over: Record<string, unknown>): Record<string, unknown> {
	return {
		scryfall_id: "00000000-0000-0000-0000-000000000000",
		oracle_id: "10000000-0000-0000-0000-000000000000",
		illustration_id: null,
		card_name: "Test Card",
		card_name_folded: "test card",
		card_artist: null,
		card_set_code: "tst",
		set_name: "Test Set",
		collector_number: "1",
		collector_number_int: 1,
		card_layout: "normal",
		card_border: "black",
		card_watermark: null,
		card_rarity_int: 0,
		released_at: "2020-06-15",
		cmc: 1,
		creature_power: null,
		creature_toughness: null,
		creature_power_text: null,
		creature_toughness_text: null,
		planeswalker_loyalty: null,
		edhrec_rank: 100,
		price_usd: 1.5,
		price_eur: null,
		price_tix: null,
		prefer_score: 50,
		cubecobra_score: null,
		oracle_text: "Deal 3 damage to any target.",
		flavor_text: "",
		type_line: "Instant",
		mana_cost_text: "{R}",
		mana_cost_jsonb: { R: [1] },
		card_types: ["Instant"],
		card_subtypes: [],
		card_colors: { R: true },
		card_color_identity: { R: true },
		produced_mana: {},
		card_keywords: {},
		card_legalities: { modern: "legal", vintage: "restricted" },
		card_oracle_tags: {},
		card_art_tags: {},
		card_is_tags: {},
		card_frame_data: {},
		...over,
	};
}

const FIXTURES: Record<string, unknown>[] = [
	engineRow({
		scryfall_id: "bolt",
		card_name: "Test Bolt",
		card_name_folded: "test bolt",
	}),
	engineRow({
		scryfall_id: "elf",
		oracle_id: "20000000-0000-0000-0000-000000000000",
		card_name: "Wild Elf",
		card_name_folded: "wild elf",
		oracle_text: "Add {G}.",
		type_line: "Creature — Elf Druid",
		card_types: ["Creature"],
		card_subtypes: ["Elf", "Druid"],
		card_colors: { G: true },
		card_color_identity: { G: true },
		produced_mana: { G: true },
		card_keywords: {},
		mana_cost_text: "{G}",
		mana_cost_jsonb: { G: [1] },
		creature_power: 1,
		creature_toughness: 1,
		creature_power_text: "1",
		creature_toughness_text: "1",
		card_rarity_int: 1,
		released_at: "2015-03-01",
		card_legalities: { modern: "legal", commander: "legal" },
	}),
	engineRow({
		scryfall_id: "eowyn",
		oracle_id: "30000000-0000-0000-0000-000000000000",
		card_name: "Éowyn, Fearless Knight",
		card_name_folded: "eowyn, fearless knight",
		oracle_text: "Flying, haste.",
		type_line: "Legendary Creature — Human Knight",
		card_types: ["Creature"],
		card_subtypes: ["Human", "Knight"],
		card_colors: { R: true, W: true },
		card_color_identity: { R: true, W: true },
		card_keywords: { Flying: true, Haste: true },
		mana_cost_text: "{2}{R}{W}",
		mana_cost_jsonb: { R: [1], W: [1] },
		cmc: 4,
		creature_power: 3,
		creature_toughness: 4,
		creature_power_text: "3",
		creature_toughness_text: "4",
		card_rarity_int: 3,
		released_at: "2023-06-23",
		card_set_code: "ltr",
		card_legalities: { modern: "legal", standard: "banned" },
	}),
	engineRow({
		scryfall_id: "colorless",
		oracle_id: "40000000-0000-0000-0000-000000000000",
		card_name: "Plain Rock",
		card_name_folded: "plain rock",
		oracle_text: "Add {C}{C}.",
		type_line: "Artifact",
		card_types: ["Artifact"],
		card_subtypes: [],
		card_colors: {},
		card_color_identity: {},
		produced_mana: { C: true },
		mana_cost_text: "{2}",
		mana_cost_jsonb: {},
		cmc: 2,
		card_rarity_int: 2,
		released_at: "2019-01-05",
	}),
];

function seededDb(): Database {
	const db = new Database(":memory:");
	// Same schema/derivations as the production sync path.
	const rows = FIXTURES.map((r) => cardsRowValues(r, fnv1a64(JSON.stringify(r))));
	const cols = Object.keys(rows[0] as object);
	db.run(`CREATE TABLE cards (${cols.map((c) => (c === "scryfall_id" ? `${c} TEXT PRIMARY KEY` : c)).join(", ")})`);
	const jsonCols = new Set([
		"mana_cost_jsonb",
		"card_types",
		"card_subtypes",
		"card_colors",
		"card_color_identity",
		"produced_mana",
		"card_keywords",
		"card_legalities",
		"card_oracle_tags",
		"card_art_tags",
		"card_is_tags",
		"card_frame_data",
		"devotion",
	]);
	const insert = db.prepare(`INSERT INTO cards (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
	for (const row of rows) {
		insert.run(
			...cols.map((c) => {
				const v = (row as Record<string, unknown>)[c];
				if (v === null || v === undefined) return null;
				return jsonCols.has(c) ? JSON.stringify(v) : (v as string | number);
			}),
		);
	}
	return db;
}

/** Run a real query string through parser → compiler → SQLite; return ids. */
function idsFor(db: Database, query: string): string[] {
	const tree = parseScryfallQuery(query);
	const where = compileWhere(tree);
	const sql = `SELECT scryfall_id, ${where.postFilters.map((pf, i) => `${pf.column} AS __pf_${i}`).join(", ") || "1"} FROM cards AS card WHERE ${where.sql} ORDER BY scryfall_id`;
	let rows = db.query(sql).all(...(where.params as (string | number)[])) as Record<string, unknown>[];
	if (where.postFilters.length > 0) {
		const regexes = where.postFilters.map((pf) => new RegExp(pf.source, "i"));
		rows = rows.filter((row) => regexes.every((re, i) => re.test(String(row[`__pf_${i}`] ?? ""))));
	}
	return rows.map((r) => String(r.scryfall_id));
}

describe("execution semantics", () => {
	const db = seededDb();
	const cases: [string, string[]][] = [
		// types (JSONB_ARRAY) and type-vs-subtype resolution
		["t:creature", ["elf", "eowyn"]],
		["t:elf", ["elf"]],
		["t:instant", ["bolt"]],
		// colors (JSONB_OBJECT containment)
		["c:r", ["bolt", "eowyn"]],
		["c:rw", ["eowyn"]],
		["c=rw", ["eowyn"]],
		["c:c", ["colorless"]],
		// color identity subset via the mask column
		["id<=rw", ["bolt", "colorless", "eowyn"]],
		["id<=g", ["colorless", "elf"]],
		// keywords
		["kw:flying", ["eowyn"]],
		// legalities with status from the original attribute
		["f:modern", ["bolt", "colorless", "elf", "eowyn"]],
		["banned:standard", ["eowyn"]],
		["restricted:vintage", ["bolt", "colorless"]],
		// numerics, rarity, cmc
		["cmc=4", ["eowyn"]],
		["pow>=2", ["eowyn"]],
		["r:mythic", ["eowyn"]],
		["r>=rare", ["colorless", "eowyn"]],
		// text: fuzzy name (accent-folded), oracle substring, exact name
		["name:eowyn", ["eowyn"]],
		['o:"any target"', ["bolt"]],
		['!"Test Bolt"', ["bolt"]],
		// exact-match text fields
		["s:ltr", ["eowyn"]],
		["border:black", ["bolt", "colorless", "elf", "eowyn"]],
		// years and dates
		["year:2023", ["eowyn"]],
		["year<=2019", ["colorless", "elf"]],
		["date>2020-01-01", ["bolt", "eowyn"]],
		// mana: ":" means >= (has at least these pips)
		["m:{r}", ["bolt", "eowyn"]],
		["m:{r}{w}", ["eowyn"]],
		// devotion (permanents only — bolt is an instant)
		["devotion:{g}", ["elf"]],
		// produced mana (colorless is a real value there)
		["produces:c", ["colorless"]],
		// boolean structure
		["t:creature c:g", ["elf"]],
		["t:instant or t:artifact", ["bolt", "colorless"]],
		["-t:creature", ["bolt", "colorless"]],
		// regex post-filter
		["o:/add \\{[gc]\\}/", ["colorless", "elf"]],
	];
	for (const [query, expected] of cases) {
		test(query, () => {
			expect(idsFor(db, query)).toEqual(expected);
		});
	}

	test("devotion derivation matches card_processing semantics", () => {
		expect(calculateDevotion("{G}{G}{2}")).toEqual({ G: [1, 2] });
		expect(calculateDevotion("{R/G}")).toEqual({ R: [1], G: [1] });
		expect(calculateDevotion("{3}")).toEqual({});
	});
});
