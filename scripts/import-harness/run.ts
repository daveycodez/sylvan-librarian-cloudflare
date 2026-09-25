// The nightly import, end to end, on this machine, with a cost meter on it.
//
//   bun run harness:import                  # default: 6k printings, 28k lines, N=7
//   bun run harness:import -- --printings 12000 --partition-bytes 4000000
//   bun run harness:import -- --statements  # also print the per-statement table
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// Until this script, the ONLY thing that had ever driven the whole
// ImportCoordinator alarm chain — listing → fetch → recode → canonical →
// transform → tags → scores → routing → (agg → finalize → reorder → build →
// publish) × N → manifest → notify → rulings → reference → purge — was the
// 11:17 UTC production cron. That is a 24-hour feedback loop on live
// infrastructure, against a Durable Objects row budget that punishes retries:
// the 2026-08-28 run spent 1,023,874 rows read, tripped MAX_RUN_ROWS_READ six
// and a half hours in, and published nothing. Read amplification of that size
// is a shape a laptop can find in two minutes; it took a production outage
// because nothing here could run the pipeline.
//
// So: the REAL coordinator class, the REAL wasm import module, the real phase
// chain and the real SQL, against a SQLite standing in for Durable Object
// storage (scripts/import-harness/storage.ts) that charges every statement to
// the phase that issued it. The corpus is the deterministic synthetic one
// `memprobe gen` already produces for scripts/gate.sh — no network, no 392MB
// download, cached across runs by the generator's own shape tag.
//
// ── WHAT A GREEN RUN DOES NOT PROVE ──────────────────────────────────────────
//
// This is bun, not workerd. It does NOT enforce:
//   - the 30s Durable Object CPU allowance per alarm (a slice that overruns in
//     production finishes fine here — the harness reports per-alarm wall time,
//     which on a dev machine is neither the same clock nor the same core),
//   - the 128MB isolate memory ceiling (a slice that OOMs in production merely
//     allocates here),
//   - workerd's I/O semantics — output gates, storage write-flush backpressure,
//     eviction between alarms. The two 900-second `exceededWallTime` stalls of
//     2026-08-28 burned 1.7s of CPU each waiting on something that never
//     settled; nothing in this harness reproduces that class.
//
// It DOES prove logic and COST: that every phase advances, that the chain
// terminates, that no phase silently redoes committed work, and — the number
// this was built for — how many storage rows each phase reads and writes per
// unit of corpus, which projects to the real one. Treat green here as
// "the shape is right", never as "it survives production".

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./shims";
import { plugin } from "bun";
import { RETIRED_COLO_ENGINE_NAMES, RETIRED_HOLDING_BYTES } from "../../src/engine/retired-engine-sweep";
import { buildCorpus, type Corpus } from "./corpus";
import { serveDumps } from "./dump-server";
import { measureEnginePool } from "./engine-pool";
import { checkOracleIndex, type OracleIndexCheck } from "./oracle-index-check";
import { FakeKV, MeteredStorage } from "./storage";

interface Options {
	printings: number;
	partitionBytes: number;
	alarmTimeoutMs: number;
	maxAlarms: number;
	statements: boolean;
	corpusDir: string;
	native: boolean;
}

function parseArgs(argv: string[]): Options {
	const flags = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg?.startsWith("--")) continue;
		const key = arg.slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith("--")) {
			flags.set(key, next);
			i++;
		} else {
			flags.set(key, "1");
		}
	}
	const num = (key: string, fallback: number) => {
		const raw = flags.get(key);
		return raw === undefined ? fallback : Number(raw);
	};
	return {
		printings: num("printings", 6000),
		// Small enough that the default corpus lands on N=7 rather than the
		// MIN_PARTITION_COUNT floor of 2: a two-partition loop has a first
		// partition and a last one and no partition that is NEITHER, which is
		// exactly the position production died in (partition 2 of 10). At 7,
		// partitions 1-5 are all middle partitions — the ones that must leave
		// draft_batches alone for the readers behind them. See
		// IMPORT_TARGET_PARTITION_BYTES in src/import-coordinator.ts.
		partitionBytes: num("partition-bytes", 4_000_000),
		// Nothing in a healthy slice takes 60s locally; the 2026-08-28 stalls
		// were promises that never settled, and this is what turns that into a
		// fast red instead of a wedged harness.
		alarmTimeoutMs: num("alarm-timeout-ms", 60_000),
		// A bound on the chain itself. The run this harness was written for did
		// 3,078 alarms on a corpus this one is a fiftieth of.
		maxAlarms: num("max-alarms", 20_000),
		statements: flags.has("statements"),
		corpusDir: flags.get("corpus-dir") ?? join(tmpdir(), "sylvan-import-harness"),
		// The oracle index's native-builder parity check (oracle-index-check.ts) builds and runs the
		// native builder against this corpus; `--no-native` skips that half.
		native: !flags.has("no-native"),
	};
}

function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

/**
 * g1's probe, answering as Cloudflare places each hint today (where.durableobjects.live and the
 * placement lines, 2026-09-24/25): sam lands in enam's pool, afr in weur's, me in eeur's.
 */
const TODAY_POOLS: Record<string, string[]> = {
	wnam: ["DFW", "SJC", "SEA", "DEN"],
	enam: ["EWR", "ATL", "IAD", "ORD"],
	sam: ["EWR", "MIA", "ATL", "EWR"],
	weur: ["AMS", "LHR", "CDG", "MAD"],
	eeur: ["FRA", "WAW", "MXP", "VIE"],
	apac: ["SIN", "HKG", "ICN", "NRT"],
	"apac-ne": ["KIX", "NRT", "ICN", "KIX"],
	"apac-se": ["SIN", "HKG", "SIN", "HKG"],
	oc: ["SYD", "MEL", "BNE", "AKL"],
	afr: ["LHR", "AMS", "MAD", "CDG"],
	me: ["FRA", "MXP", "PRG", "WAW"],
};

function fakeProbes() {
	const drawn = new Map<string, number>();
	let created = 0;
	return {
		created: () => created,
		newUniqueId: () => ({ id: created }),
		get: (_id: unknown, options?: { locationHint?: string }) => {
			created += 1;
			const hint = options?.locationHint ?? "";
			return {
				where: async () => {
					const i = drawn.get(hint) ?? 0;
					drawn.set(hint, i + 1);
					const pool = TODAY_POOLS[hint] ?? [];
					return { colo: pool[i % pool.length] ?? null };
				},
			};
		},
	};
}

// c1: the colo-era objects are the REAL SearchEngine class over real SQLite, so the sweep's
// storageFootprint and releaseCache run as shipped. search-engine-do imports store.ts, which imports
// the engine by the alias wrangler resolves to the shim; resolve it the same way here. The shim
// instantiates lazily, and neither method ever reaches it.
plugin({
	name: "engine-wasm-alias",
	setup(build) {
		build.module("sylvan-engine-wasm", async () => ({
			exports: await import(join(import.meta.dir, "../../src/engine/wasm-shim.ts")),
			loader: "object",
		}));
	},
});

/**
 * What the colo era left behind, as DeckGen's inventory had it: cache-sized objects (MB of archive
 * rows), one that holds only a few KB, and the rest names this "account" never had.
 */
const COLO_HOLDINGS: Record<string, number> = { "engine-LAX": 3, "engine-LAX-4": 2, "engine-BOS": 0 };

interface ColoObject {
	storage: MeteredStorage;
	engine: { storageFootprint(): Promise<{ bytes: number }>; releaseCache(): Promise<unknown> };
}

/** Real SearchEngine objects by name, created on first address — as the platform does. */
function coloFleet(make: (name: string, storage: MeteredStorage) => ColoObject["engine"]) {
	const objects = new Map<string, ColoObject>();
	const object = (name: string): ColoObject => {
		let found = objects.get(name);
		if (!found) {
			const storage = new MeteredStorage();
			found = { storage, engine: make(name, storage) };
			objects.set(name, found);
		}
		return found;
	};
	for (const [name, mb] of Object.entries(COLO_HOLDINGS)) {
		const db = object(name).storage.db;
		db.exec("CREATE TABLE archive_cache (archive_key TEXT NOT NULL, seq INTEGER NOT NULL, bytes BLOB NOT NULL)");
		// Incompressible, like the compressed archive chunks the real cache holds.
		const chunk = new Uint8Array(1_000_000).map((_, i) => (i * 2654435761) >>> 24);
		for (let seq = 0; seq < mb; seq++) db.run("INSERT INTO archive_cache VALUES ('store/p0', ?, ?)", [seq, chunk]);
		if (mb === 0) db.run("INSERT INTO archive_cache VALUES ('store/p0', 0, x'00')");
	}
	return { objects, object };
}

/**
 * The engine objects the publish fan-out reaches, recording what each was asked: two announced
 * objects of the hints g1 aliases (sam, afr) and one of a served hint (enam), so the harness sees
 * the notify retire the first two and prepare the third. A colo-era name reaches its real object.
 */
function fakeEngines() {
	const calls: string[] = [];
	const colo: { fleet: ReturnType<typeof coloFleet> | null } = { fleet: null };
	return {
		calls,
		colo,
		idFromName: (name: string) => ({ name }),
		get: (id: { name: string }) => {
			if ((RETIRED_COLO_ENGINE_NAMES as readonly string[]).includes(id.name) && colo.fleet) {
				calls.push(`address ${id.name}`);
				return colo.fleet.object(id.name).engine;
			}
			return fakeEngine(id, calls);
		},
	};
}

function fakeEngine(id: { name: string }, calls: string[]) {
	return {
		preparePublish: async () => {
			calls.push(`prepare ${id.name}`);
			return { prepared: true, shards: 1 };
		},
		commitPublish: async () => {
			calls.push(`commit ${id.name}`);
			return { swapped: false, shards: 1 };
		},
		releaseCache: async () => {
			calls.push(`release ${id.name}`);
			return { released: true };
		},
	};
}
// engine-enam / engine-wnam: pre-partitioning single-store region objects whose announcements
// outlived them — every nightly notified them and each logged a refusal at ERROR.
const ANNOUNCED = ["engine-sam-p0", "engine-afr-p1", "engine-enam-p0", "engine-enam", "engine-wnam"];

/** Everything the coordinator reaches for that is not this machine. */
function makeEnv(kv: FakeKV, baseUrl: string) {
	return {
		STORE_KV: kv,
		SCRYFALL_BULK_URL: `${baseUrl}/bulk-data`,
		SCRYFALL_API_URL: baseUrl,
		IMPORT_TARGET_PARTITION_BYTES: "",
		PLACEMENT_PROBE: fakeProbes(),
		SEARCH_ENGINE: fakeEngines(),
	};
}

/**
 * c1: the one-time colo-era sweep, driven through the coordinator's real notify phase against real
 * SearchEngine objects. The nightly above ran with RETIRED_ENGINE_SWEEP unset; then dry-run twice,
 * release twice. Returns what went wrong.
 */
async function retiredSweepScenario(
	coordinator: unknown,
	env: Record<string, unknown>,
	storage: MeteredStorage,
	engines: ReturnType<typeof fakeEngines>,
): Promise<string[]> {
	const problems: string[] = [];
	const fleet = engines.colo.fleet;
	if (!fleet) return ["no colo fleet"];
	const notify = () => (coordinator as { stepNotify(): Promise<void> }).stepNotify();
	const addressed = () => engines.calls.filter((c) => c.startsWith("address "));
	const rows = (name: string): number => {
		try {
			const row = fleet.objects.get(name)?.storage.db.query("SELECT COUNT(*) AS n FROM archive_cache").get() as
				| { n: number }
				| undefined;
			return Number(row?.n ?? 0);
		} catch {
			return 0; // no table: nothing stored
		}
	};
	const recorded = (): string | null => {
		const row = storage.db.query("SELECT value FROM __harness_kv WHERE key = 'retired_engine_sweep'").get() as
			| { value: string }
			| undefined;
		return row ? String((JSON.parse(row.value) as { mode?: string }).mode) : null;
	};
	const holders = Object.keys(COLO_HOLDINGS).filter((n) => (COLO_HOLDINGS[n] ?? 0) * 1e6 > RETIRED_HOLDING_BYTES);
	const small = Object.keys(COLO_HOLDINGS).filter((n) => !holders.includes(n));
	const neverHad = RETIRED_COLO_ENGINE_NAMES.filter((n) => !(n in COLO_HOLDINGS));
	const before = new Map(Object.keys(COLO_HOLDINGS).map((n) => [n, rows(n)]));
	/** The object ran no statement and holds nothing: exactly what instantiation alone leaves. */
	const untouched = (name: string) => {
		const s = fleet.objects.get(name)?.storage;
		return !s || (s.statements().length === 0 && s.deleteAllCalls === 0 && s.isEmpty());
	};
	const step = async (setting: string | undefined, label: string): Promise<string[]> => {
		if (setting === undefined) delete env.RETIRED_ENGINE_SWEEP;
		else env.RETIRED_ENGINE_SWEEP = setting;
		const mark = addressed().length;
		await notify();
		const now = addressed().slice(mark);
		console.log(`sweep ${label}: addressed ${now.length} colo-era object(s); record=${recorded() ?? "none"}`);
		return now;
	};

	if (addressed().length > 0) problems.push("the nightly addressed colo-era objects with RETIRED_ENGINE_SWEEP unset");
	if (recorded() !== null) problems.push("a sweep was recorded with the var unset");

	const dry = await step("dry-run", "dry-run");
	if (dry.length !== RETIRED_COLO_ENGINE_NAMES.length) problems.push(`dry-run addressed ${dry.length}, not 11`);
	for (const name of Object.keys(COLO_HOLDINGS)) {
		const s = fleet.objects.get(name)?.storage;
		if (rows(name) !== before.get(name) || s?.deleteAllCalls !== 0 || (s?.statements().length ?? 0) > 0)
			problems.push(`dry-run changed ${name}`);
	}
	for (const name of neverHad) if (!untouched(name)) problems.push(`dry-run wrote to never-created ${name}`);
	if (recorded() !== "dry-run") problems.push("dry-run was not recorded as finished");

	if ((await step("dry-run", "dry-run again")).length > 0) problems.push("a finished dry-run woke objects again");

	const release = await step("release", "release");
	// Every call addresses the name afresh, as the coordinator's stubs do: eleven measurements, then a
	// release and a read-back per holder.
	if (release.length !== RETIRED_COLO_ENGINE_NAMES.length + 2 * holders.length)
		problems.push(
			`release addressed ${release.length}, not 11 measurements + ${holders.length} × (release, read-back)`,
		);
	for (const name of holders) {
		const s = fleet.objects.get(name)?.storage;
		if (!(s?.deleteAllCalls === 1 && s.isEmpty())) problems.push(`release did not deleteAll ${name}`);
	}
	for (const name of small) {
		if (fleet.objects.get(name)?.storage.deleteAllCalls !== 0 || rows(name) !== before.get(name))
			problems.push(`release touched ${name}, which holds less than ${RETIRED_HOLDING_BYTES} bytes`);
	}
	for (const name of neverHad) if (!untouched(name)) problems.push(`release wrote to never-created ${name}`);
	if (recorded() !== "release") problems.push("release was not recorded as finished");
	const freed = Number(
		(
			JSON.parse(
				String(
					(
						storage.db.query("SELECT value FROM __harness_kv WHERE key = 'retired_engine_sweep'").get() as {
							value: string;
						}
					).value,
				),
			) as { freedBytes?: number }
		).freedBytes ?? 0,
	);
	const held = holders.reduce((t, n) => t + (COLO_HOLDINGS[n] ?? 0) * 1e6, 0);
	if (freed < held) problems.push(`release reports ${freed} bytes freed, less than the ${held} its holders held`);

	if ((await step("release", "release again")).length > 0) problems.push("a finished release woke objects again");
	if ((await step(undefined, "var removed")).length > 0) problems.push("the var removed still woke objects");
	return problems;
}

async function main(): Promise<number> {
	const opts = parseArgs(process.argv.slice(2));
	mkdirSync(opts.corpusDir, { recursive: true });

	const started = Date.now();
	console.log(`import harness: synthesising a ${fmt(opts.printings)}-printing corpus (cached in ${opts.corpusDir})`);
	const corpus: Corpus = await buildCorpus(opts.printings, opts.corpusDir);
	for (const [kind, bytes] of Object.entries(corpus.sizes)) {
		console.log(`  ${kind.padEnd(14)} ${fmt(bytes).padStart(12)} bytes gzipped`);
	}

	const server = serveDumps(corpus);
	const storage = new MeteredStorage();
	const kv = new FakeKV();
	const env = makeEnv(kv, server.url) as unknown as Record<string, unknown>;
	env.IMPORT_TARGET_PARTITION_BYTES = String(opts.partitionBytes);
	for (const name of ANNOUNCED) await kv.put(`engine:live:${name}`, "1");

	const ctx = {
		storage,
		exports: {
			default: { purgeCache: async () => ({ success: true, errors: [] as { code: number; message: string }[] }) },
		},
		// The coordinator's watchdog resets the object through ctx.abort when an
		// alarm overruns; here that is a red run, not a TypeError.
		abort(reason?: string): void {
			throw new Error(`ctx.abort: ${reason ?? "no reason"}`);
		},
	};

	const { ImportCoordinator } = await import("../../src/import-coordinator");
	const coordinator = new (
		ImportCoordinator as unknown as new (
			c: unknown,
			e: unknown,
		) => {
			fetch(request: Request): Promise<Response>;
			alarm(): Promise<void>;
		}
	)(ctx, env);

	const { SearchEngine } = await import("../../src/engine/search-engine-do");
	const engines = env.SEARCH_ENGINE as ReturnType<typeof fakeEngines>;
	engines.colo.fleet = coloFleet(
		(name, objectStorage) =>
			new SearchEngine({ id: { name }, storage: objectStorage, waitUntil: () => {} } as never, env as never) as never,
	);

	const phaseOf = (): string => {
		const row = (storage.db.query("SELECT value FROM meta WHERE key = 'phase'").all() as { value?: string }[])[0];
		return String(row?.value ?? "idle");
	};
	const runState = (): string => {
		const row = (storage.db.query("SELECT value FROM __harness_kv WHERE key = 'run'").all() as { value?: string }[])[0];
		if (!row?.value) return "idle";
		return String((JSON.parse(row.value) as { state?: string }).state ?? "idle");
	};

	await coordinator.fetch(new Request("https://coordinator/start-import?reason=harness"));

	let alarms = 0;
	const order: string[] = [];
	let failure: string | null = null;
	for (;;) {
		const at = await storage.getAlarm();
		if (at === null) break;
		if (alarms >= opts.maxAlarms) {
			failure = `alarm chain did not terminate within ${fmt(opts.maxAlarms)} alarms (phase ${phaseOf()})`;
			break;
		}
		await storage.deleteAlarm();
		const phase = phaseOf();
		if (order.at(-1) !== phase) order.push(phase);
		storage.phase = phase;
		const before = performance.now();
		let timedOut = false;
		await Promise.race([
			coordinator.alarm(),
			new Promise<void>((resolve) =>
				setTimeout(() => {
					timedOut = true;
					resolve();
				}, opts.alarmTimeoutMs),
			),
		]);
		const wall = performance.now() - before;
		storage.countAlarm(phase, wall);
		alarms += 1;
		if (timedOut) {
			failure = `alarm ${alarms} in phase ${phase} did not settle within ${opts.alarmTimeoutMs}ms — this is the 900s production stall's local signature`;
			break;
		}
	}

	// Before the server stops: the parity half runs the native builder against it.
	let oracle: OracleIndexCheck | null = null;
	if (!failure && runState() === "done") {
		oracle = await checkOracleIndex(kv, corpus, server.url, opts.corpusDir, opts.native);
	}

	server.stop();

	const state = runState();
	const total = storage.totals();
	// The coordinator keeps its OWN meters — the `run_meters` row: rows read and
	// written summed from every cursor's reported cost plus prechargeReads'
	// synthetic charges, alarms, and active time — and MAX_RUN_ROWS_READ is
	// checked against those, not against what storage actually did. They are
	// different quantities and the run dies on the first, so the harness reports
	// both and any gap between them.
	const metersRow = (
		storage.db.query("SELECT value FROM meta WHERE key = ?").all("run_meters") as { value?: string }[]
	)[0];
	const meters = JSON.parse(metersRow?.value ?? "{}") as {
		rows_read?: number;
		rows_written?: number;
		peak_db_bytes?: number;
	};
	const coordinatorRead = Number(meters.rows_read ?? 0);
	const coordinatorWritten = Number(meters.rows_written ?? 0);
	const elapsed = ((Date.now() - started) / 1000).toFixed(1);

	console.log(`\nchain visited ${order.length} phase transitions in ${fmt(alarms)} alarms, ${elapsed}s wall`);
	console.log(`run state: ${state}`);

	// ── per-phase cost table ───────────────────────────────────────────────
	console.log("\nphase                    alarms      rows read   rows written   wall ms   read/alarm");
	console.log("──────────────────────────────────────────────────────────────────────────────────────");
	const phases = storage.phases().sort((a, b) => b.rowsRead - a.rowsRead);
	for (const cost of phases) {
		const perAlarm = cost.alarms > 0 ? Math.round(cost.rowsRead / cost.alarms) : cost.rowsRead;
		console.log(
			`${cost.phase.padEnd(22)} ${fmt(cost.alarms).padStart(7)} ${fmt(cost.rowsRead).padStart(14)} ` +
				`${fmt(cost.rowsWritten).padStart(14)} ${Math.round(cost.wallMs).toString().padStart(9)} ${fmt(perAlarm).padStart(12)}`,
		);
	}
	console.log("──────────────────────────────────────────────────────────────────────────────────────");
	console.log(
		`${"TOTAL".padEnd(22)} ${fmt(total.alarms).padStart(7)} ${fmt(total.rowsRead).padStart(14)} ` +
			`${fmt(total.rowsWritten).padStart(14)}`,
	);
	console.log(
		`${"coordinator's meter".padEnd(22)} ${"".padStart(7)} ${fmt(coordinatorRead).padStart(14)} ` +
			`${fmt(coordinatorWritten).padStart(14)}   <- what MAX_RUN_ROWS_READ is checked against`,
	);
	// The staging high-water r3's pool gate budgets with (RunMeters.peak_db_bytes, sampled at every
	// flush), and the file's own high-water: this SQLite keeps freed pages, so page_count never falls.
	console.log(
		`staging high-water: ${fmt(Number(meters.peak_db_bytes ?? 0))} bytes by the coordinator's meter, ` +
			`${fmt(storage.sql.databaseSize)} bytes of file at the end`,
	);

	if (opts.statements) {
		console.log("\ntop statements by rows read");
		console.log("─────────────────────────────────────────────────────────────────────────────────────");
		for (const stat of storage.statements().slice(0, 25)) {
			console.log(
				`${fmt(stat.rowsRead).padStart(12)} rows  ×${fmt(stat.executions).padStart(7)}  [${stat.phase}] ${stat.sql.slice(0, 90)}`,
			);
		}
	}

	// ── projection ─────────────────────────────────────────────────────────
	//
	// The harness corpus is a known fraction of the real one, so a cost that is
	// LINEAR in corpus size projects by that ratio. A cost that is quadratic
	// does not — and that is the point: if the projection is wildly under the
	// production number, something in the real run is superlinear and the
	// harness corpus was too small to show it.
	// Measured off the 2026-08-28 production run: 541,378 all_cards lines,
	// 2,891,144,446 raw bytes (the recode phase's final checkpoint).
	const REAL_PRINTINGS = 541_378;
	const REAL_RAW_BYTES = 2_891_144_446;
	const byLines = REAL_PRINTINGS / corpus.printings;
	const byBytes = REAL_RAW_BYTES / corpus.rawBytes;
	// The synthetic corpus's lines are THINNER than Scryfall's, so the two
	// ratios disagree — and the byte ratio is the larger and the honest one for
	// everything staging-shaped (blob rows, gzip members, draft batches are all
	// byte-capped, not row-capped). Project on it and report both, so a reader
	// can see which assumption a number rests on.
	const scale = Math.max(byLines, byBytes);
	console.log(
		`\nprojection to the real corpus (${fmt(REAL_PRINTINGS)} lines / ${fmt(REAL_RAW_BYTES)} raw bytes;\n` +
			`  this run is ${fmt(corpus.printings)} lines / ${fmt(corpus.rawBytes)} raw bytes` +
			` → ×${byLines.toFixed(1)} by lines, ×${byBytes.toFixed(1)} by bytes; projecting on ×${scale.toFixed(1)}):`,
	);
	console.log(
		`  rows read    ${fmt(Math.round(total.rowsRead * scale)).padStart(12)}  against MAX_RUN_ROWS_READ 1,000,000`,
	);
	console.log(
		`  rows written ${fmt(Math.round(total.rowsWritten * scale)).padStart(12)}  against MAX_RUN_ROWS_WRITTEN 40,000`,
	);
	console.log(`  alarms       ${fmt(Math.round(total.alarms * scale)).padStart(12)}`);
	console.log("  (LINEAR projection; a phase whose real cost is superlinear in corpus size projects low.");
	console.log("   Known under-model: reorder slices at REORDER_SLICE_ROWS=12,500, so a harness partition");
	console.log("   takes ONE slice where a production partition takes five, and each slice makes two full");
	console.log("   passes over the spill groups. Add ~2 x groups x (slices-1) per partition by hand.)");

	if (failure) {
		console.error(`\nFAILED: ${failure}`);
		return 1;
	}
	if (state !== "done") {
		console.error(`\nFAILED: the run ended in state '${state}', not 'done'`);
		return 1;
	}
	console.log("");
	for (const line of oracle?.lines ?? []) console.log(line);
	if (!oracle?.ok) {
		console.error("\nFAILED: the oracle index check (above)");
		return 1;
	}

	// ── g1 and r3: the blocks the nightly decides, and what the fan-out did with them ──────────
	const published = JSON.parse(String((await kv.get("store:manifest", { type: "text" })) ?? "null")) as {
		placement?: { checked?: string; alias?: Record<string, { to: string }>; obs?: Record<string, string[][]> };
		cache?: { v?: number; codec?: string };
	} | null;
	const probes = (env.PLACEMENT_PROBE as ReturnType<typeof fakeProbes>).created();
	const engineCalls = (env.SEARCH_ENGINE as ReturnType<typeof fakeEngines>).calls;
	const aliases = Object.entries(published?.placement?.alias ?? {})
		.map(([h, a]) => `${h}→${a.to}`)
		.sort()
		.join(", ");
	console.log(
		`placement: ${probes} probe objects; checked ${published?.placement?.checked ?? "no"}; aliases ${aliases || "none"}; ` +
			`cache codec ${published?.cache?.codec ?? "absent"}`,
	);
	console.log(`notify: ${engineCalls.join("; ") || "no engine calls"}`);
	const liveLeft = kv.keys("engine:live:").sort().join(", ");
	const placementProblems = [
		probes === 44 ? null : `expected 44 probe objects (4 × 11 hints), created ${probes}`,
		published?.placement?.checked ? null : "the manifest's placement block did not pass the first-run gate",
		aliases === "afr→weur, me→eeur, sam→enam"
			? null
			: `aliases are ${aliases || "none"}, not afr→weur, me→eeur, sam→enam`,
		published?.cache?.v === 1 ? null : "the manifest carries no cache block",
		engineCalls.includes("release engine-sam-p0") && engineCalls.includes("release engine-afr-p1")
			? null
			: "the notify did not retire the aliased hints' objects",
		engineCalls.some((c) => c.endsWith("engine-sam-p0") && !c.startsWith("release"))
			? "an aliased object was prepared or committed instead of retired"
			: null,
		engineCalls.includes("prepare engine-enam-p0") ? null : "the served object was not prepared",
		engineCalls.includes("release engine-enam") && engineCalls.includes("release engine-wnam")
			? null
			: "the notify did not retire the pre-partitioning region objects",
		engineCalls.some((c) => /^(prepare|commit) engine-(enam|wnam)$/.test(c))
			? "a pre-partitioning region object was notified (the nightly ERROR refusals)"
			: null,
		liveLeft === "engine:live:engine-enam-p0" ? null : `announcements left: ${liveLeft}`,
	].filter((p): p is string => p !== null);
	if (placementProblems.length) {
		console.error(`\nFAILED: placement/cache blocks — ${placementProblems.join("; ")}`);
		return 1;
	}

	const sweepProblems = await retiredSweepScenario(coordinator, env, storage, engines);
	if (sweepProblems.length) {
		console.error(`\nFAILED: retired-engine sweep — ${sweepProblems.join("; ")}`);
		return 1;
	}

	// ── x1: what one engine object's SQLite holds through a publish of this build ─────────────────
	const pool = await measureEnginePool(kv);
	console.log("");
	for (const line of pool.lines) console.log(line);
	if (!pool.ok) {
		console.error("\nFAILED: an engine object held two builds' caches at once (above)");
		return 1;
	}

	console.log(`\nOK — published ${fmt(kv.size())} KV keys, ${fmt(kv.bytes())} bytes`);
	return 0;
}

process.exit(await main());
