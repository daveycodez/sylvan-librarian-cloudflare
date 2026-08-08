// D1 SQL fallback, part 2: the search pipeline around the compiled WHERE —
// a port of upstream's _search_sql (api_resource.py 1323-1460) in SQLite:
//
//   Postgres                            SQLite (D1)
//   ─────────────────────────────────   ────────────────────────────────────
//   SELECT DISTINCT ON (key) ... ORDER  ROW_NUMBER() OVER (PARTITION BY key
//     BY key, prefer ...                  ORDER BY prefer ...) = 1
//   two-branch UNION ALL (rows+count)   two statements in one db.batch()
//   null::integer                       NULL
//
// The engine remains the primary path; this runs only when the engine throws
// (upstream's silent-Postgres-fallback trigger) and the cards table has been
// fully synced by the import (fallback_meta.complete). Regex needles — which
// Postgres evaluates in-database — are applied as JS post-filters over the
// deduped candidate set, after ordering and before the limit.

import type { Env } from "../engine/types";
import { compileWhere } from "./sql-where";

/** Upstream RESULT_FIELD_COLUMNS: public field name → cards column. */
export const RESULT_FIELD_COLUMNS: Readonly<Record<string, string>> = {
	name: "card_name",
	set_code: "card_set_code",
	collector_number: "collector_number",
	power: "creature_power_text",
	toughness: "creature_toughness_text",
	mana_cost: "mana_cost_text",
	oracle_text: "oracle_text",
	set_name: "set_name",
	type_line: "type_line",
	illustration_id: "illustration_id",
	scryfall_id: "scryfall_id",
	price_usd: "price_usd",
	prefer_score: "prefer_score",
};

const SQL_ORDERBY: Readonly<Record<string, string>> = {
	cmc: "cmc",
	edhrec: "edhrec_rank",
	name: "lower(card_name)", // matches the engine's card_name_lower sort
	power: "creature_power",
	rarity: "card_rarity_int",
	toughness: "creature_toughness",
	usd: "price_usd",
	cubecobra: "cubecobra_score",
};

const DISTINCT_ON: Readonly<Record<string, string>> = {
	artwork: "illustration_id",
	card: "oracle_id",
	// printing: no dedupe — scryfall_id is the primary key
};

const PREFER: Readonly<Record<string, [string, "ASC" | "DESC"]>> = {
	oldest: ["released_at", "ASC"],
	newest: ["released_at", "DESC"],
	usd_low: ["price_usd", "ASC"],
	usd_high: ["price_usd", "DESC"],
	promo: ["edhrec_rank", "ASC"], // upstream: edhrec_rank stands in for promo
	default: ["prefer_score", "DESC"],
};

/** Candidate cap when a regex post-filter forces JS-side evaluation. */
const POST_FILTER_CANDIDATE_CAP = 50_000;

export interface FallbackSearchOptions {
	filterTree: unknown;
	unique: string;
	prefer: string;
	orderby: string;
	direction: string;
	limit: number | null;
	resolvedFields: readonly string[];
}

export interface FallbackSearchResult {
	totalCards: number;
	cards: Record<string, unknown>[];
}

/** True when the import has fully synced the cards table for the live store. */
export async function fallbackReady(env: Env): Promise<boolean> {
	try {
		const row = await env.STORE_DB.prepare("SELECT complete FROM fallback_meta WHERE id = 1").first<{
			complete: number;
		}>();
		return row?.complete === 1;
	} catch {
		return false; // table not created yet — fallback not available
	}
}

export async function fallbackSearch(env: Env, opts: FallbackSearchOptions): Promise<FallbackSearchResult> {
	const where = compileWhere(opts.filterTree);
	const orderCol = SQL_ORDERBY[opts.orderby] ?? "edhrec_rank";
	const direction = opts.direction === "desc" ? "DESC" : "ASC";
	const distinctOn = DISTINCT_ON[opts.unique];
	const [preferCol, preferDir] = PREFER[opts.prefer] ?? ["edhrec_rank", "ASC"];
	const limit = opts.limit ?? 1_000_000;

	// CTE columns: requested fields + the ORDER BY tiebreak pair, deduped.
	const cteColumns = [
		...new Set([...opts.resolvedFields.map((f) => RESULT_FIELD_COLUMNS[f] as string), "edhrec_rank", "prefer_score"]),
	];
	// Regex post-filter columns ride along under stable aliases.
	const pfColumns = where.postFilters.map((pf, i) => `${pf.column} AS __pf_${i}`);
	const matchingFor = (cols: string) =>
		distinctOn
			? `WITH ranked AS (
				SELECT ${cols},
					ROW_NUMBER() OVER (
						PARTITION BY ${distinctOn}
						ORDER BY ${preferCol} ${preferDir} NULLS LAST, prefer_score DESC NULLS LAST
					) AS __rn
				FROM cards AS card
				WHERE ${where.sql}
			), matching_cards AS (SELECT * FROM ranked WHERE __rn = 1)`
			: `WITH matching_cards AS (
				SELECT ${cols}
				FROM cards AS card
				WHERE ${where.sql}
			)`;
	const matching = matchingFor([...cteColumns, `${orderCol} AS sort_value`].join(", "));
	const orderBy = `sort_value ${direction} NULLS LAST, edhrec_rank ASC NULLS LAST, prefer_score DESC NULLS LAST`;

	if (where.postFilters.length > 0) {
		// Regex path, two phases so memory stays flat: a wide-open regex means
		// no SQL prefilter, and dragging every result column for a 50k-row
		// candidate set materializes ~100MB — enough to OOM a 128MB isolate.
		// Phase 1 pulls only ids, the sort key, and the regexed columns for
		// the ordered candidate set (capped), re-checks every post-filter in
		// JS; phase 2 fetches full rows for just the surviving page.
		const slimCols = [
			...new Set(["scryfall_id", "edhrec_rank", "prefer_score"]),
			`${orderCol} AS sort_value`,
			...pfColumns,
		].join(", ");
		const sql = `${matchingFor(slimCols)} SELECT * FROM matching_cards ORDER BY ${orderBy} LIMIT ${POST_FILTER_CANDIDATE_CAP}`;
		const res = await env.STORE_DB.prepare(sql)
			.bind(...where.params)
			.all<Record<string, unknown>>();
		const regexes = where.postFilters.map((pf) => new RegExp(pf.source, "i"));
		const survivors = (res.results ?? []).filter((row) =>
			regexes.every((re, i) => re.test(String(row[`__pf_${i}`] ?? ""))),
		);

		const pageIds = survivors.slice(0, limit).map((row) => String(row.scryfall_id));
		const fetchCols = [...new Set(["scryfall_id", ...cteColumns])].join(", ");
		const byId = new Map<string, Record<string, unknown>>();
		for (let at = 0; at < pageIds.length; at += 80) {
			const slice = pageIds.slice(at, at + 80);
			const pageRes = await env.STORE_DB.prepare(
				`SELECT ${fetchCols} FROM cards WHERE scryfall_id IN (${slice.map(() => "?").join(", ")})`,
			)
				.bind(...slice)
				.all<Record<string, unknown>>();
			for (const row of pageRes.results ?? []) byId.set(String(row.scryfall_id), row);
		}
		return {
			totalCards: survivors.length,
			cards: pageIds
				.map((id) => byId.get(id))
				.filter((row): row is Record<string, unknown> => row !== undefined)
				.map((row) => projectRow(row, opts.resolvedFields)),
		};
	}

	const rowsSql = `${matching} SELECT * FROM matching_cards ORDER BY ${orderBy} LIMIT ${limit}`;
	const countSql = `${matching} SELECT COUNT(1) AS n FROM matching_cards`;
	const batchRes = await env.STORE_DB.batch([
		env.STORE_DB.prepare(rowsSql).bind(...where.params),
		env.STORE_DB.prepare(countSql).bind(...where.params),
	]);
	const rows = (batchRes[0]?.results ?? []) as Record<string, unknown>[];
	const count = ((batchRes[1]?.results ?? [])[0] as { n?: number } | undefined)?.n ?? 0;
	return { totalCards: count, cards: rows.map((row) => projectRow(row, opts.resolvedFields)) };
}

/** Rename cards columns back to public field names, in requested order. */
function projectRow(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const f of fields) {
		out[f] = row[RESULT_FIELD_COLUMNS[f] as string] ?? null;
	}
	return out;
}
