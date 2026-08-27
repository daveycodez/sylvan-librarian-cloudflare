/**
 * Public search query size and parenthesis-nesting bounds
 * (TypeScript port of api/parsing/query_budget.py, upstream #1041/#1047).
 *
 * Limits are upstream's, calibrated on distinct `magic.cards` names
 * (`scripts/measure_decklist_query_budget.py`):
 *
 * - **3500 UTF-8 bytes** — 100k random 100-card decklist queries shaped
 *   `(!"…" OR …) f:commander` landed at p99.9 ~2547 B and max ~2631 B; a real cEDH reference list
 *   (MTGTop8 Witherbloom) was ~2655 B. The limit adds headroom for longer names and trailing filters.
 * - **10 parenthesis nesting levels** — maximum `( … ( … ) … )` depth during parse (sibling
 *   `(a) (b)` groups do not accumulate). Legitimate Scryfall syntax is almost always depth 0–3.
 *   Upstream's motivation is `RecursionError` around depth 200; this port's parser is recursive
 *   descent too, so the same shape overflows the same way — a stack overflow in a Worker is an
 *   isolate-level failure with no per-request traceback, which makes the bound MORE load-bearing
 *   here, not less.
 *
 * A budget rejection is a 400 with a fixed, non-disclosing message: the point is to refuse the
 * request, not to teach a prober where the limits sit.
 */

export const MAX_QUERY_UTF8_BYTES = 3500;
export const MAX_GROUP_DEPTH = 10;
export const MAX_QUERY_LOG_PREVIEW_CHARS = 80;

export const QUERY_TOO_LONG_MESSAGE = "Search query exceeds the maximum allowed length.";
export const QUERY_REGEX_REJECTED_MESSAGE = "Search query contains an unsupported regular expression.";

/** Which bound a query blew. `regex_*` kinds share one user-facing message with each other. */
export type QueryBudgetKind = "length" | "depth" | "regex_leaves" | "regex_pattern";

/** Raised when a query exceeds a measured public bound. */
export class QueryBudgetExceeded extends Error {
	readonly kind: QueryBudgetKind;
	readonly userMessage: string;

	constructor(kind: QueryBudgetKind) {
		const userMessage = kind.startsWith("regex") ? QUERY_REGEX_REJECTED_MESSAGE : QUERY_TOO_LONG_MESSAGE;
		super(userMessage);
		this.name = "QueryBudgetExceeded";
		this.kind = kind;
		this.userMessage = userMessage;
	}
}

/** Raised when a regex leaf is ill-formed — a user mistake, quoted back like the engine's own. */
export class InvalidRegexPatternError extends Error {
	readonly reason: string;

	constructor(reason: string) {
		super(reason);
		this.name = "InvalidRegexPatternError";
		this.reason = reason;
	}

	/** The same shape upstream's SQL InvalidRegularExpression handler produces. */
	userMessageForQuery(query: string): string {
		return `The search query '${query}' contains an invalid regular expression: ${this.reason}.`;
	}
}

const UTF8 = new TextEncoder();

/** UTF-8 byte length of `text` — the unit the limit is stated in, not JS's UTF-16 `.length`. */
export function utf8ByteLength(text: string): number {
	return UTF8.encode(text).length;
}

/** Reject `query` when it exceeds the public byte limit. */
export function checkQueryByteLength(query: string): void {
	if (utf8ByteLength(query) > MAX_QUERY_UTF8_BYTES) {
		throw new QueryBudgetExceeded("length");
	}
}

/**
 * Reject when either `q` or `query` exceeds the byte limit.
 *
 * Both aliases are checked independently, and BEFORE either is read as the search: an oversized
 * unused alias must not reach cache-key construction either.
 */
export function checkSearchParamLengths(params: URLSearchParams): void {
	for (const key of ["q", "query"]) {
		for (const value of params.getAll(key)) {
			checkQueryByteLength(value);
		}
	}
}

/**
 * A bounded preview plus a digest, for rejection logs.
 *
 * The whole query is deliberately not logged: it is attacker-controlled text of up to the byte
 * limit, and a rejection is exactly the case where it is most likely to be hostile. The digest is
 * what makes repeated probes correlatable without storing what they said.
 */
export function boundedQueryLogContext(query: string): { queryPreview: string; queryDigest: string } {
	const preview =
		query.length <= MAX_QUERY_LOG_PREVIEW_CHARS ? query : `${query.slice(0, MAX_QUERY_LOG_PREVIEW_CHARS)}…`;
	return { queryPreview: preview, queryDigest: fnv1a64Hex(query) };
}

/**
 * A short, stable digest of `query`.
 *
 * FNV-1a rather than the SHA-256 prefix upstream takes, because WebCrypto's digest is async and
 * this is called from a synchronous rejection path. The digest correlates repeated probes in a log;
 * nothing reads it back or trusts it, so a non-cryptographic hash is the right size of tool.
 */
function fnv1a64Hex(text: string): string {
	const bytes = UTF8.encode(text);
	let hash = 0xcbf2_9ce4_8422_2325n;
	const prime = 0x100_0000_01b3n;
	const mask = 0xffff_ffff_ffff_ffffn;
	for (const byte of bytes) {
		hash = ((hash ^ BigInt(byte)) * prime) & mask;
	}
	return hash.toString(16).padStart(16, "0");
}
