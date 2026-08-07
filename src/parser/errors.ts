/**
 * Error types for the parser port.
 *
 * Python surfaces every failure as a ValueError: lex/parse failures are wrapped
 * by parse_query into ValueError('Failed to lex/parse query: "..."'), and
 * serialization-time failures (invalid color strings, unknown rarities) are
 * raised as bare ValueErrors with their own messages. The TS port surfaces all
 * of these as ParseError, with byte-identical messages.
 */

/** Public error type: every failure of parseScryfallQuery throws this. */
export class ParseError extends Error {
	override readonly name = "ParseError";
}

/** Internal: mirrors hand_parser.LexError (pre-wrap). */
export class LexError extends Error {
	override readonly name = "LexError";
}

/** Internal: mirrors hand_parser.ParseError (pre-wrap). */
export class InternalParseError extends Error {
	override readonly name = "InternalParseError";
}
