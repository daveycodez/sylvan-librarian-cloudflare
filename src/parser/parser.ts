/**
 * Port of the recursive-descent parser half of api/parsing/hand_parser.py.
 *
 * Structure and method names mirror the Python Parser class one-to-one so that
 * upstream diffs of hand_parser.py can be hand-applied here.
 */

import { CardAttributeNode, CardBinaryOperatorNode, ExactNameNode } from "./card-query-nodes";
import {
	ALIAS_TO_FIELD_INFOS,
	COLOR_ALIAS_TO_CODES,
	COLOR_COUNT_NAMES,
	type ParserClass,
	ParserClass as PC,
} from "./db-info";
import { InternalParseError, LexError, ParseError } from "./errors";
import { firstInvalidManaSymbol } from "./mana-symbols";
import {
	AndNode,
	BinaryOperatorNode,
	DIRECTIVE_NAMES,
	DirectiveNode,
	flattenNestedOperations,
	ManaValueNode,
	NotNode,
	NumericValueNode,
	OrNode,
	Query,
	type QueryNode,
	RegexValueNode,
	StringValueNode,
	TrueNode,
} from "./nodes";
import { type PyNumber, pyLower, pyStr, pyStrip, pyUpper } from "./pystr";
import { MAX_GROUP_DEPTH, QueryBudgetExceeded } from "./query-budget";
import { foldTypographicQuotes, type Token, TT, tokenize } from "./tokenizer";

/** Python `repr()` of a plain string, for the one message that interpolates `{invalid!r}`. */
function pyRepr(s: string): string {
	const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
	let body = "";
	for (const ch of s) {
		if (ch === "\\") body += "\\\\";
		else if (ch === quote) body += `\\${quote}`;
		else if (ch === "\n") body += "\\n";
		else if (ch === "\r") body += "\\r";
		else if (ch === "\t") body += "\\t";
		else body += ch;
	}
	return `${quote}${body}${quote}`;
}

// ── Alias → parser-class lookup ──────────────────────────────────────────────

// Build once from db-info; prefer NUMERIC for dual-class aliases (cn, number)
// so bare integers route to the numeric branch, matching pyparsing behaviour.
const ALIAS_TO_PC: ReadonlyMap<string, ParserClass> = (() => {
	const map = new Map<string, ParserClass>();
	for (const [alias, fis] of ALIAS_TO_FIELD_INFOS) {
		const classes = new Set(fis.map((fi) => fi.parserClass));
		map.set(
			alias.toLowerCase(),
			classes.has(PC.NUMERIC) ? PC.NUMERIC : (fis[0] as { parserClass: ParserClass }).parserClass,
		);
	}
	return map;
})();

// On Scryfall '!' is an alias for '=' on these classes only (verified live, upstream #903 cause
// C) — on TEXT/LEGALITY it isn't an operator at all, and a trailing bang there falls through to
// the existing exact-name-prefix reading of the next factor instead. NUMERIC takes it too, in its
// own branch below. The alias also only holds when the bang is GLUED to both sides: measured
// live, `c!w` is 5,071 where `c !w` is 0 and `c! w` / `cmc! 3` are not the alias either — a
// spaced bang keeps the exact-name-prefix reading a space always had.
const BANG_ALIAS_CLASSES: ReadonlySet<ParserClass> = new Set([PC.COLOR, PC.MANA, PC.RARITY, PC.YEAR, PC.DATE]);

// Aliases that have BOTH a NUMERIC and a TEXT mapping (only cn / number today).
const DUAL_NUM_TEXT: ReadonlySet<string> = (() => {
	const set = new Set<string>();
	for (const [alias, fis] of ALIAS_TO_FIELD_INFOS) {
		if (fis.some((fi) => fi.parserClass === PC.NUMERIC) && fis.some((fi) => fi.parserClass === PC.TEXT)) {
			set.add(alias.toLowerCase());
		}
	}
	return set;
})();

const NUMERIC_ALIASES: ReadonlySet<string> = new Set(
	[...ALIAS_TO_PC].filter(([, pc]) => pc === PC.NUMERIC).map(([alias]) => alias),
);

// The set-valued names (`azorius`, `rainbow`) and the COUNT-valued ones (`m`, `gold`,
// `multicolored`) are one vocabulary as far as the value parser is concerned: both are words
// rather than letter strings. What separates them is what CardBinaryOperatorNode does with the
// result, not whether this parser will accept it.
const VALID_COLOR_NAMES: ReadonlySet<string> = new Set([...COLOR_ALIAS_TO_CODES.keys(), ...COLOR_COUNT_NAMES]);
const COLOR_LETTERS: ReadonlySet<string> = new Set("wubrgcWUBRGC");
const MIN_MTG_YEAR = 1992n;
const MAX_YEAR = 2040n;

function validateMtgYear(value: PyNumber, pos: number): bigint {
	if (value.isFloat) {
		throw new InternalParseError(`Expected integer year, got ${value.toString()} at position ${pos}`);
	}
	const year = value.toBigIntTruncated();
	if (!(MIN_MTG_YEAR <= year && year <= MAX_YEAR)) {
		throw new InternalParseError(
			`Year must be between ${MIN_MTG_YEAR} and ${MAX_YEAR}, got ${value.toString()} at position ${pos}`,
		);
	}
	return year;
}

const ARITH_OPS: ReadonlySet<TT> = new Set([TT.PLUS, TT.MINUS, TT.STAR, TT.SLASH]);

function nameNode(value: string, literal = false): CardBinaryOperatorNode {
	return new CardBinaryOperatorNode(new CardAttributeNode("name", PC.TEXT), ":", new StringValueNode(value, literal));
}

/**
 * Implicit name filter for a BARE word, which sheds its natural-language commas.
 *
 * Scryfall filters "son," exactly as "son" (measured 2026-08-08: identical totals), so
 * "rograkh, son of rograkh" finds the card. Quoted names stay verbatim — only bare words
 * route here. Python's str.rstrip(",") strips every trailing comma, not just one.
 */
function bareNameNode(value: string): CardBinaryOperatorNode {
	return nameNode(value.replace(/,+$/, ""));
}

/** Mirrors datetime.date(...) constructor validation (year already range-checked). */
function isValidDate(year: number, month: number, day: number): boolean {
	if (month < 1 || month > 12) return false;
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number;
	return day >= 1 && day <= daysInMonth;
}

function pad2(v: bigint): string {
	const s = v.toString();
	return s.length < 2 ? `0${s}` : s;
}

/** Recursive descent parser for Scryfall query syntax. */
export class Parser {
	private pos = 0;

	/** Current `(` nesting depth, bounded by MAX_GROUP_DEPTH. Siblings do not accumulate. */
	private groupDepth = 0;

	constructor(private readonly tokens: Token[]) {}

	// ── token access ─────────────────────────────────────────────────────────

	peek(offset = 0): Token {
		const idx = this.pos + offset;
		return (idx < this.tokens.length ? this.tokens[idx] : this.tokens[this.tokens.length - 1]) as Token;
	}

	consume(): Token {
		const tok = this.tokens[this.pos] as Token;
		this.pos += 1;
		return tok;
	}

	expect(tt: TT): Token {
		const tok = this.consume();
		if (tok.type !== tt) {
			throw new InternalParseError(`Expected ${tt}, got ${pyStr(tok.value)} at position ${tok.pos}`);
		}
		return tok;
	}

	// ── top-level ─────────────────────────────────────────────────────────────

	parse(): Query {
		if (this.peek().type === TT.EOF) {
			return new Query(new TrueNode());
		}
		const node = this.parseExpr();
		if (this.peek().type !== TT.EOF) {
			throw new InternalParseError(`Unexpected ${pyStr(this.peek().value)} at position ${this.peek().pos}`);
		}
		return new Query(node);
	}

	// ── expr: OR-level ────────────────────────────────────────────────────────

	parseExpr(): QueryNode {
		const operands = [this.parseAndExpr()];
		while (this.peek().type === TT.WORD && pyUpper(this.peek().value as string) === "OR") {
			this.consume();
			operands.push(this.parseAndExpr());
		}
		return operands.length === 1 ? (operands[0] as QueryNode) : new OrNode(operands);
	}

	// ── and_expr: AND-level with implicit AND ─────────────────────────────────

	parseAndExpr(): QueryNode {
		const operands = [this.parseFactor()];
		while (this.canStartFactor()) {
			if (this.peek().type === TT.WORD && pyUpper(this.peek().value as string) === "AND") {
				this.consume();
			}
			operands.push(this.parseFactor());
		}
		return operands.length === 1 ? (operands[0] as QueryNode) : new AndNode(operands);
	}

	private canStartFactor(): boolean {
		const tok = this.peek();
		if (tok.type === TT.EOF || tok.type === TT.RPAREN) {
			return false;
		}
		if (tok.type === TT.WORD) {
			return pyUpper(tok.value as string) !== "OR"; // AND is consumed inline; OR ends the and_expr
		}
		if (tok.type === TT.MINUS) {
			return tok.spaceBefore; // space before - = negation prefix; no-space = trailing arith
		}
		return (
			tok.type === TT.NUMBER ||
			tok.type === TT.QUOTED ||
			tok.type === TT.REGEX ||
			tok.type === TT.MANA ||
			tok.type === TT.LPAREN ||
			tok.type === TT.BANG
		);
	}

	// ── factor: optional negation ─────────────────────────────────────────────

	parseFactor(): QueryNode {
		if (this.peek().type === TT.MINUS) {
			this.consume();
			const operand = this.parsePrimary();
			if (operand instanceof BinaryOperatorNode && ["+", "-", "*", "/"].includes(operand.operator)) {
				throw new InternalParseError("Cannot negate an arithmetic expression");
			}
			return new NotNode(operand);
		}
		return this.parsePrimary();
	}

	// ── primary ───────────────────────────────────────────────────────────────

	parsePrimary(): QueryNode {
		const tok = this.peek();
		if (tok.type === TT.LPAREN) {
			let lhs = this.parseGroup();
			if (ARITH_OPS.has(this.peek().type) && !this.peek().spaceBefore) {
				lhs = this.arithTail(lhs);
			}
			lhs = this.spacedArithTail(lhs);
			if (this.peek().type === TT.OP) {
				const op = this.consume().value as string;
				return new CardBinaryOperatorNode(lhs, op, this.parseNumExprValue());
			}
			return lhs;
		}
		if (tok.type === TT.BANG) {
			return this.parseExactName();
		}
		if (tok.type === TT.QUOTED) {
			this.consume();
			// A bare QUOTED term is `name:"…"`, and quoting still means "match this literally":
			// measured on api.scryfall.com 2026-08-16, `q="ft"` answers 362 exactly as
			// `q=name:"ft"` does, against the bare word `q=ft`'s 1,628.
			return nameNode(pyStr(tok.value), true);
		}
		if (tok.type === TT.WORD) {
			this.consume();
			return this.parseWordPrimary(pyStr(tok.value));
		}
		if (tok.type === TT.NUMBER) {
			return this.parseNumberPrimary();
		}
		if (tok.type === TT.MANA) {
			// bare mana outside attribute context — treat as implicit name
			this.consume();
			return nameNode(pyStr(tok.value));
		}
		if (tok.type === TT.STAR) {
			// A term that STARTS with `*` is a name search whose first character collates away —
			// `q=*ft*` answers 1,628 on Scryfall, exactly as `q=ft` does. Only reachable at the
			// start of a primary, where a multiplication has no left operand and this was a
			// parse error.
			this.consume();
			return this.parseHyphenatedName("*");
		}
		throw new InternalParseError(`Unexpected ${pyStr(tok.value)} at position ${tok.pos}`);
	}

	/**
	 * Parse a parenthesised sub-expression, bounded by MAX_GROUP_DEPTH.
	 *
	 * The counter is incremented for the duration of the nested parse and restored in `finally`, so
	 * SIBLING groups do not accumulate: `(a) (b)` is depth 1 twice, not 2. It is the nesting that
	 * costs stack, and nesting is what the bound is about.
	 *
	 * QueryBudgetExceeded is NOT an InternalParseError, deliberately: `parseQuery`'s catch turns
	 * those into `Failed to parse query: "…"`, and a budget rejection must keep its own
	 * non-disclosing message rather than being reported as a syntax error.
	 */
	parseGroup(): QueryNode {
		if (this.groupDepth >= MAX_GROUP_DEPTH) {
			throw new QueryBudgetExceeded("depth");
		}
		this.groupDepth += 1;
		try {
			this.consume(); // LPAREN
			if (this.peek().type === TT.RPAREN) {
				throw new InternalParseError("Empty parentheses are not allowed");
			}
			const inner = this.parseExpr();
			this.expect(TT.RPAREN);
			return inner;
		} finally {
			this.groupDepth -= 1;
		}
	}

	parseExactName(): QueryNode {
		this.consume(); // BANG
		const tok = this.peek();
		if (tok.type === TT.QUOTED) {
			this.consume();
			return new ExactNameNode(pyStr(tok.value));
		}
		if (tok.type === TT.WORD) {
			this.consume();
			return new ExactNameNode(pyStr(tok.value));
		}
		throw new InternalParseError(`Expected word or quoted string after '!' at position ${tok.pos}`);
	}

	// ── word dispatch ─────────────────────────────────────────────────────────

	/**
	 * Consume a result-shape directive, or return null when this is not one.
	 *
	 * Scryfall accepts these inside the query string itself; they constrain
	 * presentation, not membership, so a directive parses to a DirectiveNode and
	 * `extractDirectives` strips it from the filter tree and hands it to the
	 * route layer. `dir` is Scryfall's short spelling of `direction` and sets the
	 * same parameter. Matching is on the WHOLE word, so `direct:` is unaffected.
	 */
	parseDirectivePrimary(word: string, wl: string, nextTok: Token): QueryNode | null {
		if (!DIRECTIVE_NAMES.includes(wl) || nextTok.type !== TT.OP || nextTok.value !== ":") {
			return null;
		}
		this.consume(); // ':'
		const valTok = this.peek();
		if (valTok.type === TT.WORD || valTok.type === TT.QUOTED || valTok.type === TT.NUMBER) {
			this.consume();
			let value = pyStr(valTok.value);
			// Glue hyphenated continuations, exactly as parseTextValue does. Without
			// this `prefer:usd-low` stops at `usd` and the dangling `-low` fails the
			// parse — which would make the hyphenated spellings Scryfall accepts, and
			// which _DIRECTIVE_PREFER enumerates, unreachable from inside a query.
			// A quoted value is already one token and needs no gluing.
			if (valTok.type !== TT.QUOTED) {
				while (
					this.peek().type === TT.MINUS &&
					!this.peek().spaceBefore &&
					(this.peek(1).type === TT.WORD || this.peek(1).type === TT.NUMBER) &&
					!this.peek(1).spaceBefore
				) {
					this.consume();
					value += `-${pyStr(this.consume().value)}`;
				}
			}
			return new DirectiveNode(wl, pyLower(value));
		}
		throw new InternalParseError(`Expected value after '${word}:' at position ${valTok.pos}`);
	}

	parseWordPrimary(word: string): QueryNode {
		const wl = pyLower(word);
		if (wl === "and" || wl === "or") {
			throw new InternalParseError(`Unexpected keyword ${word}`);
		}

		const pc = ALIAS_TO_PC.get(wl);
		const nextTok = this.peek();

		// ── result-shape directive (unique: / sort: / order: / direction: / dir: / prefer:) ──
		const directive = this.parseDirectivePrimary(word, wl, nextTok);
		if (directive !== null) {
			return directive;
		}

		// ── dual-class alias (cn / number): dispatch on value shape ──
		if (DUAL_NUM_TEXT.has(wl) && nextTok.type === TT.OP) {
			const op = this.consume().value as string;
			if (this.valueStartsNumber()) {
				return new CardBinaryOperatorNode(new CardAttributeNode(wl, PC.NUMERIC), op, this.parseNumExprValue());
			}
			return new CardBinaryOperatorNode(new CardAttributeNode(wl, PC.TEXT), op, this.parseTextValue(wl));
		}

		// ── NUMERIC attribute ──
		if (pc === PC.NUMERIC) {
			const numBangAlias = nextTok.type === TT.BANG && !nextTok.spaceBefore && !this.peek(1).spaceBefore;
			if (nextTok.type === TT.OP || numBangAlias) {
				const op = numBangAlias ? "=" : (nextTok.value as string);
				this.consume();
				return new CardBinaryOperatorNode(new CardAttributeNode(wl, PC.NUMERIC), op, this.parseNumExprValue());
			}
			if (ARITH_OPS.has(nextTok.type) && !nextTok.spaceBefore) {
				let lhs = this.arithTail(new CardAttributeNode(wl, PC.NUMERIC));
				lhs = this.spacedArithTail(lhs);
				if (this.peek().type === TT.OP) {
					const op = this.consume().value as string;
					return new CardBinaryOperatorNode(lhs, op, this.parseNumExprValue());
				}
				return lhs; // standalone arith expression (e.g. cmc-power)
			}
			const lhs = this.spacedArithTail(new CardAttributeNode(wl, PC.NUMERIC));
			if (lhs instanceof CardAttributeNode) {
				// no arithmetic consumed → implicit name
				return bareNameNode(word);
			}
			if (this.peek().type === TT.OP) {
				const op = this.consume().value as string;
				return new CardBinaryOperatorNode(lhs, op, this.parseNumExprValue());
			}
			return lhs;
		}

		// ── known non-NUMERIC attribute ──
		const bangAlias =
			pc !== undefined &&
			nextTok.type === TT.BANG &&
			!nextTok.spaceBefore &&
			!this.peek(1).spaceBefore &&
			BANG_ALIAS_CLASSES.has(pc);
		if (pc !== undefined && (nextTok.type === TT.OP || bangAlias)) {
			const op = bangAlias ? "=" : (nextTok.value as string);
			this.consume();
			return new CardBinaryOperatorNode(new CardAttributeNode(wl, pc), op, this.parseValueForClass(pc, wl));
		}
		if (pc !== undefined) {
			// alias recognised but no operator → might still be a hyphenated bare word (e.g. "a-b-c")
			return this.parseHyphenatedName(word);
		}

		// ── unknown alias → implicit name, possibly hyphenated ──
		return this.parseHyphenatedName(word);
	}

	parseNumberPrimary(): QueryNode {
		const tok = this.consume(); // NUMBER
		let lhs: QueryNode = new NumericValueNode(tok.value as PyNumber);
		if (ARITH_OPS.has(this.peek().type) && !this.peek().spaceBefore && this.numTermStart(this.peek(1))) {
			lhs = this.arithTail(lhs);
		}
		lhs = this.spacedArithTail(lhs);
		if (this.peek().type === TT.OP) {
			const op = this.consume().value as string;
			return new CardBinaryOperatorNode(lhs, op, this.parseNumExprValue());
		}
		return lhs; // standalone numeric literal
	}

	// ── arithmetic helpers ────────────────────────────────────────────────────

	/**
	 * Consume spaced arithmetic operators (e.g. 'power - cmc', 'power + 1').
	 *
	 * For MINUS: requires space before the following operand too, distinguishing
	 * 'power - cmc' (arithmetic) from 'power -cmc' (negation of next factor).
	 * For +, *, /: no such requirement — they have no negation ambiguity.
	 */
	private spacedArithTail(lhsIn: QueryNode): QueryNode {
		let lhs = lhsIn;
		for (;;) {
			const tok = this.peek();
			if (!ARITH_OPS.has(tok.type) || !tok.spaceBefore) break;
			if (tok.type === TT.MINUS && !this.peek(1).spaceBefore) break;
			if (!this.numTermStart(this.peek(1))) break;
			const op = this.consume().value as string;
			lhs = new CardBinaryOperatorNode(lhs, op, this.parseNumTerm());
		}
		return lhs;
	}

	private numTermStart(tok: Token): boolean {
		return (
			tok.type === TT.NUMBER ||
			tok.type === TT.LPAREN ||
			(tok.type === TT.WORD && NUMERIC_ALIASES.has(pyLower(tok.value as string)))
		);
	}

	/** Consume arith ops (no preceding space) and terms to build arithmetic AST. */
	private arithTail(lhsIn: QueryNode): QueryNode {
		let lhs = lhsIn;
		for (;;) {
			const tok = this.peek();
			if (!ARITH_OPS.has(tok.type) || tok.spaceBefore) break;
			if (!this.numTermStart(this.peek(1))) break;
			const op = this.consume().value as string;
			lhs = new CardBinaryOperatorNode(lhs, op, this.parseNumTerm());
		}
		return lhs;
	}

	parseNumTerm(): QueryNode {
		const tok = this.peek();
		if (tok.type === TT.NUMBER) {
			this.consume();
			return new NumericValueNode(tok.value as PyNumber);
		}
		if (tok.type === TT.WORD && NUMERIC_ALIASES.has(pyLower(tok.value as string))) {
			this.consume();
			return new CardAttributeNode(pyLower(tok.value as string), PC.NUMERIC);
		}
		if (tok.type === TT.LPAREN) {
			return this.parseGroup();
		}
		throw new InternalParseError(`Expected numeric term, got ${pyStr(tok.value)} at position ${tok.pos}`);
	}

	/** True if the value about to be parsed opens with a numeric literal, signed or not. */
	private valueStartsNumber(): boolean {
		if (this.peek().type === TT.NUMBER) return true;
		return this.peek().type === TT.MINUS && this.peek(1).type === TT.NUMBER;
	}

	/**
	 * Parse a numeric term that may carry a leading '-' sign (the -1 in 'power>-1').
	 *
	 * Only the leading term of a value expression may be signed. A '-' there has no competing
	 * reading — filter negation and binary subtraction both require a preceding operand, and a
	 * comparison operator has just consumed that position — so no spacing rule is needed to
	 * disambiguate it, unlike the '-' handling in spacedArithTail.
	 */
	parseSignedNumTerm(): QueryNode {
		if (this.peek().type === TT.MINUS && this.peek(1).type === TT.NUMBER) {
			this.consume(); // MINUS
			const tok = this.consume(); // NUMBER
			return new NumericValueNode((tok.value as PyNumber).negate());
		}
		return this.parseNumTerm();
	}

	/** Numeric expression in value context (spaces around arith ops are OK). */
	parseNumExprValue(): QueryNode {
		let lhs = this.parseSignedNumTerm();
		while (ARITH_OPS.has(this.peek().type) && this.numTermStart(this.peek(1))) {
			const tok = this.peek();
			if (tok.type === TT.MINUS && tok.spaceBefore && !this.peek(1).spaceBefore) break;
			const op = this.consume().value as string;
			lhs = new CardBinaryOperatorNode(lhs, op, this.parseNumTerm());
		}
		return lhs;
	}

	// ── implicit name (possibly hyphenated) ───────────────────────────────────

	/**
	 * Build an implicit name node, greedily consuming no-space MINUS+WORD/NUMBER and STAR
	 * continuations.
	 *
	 * A bare term is a `name:` search, so `*` reaches it for the same reason it reaches
	 * `parseTextValue`: the collation deletes it. Measured 2026-08-16 — `q=ft*`, `q=*ft*` and
	 * `q=ft` all answer 1,628 on api.scryfall.com, and `q=godzilla*` answers `q=godzilla`'s 8.
	 */
	parseHyphenatedName(first: string): CardBinaryOperatorNode {
		let word = first;
		for (;;) {
			const next = this.peek();
			if (next.spaceBefore) break;
			if (next.type === TT.STAR) {
				this.consume();
				word += "*";
				continue;
			}
			if (next.type === TT.WORD || next.type === TT.NUMBER) {
				// Only reachable ACROSS a star (`*ft`): the lexer scans adjacent word characters
				// into one token, so two of them never touch on their own.
				this.consume();
				word += pyStr(next.value);
				continue;
			}
			if (
				next.type === TT.MINUS &&
				(this.peek(1).type === TT.WORD || this.peek(1).type === TT.NUMBER) &&
				!this.peek(1).spaceBefore
			) {
				this.consume(); // MINUS
				word += `-${pyStr(this.consume().value)}`;
				continue;
			}
			break;
		}
		return bareNameNode(word);
	}

	// ── value parsers ─────────────────────────────────────────────────────────

	parseValueForClass(pc: ParserClass, attr: string): QueryNode {
		if (pc === PC.TEXT) {
			return this.parseTextValue(attr);
		}
		if (pc === PC.NUMERIC) {
			return this.parseNumExprValue();
		}
		if (pc === PC.COLOR) {
			return this.parseColorValue();
		}
		if (pc === PC.MANA) {
			return this.parseManaValue();
		}
		if (pc === PC.RARITY || pc === PC.LEGALITY) {
			return this.parseStringValue();
		}
		if (pc === PC.DATE) {
			return this.parseDateValue();
		}
		if (pc === PC.YEAR) {
			return this.parseYearValue();
		}
		throw new InternalParseError(`Unknown parser class ${pc}`);
	}

	/** Parse a text value: quoted string, regex, or bare word (with hyphenated continuation). */
	parseTextValue(attr: string): QueryNode {
		const tok = this.peek();
		if (tok.type === TT.QUOTED) {
			this.consume();
			// QUOTED, and `name:` reads that as "match this literally" — see StringValueNode.
			return new StringValueNode(pyStr(tok.value), true);
		}
		if (tok.type === TT.REGEX) {
			this.consume();
			return new RegexValueNode(pyStr(tok.value));
		}
		if (tok.type === TT.WORD || tok.type === TT.NUMBER || tok.type === TT.STAR) {
			this.consume();
			let word = tok.type === TT.STAR ? "*" : pyStr(tok.value);
			// Greedily consume hyphenated and STARRED continuation (no space on either side).
			//
			// `*` IS AN ORDINARY CHARACTER IN A VALUE, not a wildcard and not an error. Scryfall
			// answers `name:ft*`, `name:*ft*`, `name:*ft` and `name:f*t` with the same 1,628 as
			// `name:ft` — because a bare `name:` value is COLLATED and `*` is one more
			// non-alphanumeric character to delete, exactly like the `-` in `name:lightning-bolt`
			// (2) and the `,` in `name:lightning,bolt` (2). It is not a tokenizer rule: the same
			// `*` in a column that is NOT collated stays put and finds nothing, which is what
			// `o:ft*`, `t:crea*ture`, `ft:cro*ft` and the QUOTED `name:"ft*"` all answer (404),
			// and `a:gu*ay` matches `a:guay` because artist is collated too. All measured on
			// api.scryfall.com 2026-08-16. This port rejected the character outright, so every
			// one of those was a 400 instead.
			for (;;) {
				const next = this.peek();
				if (next.spaceBefore) break;
				if (next.type === TT.STAR) {
					this.consume();
					word += "*";
					continue;
				}
				if (next.type === TT.WORD || next.type === TT.NUMBER) {
					this.consume();
					word += pyStr(next.value);
					continue;
				}
				if (
					next.type === TT.MINUS &&
					(this.peek(1).type === TT.WORD || this.peek(1).type === TT.NUMBER) &&
					!this.peek(1).spaceBefore
				) {
					this.consume();
					word += `-${pyStr(this.consume().value)}`;
					continue;
				}
				break;
			}
			return new StringValueNode(word);
		}
		throw new InternalParseError(`Expected value for ${attr}, got ${pyStr(tok.value)} at position ${tok.pos}`);
	}

	/** Parse a mana cost value: a sequence of mana symbols, words, or numbers (no gaps). */
	parseManaValue(): QueryNode {
		const tok = this.peek();
		let value: string;
		if (tok.type === TT.QUOTED) {
			this.consume();
			value = pyUpper(pyStr(tok.value));
		} else {
			const parts: string[] = [];
			for (;;) {
				const t = this.peek();
				if (t.type === TT.MANA || t.type === TT.WORD || t.type === TT.NUMBER) {
					if (parts.length > 0 && t.spaceBefore) break;
					this.consume();
					parts.push(pyStr(t.value));
				} else {
					break;
				}
			}
			if (parts.length === 0) {
				throw new InternalParseError(`Expected mana value at position ${this.peek().pos}`);
			}
			value = pyUpper(parts.join(""));
		}
		// A mana cost can only hold certain symbols, so anything else is a query that cannot match.
		// '{Q}' is a real symbol (untap) but never appears in a cost, which is why this asks what a
		// cost may contain rather than what Magic prints. Quoting a value is just an alternate way to
		// type it (e.g. to protect spaces), not an opt-out of this check — a quoted `mana:"q"` used to
		// skip straight to StringValueNode, so it silently matched every card via an empty cost dict.
		const invalid = firstInvalidManaSymbol(value);
		if (invalid !== null) {
			throw new InternalParseError(`Invalid mana symbol ${pyRepr(invalid)} at position ${tok.pos}`);
		}
		return new ManaValueNode(value);
	}

	/** Parse a simple string value: quoted string or bare word. */
	parseStringValue(): QueryNode {
		const tok = this.peek();
		if (tok.type === TT.QUOTED) {
			this.consume();
			return new StringValueNode(pyStr(tok.value));
		}
		if (tok.type === TT.WORD) {
			this.consume();
			return new StringValueNode(pyStr(tok.value));
		}
		throw new InternalParseError(`Expected string value, got ${pyStr(tok.value)} at position ${tok.pos}`);
	}

	/** Parse a color value: a color name, a combination of color letters, or a bare integer count. */
	parseColorValue(): QueryNode {
		const tok = this.peek();
		if (tok.type === TT.NUMBER) {
			// Scryfall numeric color syntax: id>=3 / c=2 compare the NUMBER of colors in the
			// field, so a bare integer is a valid color value.
			const num = tok.value as PyNumber;
			if (num.isFloat) {
				// InternalParseError, not ParseError: upstream raises hand_parser's own ParseError
				// here, which parse_query catches and re-raises as 'Failed to parse query: "…"'.
				// The port's wrapper catches InternalParseError, so that is the equivalent type.
				throw new InternalParseError(`Expected integer color count, got ${num.toString()} at position ${tok.pos}`);
			}
			this.consume();
			return new NumericValueNode(num);
		}
		if (tok.type === TT.QUOTED) {
			this.consume();
			return new StringValueNode(pyStr(tok.value));
		}
		if (tok.type === TT.WORD) {
			const val = pyStr(tok.value);
			// The four-colour names are HYPHENATED (`yore-tiller`, `witch-maw`), and `-` is not a
			// word-continuation character, so the lexer hands this WORD MINUS WORD. Glue the three
			// back together — but only when the result is a name, so an ordinary `c:w-1` still
			// ends the value at the `w` and lets arithmetic have the rest. Same adjacency rule
			// parseDateValue uses for YYYY-MM-DD: no space on either side of the hyphen.
			if (
				this.peek(1).type === TT.MINUS &&
				!this.peek(1).spaceBefore &&
				this.peek(2).type === TT.WORD &&
				!this.peek(2).spaceBefore &&
				VALID_COLOR_NAMES.has(pyLower(`${val}-${pyStr(this.peek(2).value)}`))
			) {
				this.consume();
				this.consume();
				const tail = this.consume();
				return new StringValueNode(`${val}-${pyStr(tail.value)}`);
			}
			if (!VALID_COLOR_NAMES.has(pyLower(val)) && ![...val].every((c) => COLOR_LETTERS.has(c))) {
				throw new InternalParseError(`Invalid color value ${val} at position ${tok.pos}`);
			}
			this.consume();
			return new StringValueNode(val);
		}
		throw new InternalParseError(`Expected color value, got ${pyStr(tok.value)} at position ${tok.pos}`);
	}

	/** Parse a date value: YYYY, YYYY-MM or YYYY-MM-DD (hyphens must have no surrounding spaces). */
	parseDateValue(): QueryNode {
		const tok = this.peek();
		if (tok.type !== TT.NUMBER) {
			throw new InternalParseError(`Expected date, got ${pyStr(tok.value)} at position ${tok.pos}`);
		}
		this.consume();
		const year = validateMtgYear(tok.value as PyNumber, tok.pos);
		// Consume YYYY-MM-DD: two MINUS+NUMBER pairs without spaces
		if (
			this.peek().type === TT.MINUS &&
			!this.peek().spaceBefore &&
			this.peek(1).type === TT.NUMBER &&
			!this.peek(1).spaceBefore
		) {
			this.consume();
			const monthTok = this.consume();
			const month = (monthTok.value as PyNumber).toBigIntTruncated();
			if (
				this.peek().type === TT.MINUS &&
				!this.peek().spaceBefore &&
				this.peek(1).type === TT.NUMBER &&
				!this.peek(1).spaceBefore
			) {
				this.consume();
				const dayTok = this.consume();
				const day = (dayTok.value as PyNumber).toBigIntTruncated();
				if (!isValidDate(Number(year), Number(month), Number(day))) {
					throw new InternalParseError(`Invalid date ${year}-${pad2(month)}-${pad2(day)} at position ${tok.pos}`);
				}
				return new StringValueNode(`${year}-${pad2(month)}-${pad2(day)}`);
			}
			// YEAR-MONTH, with NO day: the month tokens are already consumed, and returning the
			// bare year here dropped them on the floor — silently, so `date:2021-02` answered
			// `date:2021`'s whole year. A partial date names a WINDOW (see `build_binary`'s
			// released_at arm, which already reads yyyymm as [yyyymm01, yyyymm31] and is where
			// the six operators pick their end of it); this only has to hand it the six digits.
			//
			// The oracle is the same shape the bare-year fix used, one precision down: a
			// year-month must equal the half-open range its own ends describe. Measured on
			// api.scryfall.com 2026-08-16, `date:2021-02` is 504 and `date>=2021-02 date<2021-03`
			// is 504, while `date:2021` is 3,834 — the answer this returned. Every operator,
			// against ours after the change: `date>=2021-02` 20,085, `date<2021-03` 21,269,
			// `date<=2021-02` 21,269, `date>2021-02` 19,871, `date!=2021-02` 33,422.
			//
			// A month outside 1..12 throws, exactly as an impossible DAY already does one branch
			// up. Scryfall 400s on `date:2021-13` ("All of your terms were ignored") where this
			// answered the whole of 2021.
			//
			// NOT zero-padding-strict: Scryfall 400s on `date:2021-2` and this accepts it as
			// 2021-02. That gap is pre-existing and shared with the day path (`date:2021-2-5` is
			// a 400 there and 482 here), and is deliberately left alone rather than widened here.
			if (month < 1n || month > 12n) {
				throw new InternalParseError(`Invalid date ${year}-${pad2(month)} at position ${tok.pos}`);
			}
			return new StringValueNode(`${year}-${pad2(month)}`);
		}
		return new StringValueNode(year.toString());
	}

	/** Parse a year value: 4-digit integer >= 1992. */
	parseYearValue(): QueryNode {
		const tok = this.peek();
		if (tok.type !== TT.NUMBER) {
			throw new InternalParseError(`Expected year, got ${pyStr(tok.value)} at position ${tok.pos}`);
		}
		this.consume();
		const year = validateMtgYear(tok.value as PyNumber, tok.pos);
		return new StringValueNode(year.toString());
	}
}

// ── entry point ───────────────────────────────────────────────────────────────

/**
 * Parse a Scryfall query string into a Query AST (hand_parser.parse_query).
 *
 * Lex/parse failures are wrapped exactly like Python's ValueError re-raise;
 * they surface as ParseError with the identical message.
 */
export function parseQuery(src: string | null | undefined): Query {
	if (!src || !pyStrip(src)) {
		return new Query(new TrueNode());
	}
	// Before the lexer, because a curly quote has to BE a quote by the time a term boundary is
	// decided; and rebinding `src` so the "Failed to lex/parse" messages echo the query the parser
	// actually read rather than the one the user pasted.
	src = foldTypographicQuotes(src);
	let tokens: Token[];
	try {
		tokens = tokenize(src);
	} catch (exc) {
		if (exc instanceof LexError) {
			throw new ParseError(`Failed to lex query: "${src}"`);
		}
		throw exc;
	}
	let result: Query;
	try {
		result = new Parser(tokens).parse();
	} catch (exc) {
		if (exc instanceof InternalParseError) {
			throw new ParseError(`Failed to parse query: "${src}"`);
		}
		throw exc;
	}
	return flattenNestedOperations(result);
}
