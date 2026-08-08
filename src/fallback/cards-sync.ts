// D1 SQL fallback, part 3: the `cards` table the fallback queries — schema
// and upsert plumbing used by the ImportCoordinator's cards phase.
//
// One row per printing, columns named exactly like upstream's magic.cards so
// the WHERE compiler's `card.<attribute_name>` emission ports unchanged.
// Multi-valued fields stay as JSON text (queried via json_each/json_extract);
// two columns are derived at sync time because the ENGINE_COLUMNS row JSON
// does not carry them:
//   color_identity_mask  WUBRG bitmask (W=16..G=1) — the subset-query
//                        optimization upstream serves with a Postgres function
//   devotion             calculate_devotion(mana_cost_text) for permanents,
//                        {} otherwise (card_processing.py:232-235 semantics)
//
// Indexes are deliberately few: D1 free meters index maintenance as rows
// written, and at ~100k rows SQLite scans are cheap for a rare fallback path.

const CARD_COLUMNS = [
	"scryfall_id",
	"oracle_id",
	"illustration_id",
	"card_name",
	"card_name_folded",
	"card_artist",
	"card_set_code",
	"set_name",
	"collector_number",
	"collector_number_int",
	"card_layout",
	"card_border",
	"card_watermark",
	"card_rarity_int",
	"released_at",
	"cmc",
	"creature_power",
	"creature_toughness",
	"creature_power_text",
	"creature_toughness_text",
	"planeswalker_loyalty",
	"edhrec_rank",
	"price_usd",
	"price_eur",
	"price_tix",
	"prefer_score",
	"cubecobra_score",
	"oracle_text",
	"flavor_text",
	"type_line",
	"mana_cost_text",
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
	"color_identity_mask",
	"devotion",
	"row_hash",
] as const;

/** JSON-typed columns (serialized as text; everything else binds directly). */
const JSON_COLUMNS = new Set([
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

const COLOR_BITS: Record<string, number> = { W: 16, U: 8, B: 4, R: 2, G: 1 };

export async function ensureCardsSchema(db: D1Database): Promise<void> {
	// No secondary indexes, deliberately: every index doubles the metered
	// write cost of the first fill and of deltas (D1 counts index
	// maintenance as rows written), while the fallback's rare queries scan
	// ~100k rows in a few ms either way. The PK's implicit index is the only
	// write amplification.
	const columns = CARD_COLUMNS.map((c) => (c === "scryfall_id" ? `${c} TEXT PRIMARY KEY` : c)).join(", ");
	await db.batch([
		db.prepare(`CREATE TABLE IF NOT EXISTS cards (${columns})`),
		db.prepare("DROP INDEX IF EXISTS idx_cards_oracle"),
		db.prepare("DROP INDEX IF EXISTS idx_cards_name"),
		db.prepare(
			"CREATE TABLE IF NOT EXISTS fallback_meta (id INTEGER PRIMARY KEY CHECK (id = 1), store_key TEXT NOT NULL, complete INTEGER NOT NULL, synced_rows INTEGER NOT NULL)",
		),
	]);
}

/**
 * Columns that churn on nearly every card, nearly every day (Scryfall
 * refreshes prices and EDHREC ranks daily). They are excluded from the
 * structural row hash so daily churn does not count as a delta — otherwise
 * the nightly diff would exceed the write budget forever and completeness
 * would flap. They still land with every structural upsert, and the sync's
 * leftover budget refreshes them for a rotating slice of rows each night
 * (the engine's in-memory store always has fresh values; only rare fallback
 * answers can be a couple of days stale on prices).
 */
export const VOLATILE_COLUMNS = ["price_usd", "price_eur", "price_tix", "edhrec_rank", "cubecobra_score"] as const;

/** The structural content hash: the row with volatile fields nulled out. */
export function structuralHash(row: Record<string, unknown>): string {
	const stripped: Record<string, unknown> = { ...row };
	for (const col of VOLATILE_COLUMNS) stripped[col] = null;
	return fnv1a64(JSON.stringify(stripped));
}

/** Refresh volatile columns for a set of rows (1 metered write per row). */
export async function execVolatileUpdates(db: D1Database, rows: Record<string, unknown>[]): Promise<void> {
	const sets = VOLATILE_COLUMNS.map((c) => `${c} = ?`).join(", ");
	const stmt = db.prepare(`UPDATE cards SET ${sets} WHERE scryfall_id = ?`);
	for (let at = 0; at < rows.length; at += 50) {
		const slice = rows.slice(at, at + 50);
		await db.batch(
			slice.map((row) =>
				stmt.bind(...VOLATILE_COLUMNS.map((c) => (row[c] as string | number | null) ?? null), String(row.scryfall_id)),
			),
		);
	}
}

/** calculate_devotion (card_query_nodes.py:463): per-color pip lists. */
export function calculateDevotion(manaCostStr: string): Record<string, number[]> {
	const devotion: Record<string, number[]> = { W: [], U: [], B: [], R: [], G: [], C: [] };
	for (const ch of manaCostStr.toUpperCase().trim()) {
		const list = devotion[ch];
		if (list) list.push(list.length + 1);
	}
	return Object.fromEntries(Object.entries(devotion).filter(([, v]) => v.length > 0));
}

/** FNV-1a 64-bit over UTF-16 code units — a stable change-detection hash. */
export function fnv1a64(s: string): string {
	let hash = 0xcbf29ce484222325n;
	const prime = 0x100000001b3n;
	const mask = 0xffffffffffffffffn;
	for (let i = 0; i < s.length; i++) {
		hash ^= BigInt(s.charCodeAt(i));
		hash = (hash * prime) & mask;
	}
	return hash.toString(16).padStart(16, "0");
}

/** Map one finalized ENGINE_COLUMNS row (parsed JSON) to cards-table values. */
export function cardsRowValues(row: Record<string, unknown>, hash: string): Record<string, unknown> {
	const identity = (row.card_color_identity ?? {}) as Record<string, unknown>;
	const mask = Object.keys(identity).reduce((m, k) => m + (COLOR_BITS[k] ?? 0), 0);
	const types = (row.card_types ?? []) as string[];
	// card_processing.py:232-235 — nonpermanents never contribute devotion.
	const isPermanent = !types.includes("Instant") && !types.includes("Sorcery");
	const devotion = isPermanent ? calculateDevotion(String(row.mana_cost_text ?? "")) : {};

	const values: Record<string, unknown> = { color_identity_mask: mask, devotion, row_hash: hash };
	for (const col of CARD_COLUMNS) {
		if (col === "color_identity_mask" || col === "devotion" || col === "row_hash") continue;
		values[col] = row[col] ?? null;
	}
	return values;
}

/**
 * Upsert prepared rows. D1 caps bound parameters per statement (~100), and a
 * row carries 45 — one statement per row, batched 40 statements per call to
 * stay inside per-invocation subrequest budgets.
 */
export async function execCardsUpserts(db: D1Database, rows: Record<string, unknown>[]): Promise<void> {
	const cols = CARD_COLUMNS.join(", ");
	const placeholders = CARD_COLUMNS.map(() => "?").join(", ");
	const stmt = db.prepare(`INSERT OR REPLACE INTO cards (${cols}) VALUES (${placeholders})`);
	for (let at = 0; at < rows.length; at += 40) {
		const slice = rows.slice(at, at + 40);
		await db.batch(
			slice.map((row) =>
				stmt.bind(
					...CARD_COLUMNS.map((col) => {
						const v = row[col];
						if (v === null || v === undefined) return null;
						return JSON_COLUMNS.has(col) ? JSON.stringify(v) : (v as string | number);
					}),
				),
			),
		);
	}
}
