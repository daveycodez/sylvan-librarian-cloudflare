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
const { MAX_DAY_ROWS_WRITTEN, MAX_RUN_ROWS_WRITTEN } = await import("../../src/import-budget");
const { PUBLISHING_KEY } = await import("../../src/engine/store-kv");
/** The coordinator's day-meter key prefix (import-coordinator.ts DAY_PREFIX). */
const DAY_PREFIX = "day:";

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
		if (this.storage.isEmpty()) return "idle";
		const row = this.storage.db.query("SELECT value FROM meta WHERE key = 'phase'").all() as { value?: string }[];
		return String(row[0]?.value ?? "idle");
	}

	/** Its storage was given back with deleteAll and nothing has been written since. */
	released(): boolean {
		return this.storage.deleteAllCalls > 0 && this.storage.isEmpty();
	}

	runState(): string {
		const row = this.storage.db.query("SELECT value FROM __harness_kv WHERE key = 'run'").all() as { value?: string }[];
		return row[0]?.value ? String((JSON.parse(row[0].value) as { state?: string }).state) : "idle";
	}

	stagingRows(): number {
		if (this.storage.isEmpty()) return 0;
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
	const published = snapshot(kv);

	// 2026-09-24: a second cron start minutes after the run published began a whole second import.
	const dup = await watchdog.startNightlyImport(env);
	const dupBody = (await dup.json()) as { skipped?: string };
	check(
		dup.status === 200 && dupBody.skipped === "duplicate-cron" && a.runState() === "done",
		"a duplicate cron start after the run finished is ignored",
	);
	check((await a.storage.getAlarm()) === null, "…and arms nothing");
	const untouched = snapshot(kv);
	check(
		[...published].every(([k, v]) => untouched.get(k) === v) && untouched.size === published.size,
		"…and KV is untouched",
	);
	check((await kv.get(watchdog.COORDINATOR_POINTER_KEY)) === null, "no failover: the pointer was never written");
	check(instances.size === 1, "no second coordinator was ever created");

	// The guard must not swallow the NEXT nightly: the same finished run, started 13 hours ago.
	const run = JSON.parse(
		(a.storage.db.query("SELECT value FROM __harness_kv WHERE key = 'run'").all() as { value: string }[])[0]?.value ??
			"{}",
	) as { startedAt?: string };
	run.startedAt = new Date(Date.now() - 13 * 3_600_000).toISOString();
	a.storage.db.run("UPDATE __harness_kv SET value = ? WHERE key = 'run'", [JSON.stringify(run)]);
	const nextDay = await watchdog.startNightlyImport(env);
	check(
		nextDay.status === 202 && a.runState() === "running" && (await a.storage.getAlarm()) !== null,
		"a cron start 13 hours after the last run began starts a new run",
	);
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

	const t0 = Date.now();
	const first = await watchdog.runImportWatchdog(env, t0, 200);
	check(
		first.kind === "suspect" && instances.size === 1,
		`the first missed check only marks it suspect (${first.why.slice(0, 60)}…)`,
	);
	const tick = await watchdog.runImportWatchdog(env, t0 + 10 * 60_000, 200);
	check(tick.kind === "failover", `the second missed check, a tick later, fails over (${tick.why.slice(0, 60)}…)`);
	const pointer = await watchdog.readPointer(kv);
	check(pointer.previous === watchdog.LEGACY_COORDINATOR_NAME && pointer.epoch > 0, `pointer → ${pointer.name}`);
	const fresh = instances.get(pointer.name);
	check(fresh !== undefined && fresh.runState() === "running", "the replacement run started");
	if (!fresh) throw new Error("no replacement instance");

	// A tick while the replacement runs must not fail over again.
	const calm = await watchdog.runImportWatchdog(env, Date.now(), 200);
	check(calm.kind === "none", `the next tick leaves the healthy replacement alone (${calm.why.slice(0, 60)})`);

	await fresh.drive();
	check(fresh.runState() === "done", `the replacement published (state ${fresh.runState()})`);
	const published = snapshot(kv);

	// The wedge clears. Its alarm, still armed from 11:33:18, finally fires.
	old.wedged = false;
	const woke = await old.drive();
	check(
		old.released(),
		`the old coordinator woke, retired and released ALL its storage after ${woke} alarm(s) (${oldStaging} staging rows before)`,
	);
	check((await old.storage.getAlarm()) === null, "it has no alarm left");
	const after = snapshot(kv);
	const changed = [...new Set([...published.keys(), ...after.keys()])].filter((k) => published.get(k) !== after.get(k));
	check(
		changed.length === 0,
		`KV is exactly what the replacement published (${changed.length} key(s) differ${changed.length ? `: ${changed.slice(0, 3).join(", ")}` : ""})`,
	);

	// A cron start now goes to the replacement — and, its run having just finished, is a duplicate.
	const nightly = await watchdog.startNightlyImport(env);
	const body = (await nightly.json()) as { skipped?: string };
	check(
		body.skipped === "duplicate-cron" && fresh.runState() === "done" && (await fresh.storage.getAlarm()) === null,
		"a cron start reaches the replacement, which ignores it as a duplicate of the run it just finished",
	);
	check(old.released(), "the retired coordinator is left alone");

	// The next tick asks the retired one to release: it already has, and nothing is written to it.
	const sweep = await watchdog.runImportWatchdog(env, Date.now(), 200);
	const swept = await watchdog.readPointer(kv);
	check(
		sweep.kind === "none" && (swept.retiring ?? []).length === 0 && old.storage.isEmpty(),
		`the watchdog's release sweep drops it from the retiring list (${JSON.stringify(swept.retiring)})`,
	);
	check(!fresh.released() && fresh.runState() === "done", "…and never touches the current coordinator");
}

// ── 3. a replaced run that wakes over budget must not touch its successor's marker ────
// 2026-09-25 (backlog x6): the fence sent a replaced run to its retire purge, but every stop
// later in the same alarm body — a run or day budget, the attempt limit, a retry run out —
// went through failRun, which deleted PUBLISHING_KEY unconditionally. By then the marker held
// the SUCCESSOR's built_at, so the old run released the new run's protection, and it ended
// `failed` with its staging stranded.
{
	console.log("\n3. a replaced run wakes with its budgets spent while its successor is publishing");
	const kv = new FakeKV();
	const instances = new Map<string, Instance>();
	const ns = namespace(kv, instances);
	const env = { STORE_KV: kv, IMPORT_COORDINATOR: ns } as unknown as Parameters<typeof watchdog.runImportWatchdog>[0];

	await watchdog.startNightlyImport(env);
	const old = ns.instanceFor(watchdog.LEGACY_COORDINATOR_NAME);
	await old.drive((phase) => phase === "bucket");
	await old.drive((phase, n) => phase !== "bucket" || n >= 1);
	const oldStaging = old.stagingRows();
	old.wedged = true;
	const t0 = Date.now();
	await watchdog.runImportWatchdog(env, t0, 200);
	await watchdog.runImportWatchdog(env, t0 + 10 * 60_000, 200);
	const pointer = await watchdog.readPointer(kv);
	const fresh = instances.get(pointer.name);
	if (!fresh) throw new Error("no replacement instance");
	// The replacement marks its family in flight at routing; stop it mid-run, publishing.
	await fresh.drive((phase) => phase === "bucket");
	const marker = await kv.get(PUBLISHING_KEY);
	check(marker !== null, `the replacement holds the publishing marker (${marker})`);

	// The old run wakes with BOTH budgets spent — its run's and the day's. Before the fix it failed
	// on the first, releasing the successor's marker and stranding its staging.
	const meters = JSON.parse(
		(old.storage.db.query("SELECT value FROM meta WHERE key = 'run_meters'").all() as { value: string }[])[0]?.value ??
			"{}",
	) as Record<string, number>;
	meters.rows_written = MAX_RUN_ROWS_WRITTEN + 1;
	old.storage.db.run("UPDATE meta SET value = ? WHERE key = 'run_meters'", [JSON.stringify(meters)]);
	const dayKey = `${DAY_PREFIX}${new Date().toISOString().slice(0, 10)}:written`;
	old.storage.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [
		dayKey,
		String(MAX_DAY_ROWS_WRITTEN + 1),
	]);
	old.wedged = false;
	await old.drive((_phase, n) => n >= 1);
	const next = await old.storage.getAlarm();
	const now = new Date();
	const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
	check((await kv.get(PUBLISHING_KEY)) === marker, "the old run left the successor's publishing marker alone");
	check(
		old.runState() === "running" && old.phase() === "purge_staging",
		`it did not fail; it is retiring (state ${old.runState()}, phase ${old.phase()})`,
	);
	check(
		next !== null && next >= tomorrow,
		`over the day budget its purge waits for the next UTC day (alarm ${next === null ? "none" : new Date(next).toISOString()})`,
	);

	// Tomorrow: the day's meter resets. The spent RUN budget does not stop a retire purge.
	old.storage.db.run("DELETE FROM meta WHERE key = ?", [dayKey]);
	await old.drive();
	check(old.released(), `it ends released, not failed (${oldStaging} staging rows before)`);
	check((await kv.get(PUBLISHING_KEY)) === marker, "…and the marker is still the successor's");

	await fresh.drive();
	check(fresh.runState() === "done", `the replacement published (state ${fresh.runState()})`);
}

// ── 4. coordinators replaced before `retiring` existed give their storage back ──────────
// 2026-09-25: 09-24's three failovers left the free account's ImportCoordinator namespace at 1.11 GB
// — every replaced run had purged its staging rows, and the space stayed with the object. The
// pointer they were replaced under has no `retiring` list; the watchdog derives one from it.
{
	console.log("\n4. replaced coordinators from before the release sweep: the watchdog releases them");
	const kv = new FakeKV();
	const instances = new Map<string, Instance>();
	const ns = namespace(kv, instances);
	const env = { STORE_KV: kv, IMPORT_COORDINATOR: ns } as unknown as Parameters<typeof watchdog.runImportWatchdog>[0];
	const t = Date.now();
	const epochs = [t - 40 * 60_000, t - 20 * 60_000, t];
	const [nameA, nameB, nameC] = epochs.map(watchdog.coordinatorNameAt) as [string, string, string];

	const started = async (name: string, epoch: number): Promise<Instance> => {
		const i = ns.instanceFor(name);
		const params = new URLSearchParams({ reason: "harness", name, epoch: String(epoch) });
		await i.coordinator.fetch(new Request(`https://coordinator/start-import?${params}`));
		await i.drive((phase) => phase === "bucket");
		await i.drive((phase, n) => phase !== "bucket" || n >= 1);
		return i;
	};
	// What the pre-fix code left: the retire purge ran, the run ended `superseded`, the pages stayed.
	const retiredTheOldWay = async (i: Instance): Promise<void> => {
		for (const table of STAGING_TABLES) i.storage.db.run(`DELETE FROM ${table}`);
		const run = JSON.parse(
			(i.storage.db.query("SELECT value FROM __harness_kv WHERE key = 'run'").all() as { value: string }[])[0]?.value ??
				"{}",
		) as Record<string, unknown>;
		i.storage.db.run("UPDATE __harness_kv SET value = ? WHERE key = 'run'", [
			JSON.stringify({ ...run, state: "superseded" }),
		]);
		i.storage.db.run("UPDATE meta SET value = 'idle' WHERE key = 'phase'");
		await i.storage.deleteAlarm();
	};

	const singleton = await started(watchdog.LEGACY_COORDINATOR_NAME, 0);
	await retiredTheOldWay(singleton);
	const a = await started(nameA, epochs[0] as number);
	await retiredTheOldWay(a);
	// B is still mid-run, and its alarm was lost: it has to retire before it can release.
	const b = await started(nameB, epochs[1] as number);
	await b.storage.deleteAlarm();
	const c = await started(nameC, epochs[2] as number);
	const held = singleton.storage.sql.databaseSize + a.storage.sql.databaseSize;
	check(
		singleton.stagingRows() === 0 && a.stagingRows() === 0 && held > 1_000_000,
		`two retired coordinators hold ${(held / 1048576).toFixed(1)}MB with no staging rows at all`,
	);
	await kv.put(
		watchdog.COORDINATOR_POINTER_KEY,
		JSON.stringify({ name: nameC, epoch: epochs[2], failovers: epochs, previous: nameB }),
	);
	check(
		JSON.stringify((await watchdog.readPointer(kv)).retiring?.slice().sort()) ===
			JSON.stringify([watchdog.LEGACY_COORDINATOR_NAME, nameA, nameB].sort()),
		"a pointer without `retiring` derives it: the singleton, previous, and the ledger's older names",
	);

	const cAlarm = await c.storage.getAlarm();
	await watchdog.runImportWatchdog(env, Date.now(), 200);
	check(singleton.released() && a.released(), "one tick releases both retired coordinators' storage");
	check(!b.released() && (await b.storage.getAlarm()) !== null, "the one still mid-run gets an alarm, not a deleteAll");
	check(
		JSON.stringify((await watchdog.readPointer(kv)).retiring) === JSON.stringify([nameB]),
		"the pointer keeps only the name still to release",
	);
	check(!c.released() && (await c.storage.getAlarm()) === cAlarm, "the current coordinator is untouched");

	await b.drive();
	check(b.released(), "the mid-run one retires on its alarm and releases itself");
	await watchdog.runImportWatchdog(env, Date.now(), 200);
	check(
		JSON.stringify((await watchdog.readPointer(kv)).retiring) === "[]",
		"the next tick finds nothing left to release",
	);

	// A name the watchdog asks about may never have been created: asking writes nothing.
	const ghost = ns.instanceFor("import-never-created");
	const reply = (await (
		await ghost.coordinator.fetch(new Request(`https://coordinator/release?epoch=${epochs[2]}`))
	).json()) as { released?: boolean };
	check(
		reply.released === true && ghost.storage.isEmpty() && ghost.storage.deleteAllCalls === 0,
		"a never-created name answers released and stores nothing",
	);
	// And the current coordinator refuses, whatever it is asked.
	const refused = (await (
		await c.coordinator.fetch(new Request(`https://coordinator/release?epoch=${epochs[2]}`))
	).json()) as { released?: boolean };
	check(refused.released === false && !c.released(), "the current coordinator refuses to release");
}

server.stop();
if (failures.length > 0) {
	console.error(`\nFAILED: ${failures.length} check(s)`);
	process.exit(1);
}
console.log("\nOK — kick, failover and release all hold");
process.exit(0);
