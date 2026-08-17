// Internal differential for the two RANDOM routes: `/cards/random` and `/random_search`, on ONE
// local store, offline.
//
//   bun scripts/random-differential.ts [--origin <url>] [--draws N] [--verbose]
//
// WHY THIS EXISTS. `search-differential.ts` runs `/search` against `/cards/search` over the whole
// parity-sweep matrix and reported 406 ok / 0 divergences on the day the extras gate was extracted
// — while BOTH random routes were drawing from the ungated corpus and neither was reachable from
// that harness at all. `/cards/random?q=lightning bolt` returned astx/76, the Strixhaven art-series
// printing, about a third of the time, on a query where `/cards/search` can never return it. The
// bug is a one-line fix; the absence of any check that could SEE it is the durable part, and this
// file is that check.
//
// THE ORACLE IS THE SIBLING ROUTE, exactly as it is in search-differential: `/cards/search` reads
// the same store through the same engine, so what `/cards/random` may draw is decided offline with
// no network and no api.scryfall.com rate limit in the way.
//
// RANDOMNESS DOES NOT MAKE THIS SOFT, and the file leans on two shapes rather than on many draws:
//
//   HARD CASES are queries whose ENTIRE population is `is:extra` and which fire no extras trigger
//   (see extras-gate.ts for what a trigger is). The gate turns them into the empty set, so
//   `/cards/random?q=…` must answer 404 EVERY time and `…&include_extras=true` must answer a card
//   every time. No sampling, no flake, and it is the same pair of requests that established the
//   rule on api.scryfall.com (2026-08-17): `/cards/random?q=t:goblin cmc=0` is 404 there and
//   returns q07/T12 "Goblin // Blood" with the flag.
//
//   SAMPLED CASES draw N times from a query and require every drawn id to be inside the gated id
//   set `/cards/search` answers for the same query. Each case first proves it CAN discriminate —
//   the ungated set has to hold ids the gated one does not — and the run fails if too few cases
//   can, so this cannot rot into a suite that passes because it stopped asking anything.
//
// WHAT IT CATCHES, verified by reverting the gate: with `applyExtrasGate` removed from
// `cardsRandomHandler`, both HARD cases fail deterministically (404 becomes a token) and the
// sampled cases fail within a few draws.
//
// `/random_search` IS A RECORDED GAP, NOT A PASS. That route calls `engine.randomCardsAsJson`,
// which bottoms out in the wasm `random_search(n, seed, fieldsJson)` — an export with NO filter
// argument, so the route has nothing to gate WITH. Giving it one is an engine change (core_api.rs,
// the wasm export, wasm-shim, store.ts, the RPC and partitioned surfaces) plus a wasm rebuild, and
// the partitioned router's `card_count` weighting has to become a MATCH-count weighting at the same
// time or a filtered draw silently favors the wrong partition. Until that lands, this file MEASURES
// the leak — one `num_cards=1000` request classified against the store's own `is:extra` id set —
// and fails if the leak DISAPPEARS, which is the live-parity `known_deviation` pattern: a recorded
// deviation that cannot rot, because closing it turns the check red and points at this comment.

// A module rather than a script, purely so top-level `await` is legal: this file imports nothing
// (the two routes are reached over HTTP, like search-differential's) and exports nothing.
export {};

const DEFAULT_ORIGIN = "http://localhost:8787";

// ─── flags ────────────────────────────────────────────────────────────────────

let origin = DEFAULT_ORIGIN;
let draws = 30;
/** `/random_search` draws in ONE request; 1,000 is the route's own ceiling. */
let bulkDraws = 1000;
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
		else if (arg === "--draws") draws = Number(value());
		else if (arg === "--bulk-draws") bulkDraws = Number(value());
		else if (arg === "--verbose") verbose = true;
		else throw new Error(`unknown flag: ${arg}`);
	}
}

// ─── the cases ────────────────────────────────────────────────────────────────

/**
 * Queries whose whole population is `is:extra` and which fire NO extras trigger — no set term, no
 * `a:`/`wm:`/`layout:`, no `name:` regex, no `t:token`, no trigger `is:` value. Both are measured
 * on api.scryfall.com as well (2026-08-16, parity-sweep-findings.md): `t:goblin cmc=0` is 404 bare
 * and 87 with `include_extras=true`, `!"Goblin Army"` is 404 and 2. This store holds 20 and 1.
 *
 * Every zero-cost goblin being a token is the whole trick, and a plain type + numeric query is as
 * far from a trigger as a query gets.
 */
const HARD_QUERIES = ["t:goblin cmc=0", '!"Goblin Army"'];

/**
 * Ordinary queries with a SMALL gated set, so one `/cards/search` page carries the whole membership
 * and any drawn id can be checked against it exactly.
 *
 * Each one's discriminating power is the share of its ungated set the gate removes — 1/3 for
 * `lightning bolt` (astx/76 is the third), 7/48 for `name:bolt`, 4/84 for the `o:` case. The run
 * asserts the split still exists rather than trusting these numbers.
 */
const SAMPLED_QUERIES = ["lightning bolt", "serra angel", "name:bolt", 'o:"draw a card" cmc=1 c:u'];

/** One `/cards/search` page. A case whose gated set does not fit in one is skipped, loudly. */
const PAGE_SIZE = 175;

// ─── fetching ─────────────────────────────────────────────────────────────────

interface Answer {
	status: number;
	ids: string[];
	total: number;
	detail: string;
}

async function getJson(path: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
	const res = await fetch(`${origin}${path}`, { headers: { accept: "application/json" } });
	const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	return { status: res.status, body };
}

/** `/cards/search`: a Scryfall List object (404 when nothing matched, which is an empty answer). */
async function compatSearch(q: string, extra = ""): Promise<Answer> {
	const { status, body } = await getJson(`/cards/search?q=${encodeURIComponent(q)}&unique=cards${extra}`);
	const data = body?.data as { id?: string }[] | undefined;
	if (status === 404) return { status, ids: [], total: 0, detail: String(body?.details ?? "") };
	if (status !== 200 || !Array.isArray(data)) {
		return { status, ids: [], total: -1, detail: String(body?.details ?? "non-List body") };
	}
	return { status, ids: data.map((c) => String(c.id)), total: Number(body?.total_cards ?? data.length), detail: "" };
}

interface Drawn {
	status: number;
	id: string | null;
	label: string;
}

async function drawOne(q: string, extra = ""): Promise<Drawn> {
	const { status, body } = await getJson(`/cards/random?q=${encodeURIComponent(q)}${extra}`);
	if (status !== 200 || body?.object !== "card") {
		return { status, id: null, label: String(body?.details ?? body?.code ?? status) };
	}
	return {
		status,
		id: String(body.id),
		label: `${String(body.name)} ${String(body.set)}/${String(body.collector_number)}`,
	};
}

/**
 * Every `is:extra` printing id in this store, in one request.
 *
 * `/search` rather than `/cards/search` because it takes `fields` and a `limit` past 175: the whole
 * extras population comes back as one column of ids for ~40KB, where the compat route would need
 * 60-odd pages of full card objects to say the same thing. `is:extra` is itself an unconditional
 * trigger, so this query is not gated by the very rule it is being used to check.
 */
async function extraIds(): Promise<Set<string>> {
	const { status, body } = await getJson(
		"/search?q=is%3Aextra&fields=scryfall_id&limit=100000&shape=columnar&unique=printing",
	);
	const ids = (body?.cards as { scryfall_id?: string[] } | undefined)?.scryfall_id;
	if (status !== 200 || !Array.isArray(ids)) throw new Error(`could not read the is:extra id set (${status})`);
	return new Set(ids.map(String));
}

// ─── the run ──────────────────────────────────────────────────────────────────

type Verdict = "ok" | "FAILURE" | "SKIPPED" | "KNOWN-GAP";

interface Finding {
	name: string;
	verdict: Verdict;
	detail: string;
}

const findings: Finding[] = [];
const counts = new Map<Verdict, number>();
function record(name: string, verdict: Verdict, detail = ""): void {
	counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
	if (verdict !== "ok") findings.push({ name, verdict, detail });
	if (verbose || verdict !== "ok") console.log(`  ${verdict === "ok" ? "ok  " : verdict} ${name} ${detail}`);
}

console.log(`random-differential: /cards/random and /random_search on ${origin}`);
console.log(`hard cases: ${HARD_QUERIES.length}; sampled cases: ${SAMPLED_QUERIES.length} x ${draws} draws\n`);

// ── 1. the hard cases: an extras-only population is an EMPTY draw ─────────────

let hardRan = 0;
for (const q of HARD_QUERIES) {
	const name = `hard/${q}`;
	const [gated, all] = await Promise.all([compatSearch(q), compatSearch(q, "&include_extras=true")]);
	// The case only means something while the store still says so; a corpus change that gives this
	// query a non-extra match must SKIP it rather than quietly assert nothing.
	if (gated.total !== 0 || all.total <= 0) {
		record(name, "SKIPPED", `no longer extras-only in this store (gated ${gated.total}, ungated ${all.total})`);
		continue;
	}
	hardRan++;
	const bare = await drawOne(q);
	if (bare.status !== 404) {
		record(name, "FAILURE", `/cards/random answered ${bare.status} ${bare.label}; every match is is:extra`);
		continue;
	}
	const forced = await drawOne(q, "&include_extras=true");
	if (forced.status !== 200) {
		record(name, "FAILURE", `include_extras=true answered ${forced.status} ${forced.label} over ${all.total} matches`);
		continue;
	}
	record(name, "ok", `404 bare, ${forced.label} with the flag`);
}

// ── 2. the sampled cases: every draw inside the gated membership ──────────────

let discriminating = 0;
for (const q of SAMPLED_QUERIES) {
	const name = `sampled/${q}`;
	const [gated, all] = await Promise.all([
		compatSearch(q),
		compatSearch(q, "&include_extras=true&include_variations=true"),
	]);
	if (gated.total < 0 || all.total < 0) {
		record(name, "SKIPPED", `/cards/search refused: ${gated.detail || all.detail}`);
		continue;
	}
	if (gated.total > PAGE_SIZE) {
		record(name, "SKIPPED", `gated set is ${gated.total}, past one page — narrow the query`);
		continue;
	}
	const gatedSet = new Set(gated.ids);
	const removed = all.ids.filter((id) => !gatedSet.has(id));
	// A case where the gate removes nothing cannot fail, whatever the route does. Say so.
	if (removed.length === 0) {
		record(name, "SKIPPED", `the gate removes nothing here (${gated.total} of ${all.total}) — not discriminating`);
		continue;
	}
	discriminating++;
	const leaks: string[] = [];
	for (let i = 0; i < draws; i++) {
		const drawn = await drawOne(q);
		if (drawn.id === null) {
			leaks.push(`draw ${i} answered ${drawn.status} ${drawn.label}`);
			break;
		}
		if (!gatedSet.has(drawn.id)) leaks.push(`${drawn.label} (${drawn.id})`);
	}
	if (leaks.length > 0) {
		record(
			name,
			"FAILURE",
			`${leaks.length}/${draws} draws outside the gated ${gated.total}: ${leaks.slice(0, 3).join(", ")}`,
		);
		continue;
	}
	record(name, "ok", `${draws} draws, all inside the gated ${gated.total} of ${all.total}`);
}

// ── 3. /random_search: the recorded gap ───────────────────────────────────────

{
	const name = "random_search/ungated-corpus";
	const extras = await extraIds();
	const { status, body } = await getJson(`/random_search?num_cards=${bulkDraws}`);
	const cards = body?.cards as { scryfall_id?: string; name?: string; set_code?: string }[] | undefined;
	if (status !== 200 || !Array.isArray(cards) || cards.length === 0) {
		record(name, "FAILURE", `/random_search answered ${status} with no cards`);
	} else {
		const hit = cards.filter((c) => extras.has(String(c.scryfall_id)));
		const share = ((100 * hit.length) / cards.length).toFixed(1);
		if (hit.length === 0) {
			// 1,000 draws with zero extras is not luck at a ~14% share — it is the fix having landed.
			record(
				name,
				"FAILURE",
				`GAP CLOSED: 0 of ${cards.length} draws are is:extra. If random_search now takes a filter, ` +
					"delete this case and give it the same membership check the /cards/random cases use.",
			);
		} else {
			record(
				name,
				"KNOWN-GAP",
				`${hit.length}/${cards.length} draws (${share}%) are is:extra — the wasm random_search takes no filter. ` +
					`e.g. ${hit
						.slice(0, 3)
						.map((c) => `${String(c.name)} ${String(c.set_code)}`)
						.join(", ")}`,
			);
		}
	}
}

// ── the verdict ───────────────────────────────────────────────────────────────

console.log("");
for (const [k, v] of [...counts].sort()) console.log(`  ${k}: ${v}`);

const failures = findings.filter((f) => f.verdict === "FAILURE");
// A run where nothing could discriminate is a run that proved nothing, and passing it would be the
// exact failure this file exists to prevent — search-differential passing while both random routes
// leaked. Both halves have to have had something to say.
if (failures.length === 0 && (hardRan === 0 || discriminating < 2)) {
	console.log(`\nVACUOUS: ${hardRan} hard cases ran and ${discriminating} sampled cases could discriminate.`);
	process.exit(1);
}
console.log(`\nFAILURES: ${failures.length}`);
for (const f of failures) console.log(`  ${f.name} — ${f.detail}`);
process.exit(failures.length > 0 ? 1 : 0);
