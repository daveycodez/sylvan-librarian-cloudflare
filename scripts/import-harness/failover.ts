// The import watchdog, end to end, on this machine: the REAL coordinator wedged mid-run, the REAL
// watchdog replacing it, a REAL replacement run publishing, and then the wedged one waking up.
//
//   bun run harness:failover
//
// Two scenarios, each on its own KV namespace:
//
//   1. LOST ALARM. A run's alarm vanishes mid-transform (2026-09-17: the final `purge` alarm was
//      never delivered). The object still answers, so the watchdog KICKS it; the chain resumes
//      from its persisted phase and publishes. No failover, no pointer.
//
//   2. WEDGE. A run stops mid-bucket and its object stops answering (2026-09-23 on DeckGen: 5h+
//      with zero invocations and 60s of active time every minute). The watchdog FAILS OVER to a
//      fresh coordinator, which publishes. Then the wedged one wakes (2026-09-21's did, after 4.5h)
//      and its alarm chain runs again. It must retire: purge its staging, end `superseded`, and
//      leave every KV key exactly as the replacement published it.
//
// Bun, not workerd — see run.ts for what a green harness does and does not prove. What this one
// proves is the protocol: who writes what, in which order, and that the fence holds.

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./shims";
import { buildCorpus } from "./corpus";
import { serveDumps } from "./dump-server";
import { FakeKV, MeteredStorage } from "./storage";

type Coordinator = { fetch(request: Request): Promise<Response>; alarm(): Promise<void> };

const PRINTINGS = 6000;
const PARTITION_BYTES = 4_000_000;
const STAGING_TABLES = [
	"chunk_staging",
	"ordered_rows",
	"spill_batches",
	"routing_keys",
	"tagdata_blobs",
	"draft_parts",
	"draft_batches",
	"stage_members",
	"stage_blobs",
];

const corpusDir = join(tmpdir(), "sylvan-import-harness");
mkdirSync(corpusDir, { recursive: true });
const corpus = await buildCorpus(PRINTINGS, corpusDir);
const server = serveDumps(corpus);
const { ImportCoordinator } = await import("../../src/import-coordinator");
const watchdog = await import("../../src/import-watchdog");

/** One Durable Object: the real class over its own metered SQLite. */
class Instance {
	readonly storage = new MeteredStorage();
	readonly coordinator: Coordinator;
	/** A wedged object answers nothing, and the platform delivers it no alarms. */
	wedged = false;
	constructor(
		readonly name: string,
		kv: FakeKV,
	) {
		const env = {
			STORE_KV: kv,
			SCRYFALL_BULK_URL: `${server.url}/bulk-data`,
			SCRYFALL_API_URL: server.url,
			IMPORT_TARGET_PARTITION_BYTES: String(PARTITION_BYTES),
		};
		const ctx = {
			storage: this.storage,
			exports: { default: { purgeCache: async () => ({ success: true, errors: [] }) } },
			abort(reason?: string): void {
				throw new Error(`ctx.abort: ${reason ?? "no reason"}`);
			},
		};
		this.coordinator = new (ImportCoordinator as unknown as new (c: unknown, e: unknown) => Coordinator)(ctx, env);
	}

	phase(): string {
		const row = this.storage.db.query("SELECT value FROM meta WHERE key = 'phase'").all() as { value?: string }[];
		return String(row[0]?.value ?? "idle");
	}

	runState(): string {
		const row = this.storage.db.query("SELECT value FROM __harness_kv WHERE key = 'run'").all() as { value?: string }[];
		return row[0]?.value ? String((JSON.parse(row[0].value) as { state?: string }).state) : "idle";
	}

	stagingRows(): number {
		let rows = 0;
		for (const table of STAGING_TABLES) {
			const r = this.storage.db.query(`SELECT COUNT(*) AS n FROM ${table}`).all() as { n: number }[];
			rows += Number(r[0]?.n ?? 0);
		}
		return rows;
	}

	/** Deliver alarms until the chain stops or `until` says so. Returns the alarms delivered. */
	async drive(until: (phase: string, alarms: number) => boolean = () => false, max = 20_000): Promise<number> {
		let alarms = 0;
		for (;;) {
			if ((await this.storage.getAlarm()) === null) return alarms;
			if (until(this.phase(), alarms)) return alarms;
			if (alarms >= max) throw new Error(`${this.name}: chain did not stop within ${max} alarms (${this.phase()})`);
			await this.storage.deleteAlarm();
			await this.coordinator.alarm();
			alarms += 1;
		}
	}
}

/** The IMPORT_COORDINATOR binding over a set of Instances, created on first use like the real one. */
function namespace(kv: FakeKV, instances: Map<string, Instance>) {
	const instanceFor = (name: string): Instance => {
		let i = instances.get(name);
		if (!i) {
			i = new Instance(name, kv);
			instances.set(name, i);
		}
		return i;
	};
	return {
		idFromName: (name: string) => name,
		get: (name: string) => ({
			fetch: (input: string) => {
				const i = instanceFor(name);
				if (i.wedged) return new Promise<Response>(() => {});
				return i.coordinator.fetch(new Request(input));
			},
		}),
		instanceFor,
	};
}

function snapshot(kv: FakeKV): Map<string, string> {
	const out = new Map<string, string>();
	for (const key of kv.keys()) {
		const bytes = (kv as unknown as { store: Map<string, Uint8Array> }).store.get(key) as Uint8Array;
		out.set(key, Bun.hash(bytes).toString(16));
	}
	return out;
}

const failures: string[] = [];
function check(ok: boolean, what: string): void {
	console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
	if (!ok) failures.push(what);
}

// ── 1. lost alarm → kick ─────────────────────────────────────────────────────
{
	console.log("\n1. a lost alarm: the watchdog kicks, the run resumes where it was");
	const kv = new FakeKV();
	const instances = new Map<string, Instance>();
	const ns = namespace(kv, instances);
	const env = { STORE_KV: kv, IMPORT_COORDINATOR: ns } as unknown as Parameters<typeof watchdog.runImportWatchdog>[0];

	await watchdog.startNightlyImport(env);
	const a = ns.instanceFor(watchdog.LEGACY_COORDINATOR_NAME);
	await a.drive((phase) => phase === "transform");
	await a.drive((phase, n) => phase !== "transform" || n >= 2);
	const lostIn = a.phase();
	await a.storage.deleteAlarm(); // the platform never delivers it
	check((await a.storage.getAlarm()) === null, `alarm lost in phase ${lostIn}`);

	const early = await watchdog.runImportWatchdog(env, Date.now() + 60_000, 200);
	check(early.kind === "none", `a minute later the watchdog waits (${early.why})`);
	const tick = await watchdog.runImportWatchdog(env, Date.now() + watchdog.STALL_MS + 60_000, 200);
	check(tick.kind === "kick", `past STALL_MS it kicks (${tick.why})`);
	check((await a.storage.getAlarm()) !== null, "the kick re-armed the alarm");
	await a.drive();
	check(a.runState() === "done", `the same run finished (state ${a.runState()})`);
	check((await kv.get(watchdog.COORDINATOR_POINTER_KEY)) === null, "no failover: the pointer was never written");
	check(instances.size === 1, "no second coordinator was ever created");
}

// ── 2. wedge → failover → the wedged one wakes and retires ─────────────────
{
	console.log("\n2. a wedge: the watchdog fails over; the wedged coordinator later wakes and retires");
	const kv = new FakeKV();
	const instances = new Map<string, Instance>();
	const ns = namespace(kv, instances);
	const env = { STORE_KV: kv, IMPORT_COORDINATOR: ns } as unknown as Parameters<typeof watchdog.runImportWatchdog>[0];

	await watchdog.startNightlyImport(env);
	const old = ns.instanceFor(watchdog.LEGACY_COORDINATOR_NAME);
	await old.drive((phase) => phase === "bucket");
	await old.drive((phase, n) => phase !== "bucket" || n >= 1); // one bucket slice in, like 11:33:18
	const wedgedIn = old.phase();
	const oldStaging = old.stagingRows();
	old.wedged = true;
	check(wedgedIn === "bucket", `wedged in phase ${wedgedIn} with ${oldStaging} staging rows and an alarm still armed`);

	const tick = await watchdog.runImportWatchdog(env, Date.now(), 200);
	check(tick.kind === "failover", `the watchdog fails over (${tick.why.slice(0, 70)}…)`);
	const pointer = await watchdog.readPointer(kv);
	check(pointer.previous === watchdog.LEGACY_COORDINATOR_NAME && pointer.epoch > 0, `pointer → ${pointer.name}`);
	const fresh = instances.get(pointer.name);
	check(fresh !== undefined && fresh.runState() === "running", "the replacement run started");
	if (!fresh) throw new Error("no replacement instance");

	// A second tick while the replacement runs must not fail over again.
	const calm = await watchdog.runImportWatchdog(env, Date.now(), 200);
	check(calm.kind === "none", `the next tick leaves the healthy replacement alone (${calm.why.slice(0, 60)})`);

	await fresh.drive();
	check(fresh.runState() === "done", `the replacement published (state ${fresh.runState()})`);
	const published = snapshot(kv);

	// The wedge clears. Its alarm, still armed from 11:33:18, finally fires.
	old.wedged = false;
	const woke = await old.drive();
	check(old.runState() === "superseded", `the old coordinator woke and ended ${old.runState()} after ${woke} alarm(s)`);
	check(old.stagingRows() === 0, `its staging is purged (${oldStaging} rows → ${old.stagingRows()})`);
	check((await old.storage.getAlarm()) === null, "it has no alarm left");
	const after = snapshot(kv);
	const changed = [...new Set([...published.keys(), ...after.keys()])].filter((k) => published.get(k) !== after.get(k));
	check(
		changed.length === 0,
		`KV is exactly what the replacement published (${changed.length} key(s) differ${changed.length ? `: ${changed.slice(0, 3).join(", ")}` : ""})`,
	);

	// And the next nightly goes to the replacement, not the retired object.
	const nightly = await watchdog.startNightlyImport(env);
	check(nightly.status === 202 && fresh.runState() === "running", "the next nightly starts on the replacement");
	check(old.runState() === "superseded", "the retired coordinator is left alone");
}

server.stop();
if (failures.length > 0) {
	console.error(`\nFAILED: ${failures.length} check(s)`);
	process.exit(1);
}
console.log("\nOK — kick and failover both hold");
process.exit(0);
