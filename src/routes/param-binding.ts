// Port of api/utils/param_binding.py: coercion of raw query-param strings into
// the typed keyword arguments a handler declares, with ParamCoercionError
// messages mirrored verbatim (Python repr of the name and echoed value, the
// declared type name, and — for enums — the accepted values in declaration
// order). Unknown string parameters are query noise and are dropped, exactly
// as upstream's ParamBinder.bind does; a positional path segment colliding
// with a same-named query parameter raises the TypeError-shaped error falcon
// turns into a 400 (see BindingTypeError).

import type { EnumSpec } from "./enums";

// Longest client-supplied value echoed back in an error message (upstream
// MAX_ECHOED_VALUE_LEN).
const MAX_ECHOED_VALUE_LEN = 80;

/**
 * Python repr() of a string: single quotes unless the value contains a single
 * quote and no double quote; backslashes, quotes and control characters
 * escaped the way CPython escapes them.
 */
export function pyRepr(value: string): string {
	const hasSingle = value.includes("'");
	const hasDouble = value.includes('"');
	const quote = hasSingle && !hasDouble ? '"' : "'";
	let out = quote;
	for (const ch of value) {
		if (ch === "\\") {
			out += "\\\\";
		} else if (ch === quote) {
			out += `\\${ch}`;
		} else if (ch === "\n") {
			out += "\\n";
		} else if (ch === "\r") {
			out += "\\r";
		} else if (ch === "\t") {
			out += "\\t";
		} else {
			const code = ch.codePointAt(0) ?? 0;
			if (code < 0x20 || code === 0x7f) {
				out += `\\x${code.toString(16).padStart(2, "0")}`;
			} else {
				out += ch;
			}
		}
	}
	return out + quote;
}

/** A request parameter's value is not valid for the type its handler declares. */
export class ParamCoercionError extends Error {
	readonly param: string;
	readonly value: string;
	readonly expected: string;
	readonly allowed: readonly string[];

	constructor(param: string, value: string, expected: string, allowed: readonly string[] = []) {
		let detail = ` (expected ${expected})`;
		if (allowed.length > 0) {
			detail = ` (expected one of: ${allowed.join(", ")})`;
		}
		// Truncate by code points, as Python slicing does.
		const points = Array.from(value);
		let shown = value;
		if (points.length > MAX_ECHOED_VALUE_LEN) {
			shown = `${points.slice(0, MAX_ECHOED_VALUE_LEN).join("")}…`;
		}
		super(`Invalid value for ${pyRepr(param)}: ${pyRepr(shown)}${detail}`);
		this.name = "ParamCoercionError";
		this.param = param;
		this.value = value;
		this.expected = expected;
		this.allowed = allowed;
	}
}

/**
 * Mirrors the TypeError upstream's binder raises for positional/keyword
 * collisions, which falcon's _handle turns into a 400 whose title is the bare
 * status line ("400 Bad Request") and whose description is str(TypeError).
 */
export class BindingTypeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BindingTypeError";
	}
}

interface Converter {
	expected: string;
	allowed: readonly string[];
	convert(raw: string): unknown;
}

// Python int() over a trimmed string: optional sign, then digits with single
// underscores strictly between digits.
const PY_INT_RE = /^[+-]?[0-9](?:_?[0-9])*$/;

/** `param: int` — Python int(str) semantics, ParamCoercionError on failure. */
export function intParam(): Converter {
	return {
		expected: "int",
		allowed: [],
		convert(raw: string): number {
			const trimmed = raw.trim();
			if (!PY_INT_RE.test(trimmed)) {
				throw new Error("invalid int");
			}
			return Number.parseInt(trimmed.replace(/_/g, ""), 10);
		},
	};
}

/** `param: str` — identity; never fails. */
export function strParam(): Converter {
	return { expected: "str", allowed: [], convert: (raw: string) => raw };
}

/** `param: Sequence[str]` — comma-split, stripped, empty parts dropped. */
export function strListParam(): Converter {
	return {
		expected: "Sequence",
		allowed: [],
		convert: (raw: string) =>
			raw
				.split(",")
				.map((part) => part.trim())
				.filter((part) => part.length > 0),
	};
}

/** `param: SomeStrEnum` — value must match a member value exactly. */
export function enumParam(spec: EnumSpec): Converter {
	return {
		expected: spec.name,
		allowed: spec.values,
		convert(raw: string): string {
			if (!(spec.values as readonly string[]).includes(raw)) {
				throw new Error("invalid enum value");
			}
			return raw;
		},
	};
}

export interface ParamSpec {
	name: string;
	converter: Converter;
	/** Present when the Python parameter has a default. */
	default?: unknown;
	/** True for POSITIONAL_OR_KEYWORD parameters (path segments map onto these in order). */
	positional?: boolean;
}

/**
 * Port of ParamBinder.bind for one handler: maps positional path segments and
 * raw query params onto the handler's typed keyword arguments.
 *
 * @param funcName Python __qualname__ of the handler (e.g. "APIResource.card"),
 *   used verbatim in TypeError-shaped messages.
 */
export function bindParams(
	funcName: string,
	spec: readonly ParamSpec[],
	positionalArgs: readonly string[],
	params: Record<string, string>,
): Record<string, unknown> {
	const positionalNames = spec.filter((p) => p.positional).map((p) => p.name);
	if (positionalArgs.length > positionalNames.length) {
		throw new BindingTypeError(
			`${funcName}() takes ${positionalNames.length} positional arguments but ${positionalArgs.length} were given`,
		);
	}
	const supplied: Record<string, string> = {};
	positionalArgs.forEach((value, i) => {
		const name = positionalNames[i];
		if (name !== undefined) {
			supplied[name] = value;
		}
	});
	const collisions = Object.keys(supplied).filter((name) => name in params);
	if (collisions.length > 0) {
		throw new BindingTypeError(`${funcName}() got multiple values for ${collisions.sort().join(", ")}`);
	}
	Object.assign(supplied, params);

	const bound: Record<string, unknown> = {};
	for (const param of spec) {
		const raw = supplied[param.name];
		if (raw !== undefined) {
			try {
				bound[param.name] = param.converter.convert(raw);
			} catch {
				throw new ParamCoercionError(param.name, raw, param.converter.expected, param.converter.allowed);
			}
		} else if ("default" in param) {
			bound[param.name] = param.default;
		}
	}
	// Unknown *string* params are query noise and are dropped (upstream
	// ParamBinder.bind); nothing non-string can arrive over HTTP.
	return bound;
}
