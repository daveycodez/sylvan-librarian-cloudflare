/**
 * Port of the lexer half of api/parsing/hand_parser.py.
 *
 * Operates on code points (Python string indexing), so positions and word
 * boundaries match Python for astral-plane characters too.
 */

import { LexError } from "./errors";
import { isAlphaCp, PyNumber } from "./pystr";

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

/** ASCII identifier start, or any Unicode letter — accented card names, e.g. Éowyn (#649). */
function isWordStart(c: string): boolean {
	return WORD_START.has(c) || isAlphaCp(c.codePointAt(0) as number);
}

/** ASCII identifier continuation, or any Unicode letter (#649). */
function isWordCont(c: string): boolean {
	return WORD_CONT.has(c) || isAlphaCp(c.codePointAt(0) as number);
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
		if (SPACE.has(cur)) {
			while (pos < n && SPACE.has(src[pos] as string)) pos++;
			spaceBefore = true;
			continue;
		}

		const start = pos;
		const sb = spaceBefore;
		spaceBefore = false;
		const c = cur;

		// {mana symbol}
		if (c === "{") {
			const end = src.indexOf("}", pos + 1);
			if (end === -1) {
				throw new LexError(`Unclosed '{' at position ${pos}`);
			}
			pos = end + 1;
			push(TT.MANA, slice(start, pos), start, sb);
			continue;
		}

		// Quoted string
		if (c === '"' || c === "'") {
			const quote = c;
			pos++;
			const chars: string[] = [];
			let closed = false;
			while (pos < n) {
				const ch = src[pos] as string;
				if (ch === "\\" && pos + 1 < n) {
					pos++;
					chars.push(src[pos] as string);
					pos++;
				} else if (ch === quote) {
					pos++;
					closed = true;
					break;
				} else {
					chars.push(ch);
					pos++;
				}
			}
			if (!closed) {
				throw new LexError(`Unclosed quote at position ${start}`);
			}
			push(TT.QUOTED, chars.join(""), start, sb);
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

		// Slash: greedily try /regex/, fall back to arithmetic SLASH
		if (c === "/") {
			let i = pos + 1;
			let matched = false;
			while (i < n) {
				if (src[i] === "\\" && i + 1 < n) {
					i += 2;
				} else if (src[i] === "/") {
					const pattern = slice(pos + 1, i).replaceAll("\\/", "/");
					pos = i + 1;
					push(TT.REGEX, pattern, start, sb);
					matched = true;
					break;
				} else {
					i += 1;
				}
			}
			if (!matched) {
				push(TT.SLASH, "/", start, sb);
				pos += 1;
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
				while (j < n && isWordCont(src[j] as string)) j++;
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
			let j = pos + 1;
			while (j < n && isWordCont(src[j] as string)) j++;
			push(TT.WORD, slice(pos, j), start, sb);
			pos = j;
			continue;
		}

		throw new LexError(`Unexpected character ${JSON.stringify(c)} at position ${pos}`);
	}

	tokens.push({ type: TT.EOF, value: "", pos: n, spaceBefore });
	return tokens;
}
