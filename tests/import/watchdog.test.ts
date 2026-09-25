// The import watchdog (src/import-watchdog.ts): every decision it can make, and the failover's
// ordering — the pointer (the fence) is written before the new run starts, the epoch only ever
// grows, and the daily cap holds. The end-to-end version, with the real coordinator wedged
// mid-run and a real replacement run publishing, is `bun run harness:failover`.

import { describe, expect, test } from "bun:test";
import {
	COORDINATOR_POINTER_KEY,
	type CoordinatorPointer,
	type CoordinatorStatus,
	coordinatorNameAt,
	decideWatchdog,
	KICK_GRACE_MS,
	LEGACY_POINTER,
	MAX_FAILOVERS_PER_DAY,
	nextPointer,
	readPointer,
	runImportWatchdog,
	STALL_MS,
	SUSPECT_CONFIRM_MS,
	startNightlyImport,
	type WatchdogEnv,
} from "../../src/import-watchdog";

const NOW = Date.parse("2026-09-23T12:00:00Z");
const MIN = 60_000;

function status(over: Partial<CoordinatorStatus>): CoordinatorStatus {
	return {
		state: "running",
		phase: "bucket",
		lastActivityMs: NOW - MIN,
		kickedAtMs: null,
		alarmAtMs: NOW - MIN + 5_000,
		epoch: 0,
		...over,
	};
}

describe("decideWatchdog", () => {
	test("a run that made progress recently is left alone", () => {
		expect(decideWatchdog(status({ lastActivityMs: NOW - (STALL_MS - 1) }), NOW).kind).toBe("none");
	});

	test("no run in flight is left alone, whatever its age", () => {
		for (const state of ["idle", "done", "failed", "superseded"] as const) {
			expect(decideWatchdog(status({ state, lastActivityMs: NOW - 10 * 3_600_000 }), NOW).kind).toBe("none");
		}
	});

	test("a stalled run that answers is kicked first — its staged work survives a lost alarm", () => {
		const action = decideWatchdog(status({ lastActivityMs: NOW - STALL_MS }), NOW);
		expect(action.kind).toBe("kick");
		expect(action.why).toContain("phase bucket silent");
	});

	test("a stalled `starting` run is treated like a running one", () => {
		expect(decideWatchdog(status({ state: "starting", lastActivityMs: NOW - 2 * STALL_MS }), NOW).kind).toBe("kick");
	});

	test("a kick that has not had its grace yet is waited on", () => {
		const s = status({ lastActivityMs: NOW - 30 * MIN, kickedAtMs: NOW - (KICK_GRACE_MS - 1) });
		expect(decideWatchdog(s, NOW).kind).toBe("none");
	});

	test("a kick that did not bring the run back is a failover", () => {
		const s = status({ lastActivityMs: NOW - 30 * MIN, kickedAtMs: NOW - KICK_GRACE_MS });
		expect(decideWatchdog(s, NOW).kind).toBe("failover");
	});

	test("a kick OLDER than the run's last activity worked once — a new stall gets a new kick", () => {
		// Kicked at -60min, ran again until -20min, silent since: the old kick says nothing about this stall.
		const s = status({ lastActivityMs: NOW - 20 * MIN, kickedAtMs: NOW - 60 * MIN });
		expect(decideWatchdog(s, NOW).kind).toBe("kick");
	});

	test("an object that does not answer is SUSPECT on the first miss, not replaced", () => {
		expect(decideWatchdog("unresponsive", NOW).kind).toBe("suspect");
	});

	test("a second miss at the next tick is a failover — the 2026-09-23 wedge", () => {
		expect(decideWatchdog("unresponsive", NOW, NOW - 10 * MIN).kind).toBe("failover");
	});

	test("a second miss only minutes after the first (a late or duplicate tick) does not confirm", () => {
		expect(decideWatchdog("unresponsive", NOW, NOW - (SUSPECT_CONFIRM_MS - 1)).kind).toBe("none");
	});

	test("a status request that THROWS is not a wedge — asked again next tick", () => {
		expect(decideWatchdog("error", NOW).kind).toBe("none");
	});
});

describe("the pointer", () => {
	test("absent, or garbage, is the legacy singleton at epoch 0", async () => {
		const kv = new MapKV();
		expect(await readPointer(kv)).toEqual(LEGACY_POINTER);
		await kv.put(COORDINATOR_POINTER_KEY, JSON.stringify({ name: 7 }));
		expect(await readPointer(kv)).toEqual(LEGACY_POINTER);
	});

	test("a failover's epoch is strictly newer, even against a clock that ran behind", () => {
		const current: CoordinatorPointer = { name: "import-x", epoch: NOW + 5_000, failovers: [] };
		const next = nextPointer(current, NOW);
		expect(next.epoch).toBe(NOW + 5_001);
		expect(next.previous).toBe("import-x");
		expect(next.name).not.toBe("import-x");
	});

	test("the failover ledger keeps only the last 24 hours", () => {
		const current: CoordinatorPointer = { name: "a", epoch: 1, failovers: [NOW - 25 * 3_600_000, NOW - 3_600_000] };
		expect(nextPointer(current, NOW).failovers).toEqual([NOW - 3_600_000, NOW]);
	});
});

// ── runImportWatchdog against fakes ───────────────────────────────────────────

class MapKV {
	readonly values = new Map<string, string>();
	readonly puts: string[] = [];
	async get(key: string, type?: unknown): Promise<unknown> {
		const v = this.values.get(key);
		if (v === undefined) return null;
		return type === "json" ? JSON.parse(v) : v;
	}
	async put(key: string, value: string): Promise<void> {
		this.puts.push(key);
		this.values.set(key, value);
	}
}

type Handler = (path: string, url: URL) => Promise<Response>;

/** A namespace of fake coordinators, one handler per name, recording every request in order. */
function namespace(handlers: Record<string, Handler>, log: string[], kv: MapKV) {
	return {
		idFromName: (name: string) => name,
		get: (id: string) => ({
			fetch: async (input: string) => {
				const url = new URL(input);
				// What the pointer said at the moment of the request — the fence-before-start assertion.
				const pointer = kv.values.get(COORDINATOR_POINTER_KEY);
				log.push(`${id} ${url.pathname}${pointer ? ` [pointer=${JSON.parse(pointer).name}]` : ""}`);
				const handler = handlers[id] ?? handlers["*"];
				if (!handler) throw new Error(`no fake coordinator named ${id}`);
				return handler(url.pathname, url);
			},
		}),
	};
}

function envOf(kv: MapKV, ns: ReturnType<typeof namespace>): WatchdogEnv {
	return { STORE_KV: kv, IMPORT_COORDINATOR: ns } as unknown as WatchdogEnv;
}

const hang: Handler = () => new Promise<Response>(() => {});
const answers =
	(s: Partial<CoordinatorStatus>): Handler =>
	async (path) =>
		path === "/status" ? Response.json(status(s)) : Response.json({ ok: true });

/** The legacy coordinator, already marked suspect by an earlier tick. */
async function suspectLegacy(kv: MapKV, since = NOW - 10 * MIN): Promise<void> {
	await kv.put(
		COORDINATOR_POINTER_KEY,
		JSON.stringify({ name: "singleton", epoch: 0, failovers: [], suspectSince: since }),
	);
	kv.puts.length = 0;
}

describe("runImportWatchdog", () => {
	test("the first missed check only marks the coordinator suspect — no new run", async () => {
		const kv = new MapKV();
		const log: string[] = [];
		const ns = namespace({ singleton: hang }, log, kv);
		const action = await runImportWatchdog(envOf(kv, ns), NOW, 20);
		expect(action.kind).toBe("suspect");
		const pointer = await readPointer(kv);
		expect(pointer).toEqual({ name: "singleton", epoch: 0, failovers: [], suspectSince: NOW });
		expect(log).toEqual(["singleton /status"]);
	});

	test("a suspect coordinator that answers again is cleared, and nothing is replaced", async () => {
		const kv = new MapKV();
		await suspectLegacy(kv);
		const log: string[] = [];
		const ns = namespace({ singleton: answers({}) }, log, kv);
		expect((await runImportWatchdog(envOf(kv, ns), NOW, 20)).kind).toBe("none");
		const pointer = await readPointer(kv);
		expect(pointer.suspectSince).toBeUndefined();
		expect(pointer.name).toBe("singleton");
		expect(log).toEqual(["singleton /status [pointer=singleton]"]);
	});

	test("a wedged coordinator is replaced on its second miss: the pointer is written BEFORE the new run starts", async () => {
		const kv = new MapKV();
		await suspectLegacy(kv);
		const log: string[] = [];
		const ns = namespace({ singleton: hang, "*": answers({ state: "idle" }) }, log, kv);
		const action = await runImportWatchdog(envOf(kv, ns), NOW, 20);
		expect(action.kind).toBe("failover");

		const pointer = await readPointer(kv);
		expect(pointer.epoch).toBe(NOW);
		expect(pointer.previous).toBe("singleton");
		expect(pointer.failovers).toEqual([NOW]);
		expect(pointer.suspectSince).toBeUndefined();
		expect(log[0]).toBe("singleton /status [pointer=singleton]");
		// The start carries the new epoch, and the pointer already names the new coordinator.
		expect(log[1]).toBe(`${pointer.name} /start-import [pointer=${pointer.name}]`);
	});

	test("the start request names the coordinator and its epoch, so the fence can compare them", async () => {
		const kv = new MapKV();
		await suspectLegacy(kv);
		const urls: URL[] = [];
		const ns = namespace(
			{
				singleton: hang,
				"*": async (_path, url) => {
					urls.push(url);
					return Response.json({ ok: true });
				},
			},
			[],
			kv,
		);
		await runImportWatchdog(envOf(kv, ns), NOW, 20);
		const pointer = await readPointer(kv);
		expect(urls[0]?.searchParams.get("name")).toBe(pointer.name);
		expect(urls[0]?.searchParams.get("epoch")).toBe(String(pointer.epoch));
		expect(urls[0]?.searchParams.get("reason")).toBe("watchdog-failover");
	});

	test("a stalled coordinator that answers is kicked, not replaced", async () => {
		const kv = new MapKV();
		const log: string[] = [];
		const ns = namespace({ singleton: answers({ lastActivityMs: NOW - 20 * MIN }) }, log, kv);
		expect((await runImportWatchdog(envOf(kv, ns), NOW, 20)).kind).toBe("kick");
		expect(log).toEqual(["singleton /status", "singleton /kick"]);
		expect(kv.puts).toEqual([]);
	});

	test("a kick that never answers counts as a miss: suspect first, replaced at the next tick", async () => {
		const kv = new MapKV();
		const ns = namespace(
			{
				singleton: async (path) =>
					path === "/status"
						? Response.json(status({ lastActivityMs: NOW - 20 * MIN }))
						: hang(path, new URL("https://x")),
				"*": answers({ state: "idle" }),
			},
			[],
			kv,
		);
		const first = await runImportWatchdog(envOf(kv, ns), NOW, 20);
		expect(first.kind).toBe("suspect");
		expect(first.why).toContain("the kick did not answer");
		expect((await readPointer(kv)).suspectSince).toBe(NOW);
		const second = await runImportWatchdog(envOf(kv, ns), NOW + 10 * MIN, 20);
		expect(second.kind).toBe("failover");
		expect((await readPointer(kv)).previous).toBe("singleton");
	});

	test("a healthy run costs one status request and nothing else", async () => {
		const kv = new MapKV();
		const log: string[] = [];
		const ns = namespace({ singleton: answers({}) }, log, kv);
		expect((await runImportWatchdog(envOf(kv, ns), NOW, 20)).kind).toBe("none");
		expect(log).toEqual(["singleton /status"]);
		expect(kv.puts).toEqual([]);
	});

	test("the watchdog follows the pointer, not the legacy name", async () => {
		const kv = new MapKV();
		await kv.put(
			COORDINATOR_POINTER_KEY,
			JSON.stringify({ name: "import-b", epoch: NOW - MIN, failovers: [], retiring: [] }),
		);
		const log: string[] = [];
		const ns = namespace({ "import-b": answers({}) }, log, kv);
		await runImportWatchdog(envOf(kv, ns), NOW, 20);
		expect(log[0]).toStartWith("import-b /status");
	});

	test(`${MAX_FAILOVERS_PER_DAY} failovers in 24 hours is the cap — the fourth wedge is reported, not restarted`, async () => {
		const kv = new MapKV();
		const failovers = Array.from({ length: MAX_FAILOVERS_PER_DAY }, (_, i) => NOW - (i + 1) * 3_600_000);
		await kv.put(
			COORDINATOR_POINTER_KEY,
			JSON.stringify({
				name: "import-c",
				epoch: NOW - 3_600_000,
				failovers,
				suspectSince: NOW - 10 * MIN,
				retiring: [],
			}),
		);
		kv.puts.length = 0;
		const log: string[] = [];
		const ns = namespace({ "import-c": hang }, log, kv);
		const action = await runImportWatchdog(envOf(kv, ns), NOW, 20);
		expect(action.kind).toBe("none");
		expect(action.why).toContain("failover cap");
		expect(kv.puts).toEqual([]);
		expect(log).toEqual(["import-c /status [pointer=import-c]"]);
	});

	test("a designated coordinator whose start was lost is started", async () => {
		const kv = new MapKV();
		await kv.put(
			COORDINATOR_POINTER_KEY,
			JSON.stringify({ name: "import-d", epoch: NOW - 15 * MIN, failovers: [], retiring: [] }),
		);
		const log: string[] = [];
		const ns = namespace({ "import-d": answers({ state: "idle" }) }, log, kv);
		await runImportWatchdog(envOf(kv, ns), NOW, 20);
		expect(log.map((l) => l.split(" [")[0])).toEqual(["import-d /status", "import-d /start-import"]);
	});

	test("an idle LEGACY coordinator is just a quiet day — never started by the watchdog", async () => {
		const kv = new MapKV();
		const log: string[] = [];
		const ns = namespace({ singleton: answers({ state: "idle" }) }, log, kv);
		await runImportWatchdog(envOf(kv, ns), NOW, 20);
		expect(log).toEqual(["singleton /status"]);
	});

	test("the nightly starts on whichever coordinator the pointer names, with its epoch", async () => {
		const kv = new MapKV();
		await kv.put(COORDINATOR_POINTER_KEY, JSON.stringify({ name: "import-e", epoch: 1234, failovers: [] }));
		const urls: string[] = [];
		const ns = namespace(
			{
				"import-e": async (_p, url) => {
					urls.push(url.search);
					return Response.json({ ok: true });
				},
			},
			[],
			kv,
		);
		await startNightlyImport(envOf(kv, ns));
		expect(urls).toEqual(["?reason=cron&name=import-e&epoch=1234"]);
	});
});

// ── releasing the coordinators a failover replaced ───────────────────────────
// 2026-09-24's three failovers left the free account's ImportCoordinator namespace at 1.11 GB with
// every staging row purged: only deleteAll gives an object's space back, and nothing asked for it.

describe("the release sweep", () => {
	const released: Handler = async (path) =>
		path === "/release" ? Response.json({ released: true, detail: "deleted" }) : Response.json(status({}));
	const notYet: Handler = async (path) =>
		path === "/release" ? Response.json({ released: false, detail: "run in flight" }) : Response.json(status({}));

	test("a failover adds the replaced coordinator to the retiring list", () => {
		const next = nextPointer({ name: "import-a", epoch: 1, failovers: [], retiring: ["singleton"] }, NOW);
		expect(next.retiring).toEqual(["singleton", "import-a"]);
		expect(nextPointer(next, NOW + 1).retiring).toEqual(["singleton", "import-a", next.name]);
	});

	test("a pointer written before `retiring` existed derives it from previous and the ledger", async () => {
		const kv = new MapKV();
		const epochs = [NOW - 40 * MIN, NOW - 20 * MIN, NOW];
		await kv.put(
			COORDINATOR_POINTER_KEY,
			JSON.stringify({
				name: coordinatorNameAt(NOW),
				epoch: NOW,
				failovers: epochs,
				previous: coordinatorNameAt(epochs[1] as number),
			}),
		);
		expect((await readPointer(kv)).retiring?.sort()).toEqual(
			["singleton", coordinatorNameAt(epochs[0] as number), coordinatorNameAt(epochs[1] as number)].sort(),
		);
		// The legacy line (epoch 0) replaced nothing, and an explicit list is taken as written.
		await kv.put(COORDINATOR_POINTER_KEY, JSON.stringify({ name: "singleton", epoch: 0, failovers: [] }));
		expect((await readPointer(kv)).retiring).toBeUndefined();
		await kv.put(
			COORDINATOR_POINTER_KEY,
			JSON.stringify({ name: "import-z", epoch: 5, failovers: [], retiring: ["import-y", "import-z"] }),
		);
		expect((await readPointer(kv)).retiring).toEqual(["import-y"]);
	});

	test("each tick asks every retired coordinator, then keeps only the ones not yet released", async () => {
		const kv = new MapKV();
		await kv.put(
			COORDINATOR_POINTER_KEY,
			JSON.stringify({
				name: "import-c",
				epoch: NOW - MIN,
				failovers: [],
				retiring: ["singleton", "import-a", "import-b"],
			}),
		);
		kv.puts.length = 0;
		const log: string[] = [];
		const ns = namespace(
			{ singleton: released, "import-a": notYet, "import-b": hang, "import-c": answers({}) },
			log,
			kv,
		);
		await runImportWatchdog(envOf(kv, ns), NOW, 20);
		expect(log.map((l) => l.split(" [")[0]).sort()).toEqual(
			["singleton /release", "import-a /release", "import-b /release", "import-c /status"].sort(),
		);
		const pointer = await readPointer(kv);
		expect(pointer.retiring).toEqual(["import-a", "import-b"]);
		expect(pointer.name).toBe("import-c");
		expect(kv.puts).toEqual([COORDINATOR_POINTER_KEY]);
	});

	test("the release carries the pointer's epoch, and a tick that releases nothing writes nothing", async () => {
		const kv = new MapKV();
		await kv.put(
			COORDINATOR_POINTER_KEY,
			JSON.stringify({ name: "import-c", epoch: 4321, failovers: [], retiring: ["import-a"] }),
		);
		kv.puts.length = 0;
		const urls: string[] = [];
		const ns = namespace(
			{
				"import-a": async (path, url) => {
					urls.push(`${path}${url.search}`);
					return Response.json({ released: false, detail: "run in flight" });
				},
				"import-c": answers({}),
			},
			[],
			kv,
		);
		await runImportWatchdog(envOf(kv, ns), NOW, 20);
		expect(urls).toEqual(["/release?epoch=4321"]);
		expect(kv.puts).toEqual([]);
	});

	test("the current coordinator is never on the list it sweeps", async () => {
		const kv = new MapKV();
		await kv.put(
			COORDINATOR_POINTER_KEY,
			JSON.stringify({
				name: "import-c",
				epoch: NOW - MIN,
				failovers: [NOW - 2 * MIN, NOW - MIN],
				previous: "import-c",
			}),
		);
		expect((await readPointer(kv)).retiring).not.toContain("import-c");
	});
});
