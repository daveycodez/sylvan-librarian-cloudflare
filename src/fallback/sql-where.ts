// D1 SQL fallback, part 1: engine-wire filter tree → SQLite WHERE clause.
//
// Port of upstream's to_sql methods (api/parsing/nodes.py +
// card_query_nodes.py), translated Postgres → SQLite and operating on the
// SERIALIZED wire tree instead of live parser nodes. That choice is
// deliberate: the wire tree is the query the ENGINE executes — kwargs()
// already applied every value normalization upstream performs before
// comparison (jsonb comparison-object keys, rarity → numeric, titlecase +
// fold_accents on names, type-vs-subtype resolution) — so the engine and the
// fallback consume the identical normalized query and cannot drift on value
// handling. What remains here is upstream's *structural* SQL emission,
// handler by handler, with the dialect translated:
//
//   Postgres                      SQLite (D1)
//   ──────────────────────────    ──────────────────────────────────────────
//   jsonb @> {k: v, ...}          json_extract(col, '$.k') checks, ANDed
//   jsonb <@ / equality           key-set checks via json_each (flat objects;
//                                 order-insensitive, like jsonb)
//   array @> / <@ (set algebra)   EXISTS / NOT EXISTS over json_each
//   color_identity_mask(col)      precomputed color_identity_mask column
//     = ANY(subset array)           IN (subset list)   (same optimization)
//   mana jsonb pip containment    per-symbol json_array_length comparisons
//   ~* regex                      post-filter marker — D1 has no REGEXP;
//                                 rows are re-checked in JS after SQL narrows
//   LIKE (backslash escapes)      LIKE ... ESCAPE '\'
//
// Parameters are positional "?" placeholders collected in emission order.

import { ALIAS_TO_FIELD_INFOS, type FieldInfo, FieldType, ParserClass } from "../parser/db-info";

/** A query construct the fallback cannot express in D1 SQL. */
export class SqlUnsupportedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SqlUnsupportedError";
	}
}

export interface CompiledWhere {
	sql: string;
	params: (string | number)[];
	/** Regex post-filters: rows must ALSO match every entry (case-insensitive). */
	postFilters: { column: string; source: string }[];
}

interface WireNode {
	node_type: string;
	kwargs: Record<string, unknown>;
}

/** Numeric wire values are PyNumber wrappers (Python int/float semantics). */
function toNumberValue(v: unknown): number {
	if (typeof v === "number") return v;
	if (typeof v === "object" && v !== null && "toNumber" in v) {
		return (v as { toNumber(): number }).toNumber();
	}
	return Number(v);
}

const COLOR_BITS: Record<string, number> = { W: 16, U: 8, B: 4, R: 2, G: 1 };

function colorKeysToMask(keys: string[]): number {
	return keys.reduce((mask, k) => mask + (COLOR_BITS[k] ?? 0), 0);
}

function subsetMasks(queryMask: number, proper: boolean): number[] {
	const out: number[] = [];
	for (let v = 0; v < 32; v++) {
		if ((v & ~queryMask) === 0 && (!proper || v !== queryMask)) out.push(v);
	}
	return out;
}

/** _escape_like_pattern: backslash-escape LIKE metacharacters. */
function escapeLike(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** mana_cost_str_to_dict (card_query_nodes.py 387-421): symbol → pip count. */
export function manaCostStrToCounts(manaCostStr: string): Map<string, number> {
	const upper = manaCostStr.toUpperCase();
	const counts = new Map<string, number>();
	for (const m of upper.matchAll(/\{([^}]*)\}/g)) {
		const sym = m[1] ?? "";
		if (/^\d+$/.test(sym)) continue; // generic mana carries no pip symbol
		counts.set(sym, (counts.get(sym) ?? 0) + 1);
	}
	const unbraced = upper.replace(/\{[^}]*\}/g, " ");
	for (const ch of unbraced) {
		if ("WUBRGCX".includes(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	}
	return counts;
}

/** calculate_cmc (card_query_nodes.py 423-461). */
export function calculateCmc(manaCostStr: string): number {
	const upper = manaCostStr.toUpperCase();
	let cmc = 0;
	for (const m of upper.matchAll(/\{([^}]*)\}/g)) {
		const sym = m[1] ?? "";
		if (/^\d+$/.test(sym)) cmc += Number(sym);
		else if (sym !== "X") cmc += 1;
	}
	const unbraced = upper.replace(/\{[^}]*\}/g, " ");
	for (const token of unbraced.matchAll(/\d+|[WUBRGC]/g)) {
		const t = token[0];
		cmc += /^\d+$/.test(t) ? Number(t) : 1;
	}
	return cmc;
}

class Compiler {
	readonly params: (string | number)[] = [];
	readonly postFilters: { column: string; source: string }[] = [];

	add(value: string | number): string {
		this.params.push(value);
		return "?";
	}

	compile(node: WireNode): string {
		switch (node.node_type) {
			case "TrueNode":
				// nodes.py TrueNode.to_sql: the always-true predicate.
				return "TRUE";
			case "AndNode":
				return this.nary(node, "AND", "TRUE");
			case "OrNode":
				return this.nary(node, "OR", "FALSE");
			case "NotNode":
				return `(NOT ${this.compile(node.kwargs.operand as WireNode)})`;
			case "ExactNameNode": {
				// Case-insensitive exact match; value is pre-lowered in the wire
				// tree, LIKE metacharacters escaped so it matches literally.
				const escaped = escapeLike(String(node.kwargs.value));
				return `(lower(card.card_name) LIKE ${this.add(escaped)} ESCAPE '\\')`;
			}
			case "CardBinaryOperatorNode":
			case "BinaryOperatorNode":
				return this.binary(node);
			case "CardAttributeNode":
			case "AttributeNode":
				return `card.${String(node.kwargs.attribute_name).toLowerCase()}`;
			case "StringValueNode":
				return this.add(String(node.kwargs.value));
			case "NumericValueNode":
				return this.add(toNumberValue(node.kwargs.value));
			case "ManaValueNode":
				// Only reachable under arithmetic (never expected); mana
				// comparisons are handled in binary() before operand emission.
				throw new SqlUnsupportedError("bare mana value outside a mana comparison");
			case "RegexValueNode":
				throw new SqlUnsupportedError("regex value outside a text comparison");
			default:
				throw new SqlUnsupportedError(`unknown node type ${node.node_type}`);
		}
	}

	private nary(node: WireNode, op: "AND" | "OR", empty: string): string {
		const operands = (node.kwargs.operands as WireNode[]) ?? [];
		if (operands.length === 0) return empty;
		if (operands.length === 1) return this.compile(operands[0] as WireNode);
		return `(${operands.map((o) => this.compile(o)).join(` ${op} `)})`;
	}

	private binary(node: WireNode): string {
		const lhs = node.kwargs.lhs as WireNode | undefined;
		const op = String(node.kwargs.op);
		const rhs = node.kwargs.rhs;

		if (lhs?.node_type === "CardAttributeNode") {
			return this.cardAttributeComparison(lhs, op, rhs);
		}
		// Arithmetic / generic comparison (BinaryOperatorNode.to_sql):
		// ":" degrades to "=", operands emit recursively. SQLite handles the
		// arithmetic operators identically.
		const sqlOp = op === ":" ? "=" : op;
		return `(${this.compile(lhs as WireNode)} ${sqlOp} ${this.compile(rhs as WireNode)})`;
	}

	private fieldInfo(attr: string, original: string): FieldInfo {
		// Mirror CardAttributeNode.__init__: alias → field infos, narrowed by
		// the parser class that matched. The wire tree does not carry the
		// parser class, but attribute_name is the RESOLVED db column, which is
		// unique within its alias set — select by dbColumnName instead.
		const infos = ALIAS_TO_FIELD_INFOS.get(original) ?? [];
		const match = infos.find((f) => f.dbColumnName === attr);
		if (match) return match;
		// Aliases that resolve differently (e.g. type→card_subtypes) or
		// attributes addressed by their own column name.
		for (const list of ALIAS_TO_FIELD_INFOS.values()) {
			const byColumn = list.find((f) => f.dbColumnName === attr);
			if (byColumn) return byColumn;
		}
		throw new SqlUnsupportedError(`no field info for attribute ${attr} (${original})`);
	}

	private cardAttributeComparison(lhs: WireNode, op: string, rhs: unknown): string {
		const attr = String(lhs.kwargs.attribute_name).toLowerCase();
		const original = String(lhs.kwargs.original_attribute ?? attr).toLowerCase();
		const col = `card.${attr}`;
		const info = this.fieldInfo(attr, original);

		// Mana cost approximate matching (":" means ">=").
		if (attr === "mana_cost_text" || attr === "mana_cost_jsonb") {
			return this.manaComparison(op, rhs);
		}
		// Devotion: mana-syntax rhs against the per-color pip-list column.
		if (attr === "devotion") {
			return this.devotionComparison(op, rhs);
		}

		if (info.parserClass === ParserClass.DATE) {
			return this.dateSearch(op, rhs);
		}
		if (info.parserClass === ParserClass.YEAR) {
			return this.yearSearch(op, rhs);
		}
		// NUMERIC and RARITY: plain comparison; ":" → "=". Rarity rhs is
		// already numeric in the wire tree (_rhs_to_json).
		if (info.parserClass === ParserClass.NUMERIC || info.parserClass === ParserClass.RARITY) {
			const sqlOp = op === ":" ? "=" : op;
			return `(${col} ${sqlOp} ${this.compile(rhs as WireNode)})`;
		}

		// JSONB_ARRAY (card_types / card_subtypes): the wire rhs is a plain
		// array of resolved values — _handle_jsonb_array's set algebra.
		if (info.fieldType === FieldType.JSONB_ARRAY) {
			if (!Array.isArray(rhs)) throw new SqlUnsupportedError(`array rhs shape for ${attr}`);
			return this.jsonbArray(col, op, rhs.map(String));
		}

		if (info.fieldType === FieldType.JSONB_OBJECT) {
			if (!Array.isArray(rhs)) throw new SqlUnsupportedError(`object rhs shape for ${attr}`);
			return this.jsonbObject(attr, col, op, original, rhs.map(String));
		}

		if (info.fieldType === FieldType.TEXT) {
			return this.textComparison(attr, col, op, rhs);
		}

		throw new SqlUnsupportedError(`unhandled field ${attr} (${info.fieldType})`);
	}

	// ── text ───────────────────────────────────────────────────────────────────

	private textComparison(attr: string, col: string, op: string, rhs: unknown): string {
		const rhsNode = rhs as WireNode;
		if (rhsNode?.node_type === "RegexValueNode") {
			// Postgres ~*: no REGEXP in D1 — narrow with TRUE and re-check rows
			// in JS after the query (sql-search applies postFilters pre-limit).
			this.postFilters.push({ column: attr, source: String(rhsNode.kwargs.value) });
			return "TRUE";
		}
		const rawValue = String((rhsNode?.kwargs?.value as string) ?? rhsNode);

		if (op === ":") {
			// _handle_colon_operator: exact-match TEXT fields use equality.
			if (["card_set_code", "card_layout", "card_border", "card_watermark", "collector_number"].includes(attr)) {
				const value = attr === "collector_number" ? rawValue : rawValue.toLowerCase();
				return `(${col} = ${this.add(value)})`;
			}
			// _handle_text_field_pattern_matching: %-joined escaped words over
			// the folded/lowered column. card_name fuzzy search reads
			// card_name_folded; the wire value is already accent-folded.
			const column = attr === "card_name" ? "card.card_name_folded" : col;
			const words = rawValue.toLowerCase().trim().split(/\s+/).filter(Boolean).map(escapeLike);
			const pattern = `%${words.join("%")}%`;
			return `(lower(${column}) LIKE ${this.add(pattern)} ESCAPE '\\')`;
		}

		// _handle_text_comparison: plain comparison operators on text columns.
		// (name/artist titlecasing and set lowercasing are already applied in
		// the wire values where upstream applies them.)
		const sqlOp = op === ":" ? "=" : op;
		return `(${col} ${sqlOp} ${this.add(rawValue)})`;
	}

	// ── jsonb array (set algebra over json_each) ───────────────────────────────

	private jsonbArray(col: string, op: string, values: string[]): string {
		const containsAll = (needles: string[]) =>
			needles
				.map((v) => `EXISTS (SELECT 1 FROM json_each(${col}) WHERE json_each.value = ${this.add(v)})`)
				.join(" AND ");
		const colSubsetOfQuery = () => {
			if (values.length === 0) return `NOT EXISTS (SELECT 1 FROM json_each(${col}))`;
			const list = values.map((v) => this.add(v)).join(", ");
			return `NOT EXISTS (SELECT 1 FROM json_each(${col}) WHERE json_each.value NOT IN (${list}))`;
		};
		switch (op) {
			case "=":
				return `(${containsAll(values)} AND ${colSubsetOfQuery()})`;
			case ":":
			case ">=":
				return `(${containsAll(values)})`;
			case "<=":
				return `(${colSubsetOfQuery()})`;
			case ">":
				return `(${containsAll(values)} AND NOT (${colSubsetOfQuery()}))`;
			case "<":
				return `(${colSubsetOfQuery()} AND NOT (${containsAll(values)}))`;
			case "!=":
			case "<>":
				return `(NOT (${containsAll(values)} AND ${colSubsetOfQuery()}))`;
			default:
				throw new SqlUnsupportedError(`array operator ${op}`);
		}
	}

	// ── jsonb object (flat {key: value} maps) ──────────────────────────────────

	private jsonbObject(attr: string, col: string, op: string, original: string, keys: string[]): string {
		// The wire rhs for JSONB_OBJECT attrs is the comparison object's key
		// list (see CardBinaryOperatorNode._rhs_to_json). Values are `true`
		// for every attr except card_legalities, whose per-key value is the
		// status word derived from the original attribute.
		const status = original === "banned" ? "banned" : original === "restricted" ? "restricted" : "legal";
		const isLegality = attr === "card_legalities";

		// color identity subset queries use the precomputed mask column —
		// the same optimization upstream's color_identity_mask() serves.
		if (attr === "card_color_identity" && [":", "<=", "<"].includes(op)) {
			const masks = subsetMasks(colorKeysToMask(keys), op === "<");
			const list = masks.map((m) => this.add(m)).join(", ");
			return `(card.color_identity_mask IN (${list}))`;
		}

		const keyPath = (k: string) => `'$."${k.replace(/"/g, '""')}"'`;
		const containsAll = () =>
			keys.length === 0
				? "TRUE" // jsonb @> '{}' is vacuously true
				: keys
						.map((k) =>
							isLegality
								? `json_extract(${col}, ${keyPath(k)}) = ${this.add(status)}`
								: `json_extract(${col}, ${keyPath(k)}) IS NOT NULL`,
						)
						.join(" AND ");
		const colKeysSubsetOfQuery = () => {
			if (keys.length === 0) return `NOT EXISTS (SELECT 1 FROM json_each(${col}))`;
			const list = keys.map((k) => this.add(k)).join(", ");
			return `NOT EXISTS (SELECT 1 FROM json_each(${col}) WHERE json_each.key NOT IN (${list}))`;
		};
		// Flat-object equality, order-insensitive (jsonb semantics): mutual
		// key containment plus per-key value agreement.
		const equal = () => `(${containsAll()} AND ${colKeysSubsetOfQuery()})`;

		// Upstream's empty-rhs special case: "c"/"colorless" queries compare
		// against the empty object exactly for ":"/">=" (containment against
		// {} is vacuously true for every row).
		if (keys.length === 0 && (op === ":" || op === ">=")) {
			return `(${colKeysSubsetOfQuery()})`;
		}

		switch (op) {
			case "=":
				return equal();
			case ":":
			case ">=":
				return `(${containsAll()})`;
			case "<=":
				return `(${colKeysSubsetOfQuery()})`;
			case ">":
				return `(${containsAll()} AND NOT ${equal()})`;
			case "<":
				return `(${colKeysSubsetOfQuery()} AND NOT ${equal()})`;
			case "!=":
			case "<>":
				return `(NOT ${equal()})`;
			default:
				throw new SqlUnsupportedError(`object operator ${op} on ${attr}`);
		}
	}

	// ── devotion (per-color pip lists, jsonb-object operator table) ────────────

	private devotionComparison(op: string, rhs: unknown): string {
		// _handle_jsonb_object attr == "devotion": the query's mana syntax
		// becomes per-color pip lists; the operator table is the jsonb one,
		// with containment expressed as per-color count comparisons (pip
		// arrays are [1..n], so jsonb containment reduces to counts).
		const value = String(((rhs as WireNode)?.kwargs?.value as string) ?? rhs);
		const counts = new Map<string, number>();
		for (const ch of value.toUpperCase().trim()) {
			if ("WUBRGC".includes(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
		}
		const col = "card.devotion";
		const path = (k: string) => `'$."${k}"'`;
		const len = (k: string) => `coalesce(json_array_length(json_extract(${col}, ${path(k)})), 0)`;
		const containsAll = () =>
			counts.size === 0 ? "TRUE" : [...counts].map(([k, n]) => `${len(k)} >= ${this.add(n)}`).join(" AND ");
		const colInQuery = () => {
			const perColor = counts.size === 0 ? [] : [...counts].map(([k, n]) => `${len(k)} <= ${this.add(n)}`);
			const noExtra =
				counts.size === 0
					? `NOT EXISTS (SELECT 1 FROM json_each(${col}))`
					: `NOT EXISTS (SELECT 1 FROM json_each(${col}) WHERE json_each.key NOT IN (${[...counts.keys()].map((k) => this.add(k)).join(", ")}))`;
			return [...perColor, noExtra].join(" AND ");
		};
		const equal = () => {
			const exact = counts.size === 0 ? [] : [...counts].map(([k, n]) => `${len(k)} = ${this.add(n)}`);
			const noExtra =
				counts.size === 0
					? `NOT EXISTS (SELECT 1 FROM json_each(${col}))`
					: `NOT EXISTS (SELECT 1 FROM json_each(${col}) WHERE json_each.key NOT IN (${[...counts.keys()].map((k) => this.add(k)).join(", ")}))`;
			return `(${[...exact, noExtra].join(" AND ")})`;
		};
		switch (op) {
			case "=":
				return equal();
			case ":":
			case ">=":
				return `(${containsAll()})`;
			case "<=":
				return `(${colInQuery()})`;
			case ">":
				return `(${containsAll()} AND NOT ${equal()})`;
			case "<":
				return `(${colInQuery()} AND NOT ${equal()})`;
			case "!=":
			case "<>":
				return `(NOT ${equal()})`;
			default:
				throw new SqlUnsupportedError(`devotion operator ${op}`);
		}
	}

	// ── mana cost (pip containment + cmc bound) ────────────────────────────────

	private manaComparison(op: string, rhs: unknown): string {
		const value = String(((rhs as WireNode)?.kwargs?.value as string) ?? rhs);
		const counts = manaCostStrToCounts(value);
		const cmc = calculateCmc(value);
		// ":" means ">=" for mana (a card that costs at least this).
		const operator = op === ":" ? ">=" : op;

		const mana = "card.mana_cost_jsonb";
		const path = (sym: string) => `'$."${sym.replace(/"/g, '""')}"'`;
		const pipLen = (sym: string) => `coalesce(json_array_length(json_extract(${mana}, ${path(sym)})), 0)`;
		// Pip arrays are [1..n], so jsonb array containment reduces to count
		// comparison; object containment is the conjunction over symbols.
		const queryInCard = () =>
			counts.size === 0 ? "TRUE" : [...counts].map(([sym, n]) => `${pipLen(sym)} >= ${this.add(n)}`).join(" AND ");
		const cardInQuery = () => {
			const perSymbol = counts.size === 0 ? [] : [...counts].map(([sym, n]) => `${pipLen(sym)} <= ${this.add(n)}`);
			const noExtraSymbols =
				counts.size === 0
					? `NOT EXISTS (SELECT 1 FROM json_each(${mana}))`
					: `NOT EXISTS (SELECT 1 FROM json_each(${mana}) WHERE json_each.key NOT IN (${[...counts.keys()].map((s) => this.add(s)).join(", ")}))`;
			return [...perSymbol, noExtraSymbols].join(" AND ");
		};
		const pipEqual = () => {
			const exact = counts.size === 0 ? [] : [...counts].map(([sym, n]) => `${pipLen(sym)} = ${this.add(n)}`);
			const noExtra =
				counts.size === 0
					? `NOT EXISTS (SELECT 1 FROM json_each(${mana}))`
					: `NOT EXISTS (SELECT 1 FROM json_each(${mana}) WHERE json_each.key NOT IN (${[...counts.keys()].map((s) => this.add(s)).join(", ")}))`;
			return `(${[...exact, noExtra].join(" AND ")})`;
		};
		const cmcParam = () => this.add(cmc);

		// _handle_mana_cost_approximate_comparison, clause for clause.
		switch (operator) {
			case "=":
				return `(${pipEqual()} AND card.cmc = ${cmcParam()})`;
			case "<=":
				return `(${cardInQuery()} AND card.cmc <= ${cmcParam()})`;
			case "<":
				return `(${cardInQuery()} AND card.cmc <= ${cmcParam()} AND NOT ${pipEqual()})`;
			case ">=":
				return `(${queryInCard()} AND card.cmc >= ${cmcParam()})`;
			case ">":
				return `(${queryInCard()} AND card.cmc >= ${cmcParam()} AND NOT ${pipEqual()})`;
			default:
				throw new SqlUnsupportedError(`mana operator ${operator}`);
		}
	}

	// ── dates ──────────────────────────────────────────────────────────────────

	private dateSearch(op: string, rhs: unknown): string {
		const value = (rhs as WireNode)?.kwargs?.value;
		const operator = op === ":" ? "=" : op;
		return `(card.released_at ${operator} ${this.add(String(value))})`;
	}

	private yearSearch(op: string, rhs: unknown): string {
		let raw = (rhs as WireNode)?.kwargs?.value;
		if (typeof raw === "object" && raw !== null) raw = toNumberValue(raw);
		const yearOk = (typeof raw === "string" && /^\d{4}$/.test(raw)) || typeof raw === "number";
		if (!yearOk) {
			throw new SqlUnsupportedError(`invalid year value ${String(raw)}`);
		}
		const year = Math.trunc(Number(raw));
		const start = `${year}-01-01`;
		const startNext = `${year + 1}-01-01`;
		const operator = op === ":" ? "=" : op;
		switch (operator) {
			case "=":
				return `(${this.add(start)} <= card.released_at AND card.released_at < ${this.add(startNext)})`;
			case ">":
				return `(card.released_at >= ${this.add(startNext)})`;
			case "<":
				return `(card.released_at < ${this.add(start)})`;
			case ">=":
				return `(card.released_at >= ${this.add(start)})`;
			case "<=":
				return `(card.released_at < ${this.add(startNext)})`;
			default:
				throw new SqlUnsupportedError(`year operator ${operator}`);
		}
	}
}

/** Compile a wire filter tree (the parser's serialized output) to SQLite. */
export function compileWhere(tree: unknown): CompiledWhere {
	const compiler = new Compiler();
	const sql = compiler.compile(tree as WireNode);
	return { sql, params: compiler.params, postFilters: compiler.postFilters };
}
