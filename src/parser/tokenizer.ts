/**
 * Port of the lexer half of api/parsing/hand_parser.py.
 *
 * Operates on code points (Python string indexing), so positions and word
 * boundaries match Python for astral-plane characters too.
 */

import { LexError } from "./errors";
import { isAlphaCp, PyNumber } from "./pystr";
import { braceCloseIndex, findCloseIndex, QUOTE_CHARS, unescapeSpan } from "./spans";

export enum TT {
	WORD = "WORD", // [a-zA-Z_][a-zA-Z0-9_.]* (includes digits-then-letters like "2rr")
	NUMBER = "NUMBER", // integer or float
	QUOTED = "QUOTED", // "..." or '...'
	REGEX = "REGEX", // /pattern/
	MANA = "MANA", // {W}, {2/R}, …
	OP = "OP", // : = != >= <= > <
	PLUS = "PLUS",
	MINUS = "MINUS",
	STAR = "STAR",
	SLASH = "SLASH",
	LPAREN = "LPAREN",
	RPAREN = "RPAREN",
	BANG = "BANG", // ! (exact-name prefix)
	EOF = "EOF",
}

export interface Token {
	readonly type: TT;
	readonly value: string | PyNumber;
	readonly pos: number;
	readonly spaceBefore: boolean;
}

const WORD_START = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_");
const WORD_CONT = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789.");
const DIGIT = new Set("0123456789");
const SPACE = new Set(" \t\r\n");
// A comma standing on its own is a natural-language separator, skipped like whitespace
// (Scryfall: "rograkh , son" filters exactly as "rograkh son"). A comma ATTACHED to a word
// stays part of that word's token — see scanWordEnd — so a field value keeps it verbatim
// (Scryfall: "t:goblin," matches nothing) while a bare name sheds it in bareNameNode.
const SKIPPED = new Set([...SPACE, ","]);

/**
 * The four typographic quotes Scryfall folds before lexing, and the only four.
 *
 * Every word processor and phone keyboard turns a typed apostrophe into U+2019 and typed double
 * quotes into U+201C/U+201D, so a pasted query carries them constantly — and this parser read them
 * as ordinary letters, which made `name:"Gaea’s Blessing"` a search for a card whose name contains
 * a curly apostrophe: no rows, no error, no clue.
 *
 * Measured against api.scryfall.com (2026-08-16) by putting each candidate around a phrase and
 * asking whether the phrase searched as ONE term (`o:Xdraw a cardX` → 2,544 rows means X delimits
 * a string). U+2018/U+2019 fold to the ASCII apostrophe and U+201C/U+201D to the ASCII double
 * quote; every other quotation-shaped character stays literal and matches nothing — guillemets
 * « » ‹ ›, low-9 „ ‚, primes ′ ″ ‵, fullwidth ＂ ＇, CJK brackets 「」『』, ornate ❛❜❝❞, backtick,
 * acute, U+02BC.
 *
 * It is a CHARACTER substitution over the whole query, not a rule about quoted regions:
 * `name:"Gaea’s Blessing"` finds Gaea's Blessing, which it could not if the curly apostrophe were
 * left alone INSIDE the double quotes, and `name:‘Gaea"s Blessing’` finds nothing, exactly as
 * `name:'Gaea"s Blessing'` does. Both directions had to be measured, because folding all four to
 * `"` fits the first observation and fails the second.
 *
 * It lived only on the compat surface until now, so `/search` and the web UI rejected the very
 * quotes their own search box produces.
 */
const TYPOGRAPHIC_QUOTES: ReadonlyMap<string, string> = new Map([
	["‘", "'"],
	["’", "'"],
	["“", '"'],
	["”", '"'],
]);

/** Fold the four typographic quotes Scryfall folds; every other character is left alone. */
export function foldTypographicQuotes(query: string): string {
	let out = "";
	let changed = false;
	for (const ch of query) {
		const folded = TYPOGRAPHIC_QUOTES.get(ch);
		if (folded === undefined) out += ch;
		else {
			out += folded;
			changed = true;
		}
	}
	return changed ? out : query;
}

/** ASCII identifier start, or any Unicode letter — accented card names, e.g. Éowyn (#649). */
function isWordStart(c: string): boolean {
	return WORD_START.has(c) || isAlphaCp(c.codePointAt(0) as number);
}

/** ASCII identifier continuation, or any Unicode letter (#649). */
function isWordCont(c: string): boolean {
	return WORD_CONT.has(c) || isAlphaCp(c.codePointAt(0) as number);
}

/**
 * Advance j past word-continuation characters and return the word's end.
 *
 * Beyond `isWordCont`, a word carries commas ("rograkh," — Scryfall keeps them on the token,
 * and bare names shed them later in `bareNameNode`) and apostrophes that are not opening a
 * quoted string: "urza's", and "urza'" mid-type. The lookahead keeps a LEADING quote of an
 * actual quoted string, as in name:'power', lexing as a QUOTED token exactly as before.
 *
 * End of input counts as "followed by more word", not as "followed by a quote". Without that,
 * "urza'" — every typeahead keystroke on the way to "urza's" — was a lex error, and the only
 * way the balancer could rescue it was to append a second apostrophe. That parsed, but as
 * `urza` AND an empty quoted string, so the search silently widened to every card containing
 * "urza" and the explanation rendered "the name contains Urza and " with nothing after the
 * "and". Deliberately NOT "preceded by a word char", which would also swallow the first
 * apostrophe of "urza''" and leave the second one opening a string that never closes.
 */
function scanWordEnd(src: string[], n: number, j: number): number {
	while (j < n) {
		const c = src[j] as string;
		const apostropheInWord = c === "'" && (j + 1 >= n || isWordCont(src[j + 1] as string));
		if (!(isWordCont(c) || c === "," || apostropheInWord)) break;
		j += 1;
	}
	return j;
}

/**
 * Find the `quote` closing a string opened before `start` and unescape its content, or null if the
 * string is unterminated. The walk is spans.findCloseIndex — the balancer's — so the lexer and
 * balancer can't drift on where an escaped quote ends; `sawEscape` comes free from it, so the common
 * no-backslash case skips the unescape pass entirely.
 */
function closedQuote(
	src: readonly string[],
	start: number,
	quote: string,
): { closeIndex: number; content: string } | null {
	const { closeIndex, sawEscape } = findCloseIndex(src, start, quote);
	if (closeIndex === null) return null;
	const content = src.slice(start, closeIndex).join("");
	return { closeIndex, content: sawEscape ? unescapeSpan(content) : content };
}

/**
 * Find the '/' closing a regex opened before `start`, unescaping ONLY `\/` → `/`; null if
 * unterminated. Every other backslash sequence (`\d`) is left for the regex engine to interpret.
 */
function closedRegex(src: readonly string[], start: number): { closeIndex: number; content: string } | null {
	const { closeIndex, sawEscape } = findCloseIndex(src, start, "/");
	if (closeIndex === null) return null;
	const content = src.slice(start, closeIndex).join("");
	return { closeIndex, content: sawEscape ? content.replaceAll("\\/", "/") : content };
}

/** Lex a query string into a flat list of Tokens, terminated by an EOF token. */
export function tokenize(source: string): Token[] {
	const src = [...source]; // code points
	const tokens: Token[] = [];
	let pos = 0;
	const n = src.length;
	let spaceBefore = false;

	const push = (type: TT, value: string | PyNumber, start: number, sb: boolean) => {
		tokens.push({ type, value, pos: start, spaceBefore: sb });
	};
	const slice = (a: number, b: number) => src.slice(a, b).join("");

	while (pos < n) {
		const cur = src[pos] as string;
		if (SKIPPED.has(cur)) {
			while (pos < n && SKIPPED.has(src[pos] as string)) pos++;
			spaceBefore = true;
			continue;
		}

		const start = pos;
		const sb = spaceBefore;
		spaceBefore = false;
		const c = cur;

		// {mana symbol}. braceCloseIndex is shared with the balancer (spans.ts): both have to agree
		// that a '{...}' is opaque whatever it holds, or the balancer reads the ')' in '(mana:{)})'
		// as query structure and rejects a query the lexer accepts — upstream #905's bug class,
		// with braces in place of quotes.
		if (c === "{") {
			const end = braceCloseIndex(src, pos + 1);
			if (end === null) {
				throw new LexError(`Unclosed '{' at position ${pos}`);
			}
			pos = end + 1;
			push(TT.MANA, slice(start, pos), start, sb);
			continue;
		}

		// Quoted string. The escape-skipping walk is the balancer's `findCloseIndex`, so the two
		// cannot disagree that a backslash escapes the next character (upstream #905: the balancer
		// read the ' in 'don\'t' as the close and appended a quote the lexer never wanted).
		if (QUOTE_CHARS.has(c)) {
			const closed = closedQuote(src, pos + 1, c);
			if (closed === null) {
				throw new LexError(`Unclosed quote at position ${start}`);
			}
			pos = closed.closeIndex + 1;
			push(TT.QUOTED, closed.content, start, sb);
			continue;
		}

		// Operators >= <= != : = > <  and  ! (bang)
		if (c === ">") {
			if (pos + 1 < n && src[pos + 1] === "=") {
				push(TT.OP, ">=", start, sb);
				pos += 2;
			} else {
				push(TT.OP, ">", start, sb);
				pos += 1;
			}
			continue;
		}
		if (c === "<") {
			if (pos + 1 < n && src[pos + 1] === "=") {
				push(TT.OP, "<=", start, sb);
				pos += 2;
			} else {
				push(TT.OP, "<", start, sb);
				pos += 1;
			}
			continue;
		}
		if (c === "!") {
			if (pos + 1 < n && src[pos + 1] === "=") {
				push(TT.OP, "!=", start, sb);
				pos += 2;
			} else {
				push(TT.BANG, "!", start, sb);
				pos += 1;
			}
			continue;
		}
		if (c === ":") {
			push(TT.OP, ":", start, sb);
			pos += 1;
			continue;
		}
		if (c === "=") {
			push(TT.OP, "=", start, sb);
			pos += 1;
			continue;
		}

		// Slash: a regex only opens in value position — directly after a comparison operator, which
		// is the only place the parser accepts one. Anywhere else '/' is arithmetic division.
		//
		// Without the guard the scan is greedy across the whole remaining query, so the division in
		// "power/2>1 name:/a/" swallows "2>1 name:" as a pattern and the query cannot parse at all
		// (upstream #908). Value position is unambiguous: division needs a left operand, and the
		// operator just consumed that slot.
		if (c === "/") {
			const prev = tokens.length > 0 ? tokens[tokens.length - 1] : undefined;
			const inValuePosition = prev !== undefined && prev.type === TT.OP;
			const closed = inValuePosition ? closedRegex(src, pos + 1) : null;
			if (closed === null) {
				// Division, or an unterminated regex falling back to division.
				push(TT.SLASH, "/", start, sb);
				pos += 1;
			} else {
				push(TT.REGEX, closed.content, start, sb);
				pos = closed.closeIndex + 1;
			}
			continue;
		}

		// Single-char arithmetic / grouping
		if (c === "+") {
			push(TT.PLUS, "+", start, sb);
			pos += 1;
			continue;
		}
		if (c === "-") {
			push(TT.MINUS, "-", start, sb);
			pos += 1;
			continue;
		}
		if (c === "*") {
			push(TT.STAR, "*", start, sb);
			pos += 1;
			continue;
		}
		if (c === "(") {
			push(TT.LPAREN, "(", start, sb);
			pos += 1;
			continue;
		}
		if (c === ")") {
			push(TT.RPAREN, ")", start, sb);
			pos += 1;
			continue;
		}

		// Number — if immediately followed by word chars, treat as WORD ("2rr", "40k-model" prefix)
		if (DIGIT.has(c)) {
			let j = pos + 1;
			while (j < n && DIGIT.has(src[j] as string)) j++;
			if (j < n && src[j] === "." && j + 1 < n && DIGIT.has(src[j + 1] as string)) {
				j++;
				while (j < n && DIGIT.has(src[j] as string)) j++;
			}
			const text = slice(pos, j);
			if (j < n && isWordCont(src[j] as string)) {
				j = scanWordEnd(src, n, j);
				push(TT.WORD, slice(pos, j), start, sb);
			} else if (text.includes(".")) {
				push(TT.NUMBER, PyNumber.float(Number(text)), start, sb);
			} else {
				push(TT.NUMBER, PyNumber.int(BigInt(text)), start, sb);
			}
			pos = j;
			continue;
		}

		// Word
		if (isWordStart(c)) {
			const j = scanWordEnd(src, n, pos + 1);
			push(TT.WORD, slice(pos, j), start, sb);
			pos = j;
			continue;
		}

		throw new LexError(`Unexpected character ${JSON.stringify(c)} at position ${pos}`);
	}

	tokens.push({ type: TT.EOF, value: "", pos: n, spaceBefore });
	return tokens;
}
