/**
 * Port of api/parsing/spans.py — the character-level span rules the lexer and the query balancer
 * share.
 *
 * A leaf module on purpose: index.ts's balancer and tokenizer.ts both need "where does a span
 * start, and where does it end", and keeping two copies of that is how upstream #905 happened —
 * the balancer closed a quote that the lexer had already treated as content.
 *
 * Operates on arrays of code points (Python string indexing), like the tokenizer.
 */

export const QUOTE_CHARS: ReadonlySet<string> = new Set(["'", '"']);

/**
 * Last character of every comparison operator the lexer emits (':', '=', '!=', '>=', '<=', '>',
 * '<'). A '/' directly after one of these is in value position, which is the only place a regex
 * opens.
 */
export const COMPARISON_TAIL_CHARS: ReadonlySet<string> = new Set([":", "=", ">", "<"]);

/**
 * Python's `str.isspace()`: bidirectional type WS, B or S, or general category Zs. NOT JS's `\s`,
 * which admits U+FEFF and omits U+001C–U+001F and U+0085.
 */
const PY_SPACE: ReadonlySet<string> = new Set([
	"\t",
	"\n",
	"\v",
	"\f",
	"\r",
	"\x1c",
	"\x1d",
	"\x1e",
	"\x1f",
	" ",
	"\x85",
	"\xa0",
	"\u1680",
	"\u2000",
	"\u2001",
	"\u2002",
	"\u2003",
	"\u2004",
	"\u2005",
	"\u2006",
	"\u2007",
	"\u2008",
	"\u2009",
	"\u200a",
	"\u2028",
	"\u2029",
	"\u202f",
	"\u205f",
	"\u3000",
]);

/**
 * Whether the '/' at `slashIndex` opens a regex rather than being division.
 *
 * The character-level form of the rule in the tokenizer, for callers that have no token stream to
 * look back into — the balancer, which runs on partially typed queries. The lexer checks the same
 * thing more precisely, by asking whether the previous token was a comparison operator.
 */
export function opensRegex(query: readonly string[], slashIndex: number): boolean {
	let pos = slashIndex - 1;
	while (pos >= 0 && PY_SPACE.has(query[pos] as string)) pos -= 1;
	return pos >= 0 && COMPARISON_TAIL_CHARS.has(query[pos] as string);
}

/**
 * Index of the '}' closing a mana symbol whose content starts at `start`, or null if unterminated.
 *
 * A plain search for the next '}': no escape sequence exists inside a mana symbol, so a '{...}' is
 * opaque whatever it holds. Deliberately no charset bounding the content — the lexer demands a '}'
 * for every '{', so a balancer that declined to close the '{' in `mana:{'` would leave a prefix of
 * the accepted query `mana:{'}` unlexable halfway through being typed (upstream #908). Whether the
 * content is a REAL symbol is mana-symbols.ts's question, not this one's.
 */
export function braceCloseIndex(query: readonly string[], start: number): number | null {
	const index = query.indexOf("}", start);
	return index < 0 ? null : index;
}

export interface CloseSearch {
	/** Index of the next unescaped closer, or null if never found. */
	readonly closeIndex: number | null;
	/** True only when the walk instead ran to the end of the query on a dangling escape. */
	readonly danglingEscape: boolean;
	/** True if the walk stepped over any backslash escape at all. */
	readonly sawEscape: boolean;
}

/**
 * Where the next unescaped `closer` is, whether a dangling escape ended the walk, and whether it
 * saw one. A backslash escapes the character after it inside a span, so `'\''` is one string
 * holding a single quote; all three answers fall out of one walk.
 */
export function findCloseIndex(query: readonly string[], start: number, closer: string): CloseSearch {
	let pos = start;
	const length = query.length;
	let sawEscape = false;
	while (pos < length) {
		const c = query[pos];
		if (c === "\\") {
			sawEscape = true;
			if (pos + 1 >= length) {
				return { closeIndex: null, danglingEscape: true, sawEscape };
			}
			pos += 2;
		} else if (c === closer) {
			return { closeIndex: pos, danglingEscape: false, sawEscape };
		} else {
			pos += 1;
		}
	}
	return { closeIndex: null, danglingEscape: false, sawEscape };
}

/** Resolve backslash escapes in span content, so `a\'b` becomes `a'b` (Python `\\(.)` → `\1`). */
export function unescapeSpan(text: string): string {
	return text.replace(/\\([\s\S])/gu, "$1");
}
