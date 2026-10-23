// x100: SELF-HEALING ENGINE PLACEMENT — the nightly's automatic version of ABANDONED_ENGINES.
//
// A Durable Object is placed once, near whoever first addresses it, and never moves; the only
// remedy for one that landed badly is a new name (an EPOCH, engine-namespace.ts). Until this, that
// took a hand-written entry and a deploy. Now the nightly judges every announced object on evidence
// the objects already keep, and gives a name a new epoch by writing it into the manifest's
// placement block — read by every stub builder, pushed to every object at notify — with no deploy.
//
// THE EVIDENCE, all of it already recorded or one row away (engine-health.ts):
//
//   colo     each object's self-reported colo (placement.ts, refreshed at most every 20h). Compared
//            with its REPLICA's home colo: the colo minimising the summed distance to all of the
//            replica's objects (a medoid, so a host always exists there). A gather calls every
//            sibling twice, so one object in another colo puts its round trip on every gather the
//            replica coordinates — DeckGen's engine-wnam-p11 in DFW is 2,700km from the eleven
//            other wnam objects in SEA; its apac p10/p11 sit in SIN, 4,600km from ten in ICN.
//   hedges   how often the replica's gathers had to route around a partition: the hedges each
//            coordinator WON against that sibling (sibling-hedge.ts), summed over the replica.
//   loads    how often the object loaded a store — a reload storm under traffic its siblings stay
//            resident under (DeckGen's engine-wnam-p8-e1, every 15–40s on 2026-10-23).
//
// Not used: the warm RPC floor. It is measured by the CALLING isolate per region, kept in memory
// and lost at eviction, and per object it adds nothing the colo does not already say (the floor
// is geography plus payload) — a held call is what the hedges count.
//
// THE RULES (judgeEngines):
//
//   MISPLACED  colo more than MISPLACED_KM from the replica's home, measured within COLO_FRESH_MS,
//              in a replica of at least MIN_GROUP_REPORTS reporting objects whose home holds at
//              least HOME_MIN_SHARE of them. ONE night is enough: a colo is the fact of an object's
//              creation (Cloudflare: objects "do not currently change locations after they are
//              created"), not a bad minute, and the probe that measured it is the object's own.
//   SICK       hedges around it >= max(SICK_HEDGES_MIN, SICK_HEDGES_FACTOR x the replica's median),
//              or loads >= max(SICK_LOADS_MIN, SICK_LOADS_FACTOR x the replica's median), over
//              yesterday's UTC day, on SICK_NIGHTS consecutive nights. A coordinator has stalled for
//              hours and recovered untouched (wnam p9 on 09-29, p1 on 10-02); two whole days have not.
//
// THE LIMITS:
//
//   - at most MAX_MOVES_PER_NIGHT moves a night per account, at most one per replica;
//   - never the same name twice within MOVE_COOLDOWN_MS — a replacement that lands no better is
//     judged again only after it;
//   - after MAX_AUTO_MOVES automatic moves of a name, or at MAX_ENGINE_EPOCH, the nightly GIVES UP
//     on it: logged every night it is still flagged, never moved again until a pin says "auto";
//   - no region is dropped or merged: a move re-creates one object of its own region.
//
// WHERE THE REPLACEMENT LANDS. Wherever its first caller is. The publish fan-out therefore SEEDS it
// (import-coordinator stepNotify -> SearchEngine.seedSibling): a host — a sibling in the replica's
// home colo — makes the first call, with no hint (engine-namespace.ts seedSiblingStub), so the new
// object is created next to the host and loads its partition at night rather than in front of a
// user. Nothing guarantees the colo; the next night's report says where it went.
//
// THE COST of one move, against the free plan: 2 KV reads (the manifest, the partition's ~14MB
// chunk) of 100,000/day, 1 KV write (its announcement) and later 1 delete (the old one's) of
// 1,000/day each, ~17 Durable Object rows written of 100,000/day, ~20MB of DO storage until the old
// object is released (ABANDONED_RELEASE_AFTER_MS past `since`, unused for ABANDONED_QUIET_MS). At
// MAX_MOVES_PER_NIGHT that is 6 reads, 3 writes and ~51 rows a night. The judging itself costs one
// placementReport call per announced object (24 on the free account, ~100 on DeckGen; rows read,
// none written), one KV list and one KV read (the pins) a night.
//
// UNDO, by hand, with no deploy: put PLACEMENT_PINS_KV_KEY in the store namespace —
//
//   bunx wrangler kv key put --namespace-id <id> --remote placement:pins '{"engine-wnam-p11": 0}'
//
// — and the next nightly writes epoch 0 for that name and holds it (`stop: "pinned"`) for as long
// as the key names it; the move's replacement is then the object nothing addresses, and a later
// publish releases it (supersededEngine: an undone move's replacement). `"auto"` instead of a
// number clears a pin or a give-up and lets the nightly judge the name again; deleting the name
// from the key unpins it at its current epoch. ABANDONED_ENGINES still works as before, for a move
// that cannot wait for a night.

import { COLOS } from "./colos.gen";
import type { EngineReport } from "./engine-health";
import { engineName, MAX_ENGINE_EPOCH, parseEngineName, replicaGroupOf } from "./engine-namespace";
import type { EngineMoveRecord } from "./placement-policy";

/** A colo this far from its replica's home is misplaced. ~10ms of round trip, paid twice per gather. */
export const MISPLACED_KM = 1000;
/** The home colo must hold at least this share of the replica's reporting objects to judge colos. */
export const HOME_MIN_SHARE = 0.4;
/** Fewer reporting objects than this and a replica's home is not judged at all. */
export const MIN_GROUP_REPORTS = 4;
/** A colo measured longer ago than this is not evidence (placement.ts re-measures every ~20h). */
export const COLO_FRESH_MS = 48 * 60 * 60 * 1000;
/** Hedges around one partition in a day, at least, to count as sick… */
export const SICK_HEDGES_MIN = 50;
/** …and at least this many times the replica's median partition. */
export const SICK_HEDGES_FACTOR = 5;
/** Store loads in a day, at least, to count as a reload storm… */
export const SICK_LOADS_MIN = 1500;
/** …and at least this many times the replica's median object. */
export const SICK_LOADS_FACTOR = 4;
/** Consecutive nights the health rule must flag a name before it moves. */
export const SICK_NIGHTS = 2;
/** A strike older than this does not continue a run: a night was skipped (a failed nightly). */
export const STRIKE_GAP_MS = 36 * 60 * 60 * 1000;
/** Moves per night per account, at most. */
export const MAX_MOVES_PER_NIGHT = 3;
/** A name is not moved again within this long of its last automatic move. */
export const MOVE_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
/** Automatic moves of one name before the nightly gives up on it. */
export const MAX_AUTO_MOVES = 3;
/** The hand-written pins (see UNDO above): `{ "<epoch-0 name>": <epoch> | "auto" }`. */
export const PLACEMENT_PINS_KV_KEY = "placement:pins";

/** A move the nightly decided: write `epoch` for `name0`, and seed `to` from `host`. */
export interface EngineMove {
	name0: string;
	/** The object the name resolved to before tonight. */
	from: string;
	/** The object it resolves to from tonight's manifest. */
	to: string;
	epoch: number;
	/** A sibling in the replica's home colo to make the first call, or null (no colo evidence). */
	host: string | null;
	why: string;
}

export interface JudgeResult {
	/** Tonight's `placement.engines`, or undefined when no name has a record. */
	engines: Record<string, EngineMoveRecord> | undefined;
	moves: EngineMove[];
	/** One line per decision (moved / kept / gave up / pinned), then a summary. */
	lines: string[];
}

export interface JudgeInput {
	/** Last night's `placement.engines`. */
	previous: Record<string, EngineMoveRecord> | undefined;
	/** Tonight's reports from every announced object that answered. */
	reports: readonly EngineReport[];
	/** The object an epoch-0 name resolves to under LAST NIGHT's placement (the list and the floors). */
	currentNameOf(name0: string): string;
	/** Whether an epoch-0 name is served tonight at all: a routable region's current generation, p < N. */
	served(name0: string): boolean;
	/** PLACEMENT_PINS_KV_KEY's value, parsed (anything else is ignored). */
	pins: unknown;
	nowMs: number;
	/** Colo coordinates; defaults to the generated table. */
	coordsOf?: (colo: string) => readonly [number, number] | undefined;
}

const defaultCoords = (colo: string): readonly [number, number] | undefined => {
	const c = COLOS[colo];
	return c ? [c[0], c[1]] : undefined;
};

/** Great-circle distance between two colos in km, or undefined for a colo the table does not know. */
export function coloKm(
	a: string,
	b: string,
	coordsOf: (colo: string) => readonly [number, number] | undefined = defaultCoords,
): number | undefined {
	if (a === b) return coordsOf(a) ? 0 : undefined;
	const p = coordsOf(a);
	const q = coordsOf(b);
	if (!p || !q) return undefined;
	const rad = Math.PI / 180;
	const dLat = (q[0] - p[0]) * rad;
	const dLon = (q[1] - p[1]) * rad;
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(p[0] * rad) * Math.cos(q[0] * rad) * Math.sin(dLon / 2) ** 2;
	return Math.round(2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h))));
}

function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[mid] as number)
		: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** The home colo of a set of colos: the medoid (least summed distance), ties to the larger count, then by name. */
export function homeColo(
	colos: readonly string[],
	coordsOf: (colo: string) => readonly [number, number] | undefined = defaultCoords,
): { colo: string; count: number } | null {
	const counts = new Map<string, number>();
	for (const c of colos) if (coordsOf(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
	let best: { colo: string; count: number; cost: number } | null = null;
	for (const [candidate, count] of counts) {
		let cost = 0;
		for (const [other, n] of counts) cost += n * (coloKm(candidate, other, coordsOf) ?? 0);
		if (
			best === null ||
			cost < best.cost ||
			(cost === best.cost && (count > best.count || (count === best.count && candidate < best.colo)))
		) {
			best = { colo: candidate, count, cost };
		}
	}
	return best ? { colo: best.colo, count: best.count } : null;
}

/** The report that speaks for one served name: from the object the name resolves to. */
interface Speaker {
	name0: string;
	group: string;
	partition: number;
	report: EngineReport;
}

interface Judged extends Speaker {
	name: string;
	misplaced: { km: number } | null;
	sick: string | null;
	evidence: string;
}

interface GroupFacts {
	home: { colo: string; count: number } | null;
	members: number;
	judgesColo: boolean;
	loadsMedian: number;
	aroundMedian: number;
	around: Map<number, number>;
}

function parsePins(pins: unknown): Map<string, number | "auto"> {
	const out = new Map<string, number | "auto">();
	if (!pins || typeof pins !== "object" || Array.isArray(pins)) return out;
	for (const [name, value] of Object.entries(pins as Record<string, unknown>)) {
		const parsed = parseEngineName(name);
		if (!parsed || parsed.partition === undefined || parsed.epoch !== undefined) continue;
		if (value === "auto") out.set(name, "auto");
		else if (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_ENGINE_EPOCH)
			out.set(name, value as number);
	}
	return out;
}

function isEmptyRecord(r: EngineMoveRecord): boolean {
	return !r.e && !r.stop && !r.strikes && !r.moves;
}

/**
 * Tonight's per-name records and moves, from last night's records and tonight's reports. PURE: the
 * coordinator gathers the reports and applies the result (import-coordinator placementGate,
 * stepNotify).
 */
export function judgeEngines(input: JudgeInput): JudgeResult {
	const coordsOf = input.coordsOf ?? defaultCoords;
	const nowIso = new Date(input.nowMs).toISOString();
	const pins = parsePins(input.pins);
	const lines: string[] = [];

	// 1. The reports that speak for a name: the object each served name resolves to, once.
	const current = new Map<string, Speaker>();
	for (const report of input.reports) {
		const parsed = parseEngineName(report.name);
		if (!parsed || parsed.partition === undefined) continue;
		const region = parsed.region as DurableObjectLocationHint;
		const name0 = engineName(region, parsed.shard, parsed.partition, parsed.generation ?? 0);
		if (!input.served(name0) || input.currentNameOf(name0) !== report.name) continue;
		const group = replicaGroupOf(report.name);
		if (group === null || current.has(name0)) continue;
		current.set(name0, { name0, group, partition: parsed.partition, report });
	}

	// 2. Per replica: its home colo and its medians.
	const byGroup = new Map<string, Speaker[]>();
	for (const entry of current.values()) {
		const list = byGroup.get(entry.group) ?? [];
		list.push(entry);
		byGroup.set(entry.group, list);
	}
	const facts = new Map<string, GroupFacts>();
	const fresh = (r: EngineReport) =>
		r.colo !== null && r.coloAt !== null && input.nowMs - r.coloAt <= COLO_FRESH_MS && coordsOf(r.colo) !== undefined;
	for (const [group, members] of byGroup) {
		const colos = members.filter((m) => fresh(m.report)).map((m) => m.report.colo as string);
		const home = homeColo(colos, coordsOf);
		const around = new Map<number, number>();
		for (const m of members) around.set(m.partition, 0);
		for (const m of members) {
			for (const [p, n] of Object.entries(m.report.around)) {
				const k = Number(p);
				if (around.has(k) && Number.isFinite(n)) around.set(k, (around.get(k) as number) + n);
			}
		}
		facts.set(group, {
			home,
			members: colos.length,
			judgesColo: home !== null && colos.length >= MIN_GROUP_REPORTS && home.count / colos.length >= HOME_MIN_SHARE,
			loadsMedian: median(members.map((m) => m.report.loads)),
			aroundMedian: median([...around.values()]),
			around,
		});
	}

	// 3. Each name's verdict.
	const judged = new Map<string, Judged>();
	for (const entry of current.values()) {
		const f = facts.get(entry.group) as GroupFacts;
		const r = entry.report;
		let misplaced: Judged["misplaced"] = null;
		if (f.judgesColo && f.home && fresh(r)) {
			const km = coloKm(r.colo as string, f.home.colo, coordsOf);
			if (km !== undefined && km > MISPLACED_KM) misplaced = { km };
		}
		const hedges = f.around.get(entry.partition) ?? 0;
		const hedgeBar = Math.max(SICK_HEDGES_MIN, SICK_HEDGES_FACTOR * f.aroundMedian);
		const loadBar = Math.max(SICK_LOADS_MIN, SICK_LOADS_FACTOR * f.loadsMedian);
		const sickness: string[] = [];
		if (hedges >= hedgeBar) sickness.push(`hedged around ${hedges} times on ${r.day} (bar ${hedgeBar})`);
		if (r.loads >= loadBar) sickness.push(`${r.loads} store loads on ${r.day} (bar ${loadBar})`);
		const where = f.home
			? `colo ${r.colo ?? "?"}${misplaced ? `, ${misplaced.km}km` : ""} vs home ${f.home.colo} (${f.home.count} of ${f.members})`
			: `colo ${r.colo ?? "?"}, no home`;
		judged.set(entry.name0, {
			...entry,
			name: r.name,
			misplaced,
			sick: sickness.length > 0 ? sickness.join(", ") : null,
			evidence:
				`${where}; hedged around ${hedges} (median ${f.aroundMedian}), ` +
				`${r.loads} loads (median ${f.loadsMedian}) on ${r.day}`,
		});
	}

	// 4. Records: pins, strikes, and who is a candidate tonight.
	const engines: Record<string, EngineMoveRecord> = {};
	const names = new Set<string>([...Object.keys(input.previous ?? {}), ...judged.keys(), ...pins.keys()]);
	const candidates: { name0: string; j: Judged; rank: number }[] = [];
	let kept = 0;
	let gaveUp = 0;
	let pinned = 0;
	for (const name0 of [...names].sort()) {
		const prev = input.previous?.[name0];
		const rec: EngineMoveRecord = prev && typeof prev === "object" ? { ...prev } : {};
		const pin = pins.get(name0);
		if (pin === "auto") {
			delete rec.stop;
			delete rec.moves;
		} else if (pin !== undefined) {
			if ((rec.e ?? 0) !== pin || rec.stop !== "pinned")
				lines.push(`Engine placement: pinned ${name0} at epoch ${pin} by hand`);
			if (pin > 0) rec.e = pin;
			else delete rec.e;
			rec.stop = "pinned";
			delete rec.strikes;
			delete rec.seen;
			pinned++;
		} else if (rec.stop === "pinned") {
			delete rec.stop;
			lines.push(`Engine placement: ${name0} unpinned at epoch ${rec.e ?? 0}; judged automatically again`);
		}
		if (!input.served(name0)) continue; // a retired name's record goes with it
		const j = judged.get(name0);
		// A name whose object did not report tonight keeps its run as it was: no evidence either way.
		if (j?.sick && rec.stop !== "pinned") {
			const running = rec.seen !== undefined && input.nowMs - Date.parse(rec.seen) <= STRIKE_GAP_MS;
			rec.strikes = (running ? (rec.strikes ?? 0) : 0) + 1;
			rec.seen = nowIso;
		} else if (j) {
			delete rec.strikes;
			delete rec.seen;
		}
		if (j && (j.misplaced || j.sick) && rec.stop !== "pinned") {
			const why = j.misplaced ? `misplaced: ${j.evidence}` : `sick (${j.sick}): ${j.evidence}`;
			const nextEpoch = (parseEngineName(j.name)?.epoch ?? 0) + 1;
			if (rec.stop === "gave-up" || (rec.moves ?? 0) >= MAX_AUTO_MOVES || nextEpoch > MAX_ENGINE_EPOCH) {
				rec.stop = "gave-up";
				rec.why = why;
				gaveUp++;
				lines.push(
					`Engine placement: gave up on ${j.name} — ${why}; ${rec.moves ?? 0} automatic move(s), ` +
						`epoch ${nextEpoch - 1} of ${MAX_ENGINE_EPOCH} — a pin of "auto" lets it be judged again`,
				);
			} else if (!j.misplaced && (rec.strikes ?? 0) < SICK_NIGHTS) {
				kept++;
				lines.push(`Engine placement: kept ${j.name} — ${why}; night ${rec.strikes} of ${SICK_NIGHTS}`);
			} else if (rec.since !== undefined && input.nowMs - Date.parse(rec.since) < MOVE_COOLDOWN_MS) {
				kept++;
				lines.push(
					`Engine placement: kept ${j.name} — ${why}; moved ${rec.since}, cooling down until ` +
						new Date(Date.parse(rec.since) + MOVE_COOLDOWN_MS).toISOString(),
				);
			} else {
				// Misplaced first, farthest first; then the sick, the most hedged-around first.
				const rank = j.misplaced ? 1e9 + j.misplaced.km : (facts.get(j.group)?.around.get(j.partition) ?? 0);
				candidates.push({ name0, j, rank });
			}
		} else if (j && (j.misplaced || j.sick)) {
			kept++;
			lines.push(
				`Engine placement: kept ${j.name} — ${j.misplaced ? "misplaced" : `sick (${j.sick})`}: ${j.evidence}; ` +
					`pinned by hand at epoch ${rec.e ?? 0}`,
			);
		}
		engines[name0] = rec;
	}

	// 5. Tonight's moves, within the limits.
	const moves: EngineMove[] = [];
	const movedGroups = new Set<string>();
	candidates.sort((a, b) => b.rank - a.rank || a.name0.localeCompare(b.name0));
	for (const { name0, j } of candidates) {
		const rec = engines[name0] as EngineMoveRecord;
		const why = j.misplaced ? `misplaced: ${j.evidence}` : `sick (${j.sick}): ${j.evidence}`;
		if (moves.length >= MAX_MOVES_PER_NIGHT || movedGroups.has(j.group)) {
			kept++;
			rec.why = why;
			lines.push(
				`Engine placement: kept ${j.name} — ${why}; ` +
					(movedGroups.has(j.group)
						? `one move per replica a night (${j.group} already moved)`
						: `${MAX_MOVES_PER_NIGHT} moves a night already made`),
			);
			continue;
		}
		const epoch = (parseEngineName(j.name)?.epoch ?? 0) + 1;
		const parsed = parseEngineName(j.name) as NonNullable<ReturnType<typeof parseEngineName>>;
		const to = engineName(
			parsed.region as DurableObjectLocationHint,
			parsed.shard,
			parsed.partition,
			parsed.generation ?? 0,
			epoch,
		);
		const f = facts.get(j.group) as GroupFacts;
		const hosts = f.judgesColo
			? [...current.values()]
					.filter(
						(m) =>
							m.group === j.group &&
							m.name0 !== name0 &&
							m.report.colo === f.home?.colo &&
							fresh(m.report) &&
							!judged.get(m.name0)?.misplaced &&
							!judged.get(m.name0)?.sick,
					)
					.sort((a, b) => a.partition - b.partition)
			: [];
		const host = hosts[0]?.report.name ?? null;
		rec.e = epoch;
		rec.since = nowIso;
		rec.moves = (rec.moves ?? 0) + 1;
		rec.why = why;
		delete rec.strikes;
		delete rec.seen;
		movedGroups.add(j.group);
		moves.push({ name0, from: j.name, to, epoch, host, why });
		lines.push(
			`Engine placement: moved ${j.name} -> ${to} — ${why}; ` +
				`${host ? `seeded from ${host} in ${f.home?.colo}` : "not seeded (no home colo): its first caller places it"}; ` +
				`automatic move ${rec.moves} of ${MAX_AUTO_MOVES}`,
		);
	}

	for (const [name0, rec] of Object.entries(engines)) if (isEmptyRecord(rec)) delete engines[name0];
	const homes = [...facts.entries()]
		.filter(([, f]) => f.home)
		.map(([g, f]) => `${g.slice("engine-".length)} ${f.home?.colo} ${f.home?.count}/${f.members}`)
		.sort();
	lines.push(
		`Engine placement: judged ${current.size} object(s) in ${facts.size} replica(s); ${moves.length} moved, ` +
			`${kept} kept, ${gaveUp} gave up, ${pinned} pinned; homes ${homes.join(", ") || "none"}`,
	);
	return { engines: Object.keys(engines).length > 0 ? engines : undefined, moves, lines };
}

// ── the coordinator's two I/O halves, kept here so they are tested with the rules ────────────────

/** How long the nightly waits for one object's placementReport (two SQLite reads; a wake at most). */
export const REPORT_DEADLINE_MS = 5_000;

/** How long it waits for one seed: a wake, a KV load of one partition (~14MB), its cache fill. */
export const SEED_DEADLINE_MS = 60_000;

/** `promise`, or a rejection after `ms` — with the timer cleared either way, so nothing outlives it. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${what} did not answer in ${ms}ms`)), ms);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Ask every announced partition object for its report, in parallel, each bounded. An object that
 * does not answer is left out — its name keeps last night's record untouched (judgeEngines) — and
 * never fails the run.
 */
export async function gatherEngineReports(
	names: readonly string[],
	ask: (name: string) => Promise<EngineReport>,
	deadlineMs: number = REPORT_DEADLINE_MS,
): Promise<{ reports: EngineReport[]; failed: string[] }> {
	const asked = names.filter((name) => parseEngineName(name)?.partition !== undefined);
	const settled = await Promise.allSettled(
		asked.map((name) =>
			within(
				Promise.resolve().then(() => ask(name)),
				deadlineMs,
				`${name} placementReport`,
			),
		),
	);
	const reports: EngineReport[] = [];
	const failed: string[] = [];
	settled.forEach((s, i) => {
		const name = asked[i] as string;
		// The object's own label is what it reports; anything else is not this name's report.
		if (s.status === "fulfilled" && s.value?.name === name) reports.push(s.value);
		else failed.push(name);
	});
	return { reports, failed };
}

/**
 * Seed tonight's moves (see WHERE THE REPLACEMENT LANDS): each host makes the first call to its
 * sibling's replacement. In parallel — at most one per replica, MAX_MOVES_PER_NIGHT in all — each
 * bounded, none able to fail the publish: a replacement that is not seeded is created by its first
 * real caller instead, as an ABANDONED_ENGINES move's always was. One line per move.
 */
export async function seedMoves(
	moves: readonly EngineMove[],
	seed: (host: string, to: string) => Promise<{ cards: number; ms: number }>,
	log: (line: string) => void = (line) => console.log(line),
	deadlineMs: number = SEED_DEADLINE_MS,
): Promise<{ seeded: string[]; unseeded: string[] }> {
	const seeded: string[] = [];
	const unseeded: string[] = [];
	await Promise.all(
		moves.map(async (move) => {
			if (move.host === null) {
				unseeded.push(move.to);
				log(`Engine placement: ${move.to} not seeded (no host in a home colo); its first caller creates it`);
				return;
			}
			try {
				const { cards, ms } = await within(seed(move.host, move.to), deadlineMs, `seed of ${move.to}`);
				seeded.push(move.to);
				log(`Engine placement: seeded ${move.to} from ${move.host} (${cards} cards loaded in ${ms}ms)`);
			} catch (err) {
				unseeded.push(move.to);
				log(`Engine placement: could not seed ${move.to} from ${move.host} (${err}); its first caller creates it`);
			}
		}),
	);
	return { seeded, unseeded };
}
