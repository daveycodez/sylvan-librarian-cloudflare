/**
 * Canonical JSON serialization for the engine wire tree.
 *
 * Byte-compatible with Python's
 *   json.dumps(tree, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
 * including Python's int-vs-float rendering (2 vs 2.0), which PyNumber preserves.
 */

import type { FilterValue } from "./nodes";
import { PyNumber } from "./pystr";

export function canonicalStringify(value: FilterValue): string {
	if (typeof value === "string") {
		// JSON.stringify's string escaping matches Python json.dumps(ensure_ascii=False)
		// for all well-formed strings (control chars via \b\t\n\f\r/\u00XX, " and \).
		return JSON.stringify(value);
	}
	if (value instanceof PyNumber) {
		return value.toString();
	}
	if (Array.isArray(value)) {
		return `[${value.map((v) => canonicalStringify(v)).join(",")}]`;
	}
	const record = value as unknown as Record<string, FilterValue>;
	const keys = Object.keys(record).sort();
	const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(record[k] as FilterValue)}`);
	return `{${parts.join(",")}}`;
}
