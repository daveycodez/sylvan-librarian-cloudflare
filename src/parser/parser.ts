/**
 * Port of the recursive-descent parser half of api/parsing/hand_parser.py.
 *
 * Structure and method names mirror the Python Parser class one-to-one so that
 * upstream diffs of hand_parser.py can be hand-applied here.
 */

import { CardAttributeNode, CardBinaryOperatorNode, ExactNameNode } from "./card-query-nodes";
import { ALIAS_TO_FIELD_INFOS, COLOR_NAME_TO_CODE, type ParserClass, ParserClass as PC } from "./db-info";
import { InternalParseError, LexError, ParseError } from "./errors";
import {
	AndNode,
	BinaryOperatorNode,
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
import { type Token, TT, tokenize } from "./tokenizer";

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

const VALID_COLOR_NAMES: ReadonlySet<string> = new Set(COLOR_NAME_TO_CODE.keys());
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

function nameNode(value: string): CardBinaryOperatorNode {
	return new CardBinaryOperatorNode(new CardAttributeNode("name", PC.TEXT), ":", new StringValueNode(value));
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
			return nameNode(pyStr(tok.value));
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
		throw new InternalParseError(`Unexpected ${pyStr(tok.value)} at position ${tok.pos}`);
	}

	parseGroup(): QueryNode {
		this.consume(); // LPAREN
		if (this.peek().type === TT.RPAREN) {
			throw new InternalParseError("Empty parentheses are not allowed");
		}
		const inner = this.parseExpr();
		this.expect(TT.RPAREN);
		return inner;
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

	parseWordPrimary(word: string): QueryNode {
		const wl = pyLower(word);
		if (wl === "and" || wl === "or") {
			throw new InternalParseError(`Unexpected keyword ${word}`);
		}

		const pc = ALIAS_TO_PC.get(wl);
		const nextTok = this.peek();

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
			if (nextTok.type === TT.OP) {
				const op = this.consume().value as string;
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
		if (pc !== undefined && nextTok.type === TT.OP) {
			const op = this.consume().value as string;
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

	/** Build an implicit name node, greedily consuming no-space MINUS+WORD/NUMBER continuations. */
	parseHyphenatedName(first: string): CardBinaryOperatorNode {
		const parts = [first];
		while (
			this.peek().type === TT.MINUS &&
			!this.peek().spaceBefore &&
			(this.peek(1).type === TT.WORD || this.peek(1).type === TT.NUMBER) &&
			!this.peek(1).spaceBefore
		) {
			this.consume(); // MINUS
			parts.push(pyStr(this.consume().value));
		}
		return bareNameNode(parts.join("-"));
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
			return new StringValueNode(pyStr(tok.value));
		}
		if (tok.type === TT.REGEX) {
			this.consume();
			return new RegexValueNode(pyStr(tok.value));
		}
		if (tok.type === TT.WORD || tok.type === TT.NUMBER) {
			this.consume();
			let word = pyStr(tok.value);
			// Greedily consume hyphenated continuation (no space on either side)
			while (
				this.peek().type === TT.MINUS &&
				!this.peek().spaceBefore &&
				(this.peek(1).type === TT.WORD || this.peek(1).type === TT.NUMBER) &&
				!this.peek(1).spaceBefore
			) {
				this.consume();
				word += `-${pyStr(this.consume().value)}`;
			}
			return new StringValueNode(word);
		}
		throw new InternalParseError(`Expected value for ${attr}, got ${pyStr(tok.value)} at position ${tok.pos}`);
	}

	/** Parse a mana cost value: a sequence of mana symbols, words, or numbers (no gaps). */
	parseManaValue(): QueryNode {
		const tok = this.peek();
		if (tok.type === TT.QUOTED) {
			this.consume();
			return new StringValueNode(pyStr(tok.value));
		}
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
		return new ManaValueNode(pyUpper(parts.join("")));
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
			if (!VALID_COLOR_NAMES.has(pyLower(val)) && ![...val].every((c) => COLOR_LETTERS.has(c))) {
				throw new InternalParseError(`Invalid color value ${val} at position ${tok.pos}`);
			}
			this.consume();
			return new StringValueNode(val);
		}
		throw new InternalParseError(`Expected color value, got ${pyStr(tok.value)} at position ${tok.pos}`);
	}

	/** Parse a date value: YYYY or YYYY-MM-DD (hyphens must have no surrounding spaces). */
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
			if (
				this.peek().type === TT.MINUS &&
				!this.peek().spaceBefore &&
				this.peek(1).type === TT.NUMBER &&
				!this.peek(1).spaceBefore
			) {
				this.consume();
				const dayTok = this.consume();
				const month = (monthTok.value as PyNumber).toBigIntTruncated();
				const day = (dayTok.value as PyNumber).toBigIntTruncated();
				if (!isValidDate(Number(year), Number(month), Number(day))) {
					throw new InternalParseError(`Invalid date ${year}-${pad2(month)}-${pad2(day)} at position ${tok.pos}`);
				}
				return new StringValueNode(`${year}-${pad2(month)}-${pad2(day)}`);
			}
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
