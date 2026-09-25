// The import watchdog, end to end, on this machine: the REAL coordinator wedged mid-run, the REAL
// watchdog replacing it, a REAL replacement run publishing, and then the wedged one waking up.
//
//   bun run harness:failover
//
// Seven scenarios, each on its own KV namespace (5-7 are backlog x3's, at the bottom):
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
//   3-4. A replaced run waking over budget; replaced coordinators releasing their storage.
//
//   5-7. NEVER MORE THAN THREE GENERATIONS (x3), each watching every KV write: a wedge mid-publish
//      whose run wakes past its top-of-alarm check (the write-time fence stops it); a deploy landing
//      mid-nightly (the deploy wins); and the byte guard dropping the rollback, then refusing.
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
	"corpus_blobs",
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
	// The day's meters are one row, "read,written" (ImportCoordinator.dayMeters).
	const dayKey = `${DAY_PREFIX}${new Date().toISOString().slice(0, 10)}`;
	old.storage.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [
		dayKey,
		`0,${MAX_DAY_ROWS_WRITTEN + 1}`,
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

// ── x3: never more than three store generations in KV ─────────────────────────
// Retention by role (src/engine/kv-retention.ts): the live family, the family it replaced, and the
// one upload-lease holder's. Every scenario below watches EVERY KV write and fails if a fourth
// generation is ever present, and starts from a namespace holding two real generations (live and
// rollback), so the third is always the one under test.

const retention = await import("../../src/engine/kv-retention");
const storeKv = await import("../../src/engine/store-kv");
const deployUpload = await import("../deploy-upload");
type StoreManifest = import("../../src/engine/types").StoreManifest;
type DeployKv = import("../deploy-upload").DeployKv;

/** Fail on any write after which KV holds more than three generations; remember the most seen. */
function watchGenerations(kv: FakeKV): { max: () => number; violations: string[] } {
	let max = 0;
	const violations: string[] = [];
	kv.onWrite = (key, op) => {
		const n = retention.generationsPresent(kv.keys(retention.GENERATION_KEY_PREFIX)).length;
		max = Math.max(max, n);
		if (n > 3) violations.push(`${op} ${key}: ${n} generations`);
	};
	return { max: () => max, violations };
}

async function manifestOf(kv: FakeKV): Promise<StoreManifest> {
	return JSON.parse(String(await kv.get(storeKv.MANIFEST_KEY, "text"))) as StoreManifest;
}

function generations(kv: FakeKV): string[] {
	return retention.generationsPresent(kv.keys(retention.GENERATION_KEY_PREFIX));
}

function keysOf(kv: FakeKV, builtAt: string): string[] {
	return kv.keys(retention.GENERATION_KEY_PREFIX).filter((k) => retention.generationOfKey(k) === builtAt);
}

function metaOf(i: Instance, key: string): string | null {
	const row = i.storage.db.query("SELECT value FROM meta WHERE key = ?").all(key) as { value?: string }[];
	return row[0]?.value === undefined ? null : String(row[0].value);
}

/** Move a finished run's start 13 hours back, so the next cron start is a new day and not a duplicate. */
function backdateRun(i: Instance): void {
	const row = i.storage.db.query("SELECT value FROM __harness_kv WHERE key = 'run'").all() as { value: string }[];
	const run = JSON.parse(row[0]?.value ?? "{}") as { startedAt?: string };
	run.startedAt = new Date(Date.now() - 13 * 3_600_000).toISOString();
	i.storage.db.run("UPDATE __harness_kv SET value = ? WHERE key = 'run'", [JSON.stringify(run)]);
}

function runDetail(i: Instance): string {
	const row = i.storage.db.query("SELECT value FROM __harness_kv WHERE key = 'run'").all() as { value?: string }[];
	return row[0]?.value ? String((JSON.parse(row[0].value) as { detail?: string }).detail ?? "") : "";
}

/** Two nightly runs on the legacy coordinator: the second live, the first its rollback. */
async function seedTwoGenerations(
	kv: FakeKV,
	ns: ReturnType<typeof namespace>,
	env: Parameters<typeof watchdog.runImportWatchdog>[0],
): Promise<{ g1: string; g2: string; a: Instance }> {
	await watchdog.startNightlyImport(env);
	const a = ns.instanceFor(watchdog.LEGACY_COORDINATOR_NAME);
	await a.drive();
	const g1 = String((await manifestOf(kv)).built_at);
	backdateRun(a);
	await Bun.sleep(1_100); // built_at is in seconds: the next run's must differ
	await watchdog.startNightlyImport(env);
	await a.drive();
	const live = await manifestOf(kv);
	const g2 = String(live.built_at);
	check(
		g2 !== g1 && live.previous_built_at === g1 && generations(kv).join() === [g2, g1].join(),
		`seeded: live ${g2}, its manifest names ${live.previous_built_at} as the rollback, and KV holds exactly those two`,
	);
	backdateRun(a);
	await Bun.sleep(1_100);
	return { g1, g2, a };
}

/** The deploy side (scripts/deploy-upload.ts) over the harness KV, with a clock its waits advance. */
function fakeDeployKv(kv: FakeKV, clock = { offset: 0 }): DeployKv {
	return {
		get: async (key) => ({ value: (await kv.get(key, "text")) as string | null, failed: null }),
		put: (key, value, opts) =>
			kv.put(key, value, opts?.metadata !== undefined ? { metadata: opts.metadata } : undefined),
		list: async (prefix) => (await kv.list({ prefix })).keys,
		deleteKeys: async (keys) => {
			for (const key of keys) await kv.delete(key);
			return true;
		},
		sleep: async (ms) => {
			clock.offset += ms;
		},
		now: () => Date.now() + clock.offset,
	};
}

/**
 * A deploy publishing a store: scripts/import-store.sh's fence, then seed-remote-kv.ts's sequence
 * through the REAL deploy-upload functions — begin (fence settle, lease, sweep, guard), the family's
 * keys, the lease check, the manifest, finish. The family is the live one's bytes under a new
 * built_at, so the result is a servable store.
 */
async function deployPublish(kv: FakeKV, builtAt: string): Promise<StoreManifest> {
	const live = await manifestOf(kv);
	const from = String(live.built_at);
	const rename = (k: string) => k.replace(`-${from}`, `-${builtAt}`);
	const family = keysOf(kv, from);
	const values = new Map<string, Uint8Array>();
	for (const k of family) values.set(k, new Uint8Array((await kv.get(k, "arrayBuffer")) as ArrayBuffer));
	const incomingBytes = [...values.values()].reduce((n, v) => n + v.byteLength, 0);
	const dkv = fakeDeployKv(kv);
	await deployUpload.writeDeployFence(dkv);
	const begun = await deployUpload.beginDeployUpload(dkv, { builtAt, incomingBytes });
	if (!begun.ok) throw new Error(`deploy refused: ${begun.why}`);
	for (const [k, v] of values) await kv.put(rename(k), v, { metadata: retention.kvBytesMetadata(v.byteLength) });
	if (!(await deployUpload.deployStillHoldsLease(dkv, builtAt))) throw new Error("deploy lost its lease");
	const next: StoreManifest = {
		...live,
		built_at: builtAt,
		store_key: rename(live.store_key),
		partitions: live.partitions?.map((p) => ({ ...p, store_key: rename(p.store_key) })),
	};
	const published = retention.withPreviousBuiltAt(next, live);
	await kv.put(storeKv.MANIFEST_KEY, JSON.stringify(published));
	await deployUpload.finishDeployUpload(dkv, published);
	return published;
}

// ── 5. a wedge mid-publish: the replacement publishes, the old run wakes past its top check ──
{
	console.log("\n5. x3: a run wedges mid-publish, is failed over, and wakes past its top-of-alarm check");
	const kv = new FakeKV();
	const instances = new Map<string, Instance>();
	const ns = namespace(kv, instances);
	const env = { STORE_KV: kv, IMPORT_COORDINATOR: ns } as unknown as Parameters<typeof watchdog.runImportWatchdog>[0];
	const watch = watchGenerations(kv);
	const { g1, g2, a: old } = await seedTwoGenerations(kv, ns, env);

	await watchdog.startNightlyImport(env);
	await old.drive((phase) => phase === "publish");
	await old.drive((_phase, n) => n >= 1); // partition 0's chunk goes up
	await old.drive((phase) => phase !== "publish"); // partition 0 completes
	await old.drive((phase) => phase === "publish"); // …and it stops short of partition 1's chunk
	const g3 = String(metaOf(old, "built_at"));
	const oldKeys = keysOf(kv, g3);
	check(
		old.phase() === "publish" &&
			oldKeys.some((k) => k.includes("-p0.store:")) &&
			!oldKeys.some((k) => k.includes("-p1.")),
		`the old run (build ${g3}) wedges with ${oldKeys.length} key(s) of its family uploaded, about to put partition 1`,
	);
	old.wedged = true;
	const t0 = Date.now();
	await watchdog.runImportWatchdog(env, t0, 200);
	const failover = await watchdog.runImportWatchdog(env, t0 + 10 * 60_000, 200);
	check(failover.kind === "failover", "the watchdog fails over");
	const fresh = instances.get((await watchdog.readPointer(kv)).name);
	if (!fresh) throw new Error("no replacement instance");
	await fresh.drive();
	const g4 = String((await manifestOf(kv)).built_at);
	check(fresh.runState() === "done" && g4 !== g3, `the replacement published build ${g4}`);
	check(keysOf(kv, g3).length === 0, "the old run's orphan family was retired before the replacement's first key");
	const live = await manifestOf(kv);
	check(
		live.previous_built_at === g2 && generations(kv).join() === [g4, g2].join() && keysOf(kv, g1).length === 0,
		`KV holds live ${g4} and rollback ${g2}; ${g1} (the old rollback) is gone`,
	);
	const published = snapshot(kv);

	// The wedge clears. Its top-of-alarm read of the pointer is STALE (KV is eventually consistent),
	// so the run gets past it and goes to put partition 1 — the write-time fence must stop it.
	old.wedged = false;
	kv.staleGets.set(watchdog.COORDINATOR_POINTER_KEY, [null]);
	const putsBefore = kv.puts.length;
	await old.drive();
	check(
		(kv.staleGets.get(watchdog.COORDINATOR_POINTER_KEY) ?? []).length === 0,
		"its top-of-alarm check read the stale pointer and passed",
	);
	check(
		kv.puts.slice(putsBefore).every((k) => retention.generationOfKey(k) !== g3) && keysOf(kv, g3).length === 0,
		"the write-time fence stopped its next put: nothing of its family came back",
	);
	check(old.released(), "it retired and released its storage");
	const after = snapshot(kv);
	const changed = [...new Set([...published.keys(), ...after.keys()])].filter((k) => published.get(k) !== after.get(k));
	check(changed.length === 0, `KV is exactly what the replacement published (${changed.length} key(s) differ)`);
	check(
		watch.violations.length === 0 && watch.max() <= 3,
		`never more than three generations at any write (max ${watch.max()}${watch.violations.length ? `; ${watch.violations[0]}` : ""})`,
	);
}

// ── 6. a deploy lands mid-nightly: the deploy wins ─────────────────────────────
{
	console.log("\n6. x3: a deploy fences a nightly that is mid-upload, and the deploy wins");
	const kv = new FakeKV();
	const instances = new Map<string, Instance>();
	const ns = namespace(kv, instances);
	const env = { STORE_KV: kv, IMPORT_COORDINATOR: ns } as unknown as Parameters<typeof watchdog.runImportWatchdog>[0];
	const watch = watchGenerations(kv);
	const { g1, g2, a } = await seedTwoGenerations(kv, ns, env);

	await watchdog.startNightlyImport(env);
	await a.drive((phase) => phase === "publish");
	await a.drive((_phase, n) => n >= 1);
	const g3 = String(metaOf(a, "built_at"));
	check(
		keysOf(kv, g3).length >= 2 && retention.parseUploadLease(String(await kv.get(PUBLISHING_KEY)))?.built_at === g3,
		`the nightly (build ${g3}) holds the upload lease with ${keysOf(kv, g3).length} key(s) up`,
	);

	await Bun.sleep(1_100);
	const d = String(Math.floor(Date.now() / 1000));
	const deployed = await deployPublish(kv, d);
	check(keysOf(kv, g3).length === 0, "the deploy retired the nightly's half-uploaded family before its own first key");
	check(
		deployed.previous_built_at === g2 && generations(kv).join() === [d, g2].join() && keysOf(kv, g1).length === 0,
		`the deploy's store ${d} is live, ${g2} is its rollback, ${g1} is gone`,
	);
	check((await kv.get(PUBLISHING_KEY)) === null, "the deploy released its lease");
	const published = snapshot(kv);

	await a.drive();
	check(
		a.runState() === "superseded" && !a.released(),
		`the nightly retired at its next alarm (state ${a.runState()}) and keeps its storage for tomorrow's run`,
	);
	const after = snapshot(kv);
	const changed = [...new Set([...published.keys(), ...after.keys()])].filter((k) => published.get(k) !== after.get(k));
	check(changed.length === 0, `…and wrote nothing: KV is what the deploy published (${changed.length} key(s) differ)`);

	// A run that starts AFTER the fence is not retired by it — and waits while a deploy holds the lease.
	const fence = retention.parseDeployFence(await kv.get(retention.DEPLOY_FENCE_KEY, "json"));
	await kv.put(
		PUBLISHING_KEY,
		retention.encodeUploadLease({ built_at: "999", owner: retention.DEPLOY_LEASE_OWNER, epoch: fence?.at ?? 0 }),
	);
	await watchdog.startNightlyImport(env);
	await a.drive((phase) => phase === "routing");
	const due = Date.now();
	await a.drive((_phase, n) => n >= 1);
	const next = await a.storage.getAlarm();
	const g5 = String(metaOf(a, "built_at"));
	check(
		a.phase() === "routing" && next !== null && next >= due + 4 * 60_000 && keysOf(kv, g5).length === 0,
		`a later run meeting a deploy's lease waits (${next === null ? "no alarm" : `${Math.round((next - due) / 60_000)}min`}) and uploads nothing`,
	);
	await kv.delete(PUBLISHING_KEY);
	await a.drive();
	const live = await manifestOf(kv);
	check(
		a.runState() === "done" && String(live.built_at) === g5 && live.previous_built_at === d,
		`once the lease is free it publishes ${g5}, with the deploy's ${d} as its rollback`,
	);
	check(generations(kv).join() === [g5, d].join(), `KV ends holding ${g5} and ${d}`);
	check(
		watch.violations.length === 0 && watch.max() <= 3,
		`never more than three generations at any write (max ${watch.max()}${watch.violations.length ? `; ${watch.violations[0]}` : ""})`,
	);
}

// ── 7. the byte guard: drop the rollback, or refuse ─────────────────────────────
{
	console.log("\n7. x3: the byte guard drops the rollback generation near the cap, and refuses over it");
	const kv = new FakeKV();
	const instances = new Map<string, Instance>();
	const ns = namespace(kv, instances);
	const env = { STORE_KV: kv, IMPORT_COORDINATOR: ns } as unknown as Parameters<typeof watchdog.runImportWatchdog>[0];
	const watch = watchGenerations(kv);
	const { g1, g2, a } = await seedTwoGenerations(kv, ns, env);

	// The harness corpus is a few MB, so the rest of a namespace near the cap is one filler key whose
	// metadata says what a list would — exactly what the guard reads.
	const FILLER = "x3:filler";
	const live = await manifestOf(kv);
	const known = retention.manifestChunkSizes(live);
	const sum = (keys: { name: string; metadata?: unknown }[]) =>
		keys.reduce((n, k) => n + retention.listedKeyBytes(k, known).bytes, 0);
	const all = (await kv.list()).keys;
	const used = sum(all);
	const rollbackBytes = sum(all.filter((k) => retention.generationOfKey(k.name) === g1));
	const incoming = Math.ceil((live.store_gzip_bytes ?? 0) * retention.NEW_FAMILY_ALLOWANCE);
	// Over the guard with the rollback, under it without: the rollback has to go.
	await kv.put(FILLER, "x", {
		metadata: retention.kvBytesMetadata(retention.KV_GUARD_BYTES - used - incoming + Math.floor(rollbackBytes / 2)),
	});
	let firstKeyGenerations: string[] | null = null;
	const watching = kv.onWrite;
	kv.onWrite = (key, op) => {
		watching?.(key, op);
		const at = retention.generationOfKey(key);
		if (op === "put" && at && at !== g1 && at !== g2 && firstKeyGenerations === null) {
			firstKeyGenerations = generations(kv).filter((g) => g !== at);
		}
	};
	await watchdog.startNightlyImport(env);
	await a.drive();
	const g3 = String((await manifestOf(kv)).built_at);
	check(
		JSON.stringify(firstKeyGenerations) === JSON.stringify([g2]),
		`near the cap, the rollback ${g1} was dropped BEFORE build ${g3}'s first key (present then: ${JSON.stringify(firstKeyGenerations)})`,
	);
	check(
		a.runState() === "done" &&
			(await manifestOf(kv)).previous_built_at === g2 &&
			generations(kv).join() === [g3, g2].join(),
		`the run published ${g3}; ${g2} is its rollback`,
	);

	// Over the guard even without the rollback: the run refuses before its family's first key.
	await kv.put(FILLER, "x", { metadata: retention.kvBytesMetadata(retention.KV_GUARD_BYTES) });
	backdateRun(a);
	await Bun.sleep(1_100);
	await watchdog.startNightlyImport(env);
	await a.drive();
	const refused = String(metaOf(a, "built_at"));
	check(
		a.runState() === "failed" && runDetail(a).includes("byte guard"),
		`over the cap the run fails with the guard's reason (${runDetail(a).slice(0, 80)}…)`,
	);
	check(
		keysOf(kv, refused).length === 0 && String((await manifestOf(kv)).built_at) === g3,
		`nothing of build ${refused} was uploaded, and ${g3} is still live`,
	);
	check((await kv.get(PUBLISHING_KEY)) === null, "the refused run released its lease");

	// The deploy's guard: same decision, same refusal, before its first key.
	const dkv = fakeDeployKv(kv);
	const deployKeysBefore = kv.keys().length;
	const begun = await deployUpload.beginDeployUpload(dkv, { builtAt: "4102444800", incomingBytes: 50_000_000 });
	check(
		!begun.ok && (await kv.get(PUBLISHING_KEY)) === null && generations(kv).join() === [g3, g2].join(),
		`the deploy refuses too, releases its lease and deletes nothing (${kv.keys().length - deployKeysBefore} key(s) added: the fence)`,
	);
	check(
		watch.violations.length === 0 && watch.max() <= 3,
		`never more than three generations at any write (max ${watch.max()}${watch.violations.length ? `; ${watch.violations[0]}` : ""})`,
	);
}

server.stop();
if (failures.length > 0) {
	console.error(`\nFAILED: ${failures.length} check(s)`);
	process.exit(1);
}
console.log("\nOK — kick, failover and release all hold");
process.exit(0);
