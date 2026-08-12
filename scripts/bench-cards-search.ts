// A/B benchmark: /search against the new /cards/search (upstream #912).
//
// scripts/bench.sh compares THIS PORT against upstream and Scryfall on one
// route. This compares TWO ROUTES OF THIS PORT against each other, because
// /cards/search is not /search with a different envelope — it asks the Durable
// Object to build full Scryfall card objects out of the card-object archive
// (the second KV archive added in 0d19d29), where /search returns ten flat
// columns. The question this answers is what that materialization costs, in
// wall time at the client and in CPU at the Worker.
//
// Client-side numbers land first (the table below is printed before anything
// else happens). The Worker-side numbers — cpuTimeMs, wallTimeMs, the DO RPC —
// come from Workers Observability afterwards, joined on the run id that every
// URL in the run carries. Nothing here queries observability itself; a bench
// that ingests its own telemetry cannot be re-read later against a different
// question.
//
// FOUR THINGS THAT WOULD SILENTLY MEASURE THE WRONG SUBJECT:
//
//   The edge cache. BOTH routes are cached, on deliberately different tiers:
//                /search sends `public, max-age=90, stale-while-revalidate=86400`
//                (http.ts searchCacheHeader) and /cards/search sends
//                `public, max-age=57600` (CARDS_CACHE, Scryfall's own tier, added
//                in 7a9edac), with wrangler.jsonc's Workers Cache honoring both.
//                A repeated URL on either route is answered at the edge and never
//                reaches the Worker at all — so a benchmark that reuses URLs
//                measures two caches rather than two search paths, and the
//                cheaper number belongs to whichever tier is longer. Phase A
//                therefore gives every request its own nonce, which is the only
//                way both routes run the Worker on every hit and the CPU
//                comparison is of like for like. Phase B then deliberately
//                repeats one URL per variant to measure the two caches, and
//                reports cf-cache-status so a hit is visible rather than
//                inferred. Read a phase B "1st" row as the only real request in
//                its group of three.
//   Param drift. The two routes do not default to the same search. /search is
//                limit=100, orderby=edhrec, ten flat fields (SEARCH_SPEC).
//                /cards/search is 175 per page (objects.ts PAGE_SIZE),
//                order=name, whole card objects. So `search-matched` runs
//                /search at 175 and by name: the gap between `search` and
//                `search-matched` is page size and sort, and the gap between
//                `search-matched` and `cards-search` is card-object
//                materialization. Two gaps, separately attributable.
//   Query memo. The engine memoizes (vendor/…/bench_text_memo.py), and both
//                routes compile the SAME filter tree — so whichever variant
//                asks for a query second gets a warm memo the first one paid
//                for. Variants are therefore rotated per query (round-robin by
//                query index), and each sample records `pos`, its position
//                within that query's round, so the analysis can check whether
//                position moved the number instead of assuming it did not.
//   Cold DOs.   A region whose SearchEngine DO has been evicted loads ~76.6MB
//                from KV before it can answer — production logs show ~1.5-1.8s
//                for that path. --warmup requests (default 3) wake it before
//                anything is recorded; x-sylvan-engine names the DO that
//                answered, and it is carried on every sample. Note the colo
//                parsed off CF-Ray no longer identifies the DO: many colos map
//                to one region, so `colo` and `engine` are separate columns.
//
// Rate limiting is opt-in on the target (RATE_LIMIT_ENABLED=true), and BOTH
// routes are limited — isRateLimitedRoute covers `search` and every `cards/*`
// (rate-limit.ts:83-93) — at 25 per 10s by default. The run is sequential and
// paced (--delay, default 120ms) to stay under that; x-sylvan-rl rides on every
// sample and any 429 is counted and shouted about, because a 429 is fast and
// would otherwise look like a fast search.
//
// Usage:
//   bun run scripts/bench-cards-search.ts
//   bun run scripts/bench-cards-search.ts --base https://sylvan.mtgseeker.com
//   bun run scripts/bench-cards-search.ts --key "$TRUSTED_API_KEY" --delay 0

// The workers.dev hostname follows the Worker NAME in wrangler.jsonc
// ("sylvan-librarian"), not the repo or the product. A wrong subdomain here does
// not fail loudly — Cloudflare answers every path on an unclaimed *.workers.dev
// with a 404 body reading "error code: 1042" — so a whole run can come back
// looking like a routing bug in this port. Hence the /search reachability check
// in main() before any timing is recorded.
const DEFAULT_BASE = "https://sylvan-librarian.daveycodez.workers.dev";

// The bench.sh query set, unchanged, so a number here is comparable to a number
// there: a spread of selectivities, text scans, and colour/type filters.
const QUERIES = [
	"t:goblin cmc<3 c:r",
	'o:"draw a card" t:creature f:modern',
	"kw:flying pow>=4 -c:w",
	"t:instant cmc=1 c:u",
	"t:legendary t:elf f:commander",
	'o:"enters tapped" t:land',
	"c:wu t:bird",
	"r:mythic t:dragon cmc<=4",
	"t:planeswalker c:b f:pioneer",
	"t:instant o:damage cmc=1",
] as const;

/** PAGE_SIZE from routes/scryfall-compat/objects.ts — what /cards/search returns per page. */
const CARDS_PAGE_SIZE = 175;

interface Variant {
	/** Column name in the report, and the value joined on in observability. */
	readonly name: string;
	readonly path: string;
	/** Search params other than `q` and the nonce. */
	readonly params: Readonly<Record<string, string>>;
	readonly note: string;
}

const VARIANTS: readonly Variant[] = [
	{
		name: "search",
		path: "/search",
		params: {},
		note: "as shipped: limit=100, orderby=edhrec, 10 flat fields",
	},
	{
		name: "search-matched",
		path: "/search",
		params: { limit: String(CARDS_PAGE_SIZE), orderby: "name", direction: "asc", unique: "card" },
		note: `page size and sort matched to /cards/search (limit=${CARDS_PAGE_SIZE}, by name)`,
	},
	{
		name: "cards-search",
		path: "/cards/search",
		params: { order: "name" },
		note: "full Scryfall card objects, 175/page",
	},
];

interface Sample {
	runId: string;
	phase: "uncached" | "cached";
	variant: string;
	query: string;
	/** Index into QUERIES — the rotation offset for this round. */
	qi: number;
	/** Position of this variant within its query's round; 0 is the one that pays for the memo. */
	pos: number;
	/** Repeat number within phase B (0 = the request that populates the cache). */
	rep: number;
	url: string;
	status: number;
	/** Ray id, and the colo parsed off its tail. Still the join key for
	 * observability, but no longer a proxy for which DO answered: engine DOs are
	 * named per region, so many colos share one. */
	cfRay: string;
	colo: string;
	cacheStatus: string;
	/** x-sylvan-engine: which DO answered (`do-<region>`, `do-<region>-N`), empty on a cache hit. */
	engine: string;
	/** x-sylvan-rl: the limiter's verdict (`off`, `allowed`, `limited`, …). */
	rl: string;
	ttfbMs: number;
	totalMs: number;
	bytes: number;
	/** total_cards from the envelope — both routes report it, and they must agree. */
	totalCards: number | null;
	/** Cards actually in the page: /search honours `limit`, /cards/search is fixed at 175. */
	returned: number | null;
	/** /search only: engine_query duration_ms out of outer_timings. /cards/search has no timer. */
	serverEngineMs: number | null;
}

function parseArgs(argv: string[]): {
	base: string;
	key: string | null;
	delayMs: number;
	warmup: number;
	out: string;
	queries: readonly string[];
} {
	let base = DEFAULT_BASE;
	let key: string | null = process.env.TRUSTED_API_KEY ?? null;
	// 450ms keeps the run at ~2.2 req/s, under the limiter's default 25 per 10s
	// (2.5/s) with margin. The limiter is live on the daveycodez deployment —
	// RateLimiter.jsrpc shows up in its observability — and a 429 is a fast
	// response that is not a search, so pacing is cheaper than filtering them
	// back out afterwards. --key with TRUSTED_API_KEY is the way to go faster.
	let delayMs = 450;
	let warmup = 3;
	let out = `bench-cards-search-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
	let limit: number = QUERIES.length;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = (): string => {
			const v = argv[i + 1];
			if (v === undefined) throw new Error(`${arg} needs a value`);
			i += 1;
			return v;
		};
		if (arg === "--base") base = next().replace(/\/+$/, "");
		else if (arg === "--key") key = next();
		else if (arg === "--delay") delayMs = Number(next());
		else if (arg === "--warmup") warmup = Number(next());
		else if (arg === "--out") out = next();
		else if (arg === "--queries") limit = Number(next());
		else if (arg === "--help" || arg === "-h") {
			console.log("bench-cards-search: /search vs /cards/search on one deployment.");
			console.log("  --base URL   target (default https://sylvan-library.daveycodez.workers.dev)");
			console.log("  --key K      X-API-Key, to bypass the per-IP limiter (or $TRUSTED_API_KEY)");
			console.log("  --delay MS   pause between requests (default 450, to stay under the limiter)");
			console.log("  --warmup N   discarded requests that wake the colo's DO (default 3)");
			console.log("  --queries N  use only the first N of the 10 queries");
			console.log("  --out FILE   where the raw samples land (JSON)");
			process.exit(0);
		} else throw new Error(`unknown argument: ${arg}`);
	}
	return { base, key, delayMs, warmup, out, queries: QUERIES.slice(0, limit) };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Count the objects in an already-encoded card array without parsing it, and
 * without a regex that a `{` inside oracle text would fool. Same trick as
 * scryfall-compat/routes.ts countCards, for the same reason: the page can be a
 * megabyte, and the count is not worth a parse.
 */
function countTopLevelObjects(json: string): number {
	let depth = 0;
	let count = 0;
	let inString = false;
	let escaped = false;
	for (const ch of json) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") {
			if (depth === 0) count += 1;
			depth += 1;
		} else if (ch === "}") depth -= 1;
	}
	return count;
}

/**
 * Pull the few numbers worth reporting out of a body, tolerating both envelopes
 * and every error shape either route can answer with.
 *
 * /search:       {cards: [...], total_cards, outer_timings: {...}}
 * /cards/search: {object: "list", total_cards, has_more, data: [...]}
 *                — or {object: "error", status, details} for a miss (404) or a
 *                parse failure (400), which is why `returned` can be 0 rather
 *                than null on a perfectly well-formed response.
 */
function readBody(text: string): Pick<Sample, "totalCards" | "returned" | "serverEngineMs"> {
	try {
		const body = JSON.parse(text) as Record<string, unknown>;
		const cards = (body.cards ?? body.data) as unknown[] | undefined;
		const timings = body.outer_timings as Record<string, { _meta?: { duration_ms?: number } }> | undefined;
		return {
			totalCards: typeof body.total_cards === "number" ? body.total_cards : null,
			returned: Array.isArray(cards) ? cards.length : null,
			serverEngineMs: timings?.engine_query?._meta?.duration_ms ?? null,
		};
	} catch {
		// A body that will not parse is still worth a row — the status and the
		// byte count say what happened, and countTopLevelObjects gives a floor on
		// what came back. Losing the whole sample to a JSON error would hide it.
		return { totalCards: null, returned: countTopLevelObjects(text) || null, serverEngineMs: null };
	}
}

function buildUrl(base: string, variant: Variant, query: string, nonce: string): string {
	const url = new URL(base + variant.path);
	url.searchParams.set("q", query);
	for (const [k, v] of Object.entries(variant.params)) url.searchParams.set(k, v);
	// The cache-key nonce, and the observability join key. Safe on both routes:
	// /search binds a fixed SEARCH_SPEC and drops unknown params (param-binding.ts,
	// upstream ParamBinder.bind), and cardsSearchHandler reads params by name and
	// never enumerates them. So `_b` changes the URL and nothing else about the
	// search — which is exactly what a cache-buster has to do to stay honest.
	url.searchParams.set("_b", nonce);
	return url.toString();
}

async function hit(
	url: string,
	key: string | null,
	meta: Omit<
		Sample,
		| "url"
		| "status"
		| "cfRay"
		| "colo"
		| "cacheStatus"
		| "engine"
		| "rl"
		| "ttfbMs"
		| "totalMs"
		| "bytes"
		| "totalCards"
		| "returned"
		| "serverEngineMs"
	>,
): Promise<Sample> {
	const headers: Record<string, string> = { "User-Agent": "sylvan-librarian-cloudflare-bench/2.0" };
	if (key) headers["X-API-Key"] = key;

	const started = performance.now();
	const response = await fetch(url, { headers });
	// fetch resolves when the headers land, so this is TTFB; the body read below
	// is the rest of the transfer. The split matters here more than it does in
	// bench.sh: the whole hypothesis is that /cards/search moves far more bytes,
	// and bytes show up after the first one.
	const ttfbMs = performance.now() - started;
	const text = await response.text();
	const totalMs = performance.now() - started;

	const cfRay = response.headers.get("cf-ray") ?? "";
	return {
		...meta,
		url,
		status: response.status,
		cfRay,
		colo: cfRay.split("-")[1] ?? "",
		cacheStatus: response.headers.get("cf-cache-status") ?? "",
		engine: response.headers.get("x-sylvan-engine") ?? "",
		rl: response.headers.get("x-sylvan-rl") ?? "",
		ttfbMs,
		totalMs,
		bytes: new TextEncoder().encode(text).length,
		...readBody(text),
	};
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return Number.NaN;
	const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[idx] as number;
}

const median = (values: number[]): number =>
	percentile(
		[...values].sort((a, b) => a - b),
		50,
	);

function fmtMs(value: number): string {
	return Number.isNaN(value) ? "   -  " : `${value.toFixed(1)}ms`;
}

function fmtBytes(value: number): string {
	if (Number.isNaN(value)) return "   - ";
	if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)}MB`;
	return `${(value / 1024).toFixed(1)}KB`;
}

/** One right-aligned table, drawn without a dependency. */
function table(headers: string[], rows: string[][]): string {
	const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
	const line = (cells: string[]): string =>
		cells.map((c, i) => (i === 0 ? c.padEnd(widths[i] as number) : c.padStart(widths[i] as number))).join("  ");
	return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

/** Phase A: every request unique, so every request runs the Worker. */
function reportUncached(samples: Sample[]): string {
	const rows: string[][] = [];
	for (const variant of VARIANTS) {
		const mine = samples.filter((s) => s.variant === variant.name && s.status === 200);
		if (mine.length === 0) {
			rows.push([variant.name, "0", ...Array(7).fill("-")]);
			continue;
		}
		const totals = mine.map((s) => s.totalMs).sort((a, b) => a - b);
		const ttfbs = mine.map((s) => s.ttfbMs).sort((a, b) => a - b);
		const serverMs = mine.map((s) => s.serverEngineMs).filter((v): v is number => v !== null);
		rows.push([
			variant.name,
			String(mine.length),
			fmtMs(percentile(ttfbs, 50)),
			fmtMs(percentile(totals, 50)),
			fmtMs(percentile(totals, 90)),
			fmtMs(percentile(totals, 100)),
			fmtBytes(median(mine.map((s) => s.bytes))),
			String(Math.round(median(mine.map((s) => s.returned ?? 0)))),
			serverMs.length > 0 ? fmtMs(median(serverMs)) : "-",
		]);
	}
	return table(
		["variant", "n", "ttfb p50", "total p50", "total p90", "total max", "bytes p50", "cards", "engine p50"],
		rows,
	);
}

/** Phase B: the same URL three times, which is where the cache asymmetry shows. */
function reportCached(samples: Sample[]): string {
	const rows: string[][] = [];
	for (const variant of VARIANTS) {
		for (let rep = 0; rep < 3; rep += 1) {
			const mine = samples.filter((s) => s.variant === variant.name && s.rep === rep && s.status === 200);
			if (mine.length === 0) continue;
			const statuses = [...new Set(mine.map((s) => s.cacheStatus || "(none)"))].join(",");
			rows.push([
				variant.name,
				rep === 0 ? "1st" : `repeat ${rep}`,
				fmtMs(median(mine.map((s) => s.ttfbMs))),
				fmtMs(median(mine.map((s) => s.totalMs))),
				statuses,
			]);
		}
	}
	return table(["variant", "run", "ttfb p50", "total p50", "cf-cache-status"], rows);
}

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2));
	// The join key. Short and unmistakable in a URL, so an observability filter
	// can be `$workers.event.request.url contains <runId>` and catch this run and
	// nothing else. No Date.now() games — one id, minted once, printed loudly.
	const runId = `b${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;

	console.log(`target   ${opts.base}`);
	console.log(`run id   ${runId}   (every URL carries &_b=${runId}-…)`);
	console.log(`queries  ${opts.queries.length}    delay ${opts.delayMs}ms    warmup ${opts.warmup}`);
	console.log(
		`auth     ${opts.key ? "X-API-Key sent (limiter bypassed if configured)" : "none — subject to the per-IP limiter"}`,
	);
	for (const v of VARIANTS) console.log(`  ${v.name.padEnd(15)} ${v.path}  — ${v.note}`);
	console.log("");

	// Preflight, because the failure this catches is invisible in the numbers. An
	// unclaimed *.workers.dev subdomain answers EVERY path with a 404 whose body
	// is "error code: 1042", and this port answers an unknown path with a 404
	// too — so a typo'd hostname produces a complete, fast, entirely uniform run
	// of 404s that reads like a routing regression. One request up front, and the
	// two are told apart by whether the body is this Worker's JSON.
	{
		const probe = await fetch(`${opts.base}/search?q=t%3Agoblin&_b=${runId}-probe`, {
			headers: { "User-Agent": "sylvan-librarian-cloudflare-bench/2.0" },
		});
		const body = await probe.text();
		if (!probe.ok) {
			const cloudflareEdge = body.includes("error code: 1042") || !body.trimStart().startsWith("{");
			console.error(`preflight: GET /search -> ${probe.status}`);
			console.error(
				cloudflareEdge
					? `  ${opts.base} is not serving this Worker (Cloudflare answered, the Worker did not).\n  Check the hostname against the "name" in wrangler.jsonc, and pass --base.`
					: `  the Worker answered but not with a search: ${body.slice(0, 200)}`,
			);
			process.exit(1);
		}
	}

	// Wake the region's DO before anything is recorded. A cold hit is ~1.5s and
	// lands on whichever variant happens to go first, which would be a difference
	// between the routes that is not about the routes.
	for (let i = 0; i < opts.warmup; i += 1) {
		const variant = VARIANTS[i % VARIANTS.length] as Variant;
		const url = buildUrl(opts.base, variant, "t:goblin", `${runId}-warm-${i}`);
		try {
			const sample = await hit(url, opts.key, {
				runId,
				phase: "uncached",
				variant: variant.name,
				query: "t:goblin",
				qi: -1,
				pos: -1,
				rep: -1,
			});
			console.log(
				`warmup ${i + 1}/${opts.warmup}  ${sample.status}  ${sample.totalMs.toFixed(0)}ms  ${sample.engine || "(cached)"}`,
			);
		} catch (err) {
			console.log(`warmup ${i + 1}/${opts.warmup}  failed: ${err}`);
		}
		await sleep(opts.delayMs);
	}

	const samples: Sample[] = [];
	let seq = 0;

	// ── Phase A: unique URL per request, so both routes run the Worker ────────
	process.stdout.write("\nphase A (uncached) ");
	for (let qi = 0; qi < opts.queries.length; qi += 1) {
		const query = opts.queries[qi] as string;
		// Rotate which variant leads this query, so the engine's memo — warmed by
		// whoever asks first — is paid for equally across the three.
		for (let pos = 0; pos < VARIANTS.length; pos += 1) {
			const variant = VARIANTS[(qi + pos) % VARIANTS.length] as Variant;
			seq += 1;
			const url = buildUrl(opts.base, variant, query, `${runId}-${seq}`);
			try {
				samples.push(
					await hit(url, opts.key, { runId, phase: "uncached", variant: variant.name, query, qi, pos, rep: -1 }),
				);
				process.stdout.write(".");
			} catch (err) {
				process.stdout.write("!");
				console.error(`\n  ${variant.name} "${query}" failed: ${err}`);
			}
			await sleep(opts.delayMs);
		}
	}

	// ── Phase B: one URL per variant, three times, to measure the cache ───────
	process.stdout.write("\nphase B (repeat)   ");
	for (const variant of VARIANTS) {
		for (let qi = 0; qi < Math.min(3, opts.queries.length); qi += 1) {
			const query = opts.queries[qi] as string;
			// One nonce for all three repeats: the first populates whatever cache
			// exists and the next two get the chance to hit it.
			const nonce = `${runId}-rep-${variant.name}-${qi}`;
			const url = buildUrl(opts.base, variant, query, nonce);
			for (let rep = 0; rep < 3; rep += 1) {
				try {
					samples.push(
						await hit(url, opts.key, { runId, phase: "cached", variant: variant.name, query, qi, pos: -1, rep }),
					);
					process.stdout.write(".");
				} catch (err) {
					process.stdout.write("!");
					console.error(`\n  ${variant.name} repeat ${rep} failed: ${err}`);
				}
				await sleep(opts.delayMs);
			}
		}
	}
	console.log("\n");

	// ── Report ───────────────────────────────────────────────────────────────
	const uncached = samples.filter((s) => s.phase === "uncached" && s.qi >= 0);
	const cached = samples.filter((s) => s.phase === "cached");

	console.log("PHASE A — every request reaches the Worker (unique cache key)\n");
	console.log(reportUncached(uncached));
	console.log("");
	console.log("PHASE B — same URL three times (this is where the cache asymmetry lives)\n");
	console.log(reportCached(cached));

	// Everything that would make the table above a lie, stated rather than buried.
	const bad = samples.filter((s) => s.status !== 200);
	if (bad.length > 0) {
		const byStatus = new Map<number, number>();
		for (const s of bad) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
		console.log(`\nNON-200: ${[...byStatus].map(([code, n]) => `${code}x${n}`).join(" ")}`);
		if (byStatus.has(429))
			console.log(
				"  429s present — the limiter is on and these are NOT searches. Re-run with --key or a larger --delay.",
			);
		for (const s of bad.slice(0, 5)) console.log(`  ${s.status} ${s.variant} "${s.query}" rl=${s.rl || "-"}`);
	}

	// total_cards must agree across the three variants for a given query: they
	// run the same filter tree, and a mismatch means the routes disagree about
	// what the query MEANS — which would make every timing above a comparison of
	// two different searches.
	for (const query of opts.queries) {
		const counts = new Map<string, number | null>();
		for (const s of uncached.filter((x) => x.query === query && x.status === 200)) counts.set(s.variant, s.totalCards);
		const distinct = new Set([...counts.values()].filter((v) => v !== null));
		if (distinct.size > 1) {
			console.log(`\nDISAGREEMENT on "${query}": ${[...counts].map(([v, c]) => `${v}=${c}`).join(" ")}`);
		}
	}

	const colos = [...new Set(samples.map((s) => s.colo).filter(Boolean))];
	const engines = [...new Set(samples.map((s) => s.engine).filter(Boolean))];
	console.log(`\ncolo ${colos.join(",") || "?"}    engine ${engines.join(",") || "?"}`);

	await Bun.write(
		opts.out,
		JSON.stringify({ runId, base: opts.base, startedAt: new Date().toISOString(), samples }, null, 2),
	);
	console.log(`\n${samples.length} samples -> ${opts.out}`);

	// The handoff to the Worker-side half. Observability keeps the request URL,
	// so the run id is the join: filter on it, then group by which path the URL
	// carries. Ray ids are on every sample too, for pinning one row exactly.
	console.log(`\nNEXT — Workers Observability, filtered to this run:`);
	console.log(`  $workers.event.request.url  contains  "_b=${runId}"`);
	console.log(`  then split /search vs /cards/search on the same field, and read cpuTimeMs and wallTimeMs.`);
	console.log(
		`  Phase A gives ${uncached.filter((s) => s.status === 200).length} Worker invocations; phase B's /search repeats should be MISSING (served from cache).`,
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
