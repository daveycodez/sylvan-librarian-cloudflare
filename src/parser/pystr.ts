/**
 * Python string semantics for the parser port.
 *
 * The fixture ground truth is produced by CPython, so every case-mapping or
 * classification the parser applies must match CPython 3.13 (Unicode 15.1)
 * exactly — not the JS engine's own (newer) Unicode tables. The generated
 * exception tables in py-unicode-data.ts encode every code point where the two
 * disagree; everything else falls through to the JS built-ins.
 */

import {
	ALPHA_ADD,
	ALPHA_DEL,
	CASE_IGNORABLE_ADD,
	CASE_IGNORABLE_DEL,
	CASED_ADD,
	CASED_DEL,
	CCC_NONZERO,
	LOWER_EXCEPTIONS,
	PY_SPACE,
	TITLE_EXCEPTIONS,
	UPPER_EXCEPTIONS,
} from "./py-unicode-data";

const CAPITAL_SIGMA = 0x03a3;
const SMALL_SIGMA = "σ";
const FINAL_SIGMA = "ς";

function inRanges(ranges: ReadonlyArray<readonly [number, number]>, cp: number): boolean {
	let lo = 0;
	let hi = ranges.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const r = ranges[mid] as readonly [number, number];
		if (cp < r[0]) hi = mid - 1;
		else if (cp > r[1]) lo = mid + 1;
		else return true;
	}
	return false;
}

/** Code points of a string (Python strings index by code point, JS by UTF-16 unit). */
export function codePoints(s: string): number[] {
	const out: number[] = [];
	for (const ch of s) out.push(ch.codePointAt(0) as number);
	return out;
}

export function fromCodePoints(cps: readonly number[]): string {
	let out = "";
	// Chunked to avoid call-stack limits on long strings.
	for (let i = 0; i < cps.length; i += 1024) {
		out += String.fromCodePoint(...cps.slice(i, i + 1024));
	}
	return out;
}

const RE_CASED = /\p{Cased}/u;
const RE_CASE_IGNORABLE = /\p{Case_Ignorable}/u;
const RE_ALPHA = /^\p{L}$/u;

/** Mirrors CPython's _PyUnicode_IsCased. */
export function isCased(cp: number): boolean {
	if (inRanges(CASED_ADD, cp)) return true;
	if (inRanges(CASED_DEL, cp)) return false;
	return RE_CASED.test(String.fromCodePoint(cp));
}

/** Mirrors CPython's _PyUnicode_IsCaseIgnorable. */
export function isCaseIgnorable(cp: number): boolean {
	if (inRanges(CASE_IGNORABLE_ADD, cp)) return true;
	if (inRanges(CASE_IGNORABLE_DEL, cp)) return false;
	return RE_CASE_IGNORABLE.test(String.fromCodePoint(cp));
}

/** Mirrors Python str.isalpha() for a single code point. */
export function isAlphaCp(cp: number): boolean {
	if (inRanges(ALPHA_ADD, cp)) return true;
	if (inRanges(ALPHA_DEL, cp)) return false;
	return RE_ALPHA.test(String.fromCodePoint(cp));
}

/** Mirrors Python str.isalpha() for a single-character string. */
export function isAlphaChar(c: string): boolean {
	return isAlphaCp(c.codePointAt(0) as number);
}

/**
 * The Final_Sigma context rule, as implemented by CPython's lower_ucs4:
 * capital sigma lowercases to ς when a cased character precedes it (skipping
 * case-ignorable characters) and no cased character follows it (likewise).
 */
function lowerSigma(cps: readonly number[], i: number): string {
	let j = i - 1;
	while (j >= 0 && isCaseIgnorable(cps[j] as number)) j--;
	let finalSigma = j >= 0 && isCased(cps[j] as number);
	if (finalSigma) {
		j = i + 1;
		while (j < cps.length && isCaseIgnorable(cps[j] as number)) j++;
		finalSigma = j === cps.length || !isCased(cps[j] as number);
	}
	return finalSigma ? FINAL_SIGMA : SMALL_SIGMA;
}

function lowerCp(cps: readonly number[], i: number): string {
	const cp = cps[i] as number;
	if (cp === CAPITAL_SIGMA) return lowerSigma(cps, i);
	const exc = LOWER_EXCEPTIONS.get(cp);
	if (exc !== undefined) return exc;
	return String.fromCodePoint(cp).toLowerCase();
}

function upperCp(cp: number): string {
	const exc = UPPER_EXCEPTIONS.get(cp);
	if (exc !== undefined) return exc;
	return String.fromCodePoint(cp).toUpperCase();
}

function titleCp(cp: number): string {
	const exc = TITLE_EXCEPTIONS.get(cp);
	if (exc !== undefined) return exc;
	return String.fromCodePoint(cp).toUpperCase();
}

/** Mirrors Python str.lower() (full case mappings + Final_Sigma). */
export function pyLower(s: string): string {
	const cps = codePoints(s);
	let out = "";
	for (let i = 0; i < cps.length; i++) out += lowerCp(cps, i);
	return out;
}

/** Mirrors Python str.upper() (full case mappings). */
export function pyUpper(s: string): string {
	let out = "";
	for (const ch of s) out += upperCp(ch.codePointAt(0) as number);
	return out;
}

/** Mirrors Python str.title() (CPython do_title). */
export function pyStrTitle(s: string): string {
	const cps = codePoints(s);
	let out = "";
	let previousIsCased = false;
	for (let i = 0; i < cps.length; i++) {
		const cp = cps[i] as number;
		out += previousIsCased ? lowerCp(cps, i) : titleCp(cp);
		previousIsCased = isCased(cp);
	}
	return out;
}

/** Mirrors Python str.capitalize() (title-case first char, lowercase the rest). */
export function pyCapitalize(s: string): string {
	const cps = codePoints(s);
	if (cps.length === 0) return "";
	let out = titleCp(cps[0] as number);
	for (let i = 1; i < cps.length; i++) out += lowerCp(cps, i);
	return out;
}

/** Mirrors Python str.strip() with no arguments (Python's whitespace set, not JS trim's). */
export function pyStrip(s: string): string {
	const cps = codePoints(s);
	let start = 0;
	let end = cps.length;
	while (start < end && PY_SPACE.has(cps[start] as number)) start++;
	while (end > start && PY_SPACE.has(cps[end - 1] as number)) end--;
	return fromCodePoints(cps.slice(start, end));
}

/**
 * Mirrors api.parsing.card_query_nodes.fold_accents: NFKD-decompose, then drop
 * every character with a nonzero canonical combining class. The ccc table comes
 * from CPython's unicodedata (see py-unicode-data.ts), NOT from \p{M}, which
 * matches a different set.
 */
export function foldAccents(value: string): string {
	const decomposed = value.normalize("NFKD");
	let out = "";
	for (const ch of decomposed) {
		if (!inRanges(CCC_NONZERO, ch.codePointAt(0) as number)) out += ch;
	}
	return out;
}

// ── Python numbers ───────────────────────────────────────────────────────────

/**
 * A Python int-or-float, preserving the int/float distinction that Python's
 * json/repr output depends on (json.dumps(2) == "2" but json.dumps(2.0) == "2.0",
 * and Python ints are arbitrary-precision).
 */
export class PyNumber {
	private constructor(
		readonly kind: "int" | "float",
		private readonly intValue: bigint,
		private readonly floatValue: number,
	) {}

	static int(value: bigint): PyNumber {
		return new PyNumber("int", value, 0);
	}

	static float(value: number): PyNumber {
		return new PyNumber("float", 0n, value);
	}

	get isFloat(): boolean {
		return this.kind === "float";
	}

	/** Truncating conversion, mirroring Python's int(x) on int|float. */
	toBigIntTruncated(): bigint {
		return this.kind === "int" ? this.intValue : BigInt(Math.trunc(this.floatValue));
	}

	/** Numeric value (lossy for huge ints; only used where Python's value is small). */
	toNumber(): number {
		return this.kind === "int" ? Number(this.intValue) : this.floatValue;
	}

	/** Mirrors Python str()/repr() of the number (also what json.dumps emits). */
	toString(): string {
		return this.kind === "int" ? this.intValue.toString() : pyFloatRepr(this.floatValue);
	}

	/** Lossy convenience for consumers that JSON.stringify the wire tree directly. */
	toJSON(): number {
		return this.toNumber();
	}
}

/** Mirrors Python str(x) for the value types that appear in tokens. */
export function pyStr(value: string | PyNumber): string {
	return typeof value === "string" ? value : value.toString();
}

/**
 * Mirrors CPython float repr: shortest round-trip digits, fixed notation for
 * decimal exponents in [-4, 15], scientific (with >= 2 exponent digits) outside.
 */
export function pyFloatRepr(x: number): string {
	if (!Number.isFinite(x)) return x > 0 ? "inf" : Number.isNaN(x) ? "nan" : "-inf";
	if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
	const neg = x < 0;
	const ax = Math.abs(x);
	let digits = "";
	let exp10 = 0;
	for (let p = 1; p <= 17; p++) {
		const s = ax.toExponential(p - 1);
		if (Number(s) === ax) {
			const [mantissa, expPart] = s.split("e") as [string, string];
			digits = mantissa.replace(".", "");
			// Strip trailing zeros the precision padding may have introduced.
			digits = digits.replace(/0+$/, "") || "0";
			exp10 = Number(expPart);
			break;
		}
	}
	let body: string;
	if (exp10 >= -4 && exp10 < 16) {
		if (exp10 >= digits.length - 1) {
			body = `${digits}${"0".repeat(exp10 - (digits.length - 1))}.0`;
		} else if (exp10 >= 0) {
			body = `${digits.slice(0, exp10 + 1)}.${digits.slice(exp10 + 1)}`;
		} else {
			body = `0.${"0".repeat(-exp10 - 1)}${digits}`;
		}
	} else {
		const mant = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : (digits[0] as string);
		const sign = exp10 < 0 ? "-" : "+";
		const mag = Math.abs(exp10).toString().padStart(2, "0");
		body = `${mant}e${sign}${mag}`;
	}
	return neg ? `-${body}` : body;
}
