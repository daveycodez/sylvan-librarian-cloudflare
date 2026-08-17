// Internal differential: `/search` against `/cards/search`, on ONE local store, offline.
//
//   bun scripts/search-differential.ts [--origin <url>] [--limit N] [--only <substr>]
//                                      [--cases <path>] [--verbose]
//
// WHY THIS EXISTS. `/cards/search` is the surface both parity harnesses point at: live-parity pins
// ~46 shapes byte-for-byte against api.scryfall.com and parity-sweep runs a generated matrix
// against it. `/search` — this project's OWN route, the one the web UI calls — had no automated
// coverage of any kind. The consequence showed up by hand: `/search` never applied Scryfall's
// `include_extras` exclusion, which was harmless while the store was built from `default_cards`
// (no art-series printings in that dump) and wrong the day the importer moved to `all_cards`.
// `q=lightning bolt` answered three printings where `/cards/search` answered two. Nothing in the
// suite could have caught it, because nothing ran `/search` against anything.
//
// THE ORACLE IS THE OTHER ROUTE, not Scryfall. Both routes read the same local store through the
// same engine, so a disagreement about WHICH CARDS MATCH is a bug in one of them and needs no
// network to find. That also makes this sharper than probing Scryfall: it can run the whole matrix
// in seconds, as often as anyone likes, with api.scryfall.com rate-limiting nobody.
//
// The comparison is deliberately narrow:
//
//   * MEMBERSHIP — the SET of `scryfall_id`s. This is the real oracle. The envelopes differ by
//     design (Scryfall List object against this port's own shape), so nothing but the id set and
//     its order is compared.
//   * ORDERING — the SEQUENCE of those ids, checked only when membership already agrees. Two
//     routes resolving `dir:auto` or a `sort:` directive differently show up here and nowhere else.
//
// THE CORPUS IS THE SWEEP'S, not a second hand-written list: `parity-sweep.ts --dump-cases` writes
// the generated matrix (operator × polarity × value-form, every `DB_COLUMNS` alias, every `order=`,
// every `unique=`, the boolean and realistic-query groups) and this reads it. A query added there
// is exercised here for free; a list invented here would drift from it within a week.
//
// THE TWO ROUTES MUST BE ASKED THE SAME QUESTION, and left alone they are not:
//
//   * `/cards/search` runs `scryfallTermPolicy` on the raw query first, because Scryfall drops a
//     term it cannot honor rather than rejecting the query. `/search` and the web UI keep the
//     WHOLE upstream vocabulary (`subtype:`, `types:`, `oracle_tags:` …), on purpose — one parser,
//     two policies, and the policy is a route-layer fact. So `/search` is handed `policy.query`,
//     the query the compat route actually compiled, and a case where every term was ignored is
//     TERM-POLICY rather than a divergence. Comparing the raw text instead would file the entire
//     negation-tautology group as membership bugs, which is what it did on the first run.
//   * The DEFAULTS differ: `/cards/search` sorts by `name` ascending-by-auto, `/search` by
//     `edhrec`. Both are correct for their own surface (`order=` and `orderby=` are separate
//     parameters with separate documented defaults), so the differential pins them explicitly and
//     compares what is left. An unpinned run reports every case as an ordering divergence.
//
// WHAT IS NOT A FINDING, and is classified rather than reported:
//
//   TERM-POLICY   — the compat side dropped every term (400 "All of your terms were ignored.").
//   UNSUPPORTED   — the sweep's own mark for a case probing an operator this port does not
//                   implement.
//   EMPTY         — `/cards/search` answers 404 for a query that matches nothing and 422 for a
//                   page past the end; `/search` answers 200 with zero rows. Scryfall's statuses
//                   are the compat surface's whole point, and both sides agree there are no cards.
//   PARAM-ONLY    — a case whose only content is a `/cards/*` parameter `/search` does not have
//                   (`include_extras`, `include_variations`, `include_multilingual`).
//   BOTH-ERROR    — both routes rejected the query. The BODIES differ by design (Scryfall error
//                   object against this port's `{title, description}`); agreeing that it is an
//                   error is all that is asked.
//
// Everything else is a DIVERGENCE and the deliverable. Exit code 1 if there are any.

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scryfallTermPolicy } from "../src/routes/scryfall-compat/query-terms";

const DEFAULT_ORIGIN = "http://localhost:8787";
/** `/cards/search` pages at 175; matching it is what makes the id lists comparable. */
const PAGE_SIZE = 175;

// ─── flags ────────────────────────────────────────────────────────────────────

let origin = DEFAULT_ORIGIN;
let only: string | undefined;
let limit = Number.POSITIVE_INFINITY;
let casesPath: string | undefined;
let verbose = false;

{
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const value = () => {
			const v = args[++i];
			if (v === undefined) throw new Error(`${arg} needs a value`);
			return v;
		};
		if (arg === "--origin") origin = value().replace(/\/+$/, "");
		else if (arg === "--only") only = value();
		else if (arg === "--limit") limit = Number(value());
		else if (arg === "--cases") casesPath = value();
		else if (arg === "--verbose") verbose = true;
		else throw new Error(`unknown flag: ${arg}`);
	}
}

// ─── the corpus ───────────────────────────────────────────────────────────────

interface SweepCase {
	name: string;
	group: string;
	path: string;
	unsupported?: boolean;
}

function loadCases(): SweepCase[] {
	if (casesPath) return JSON.parse(readFileSync(casesPath, "utf8")) as SweepCase[];
	// Generated on the spot, so this script has no committed copy of the matrix to fall behind it.
	const out = join(mkdtempSync(join(tmpdir(), "search-diff-")), "cases.json");
	const proc = Bun.spawnSync(["bun", join(import.meta.dir, "parity-sweep.ts"), "--dump-cases", out], {
		stderr: "pipe",
		stdout: "pipe",
	});
	if (!existsSync(out)) {
		throw new Error(`parity-sweep --dump-cases produced nothing:\n${new TextDecoder().decode(proc.stderr)}`);
	}
	return JSON.parse(readFileSync(out, "utf8")) as SweepCase[];
}

// ─── parameter translation ────────────────────────────────────────────────────

/** Scryfall's `unique` spellings -> this port's own (compat routes.ts UNIQUE_MAP). */
const UNIQUE_MAP: Record<string, string> = { cards: "card", art: "artwork", prints: "printing" };
/** Parameters that exist only on the `/cards/*` surface — a case built around one is PARAM-ONLY. */
const COMPAT_ONLY_PARAMS = ["include_extras", "include_variations", "include_multilingual"];

/** Orders `/cards/search` accepts and falls back to `name` for — see SCRYFALL_ONLY_ORDERS. */
const NO_COUNTERPART_ORDERS = ["penny", "review"];
/** `/search` orderby vocabulary, for the same silent fallback the compat route applies. */
const ORDERBY_VALUES = new Set([
	"artist",
	"cmc",
	"color",
	"cubecobra",
	"edhrec",
	"eur",
	"name",
	"power",
	"rarity",
	"released",
	"set",
	"tix",
	"toughness",
	"usd",
]);

interface Translated {
	/** The `/cards/search` URL to fetch, with serialization-only parameters removed. */
	compatPath: string | null;
	/** The `/search` URL, or null when the case has no `/search` counterpart. */
	path: string | null;
	skip?: "PARAM-ONLY" | "NOT-A-SEARCH" | "TERM-POLICY";
}

/**
 * `/cards/search?…` -> `/search?…`, honoring the differences in vocabulary rather than papering
 * over them: `order`->`orderby` (same values, both pinned so the two defaults do not fight),
 * `dir`->`direction`, `unique` through UNIQUE_MAP, `page` -> the `offset`/`limit` window
 * `/cards/search` would have served, and the query itself through `scryfallTermPolicy`.
 *
 * `fields=scryfall_id` keeps the response to the one column being compared — the id list is the
 * whole oracle, and asking for the default ten fields would move megabytes per case.
 */
function translate(path: string): Translated {
	const url = new URL(path, "http://x");
	if (url.pathname !== "/cards/search") return { compatPath: null, path: null, skip: "NOT-A-SEARCH" };
	const p = url.searchParams;
	const rawQ = p.get("q");
	if (rawQ === null) return { compatPath: null, path: null, skip: "NOT-A-SEARCH" };

	// `format=`/`pretty=` choose a SERIALIZATION; membership is the oracle here, and `format=text`
	// is not even JSON. Dropped from both sides rather than skipped, so the query still gets run.
	const compat = new URLSearchParams(p);
	compat.delete("format");
	compat.delete("pretty");
	const compatPath = `/cards/search?${compat.toString()}`;

	const policy = scryfallTermPolicy(rawQ);
	if (policy.allIgnored || policy.unclosedParens) return { compatPath, path: null, skip: "TERM-POLICY" };

	const out = new URLSearchParams({ q: policy.query, fields: "scryfall_id", limit: String(PAGE_SIZE) });
	// Both defaults pinned, and pinned to the COMPAT surface's: `order=name`, `dir=auto`.
	const orderRaw = (p.get("order") ?? "name").toLowerCase();
	const order = ORDERBY_VALUES.has(orderRaw) ? orderRaw : "name";
	out.set("orderby", NO_COUNTERPART_ORDERS.includes(orderRaw) ? "name" : order);
	out.set(
		"direction",
		["asc", "desc", "auto"].includes((p.get("dir") ?? "auto").toLowerCase())
			? (p.get("dir") ?? "auto").toLowerCase()
			: "auto",
	);
	// An unrecognized `unique` is Scryfall's default on the compat side, SILENTLY; `/search` would
	// 400 on the same spelling, so the fallback is applied here rather than sent.
	out.set("unique", UNIQUE_MAP[(p.get("unique") ?? "cards").toLowerCase()] ?? "card");
	// `page` is Scryfall's to_i-and-clamp: `abc` and `0` are page 1, `2.5` truncates to 2.
	const page = Math.max(1, Number.parseInt(p.get("page") ?? "1", 10) || 1);
	if (page > 1) out.set("offset", String((page - 1) * PAGE_SIZE));

	const paramOnly = COMPAT_ONLY_PARAMS.some((name) => p.has(name));
	return { compatPath, path: `/search?${out.toString()}`, ...(paramOnly ? { skip: "PARAM-ONLY" as const } : {}) };
}

// ─── fetching ─────────────────────────────────────────────────────────────────

interface Answer {
	status: number;
	ids: string[] | null;
	total: number | null;
	detail: string;
}

async function get(path: string): Promise<Response> {
	return fetch(`${origin}${path}`, { headers: { accept: "application/json" } });
}

/** `/cards/search`: a Scryfall List object, or a Scryfall error object. */
async function compatAnswer(path: string): Promise<Answer> {
	const res = await get(path);
	const body = (await res.json().catch(() => null)) as {
		data?: { id?: string }[];
		total_cards?: number;
		details?: string;
	} | null;
	if (res.status !== 200 || !Array.isArray(body?.data)) {
		return { status: res.status, ids: null, total: null, detail: String(body?.details ?? res.statusText) };
	}
	return {
		status: res.status,
		ids: body.data.map((c) => String(c.id)),
		total: body.total_cards ?? null,
		detail: "",
	};
}

/** `/search`: this port's own envelope, with `scryfall_id` on each row. */
async function searchAnswer(path: string): Promise<Answer> {
	const res = await get(path);
	const body = (await res.json().catch(() => null)) as {
		cards?: { scryfall_id?: string }[];
		total_cards?: number;
		description?: string;
	} | null;
	if (res.status !== 200 || !Array.isArray(body?.cards)) {
		return { status: res.status, ids: null, total: null, detail: String(body?.description ?? res.statusText) };
	}
	return {
		status: res.status,
		ids: body.cards.map((c) => String(c.scryfall_id)),
		total: body.total_cards ?? null,
		detail: "",
	};
}

// ─── the run ──────────────────────────────────────────────────────────────────

type Verdict = "ok" | "DIVERGENCE" | "UNSUPPORTED" | "PARAM-ONLY" | "BOTH-ERROR" | "SKIPPED" | "TERM-POLICY" | "EMPTY";

interface Finding {
	name: string;
	verdict: Verdict;
	kind: string;
	detail: string;
}

const all = loadCases();
const selected = all.filter((c) => !only || c.name.includes(only) || c.group.includes(only)).slice(0, limit);

console.log(`search-differential: /search vs /cards/search on ${origin}`);
console.log(`matrix: ${selected.length} of ${all.length} sweep cases\n`);

const findings: Finding[] = [];
const counts = new Map<Verdict, number>();
function record(name: string, verdict: Verdict, kind = "", detail = ""): void {
	counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
	if (verdict !== "ok") findings.push({ name, verdict, kind, detail });
	if (verbose || verdict === "DIVERGENCE") console.log(`  ${verdict === "ok" ? "ok  " : verdict} ${name} ${detail}`);
}

for (const c of selected) {
	const t = translate(c.path);
	if (t.path === null || t.compatPath === null) {
		record(c.name, t.skip === "TERM-POLICY" ? "TERM-POLICY" : "SKIPPED", t.skip ?? "");
		continue;
	}
	const [compat, search] = await Promise.all([compatAnswer(t.compatPath), searchAnswer(t.path)]);

	if (compat.ids === null && search.ids === null) {
		record(c.name, "BOTH-ERROR", "", `${compat.status}/${search.status}`);
		continue;
	}
	// `/cards/search` speaks Scryfall's statuses: 404 for a query that matches nothing, 422 for a
	// page past the end. `/search` answers 200 with an empty `cards`. Both say zero cards.
	if (compat.ids === null && (compat.status === 404 || compat.status === 422) && search.ids?.length === 0) {
		record(c.name, "EMPTY", "", `${compat.status} vs 0 rows`);
		continue;
	}
	if (compat.ids === null || search.ids === null) {
		// One route answered and the other refused. Designed for an unsupported term (the compat
		// side drops it and can 400 when every term went), a finding otherwise.
		const verdict = c.unsupported ? "UNSUPPORTED" : "DIVERGENCE";
		record(
			c.name,
			verdict,
			"status",
			`/cards/search ${compat.status} ${compat.detail} | /search ${search.status} ${search.detail} | ${t.compatPath} || ${t.path}`,
		);
		continue;
	}
	if (t.skip === "PARAM-ONLY") {
		record(c.name, "PARAM-ONLY");
		continue;
	}

	const compatSet = new Set(compat.ids);
	const searchSet = new Set(search.ids);
	const onlyCompat = compat.ids.filter((id) => !searchSet.has(id));
	const onlySearch = search.ids.filter((id) => !compatSet.has(id));
	if (onlyCompat.length > 0 || onlySearch.length > 0) {
		const verdict = c.unsupported ? "UNSUPPORTED" : "DIVERGENCE";
		record(
			c.name,
			verdict,
			"membership",
			`total ${compat.total}/${search.total}; only-/cards ${onlyCompat.length} ${onlyCompat
				.slice(0, 3)
				.join(
					",",
				)}; only-/search ${onlySearch.length} ${onlySearch.slice(0, 3).join(",")} | ${t.compatPath} || ${t.path}`,
		);
		continue;
	}
	// Membership agrees, so ordering is comparable position by position.
	const misordered = compat.ids.findIndex((id, i) => search.ids?.[i] !== id);
	if (misordered >= 0) {
		record(
			c.name,
			c.unsupported ? "UNSUPPORTED" : "DIVERGENCE",
			"ordering",
			`first differing position ${misordered} | ${t.compatPath} || ${t.path}`,
		);
		continue;
	}
	if (compat.total !== search.total) {
		record(c.name, "DIVERGENCE", "total_cards", `${compat.total} vs ${search.total} | ${t.compatPath} || ${t.path}`);
		continue;
	}
	record(c.name, "ok");
}

console.log("");
for (const [k, v] of [...counts].sort()) console.log(`  ${k}: ${v}`);

const divergences = findings.filter((f) => f.verdict === "DIVERGENCE");
console.log(`\nDIVERGENCES: ${divergences.length}`);
for (const f of divergences) console.log(`  ${f.kind}: ${f.name} — ${f.detail}`);
process.exit(divergences.length > 0 ? 1 : 0);
