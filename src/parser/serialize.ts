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
	// One flat list of pieces, joined ONCE. Building each level's `{…}` by joining
	// its children's strings re-copies the whole subtree per level, which is
	// quadratic in nesting depth — and an arithmetic chain nests one level per
	// operator (a 1,600-term chain took ~31ms here for 200KB of output).
	const out: string[] = [];
	write(value, out);
	return out.join("");
}

function write(value: FilterValue, out: string[]): void {
	if (typeof value === "string") {
		// JSON.stringify's string escaping matches Python json.dumps(ensure_ascii=False)
		// for all well-formed strings (control chars via \b\t\n\f\r/\u00XX, " and \).
		out.push(JSON.stringify(value));
		return;
	}
	if (value instanceof PyNumber) {
		out.push(value.toString());
		return;
	}
	if (Array.isArray(value)) {
		out.push("[");
		for (let i = 0; i < value.length; i++) {
			if (i > 0) out.push(",");
			write(value[i] as FilterValue, out);
		}
		out.push("]");
		return;
	}
	const record = value as unknown as Record<string, FilterValue>;
	const keys = Object.keys(record).sort();
	out.push("{");
	for (let i = 0; i < keys.length; i++) {
		const k = keys[i] as string;
		if (i > 0) out.push(",");
		out.push(JSON.stringify(k), ":");
		write(record[k] as FilterValue, out);
	}
	out.push("}");
}
