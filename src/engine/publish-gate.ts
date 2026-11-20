/**
 * The last check before a store goes live: it must not be SMALLER than the one it replaces.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 *
 * On 2026-11-19 an import read an empty oracle_tags dump and published a store with no oracle tags
 * over one that was fine (import-dump-guard.ts). The dump guard now refuses a release whose FILES
 * are empty or short — but a file can be the right size and wrong: a renamed key every line still
 * parses around, a dump cut to half its tags, a bug of this importer's own. What all of those have
 * in common is the result: a store that lost something the live one has.
 *
 * The manifest is the commit point of a publish, and both manifests are in hand there — the one
 * about to be written and the one it replaces. So the publisher compares them, and refuses to
 * write a manifest that has shrunk. The live store stays; a refused nightly fails its run, a
 * refused deploy fails the build.
 *
 * ── WHAT IS COMPARED ─────────────────────────────────────────────────────────
 *
 * COUNTS, always — facts about the corpus, whatever the archive layout:
 *   cards, canonical printings   at least 97% of the live store's (Scryfall deletes a handful of
 *                                cards a year; 3% is ~1,200 cards)
 *   oracle and art tag aliases   at least 80% (the alias map's two tables: 857 and 1,433 on
 *                                2026-11-20; the empty dump left 0 oracle aliases)
 *
 * SIZES, only between two stores of the SAME archive format and content generation — a layout
 * change is allowed to make things smaller:
 *   archive bytes, names blob, printed-names blob    at least 90%
 *   oracle-tags blob                                 at least 80% (it was 61 bytes for 31,515)
 *
 * A number either manifest does not carry is not compared, so a store published before a field
 * existed gates nothing on it, and an empty namespace gates nothing at all.
 *
 * `ALLOW_STORE_SHRINK=1` (a Worker var for the nightly, the environment for a deploy) publishes
 * anyway — for the day a shrink is real.
 */

import type { StoreManifest } from "./types";

interface Metric {
	name: string;
	ratio: number;
	/** Compared only when both stores share an archive format and content generation. */
	sameLayoutOnly: boolean;
	of(manifest: StoreManifest): number | undefined;
}

const METRICS: readonly Metric[] = [
	{ name: "cards", ratio: 0.97, sameLayoutOnly: false, of: (m) => m.card_count },
	{ name: "canonical printings", ratio: 0.97, sameLayoutOnly: false, of: (m) => m.printing_count },
	{ name: "oracle tag aliases", ratio: 0.8, sameLayoutOnly: false, of: (m) => m.tag_alias_counts?.oracle },
	{ name: "art tag aliases", ratio: 0.8, sameLayoutOnly: false, of: (m) => m.tag_alias_counts?.art },
	{ name: "archive bytes", ratio: 0.9, sameLayoutOnly: true, of: (m) => m.store_bytes },
	{ name: "card names blob bytes", ratio: 0.9, sameLayoutOnly: true, of: (m) => m.names_bytes },
	{ name: "printed names blob bytes", ratio: 0.9, sameLayoutOnly: true, of: (m) => m.printed_bytes },
	{ name: "oracle tags blob bytes", ratio: 0.8, sameLayoutOnly: true, of: (m) => m.otags_bytes },
];

const usable = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/**
 * Everything `next` has lost against `live`, one sentence each — empty means it may be published.
 * `live` is the manifest being replaced, or null when there is none.
 */
export function publishRegressions(next: StoreManifest, live: StoreManifest | null): string[] {
	if (live === null) return [];
	const sameLayout = next.format_version === live.format_version && next.content_generation === live.content_generation;
	const problems: string[] = [];
	for (const metric of METRICS) {
		if (metric.sameLayoutOnly && !sameLayout) continue;
		const before = metric.of(live);
		if (!usable(before)) continue;
		const after = metric.of(next) ?? 0;
		if (after < metric.ratio * before) {
			problems.push(
				`${metric.name} ${after.toLocaleString("en-US")}, where the live store has ${before.toLocaleString("en-US")} ` +
					`(under ${Math.round(metric.ratio * 100)}%)`,
			);
		}
	}
	return problems;
}

/** The alias map's two table sizes, for `StoreManifest.tag_alias_counts`; undefined when it does not parse. */
export function tagAliasCounts(tagAliasesJson: string | null | undefined): { oracle: number; art: number } | undefined {
	if (!tagAliasesJson) return undefined;
	try {
		const map = JSON.parse(tagAliasesJson) as { oracle?: unknown; art?: unknown };
		const size = (table: unknown) => (table !== null && typeof table === "object" ? Object.keys(table).length : 0);
		return { oracle: size(map.oracle), art: size(map.art) };
	} catch {
		return undefined;
	}
}

/** The refusal's wording, shared by both publishers so the log line is one thing to search for. */
export function shrinkRefusal(storeKey: string, problems: readonly string[]): string {
	return (
		`refusing to publish ${storeKey}: it has lost content against the live store — ${problems.join("; ")}. ` +
		"The live store stays. Set ALLOW_STORE_SHRINK=1 to publish anyway if the shrink is real"
	);
}
