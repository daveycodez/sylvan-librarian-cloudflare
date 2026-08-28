// The nightly import, end to end, on this machine, with a cost meter on it.
//
//   bun run harness:import                  # default: ~6k printings, N=4
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
import { plugin } from "bun";
import { buildCorpus, type Corpus } from "./corpus";
import { serveDumps } from "./dump-server";
import { FakeKV, MeteredStorage } from "./storage";

/** `WebAssembly.Module` is declared abstract in lib.dom; the committed wasm
 * tests construct it the same way (tests/import/canonical-wasm.test.ts). */
const WasmModule = WebAssembly.Module as unknown as new (bytes: ArrayBuffer) => WebAssembly.Module;

// ── the two things bun cannot resolve that workerd can ───────────────────────
//
// Registered BEFORE the coordinator is imported (hence the dynamic import
// below): `cloudflare:workers` is a runtime-provided module, and a `.wasm`
// import is a WebAssembly.Module under wrangler's CompiledWasm rule but a bare
// file path under bun. Both shims are load-time only — no behaviour of the
// code under test is replaced.
plugin({
	name: "workers-runtime-shims",
	setup(build) {
		build.module("cloudflare:workers", () => ({
			exports: {
				DurableObject: class {
					ctx: unknown;
					env: unknown;
					constructor(ctx: unknown, env: unknown) {
						this.ctx = ctx;
						this.env = env;
					}
				},
				WorkerEntrypoint: class {},
			},
			loader: "object",
		}));
		build.onLoad({ filter: /\.wasm$/ }, async (args) => ({
			exports: { default: new WasmModule(await Bun.file(args.path).arrayBuffer()) },
			loader: "object",
		}));
	},
});

// Workers exposes `scheduler.wait` as a global; the reference phase paces its
// api.scryfall.com requests with it. Bun does not, and without this the phase
// fails with a ReferenceError that has nothing to do with the code under test.
(globalThis as { scheduler?: { wait(ms: number): Promise<void> } }).scheduler ??= {
	wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

interface Options {
	printings: number;
	partitionBytes: number;
	alarmTimeoutMs: number;
	maxAlarms: number;
	statements: boolean;
	corpusDir: string;
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
		// Small enough that the synthetic corpus lands on N=4 rather than the
		// MIN_PARTITION_COUNT floor: partitions 0 (first), 1-2 (neither first
		// nor last — the ones production died on) and 3 (last, the one that
		// drops draft_batches) all get exercised. See IMPORT_TARGET_PARTITION_BYTES
		// in src/import-coordinator.ts.
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
	};
}

function fmt(n: number): string {
	return n.toLocaleString("en-US");
}

/** Everything the coordinator reaches for that is not this machine. */
function makeEnv(kv: FakeKV, baseUrl: string) {
	return {
		STORE_KV: kv,
		SCRYFALL_BULK_URL: `${baseUrl}/bulk-data`,
		SCRYFALL_API_URL: baseUrl,
		IMPORT_TARGET_PARTITION_BYTES: "",
	};
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

	const ctx = {
		storage,
		exports: {
			default: { purgeCache: async () => ({ success: true, errors: [] as { code: number; message: string }[] }) },
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

	server.stop();

	const state = runState();
	const total = storage.totals();
	// The coordinator keeps its OWN meters — `do_rows_read`/`do_rows_written`,
	// summed from every cursor's reported cost plus prechargeReads' synthetic
	// charges — and MAX_RUN_ROWS_READ is checked against those, not against
	// what storage actually did. They are different quantities and the run dies
	// on the first, so the harness reports both and any gap between them.
	const meter = (key: string): number => {
		const row = (storage.db.query("SELECT value FROM meta WHERE key = ?").all(key) as { value?: string }[])[0];
		return Number(row?.value ?? 0);
	};
	const coordinatorRead = meter("do_rows_read");
	const coordinatorWritten = meter("do_rows_written");
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
	console.log(`\nOK — published ${fmt(kv.size())} KV keys, ${fmt(kv.bytes())} bytes`);
	return 0;
}

process.exit(await main());
