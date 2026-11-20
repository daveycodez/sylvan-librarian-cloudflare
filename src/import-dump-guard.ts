/**
 * A Scryfall bulk release that arrives empty or badly short is SKIPPED, not imported.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 *
 * On 2026-11-19 Scryfall's 22:00 UTC refresh published `oracle-tags-20261119220030.jsonl.gz` as a
 * 20-byte gzip of nothing (and did not regenerate art_tags at all). Nothing here looked: the 23:10
 * import read zero oracle tags, built a store in which no card carries one, and published it —
 * `Oracle tags published: … (45 bytes raw)` where every run before said ~102,600 — over a store
 * that was fine. Every `otag:` search answered 404 on both accounts for four and a half hours,
 * cached for sixteen, until a hand-run rebuild from that morning's dump replaced it.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 *
 * Before a run stages, parses or publishes anything, every dump it reads must be at least
 * DUMP_MIN_BYTES long (its stored, gzipped length — one HEAD each). A dump under its floor fails
 * the run there: the live store stays, the bulk trigger does not retry the same dumps
 * (import-coordinator.ts `triedDumps`), and the next refresh is judged afresh. The deploy's
 * store-age gate asks the same question before calling a newer release a reason to rebuild, and
 * the native builder refuses the same dumps (engine/builder/src/bulk.rs `DUMP_MIN_BYTES`, pinned
 * to this table by tests/import/dump-guard.test.ts).
 *
 * The floors are about HALF of each dump's size on 2026-11-19 — far above anything empty or cut
 * short, far below any real release, and since the corpus only grows they only get easier to
 * clear. Measured that day (gzipped): all_cards 407.9 MB, default_cards 81.3 MB, oracle_cards
 * 25.5 MB, art_tags 13.4 MB, oracle_tags 6.1 MB (the morning's; the evening's was the 20 bytes),
 * rulings 5.5 MB.
 *
 * A size the server will not state is NOT a refusal: the check exists to catch a release that is
 * visibly wrong, and a HEAD that fails or carries no length says nothing either way. The parse
 * coverage checks further in still stand behind it.
 */

import type { DumpKind } from "./import-phases";

/** The least a dump's gzipped length may be, bytes. See the header for the measured sizes. */
export const DUMP_MIN_BYTES: Readonly<Record<DumpKind, number>> = {
	all_cards: 200_000_000,
	default_cards: 40_000_000,
	oracle_cards: 12_000_000,
	art_tags: 6_000_000,
	oracle_tags: 3_000_000,
	rulings: 2_500_000,
};

/** What is wrong with a dump of `bytes` stored bytes, or null — and null for an unknown length. */
export function dumpSizeProblem(kind: DumpKind, bytes: number | null): string | null {
	if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;
	const floor = DUMP_MIN_BYTES[kind];
	return bytes < floor
		? `${kind} is ${bytes.toLocaleString("en-US")} bytes, under its ${floor.toLocaleString("en-US")}-byte floor`
		: null;
}

/** A dump's stored length by HEAD, or null when the server does not say. Never throws. */
export async function dumpStoredBytes(uri: string, userAgent: string, timeoutMs = 10_000): Promise<number | null> {
	try {
		const res = await fetch(uri, {
			method: "HEAD",
			// identity: the length asked about is the gzip FILE's, not a transfer encoding of it.
			headers: { "User-Agent": userAgent, "Accept-Encoding": "identity" },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return null;
		const length = Number(res.headers.get("content-length") ?? Number.NaN);
		return Number.isFinite(length) ? length : null;
	} catch {
		return null;
	}
}

/**
 * Every problem with a release, one sentence per bad dump (empty = the release may be imported).
 * `uris` is each dump's download address; `sizeOf` is `dumpStoredBytes` unless a test says otherwise.
 */
export async function releaseProblems(
	uris: ReadonlyMap<DumpKind, string>,
	sizeOf: (uri: string, kind: DumpKind) => Promise<number | null>,
): Promise<string[]> {
	const checked = await Promise.all(
		[...uris].map(async ([kind, uri]) => dumpSizeProblem(kind, await sizeOf(uri, kind))),
	);
	return checked.filter((problem): problem is string => problem !== null);
}
