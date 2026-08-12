// Closed-loop load generator for /search, built to answer the questions
// scripts/bench.sh structurally cannot: bench.sh issues 30 strictly serial
// requests, and every threshold in src/engine/shard-controller.ts is expressed
// in requests per SECOND at one Durable Object. Nothing in the repo has ever
// put concurrent load on that path.
//
// It exists to measure two numbers and one behavior:
//
//   C  — per-request occupancy of a single SearchEngine DO. Profiling in
//        d538c1f put the DO side near 0.65ms of CPU for a 26KB result, but the
//        controller keys on RPC WALL TIME, and production warm samples came
//        back at 7-77ms (min 7, mean ~36). So the round trip costs 10-100x the
//        query it carries, and transport, not the search, is what a /search
//        actually spends against the engine. Confirming that under load — and
//        finding where it inflects — is the point of the ramp. A DO is
//        single-threaded, so its ceiling is 1000/C req/s. Set SHARDS_MAX=1 on
//        the target to measure it.
//   ρ  — where the latency knee sits. Service time is CPU-bound and close to
//        deterministic, so M/D/1 applies: T/C = 1 + ρ/(2(1-ρ)). The controller's
//        `3 x floor` rule targets T/C = 3, i.e. ρ = 80%, which is the right
//        place to fan out. At the measured floor that rule already binds and
//        LATENCY_ABS_MS is inert — so the open question is no longer which one
//        fires, it is whether the VARIANCE breaks the rule: a 7ms fast tail
//        against a ~36ms mean is a permanent breach of a 3x bar, which would
//        expand a loaded region to SHARDS_MAX on spread alone. If the ramp shows
//        that spread persisting under load, LATENCY_FLOOR_MULT is what needs
//        raising. remote-engine.ts summarizes warm RPCs into the log, so the
//        run reports the distribution directly — read min against mean.
//   the fan-out itself — x-sylvan-engine names the DO that answered
//        (`do-<region>` for shard 0, `do-<region>-N` after), so the per-stage shard
//        histogram is the controller converging, live.
//
// TWO-PHASE EXPERIMENT. Run both; the pair is the point.
//
//   1. Ceiling.   SHARDS_MAX=1 on the target, so the fan-out cannot rescue a
//                 saturated DO. Ramp until p50 inflects. The concurrency at the
//                 inflection is the single-DO ceiling; the flat p50 below it is
//                 C + network. This is the number the controller is tuned
//                 against and the one nothing has ever measured.
//   2. Autoscale. SHARDS_MAX unset (or high). Same ramp. Watch the shard
//                 histogram widen and p99 recover. The gap between "p50 starts
//                 climbing" and "a second shard appears" is how late the
//                 trigger fires — the thing the analysis says is ~18 points of
//                 utilization too late.
//
// THREE THINGS THAT WILL SILENTLY MEASURE THE WRONG SUBJECT:
//
//   Edge cache.  wrangler.jsonc caches /search for 90s and cache hits never
//                reach the Worker, let alone the DO. Every request here carries
//                a unique `_lt` param; the binder drops unknown string params
//                (param-binding.ts, upstream ParamBinder.bind), so it changes
//                the cache key and nothing else. --cached opts out to measure
//                the cache instead, which is a different and also useful run.
//   Rate limit.  RATE_LIMIT_PER_10S defaults to 25 per 10s. Enforcement is
//                asynchronous by design, so the effective ceiling runs ~2x the
//                configured one: measured against production 2026-08-09 at 8
//                concurrent for 60s, a 10/s configuration passed 20.5/s in
//                steady state (t>=20s; 1301 of 5311 requests allowed overall).
//                Read the steady state, not the total — the first ~15s carry a
//                one-time grace from the cold per-IP DO that made a 15s run
//                look like 3.5x. Still far below EXPAND_MIN_RATE, so without a
//                trusted key this measures the limiter and nothing else. Pass
//                --key (or export TRUSTED_API_KEY) to send X-API-Key;
//                x-sylvan-rl in the output says which happened.
//   Query memo. The engine memoizes (see vendor bench_text_memo.py). One
//                repeated query measures the memo, not a search. The pool below
//                is cycled per request for that reason.
//   Cold DOs.    The big one, and the reason --warmup exists. A region whose DO
//                has been evicted loads ~76.6MB from KV before it can answer,
//                and the shard controller excludes wake-carrying samples by
//                design — so a run against a cold DO measures the wake AND
//                leaves the autoscaler blind throughout. --warmup discards a
//                leading stretch; it defaults on, and turning it off is how you
//                get a 1.5s first stage that looks like a knee and is not one.
//
// A REFERENCE RUN, so a future one has something to differ from. Local
// `bun run dev`, rows shape, 15s warmup discarded, 10s per stage:
//
//   conc=  1  rps=398.7  p50= 2ms  p90= 3ms  p99=  8ms  | do-wnam
//   conc=  2  rps=419.7  p50= 4ms  p90= 6ms  p99= 15ms  | do-wnam
//   conc=  4  rps=449.5  p50= 8ms  p90=11ms  p99= 22ms  | do-wnam
//   conc=  8  rps=449.7  p50=16ms  p90=21ms  p99= 40ms  | do-wnam + do-wnam-1
//   conc= 16  rps=446.7  p50=33ms  p90=40ms  p99=183ms  | both
//   conc= 32  rps=464.0  p50=65ms  p90=82ms  p99=104ms  | both
//
// Throughput flattens at ~450/s from conc=2 and p50 then doubles with each step —
// textbook saturation, latency = concurrency / throughput. The controller
// expanded once, at conc=8: "rpc 16ms vs floor 1ms at 410/s".
//
// Two cautions about reading that table as production. Locally every DO shares
// one miniflare process, so a second shard adds no capacity — throughput is
// flat across the expansion, which says nothing about whether sharding works.
// And the ~450/s ceiling is the whole local stack, not the DO: warm RPCs
// underneath were 0.9-5.3ms, so the DO was nowhere near its own limit. Stage
// length also has to exceed EXPAND_COOLDOWN_MS (30s) before a run can say
// anything about laddering; at 10s stages this one could not.
//
// AND A PRODUCTION RUN, sylvan.mtgseeker.com, limiter off, 30s warmup, 20s
// stages, 18450 requests, none cached, none limited, zero errors:
//
//   conc=  1  rps=  7.0  p50=132ms  p90=212ms   |  s=72.9% s-1=17.9% s-2= 9.3%
//   conc=  8  rps= 63.6  p50=117ms  p90=190ms   |  s=72.1% s-1=15.8% s-2=12.1%
//   conc= 32  rps=233.9  p50=136ms  p90=195ms   |  s=73.5% s-1=16.3% s-2=10.3%
//   conc= 64  rps=436.1  p50=142ms  p90=203ms   |  s=68.4% s-1=17.3% s-2=9.3% s-3=4.9%
//
// READ THIS AS A NON-RESULT FOR THE CEILING. p50 is flat across a 64x range and
// throughput scales linearly with concurrency — 64/0.142s = 451/s against 436
// observed — which is the signature of a generator bound by its own round trip,
// not a saturated server. One machine at ~130ms RTT cannot saturate this; the
// DO's ceiling is somewhere above 436/s and this run does not find it. To get
// it you need either many source machines or a generator inside Cloudflare.
//
// What it DID establish, from the warm-rpc log lines underneath:
//   - Production floor is 5-7ms even under load, so `3 x floor` is 15-21ms and
//     the ratio rule binds. LATENCY_ABS_MS (10) is inert in production; it
//     governs only the local regime where the floor collapses to ~1ms.
//   - Within a 2s window min/avg ran 1.2-2.2x, never near 3x, so the variance
//     concern is retired under real load as well as locally.
//   - The shard split never converged, which was a real defect. Fixed by the
//     rendezvous in shard-controller.ts and re-run to confirm: at conc=64 the
//     same ramp went from 68.4/17.3/9.3/4.9 across four shards (2.74x
//     imbalance, shard 0 at p50 154ms against 86-125ms for the rest) to
//     20.5/20.0/20.0/19.9/19.6 across five (1.02x, every shard 116-122ms).
//     Stage p50 fell 142ms -> 118ms with it. Re-running this pair is how to
//     check the fan-out still balances after any change to the controller.
//
// Read TRUSTED_API_KEY from your own shell (`export TRUSTED_API_KEY=...`) or
// pass --key. This script never reads .env.
//
// Usage:
//   bun run scripts/load-test.ts --url https://example.com/search --dry-run
//   bun run scripts/load-test.ts --url https://example.com/search \
//     --stages 1,2,4,8,16,32,64 --hold 20 --shape rows --out results.tsv
//
// --shape rows|columnar picks the encoding. Both go through searchSerialized,
// so both charge the encode to the DO; columnar is the heavier payload and the
// one d538c1f profiled, so run the pair if you want C's payload sensitivity.

import { parseArgs } from "node:util";

/** Unique per invocation. The cache-buster below must not repeat WITHIN a
 * run (stages would replay each other's URLs) or ACROSS runs inside the 90s
 * edge TTL (a rerun would replay the last one's). A per-stage counter did
 * both: a production ramp came back 52% cache HITs, each stage hitting
 * exactly the previous stage's request count. */
const RUN_ID = Date.now().toString(36);

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
	"t:artifact cmc>=6 -t:creature",
	"t:enchantment c:g f:standard",
	"o:sacrifice t:creature c:b",
	"pow>=6 tou>=6 f:commander",
	"t:sorcery o:destroy c:r",
];

interface Sample {
	/** Completion time, ms since the stage began. Without this a run can only
	 * report totals, and a total cannot separate a one-time startup effect from
	 * a steady-state rate — which is exactly the distinction that matters when
	 * reading the rate limiter. */
	t: number;
	ms: number;
	status: number;
	/** x-sylvan-engine: which DO answered (do-<region>, do-<region>-N). */
	shard: string;
	/** cf-cache-status: HIT here means the run is measuring the edge cache. */
	cache: string;
	/** x-sylvan-rl: "limited" means the run is measuring the rate limiter. */
	rl: string;
	bytes: number;
}

interface StageResult {
	concurrency: number;
	elapsedMs: number;
	samples: Sample[];
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return Number.NaN;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx] as number;
}

function histogram(values: string[]): string {
	const counts = new Map<string, number>();
	for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([k, n]) => `${k || "-"}=${n}`)
		.join(" ");
}

/** How every request in a run is shaped. */
interface RunConfig {
	headers: Record<string, string>;
	cached: boolean;
	/** RESPONSE_SHAPE: "rows" (the route default) or "columnar". Both take the
	 * searchSerialized path, where the DO encodes — the CPU this is measuring. */
	shape: string;
}

/** One worker: issue requests back to back until the deadline. */
async function worker(
	base: string,
	stageStart: number,
	deadline: number,
	cfg: RunConfig,
	counter: { n: number },
	out: Sample[],
): Promise<void> {
	while (Date.now() < deadline) {
		const seq = counter.n++;
		const query = QUERIES[seq % QUERIES.length] as string;
		const url = new URL(base);
		url.searchParams.set("q", query);
		url.searchParams.set("shape", cfg.shape);
		// Unknown param: dropped by the binder, but part of the edge cache key.
		if (!cfg.cached) url.searchParams.set("_lt", `${RUN_ID}-${seq}`);
		const started = Date.now();
		try {
			const res = await fetch(url, { headers: cfg.headers });
			const body = await res.arrayBuffer();
			out.push({
				t: Date.now() - stageStart,
				ms: Date.now() - started,
				status: res.status,
				shard: res.headers.get("x-sylvan-engine") ?? "",
				cache: res.headers.get("cf-cache-status") ?? "",
				rl: res.headers.get("x-sylvan-rl") ?? "",
				bytes: body.byteLength,
			});
		} catch (err) {
			out.push({
				t: Date.now() - stageStart,
				ms: Date.now() - started,
				status: 0,
				shard: "",
				cache: "",
				rl: String(err).slice(0, 40),
				bytes: 0,
			});
		}
	}
}

/** Shared by every stage AND the warmup: see RUN_ID. */
const runCounter = { n: 0 };

async function runStage(base: string, concurrency: number, holdMs: number, cfg: RunConfig): Promise<StageResult> {
	const samples: Sample[] = [];
	const startedAt = Date.now();
	const deadline = startedAt + holdMs;
	await Promise.all(
		Array.from({ length: concurrency }, () => worker(base, startedAt, deadline, cfg, runCounter, samples)),
	);
	return { concurrency, elapsedMs: Date.now() - startedAt, samples };
}

function reportStage(stage: StageResult): string {
	const ok = stage.samples.filter((s) => s.status === 200);
	const sorted = ok.map((s) => s.ms).sort((a, b) => a - b);
	const rps = (stage.samples.length / stage.elapsedMs) * 1000;
	const errors = stage.samples.length - ok.length;
	return [
		`conc=${String(stage.concurrency).padStart(3)}`,
		`rps=${rps.toFixed(1).padStart(7)}`,
		`p50=${String(percentile(sorted, 50)).padStart(5)}ms`,
		`p90=${String(percentile(sorted, 90)).padStart(5)}ms`,
		`p99=${String(percentile(sorted, 99)).padStart(6)}ms`,
		`err=${String(errors).padStart(4)}`,
		`| shards: ${histogram(stage.samples.map((s) => s.shard))}`,
	].join("  ");
}

const { values } = parseArgs({
	options: {
		url: { type: "string" },
		stages: { type: "string", default: "1,2,4,8,16,32,64" },
		hold: { type: "string", default: "20" },
		key: { type: "string" },
		out: { type: "string" },
		cached: { type: "boolean", default: false },
		shape: { type: "string", default: "rows" },
		warmup: { type: "string", default: "30" },
		"dry-run": { type: "boolean", default: false },
	},
});

/** RESPONSE_SHAPE in src/routes/enums.ts. */
const SHAPES = ["rows", "columnar"];

const base = values.url;
if (!base) {
	console.error("--url is required (no default: this generates real load).");
	console.error("  e.g. --url https://<your-worker>/search");
	process.exit(2);
}

const stages = (values.stages as string).split(",").map((s) => Number.parseInt(s.trim(), 10));
if (stages.some((n) => !Number.isFinite(n) || n < 1)) {
	console.error(`--stages must be positive integers, got ${values.stages}`);
	process.exit(2);
}
const holdMs = Number.parseFloat(values.hold as string) * 1000;
if (!Number.isFinite(holdMs) || holdMs < 1000) {
	console.error("--hold must be at least 1 (seconds)");
	process.exit(2);
}

const shape = values.shape as string;
if (!SHAPES.includes(shape)) {
	console.error(`--shape must be one of ${SHAPES.join(", ")}, got ${shape}`);
	process.exit(2);
}
const warmupMs = Number.parseFloat(values.warmup as string) * 1000;
if (!Number.isFinite(warmupMs) || warmupMs < 0) {
	console.error("--warmup must be 0 or more (seconds)");
	process.exit(2);
}

const apiKey = values.key ?? process.env.TRUSTED_API_KEY;
const headers: Record<string, string> = { "User-Agent": "sylvan-librarian-cloudflare-loadtest/1.0" };
if (apiKey) headers["X-API-Key"] = apiKey;
const cfg: RunConfig = { headers, cached: values.cached as boolean, shape };

const peak = Math.max(...stages);
console.error(`Target:      ${base}`);
console.error(`Stages:      ${stages.join(", ")} concurrent, ${holdMs / 1000}s each`);
console.error(`Shape:       ${shape} (both shapes take the DO-encoded searchSerialized path)`);
console.error(`Cache:       ${values.cached ? "REUSED urls (measures the edge cache)" : "busted per request"}`);
console.error(
	`Rate limit:  ${apiKey ? "bypass key present" : "NO KEY — expect a wall near 3.5x RATE_LIMIT_PER_10S/10 req/s"}`,
);
console.error(
	`Warmup:      ${warmupMs / 1000}s discarded${warmupMs === 0 ? " (DISABLED — stage 1 will measure the relay path)" : ""}`,
);
console.error(`Peak:        ${peak} in flight; total wall time ~${(warmupMs + stages.length * holdMs) / 1000}s`);
console.error("");

if (values["dry-run"]) {
	console.error("--dry-run: nothing sent.");
	process.exit(0);
}

// Discarded warm-up. A region whose DO has been evicted loads the whole store
// before it can answer, and the shard controller excludes wake-carrying samples
// outright, so until this finishes it is not receiving signal either. Measuring
// through it would put a ~1.5s first stage in the table and read as a knee that
// is really just a cold start.
//
// It also covers the OTHER wake this bench can trip: a shard the controller
// opens mid-run is warmed before it takes traffic, so its first requests do not
// appear here as a cluster of slow samples the way they used to.
if (warmupMs > 0) {
	const warm = await runStage(base, 2, warmupMs, cfg);
	const relayed = warm.samples.filter((s) => s.ms > 500).length;
	console.error(
		`warmup: ${warm.samples.length} requests discarded, ${relayed} over 500ms ` +
			`(cold wakes), last=${warm.samples.at(-1)?.ms ?? "-"}ms`,
	);
	if (relayed === warm.samples.length && warm.samples.length > 0) {
		console.error("WARNING: every warmup request looked cold — the DO may not have stayed warm. Raise --warmup.");
	}
}

const results: StageResult[] = [];
for (const concurrency of stages) {
	const stage = await runStage(base, concurrency, holdMs, cfg);
	results.push(stage);
	console.error(reportStage(stage));
}

// Cache and limiter checks last: if either fired, the numbers above describe
// something other than the engine, and that has to be impossible to miss.
const all = results.flatMap((r) => r.samples);
const cacheHits = all.filter((s) => s.cache.toUpperCase() === "HIT").length;
const limited = all.filter((s) => s.rl === "limited").length;
console.error("");
if (cacheHits > 0) {
	console.error(`WARNING: ${cacheHits}/${all.length} responses were edge cache HITs — those never reached a DO.`);
}
if (limited > 0) {
	console.error(`WARNING: ${limited}/${all.length} responses were rate limited — this measured the limiter.`);
}
if (cacheHits === 0 && limited === 0) {
	console.error(`Clean run: ${all.length} requests, none cached, none limited.`);
}

if (values.out) {
	const lines = ["concurrency\tt\tms\tstatus\tshard\tcache\trl\tbytes"];
	for (const stage of results) {
		for (const s of stage.samples) {
			lines.push(`${stage.concurrency}\t${s.t}\t${s.ms}\t${s.status}\t${s.shard}\t${s.cache}\t${s.rl}\t${s.bytes}`);
		}
	}
	await Bun.write(values.out as string, `${lines.join("\n")}\n`);
	console.error(`Wrote ${all.length} samples to ${values.out}`);
}
