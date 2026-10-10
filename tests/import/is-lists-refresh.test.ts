// The nightly refresh of the `is:` lists that are Scryfall's own record (src/import-is-lists.ts),
// against a Scryfall that can be made to move, fail and lie (scripts/import-harness/fake-scryfall.ts).
//
// What is pinned: a night on which nothing moved asks for first pages and nothing else; a list
// that grew is read whole and the table carries the member; a list whose read fails, or answers
// anything that is not a whole list, stays as it was while the others go on; the work survives
// the end of an alarm between any two requests; and the table handed to the builder is the
// compiled one with exactly the refreshed lists replaced.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type FakeCard, FakeScryfall } from "../../scripts/import-harness/fake-scryfall";
import { FIXED_ROWS_WRITTEN_PER_ALARM, MAX_DAY_ROWS_WRITTEN } from "../../src/import-budget";
import {
	ART_REPS_MARGIN_DAYS,
	ART_REPS_MAX_PAGES,
	ART_REPS_QUERY,
	artRepsFrom,
	beginNight,
	byNumber,
	checkSearchPage,
	closeNight,
	composeOverride,
	fnv1a64,
	IS_LISTS_DEADLINE_MS,
	IS_LISTS_GAP_MS,
	IS_LISTS_NIGHT_REQUESTS,
	IS_LISTS_SLICE_MS,
	IS_LISTS_SLICE_REQUESTS,
	IS_LISTS_STATE_MAX_BYTES,
	type IsListsState,
	ListRefused,
	type NightWork,
	noteOf,
	readCompiled,
	runSlice,
	SCRYFALL_PAGE_ROWS,
	type SearchAnswer,
} from "../../src/import-is-lists";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DAY = 86_400_000;
const COMPILED_DAY = "2026-10-09";
const night = (n: number) => Date.parse(`${COMPILED_DAY}T11:17:00Z`) + n * DAY;

/** A small world: an old set, Jumpstart, and a set released a week before the table was measured. */
function world(): FakeScryfall {
	let id = 0;
	const cards: FakeCard[] = [];
	const add = (set: string, n: number, lang: string, name: string, oracle: number, is: string[], parts = false) => {
		const card: FakeCard = {
			id: uuid(++id),
			oracle_id: uuid(9000 + oracle),
			name,
			set,
			collector_number: String(n),
			lang,
			is,
		};
		if (parts) card.all_parts = [{ object: "related_card" }];
		cards.push(card);
	};
	for (let n = 1; n <= 12; n++) add("jmp", n, "en", `Jump ${n}`, 100 + n, ["jumpstart"]);
	add("old", 1, "en", "Old 1", 1, ["covered", "intro"]);
	add("old", 1, "fr", "Old 1", 1, []);
	add("old", 2, "en", "Old 2", 2, ["intro"]);
	add("old", 2, "fr", "Old 2", 2, []);
	add("old", 3, "en", "Old 3", 3, []);
	add("old", 3, "es", "Old 3", 3, ["covered", "misprint"]);
	add("old", 4, "en", "Old 4", 4, ["invitational"]);
	add("old", 4, "de", "Old 4", 4, ["covered", "invitational"]);
	add("old", 5, "en", "Old 5", 5, ["related"], true);
	add("old", 6, "en", "Old 6", 6, ["related"]);
	add("old", 7, "en", "Spike One", 7, ["spikey"]);
	add("old", 8, "en", "Book One", 8, ["spellbook"]);
	add("new", 1, "en", "New 1", 21, ["covered"]);
	add("new", 2, "en", "New 2", 22, ["related"], true);
	add("new", 3, "en", "Spike Two", 23, ["spikey"]);
	for (let n = 4; n <= 6; n++) add("new", n, "en", `New ${n}`, 20 + n, []);
	const fake = new FakeScryfall(cards, [
		{ code: "old", released_at: "2020-01-01" },
		{ code: "jmp", released_at: "2020-07-17" },
		{ code: "new", released_at: "2026-10-02" },
	]);
	fake.pageRows = 5;
	return fake;
}

const rowsOf = (fake: FakeScryfall, q: string) => (fake.rows(q, "prints") as FakeCard[]).length;

/** A compiled table that is this world on the day it was measured, in the generator's wide keys. */
function compiledFor(fake: FakeScryfall): string {
	const tiers = /^# print_tiers\.tsv (\S+)$/m.exec(
		readFileSync(join(import.meta.dir, "../../engine/builder/src/is_lists.tsv"), "utf8"),
	);
	return [
		`# GENERATED FILE - do not edit. Built by scripts/generate-is-lists.ts from api.scryfall.com, ${COMPILED_DAY}.`,
		"#",
		...["covered", "intro", "invitational", "jumpstart", "misprint", "related", "spellbook", "spikey"].map(
			(tag) => `# ${tag}: ${rowsOf(fake, `is:${tag} lang:any`)} rows of every language on api.scryfall.com`,
		),
		`# print_tiers.tsv ${tiers?.[1]}`,
		"covered\trow\told\ten\t1",
		"covered\tnot-row\tnew\ten\t9",
		"covered\tnot-row\told\tfr\t1 2",
		"intro\tprint\told\t1 2",
		"invitational\trow\told\tde\t4",
		"invitational\trow\told\ten\t4",
		"jumpstart\tset\tjmp",
		"misprint\trow\told\tes\t3",
		`related\toracle\t${uuid(9006)}\tOld 6`,
		`spellbook\toracle\t${uuid(9008)}\tBook One`,
		`spikey\toracle\t${uuid(9007)}\tSpike One`,
		`spikey\toracle\t${uuid(9023)}\tSpike Two`,
		"spikey\tnot-row\told\tja\t7",
		"",
	].join("\n");
}

interface Ran {
	state: IsListsState;
	line: string;
	work: NightWork;
	asked: string[];
}

/** One night, every alarm of it: the work goes through JSON between slices, as it does through storage. */
async function runNight(
	fake: FakeScryfall,
	compiled: string,
	stored: IsListsState | null,
	nowMs: number,
	perSlice = 1000,
	artFrom: string | null = null,
): Promise<Ran> {
	const from = fake.asked.length;
	let work = beginNight(compiled, stored && structuredClone(stored), nowMs, artFrom);
	for (let slices = 0; ; slices++) {
		if (slices > 500) throw new Error("the night does not end");
		const over = await runSlice(work, {
			get: async (path) => fake.answer(path),
			now: () => nowMs,
			maxRequests: perSlice,
			deadlineMs: nowMs + 60_000,
		});
		if (over) break;
		work = JSON.parse(JSON.stringify(work)) as NightWork;
	}
	const { state, line } = closeNight(work);
	return { state, line, work, asked: fake.asked.slice(from) };
}

const queries = (asked: string[]) =>
	asked.map((path) => decodeURIComponent(path.replace(/^.*[?&]q=([^&]*).*$/, "$1")).replaceAll("+", " "));
const pagesOf = (asked: string[], q: string) => queries(asked).filter((x) => x === q).length;

describe("the answer checks, shared with `bun run is-lists`", () => {
	const card = { id: uuid(1), name: "A", set: "old", collector_number: "1", lang: "en" };
	const list = (over: Record<string, unknown>, cards: unknown[] = [card]): SearchAnswer => ({
		status: 200,
		body: { object: "list", total_cards: cards.length, has_more: false, data: cards, ...over },
	});

	test("a plain no-match is the empty list, and a list is its rows", () => {
		expect(checkSearchPage("q", { status: 404, body: { object: "error", code: "not_found" } })).toEqual({
			rows: [],
			total: 0,
			hasMore: false,
		});
		expect(checkSearchPage("q", list({})).rows).toHaveLength(1);
	});

	test("anything that is not a whole page of a list is refused", () => {
		const refused: SearchAnswer[] = [
			{ status: 500, body: { object: "error" } },
			{ status: 200, body: null },
			{ status: 404, body: { object: "error", code: "not_found", warnings: ["x"] } },
			list({ warnings: ["Invalid expression “is:nope” was ignored."] }),
			list({ total_cards: "1" }),
			list({ total_cards: 0 }),
			list({ has_more: undefined }),
			list({}, []),
			list({}, [{ ...card, set: undefined }]),
			list({}, [{ ...card, collector_number: "" }]),
			list({}, [{ ...card, collector_number: "1 a" }]),
			list({}, [{ ...card, lang: "e\tn" }]),
			list({}, [{ ...card, name: "A\tB" }]),
			list({}, [null]),
		];
		for (const answer of refused) expect(() => checkSearchPage("q", answer)).toThrow(ListRefused);
	});

	test("the fingerprint is the builder's FNV-1a", () => {
		const reference = (bytes: Uint8Array) => {
			let hash = 0xcbf29ce484222325n;
			for (const byte of bytes) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
			return hash.toString(16).padStart(16, "0");
		};
		const tiers = readFileSync(join(import.meta.dir, "../../engine/builder/src/print_tiers.tsv"));
		const table = readFileSync(join(import.meta.dir, "../../engine/builder/src/is_lists.tsv"));
		// The committed table records the tier table's fingerprint, which is_lists.rs checks.
		expect(table.toString()).toContain(`# print_tiers.tsv ${fnv1a64(tiers)}`);
		for (const bytes of [new Uint8Array(0), new TextEncoder().encode("a"), tiers, table]) {
			expect(fnv1a64(bytes)).toBe(reference(bytes));
		}
	});

	test("collector numbers sort by number and then by text", () => {
		expect(["10", "2", "1★", "1", "J25-15", "a"].sort(byNumber)).toEqual(["1", "1★", "2", "10", "J25-15", "a"]);
	});

	test("the committed table reads as the night needs it", () => {
		const { base, lines } = readCompiled(
			readFileSync(join(import.meta.dir, "../../engine/builder/src/is_lists.tsv"), "utf8"),
		);
		expect(base.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(base.refinable).toBe(true);
		// The foreign rows the compiled table lists are `-is:covered -lang:en`, row for row.
		expect(base.foreignRows).toBeGreaterThan(3000);
		for (const tag of ["intro", "invitational", "jumpstart", "misprint", "old_artist"] as const)
			expect(base.totals[tag]).toBeGreaterThan(0);
		// The ninth list is written by row and nothing wider: a translation is not its English row.
		expect(lines.old_artist.length).toBeGreaterThan(200);
		expect(lines.old_artist.every((line) => line.split("\t")[1] === "row")).toBe(true);
		expect(lines.covered.length + lines.related.length).toBeGreaterThan(300);
	});
});

describe("what a night may cost on the free plan", () => {
	test("requests an alarm, alarms a night, rows written and the state's size are all bounded by constants", () => {
		// An invocation gets 50 subrequests; the alarm's own bookkeeping (the fence's KV reads, the
		// state's put) needs a few of them.
		expect(IS_LISTS_SLICE_REQUESTS).toBeLessThanOrEqual(40);
		const alarms = Math.ceil(IS_LISTS_NIGHT_REQUESTS / IS_LISTS_SLICE_REQUESTS);
		expect(alarms).toBe(8);
		// Each alarm pays the chain's fixed toll and writes its progress row; the last writes three more.
		const rowsWritten = alarms * (FIXED_ROWS_WRITTEN_PER_ALARM + 1) + 3;
		expect(rowsWritten).toBeLessThan(MAX_DAY_ROWS_WRITTEN / 1000);
		// The fixed part of the worst night — every small list whole (422, 92, 5,989, 491 and the
		// 2,773 rows `new:artist` leaves out, of 175 a page; 72 and 678 cards), the foreign rows whole,
		// three sizes and /sets — leaves the sets most of the night's requests.
		const pages = (rows: number) => Math.ceil(rows / SCRYFALL_PAGE_ROWS);
		const fixed =
			pages(422) + pages(92) + pages(5989) + pages(491) + pages(2773) + pages(72) + pages(678) + pages(3226) + 3 + 1;
		expect(fixed).toBe(86);
		expect(IS_LISTS_NIGHT_REQUESTS - fixed).toBeGreaterThanOrEqual(150);
		// One request a second, and a slow answer on every one of them: still inside the deadline's
		// order, and an alarm's share far inside the 5-minute alarm watchdog.
		expect(IS_LISTS_GAP_MS).toBeGreaterThanOrEqual(1000);
		expect((IS_LISTS_NIGHT_REQUESTS * (IS_LISTS_GAP_MS + 500)) / 60_000).toBeLessThanOrEqual(6);
		expect(IS_LISTS_SLICE_MS).toBeLessThanOrEqual(120_000);
		expect(IS_LISTS_DEADLINE_MS).toBeLessThanOrEqual(15 * 60_000);
		// One KV value (25 MiB) and one Durable Object row (2 MB), with room.
		expect(IS_LISTS_STATE_MAX_BYTES).toBeLessThan(2_000_000);
	});
});

describe("a night of the refresh", () => {
	test("the first night reads the card lists and the recent sets, and nothing that did not move", async () => {
		const fake = world();
		const compiled = compiledFor(fake);
		const first = await runNight(fake, compiled, null, night(1));
		// Six first pages, the foreign rows' and the three sizes', /sets, and the one recent set.
		expect(first.asked).toHaveLength(14);
		expect(pagesOf(first.asked, "is:jumpstart lang:any")).toBe(1);
		expect(first.line).toContain("jumpstart = (12)");
		expect(first.line).toContain("sets: 1 of 3 owed a read, 1 read — new (1/5/1)");
		expect(first.state.checked).toBe("2026-10-10");
		expect(Object.keys(first.state.sets).sort()).toEqual(["jmp", "new", "old"]);
		expect(first.state.sets.old).toEqual({ count: 8 });

		const table = composeOverride(compiled, first.state) as string;
		const { base } = readCompiled(compiled);
		expect(table).toContain(`# base ${base.fingerprint}\n# print_tiers.tsv ${base.tiers}\n# meta {`);
		const lines = table.split("\n").filter((l) => l && !l.startsWith("#"));
		// The set read is written absolutely, in place of the compiled exceptions for it; the set
		// not read keeps its compiled English line; the foreign rows are the answer's.
		expect(lines.filter((l) => l.startsWith("covered\t"))).toEqual([
			"covered\trow\told\ten\t1",
			"covered\tnot-row\told\tfr\t1 2",
			"covered\trow\tnew\ten\t1",
			"covered\tnot-row\tnew\ten\t2 3 4 5 6",
		]);
		expect(lines.filter((l) => l.startsWith("related\t"))).toEqual([
			`related\toracle\t${uuid(9006)}\tOld 6`,
			"related\tprint\tnew\t2",
			"related\tnot\tnew\t1 3 4 5 6",
		]);
		// A list that fits its first page is whole on its probe; a card list keeps the compiled
		// table's own exceptions; a row list not read is the compiled one, wide keys and all.
		expect(lines).toContain("intro\trow\told\ten\t1 2");
		expect(lines).toContain("jumpstart\tset\tjmp");
		expect(lines.filter((l) => l.startsWith("spikey\t"))).toEqual([
			`spikey\toracle\t${uuid(9007)}\tSpike One`,
			`spikey\toracle\t${uuid(9023)}\tSpike Two`,
			"spikey\tnot-row\told\tja\t7",
		]);
		expect(noteOf(first.state, base.date)).toEqual({
			base: COMPILED_DAY,
			source: "nightly",
			checked: "2026-10-10",
			fetched: {
				intro: "2026-10-10",
				invitational: "2026-10-10",
				misprint: "2026-10-10",
				spellbook: "2026-10-10",
				spikey: "2026-10-10",
				"covered-foreign": "2026-10-10",
			},
			sets: 1,
			sets_fetched: "2026-10-10",
		});
	});

	test("unchanged lists are not refetched: eleven first pages, and the same table", async () => {
		const fake = world();
		const compiled = compiledFor(fake);
		const first = await runNight(fake, compiled, null, night(1));
		const second = await runNight(fake, compiled, first.state, night(2));
		expect(second.asked).toHaveLength(11);
		expect(queries(second.asked).filter((q) => q.startsWith("e:"))).toEqual([]);
		expect(second.asked.filter((path) => path.includes("page="))).toEqual([]);
		expect(second.line).toContain("sets: 0 of 3 owed a read, 0 read");
		expect(second.line).toContain("sizes 2/24/3 reconcile with the sets read");
		const body = (state: IsListsState) =>
			(composeOverride(compiled, state) as string).split("\n").filter((l) => !l.startsWith("#"));
		expect(body(second.state)).toEqual(body(first.state));
		expect(second.state.checked).toBe("2026-10-11");
	});

	test("a state that refines nothing is no override at all", async () => {
		const fake = world();
		const compiled = compiledFor(fake);
		const work = beginNight(compiled, null, night(1));
		expect(composeOverride(compiled, work.state)).toBeNull();
		expect(noteOf(work.state, COMPILED_DAY)).toEqual({ base: COMPILED_DAY, source: "compiled", checked: null });
	});

	test("a list that grew is read whole, and the table carries the new member", async () => {
		const fake = world();
		const compiled = compiledFor(fake);
		const first = await runNight(fake, compiled, null, night(1));
		const grow = (n: number) =>
			fake.cards.push({
				id: uuid(500 + n),
				oracle_id: uuid(9100 + n),
				name: `Jump ${n}`,
				set: "jmp",
				collector_number: String(n),
				lang: "en",
				is: ["jumpstart"],
			});
		grow(13);
		const second = await runNight(fake, compiled, first.state, night(2));
		expect(pagesOf(second.asked, "is:jumpstart lang:any")).toBe(3);
		expect(second.line).toContain("jumpstart first read (13)");
		expect(composeOverride(compiled, second.state)).toContain(
			"jumpstart\trow\tjmp\ten\t1 2 3 4 5 6 7 8 9 10 11 12 13\n",
		);
		expect(composeOverride(compiled, second.state)).not.toContain("jumpstart\tset\tjmp");
		// Its set's count moved too: the set is read, for the first time, so the sizes cannot be told apart tonight.
		expect(second.line).toContain("jmp (0/13/0)");
		expect(second.line).toContain("not reconciled: jmp read for the first time");

		grow(14);
		const third = await runNight(fake, compiled, second.state, night(3));
		expect(third.line).toContain("jumpstart +1 −0 (14)");
		expect(third.line).toContain("jmp (0/13/0 → 0/14/0)");
		expect(third.line).toContain("reconcile with the sets read");
		expect(third.state.lists.jumpstart?.fetched).toBe("2026-10-12");
	});

	test("a small list is read whole every week, moved or not", async () => {
		const fake = world();
		const compiled = compiledFor(fake);
		const first = await runNight(fake, compiled, null, night(1));
		// Six days after the table was measured its size still vouches for it; on the seventh it is read.
		const sixth = await runNight(fake, compiled, first.state, night(6));
		expect(pagesOf(sixth.asked, "is:jumpstart lang:any")).toBe(1);
		const seventh = await runNight(fake, compiled, sixth.state, night(7));
		expect(pagesOf(seventh.asked, "is:jumpstart lang:any")).toBe(3);
		expect(seventh.state.lists.jumpstart).toMatchObject({ total: 12, fetched: "2026-10-16" });
		const eighth = await runNight(fake, compiled, seventh.state, night(8));
		expect(pagesOf(eighth.asked, "is:jumpstart lang:any")).toBe(1);
		expect(eighth.line).toContain("jumpstart = (12)");
	});

	test("a read that fails midway leaves that list as it was, and the night goes on", async () => {
		const fake = world();
		const compiled = compiledFor(fake);
		const first = await runNight(fake, compiled, null, night(7));
		const good = first.state.lists.jumpstart;
		expect(good?.total).toBe(12);
		fake.cards.push({
			id: uuid(513),
			oracle_id: uuid(9113),
			name: "Jump 13",
			set: "jmp",
			collector_number: "13",
			lang: "en",
			is: ["jumpstart"],
		});
		fake.fault = (path) => (path.includes("jumpstart") && path.includes("page=2") ? "throw" : null);
		const second = await runNight(fake, compiled, first.state, night(8));
		expect(second.line).toContain("jumpstart REFUSED (fake Scryfall: connection reset)");
		expect(second.state.lists.jumpstart).toEqual(good as NonNullable<typeof good>);
		// Everything after it was still asked, and the night ended.
		expect(second.line).toContain("misprint +0 −0 (1)");
		expect(second.state.checked).toBe("2026-10-17");
		expect(composeOverride(compiled, second.state)).toContain("jumpstart\trow\tjmp\ten\t1 2 3 4 5 6 7 8 9 10 11 12\n");
	});

	test("a malformed page refuses the list: no row, a moved total, a warning, a repeat, no end", async () => {
		const faults: Record<string, (truth: SearchAnswer) => SearchAnswer> = {
			"a row without id, set, number or lang": (t) => {
				const body = structuredClone(t.body) as { data: Record<string, unknown>[] };
				delete (body.data[0] as Record<string, unknown>).set;
				return { status: 200, body };
			},
			"the list moved while it was read (13 rows, then 14)": (t) => ({
				status: 200,
				body: { ...(t.body as object), total_cards: 14 },
			}),
			"answered with a warning": (t) => ({
				status: 200,
				body: { ...(t.body as object), warnings: ["Invalid expression was ignored."] },
			}),
			"more pages after all 13 rows": (t) => ({ status: 200, body: { ...(t.body as object), has_more: true } }),
			"13 rows received of 13": () => ({
				status: 200,
				body: { object: "list", total_cards: 13, has_more: false, data: [] },
			}),
			"is:jumpstart lang:any: 200 null": () => ({ status: 200, body: null }),
			"is:jumpstart lang:any: 503": () => ({ status: 503, body: { object: "error" } }),
		};
		for (const [why, mangle] of Object.entries(faults)) {
			const fake = world();
			const compiled = compiledFor(fake);
			fake.cards.push({
				id: uuid(513),
				oracle_id: uuid(9113),
				name: "Jump 13",
				set: "jmp",
				collector_number: "13",
				lang: "en",
				is: ["jumpstart"],
			});
			// The LAST page (3 of 3), so the list is complete but for the fault.
			fake.fault = (path) => (path.includes("jumpstart") && path.includes("page=3") ? mangle(fake.truth(path)) : null);
			const ran = await runNight(fake, compiled, null, night(1));
			expect(ran.line).toContain("jumpstart REFUSED");
			if (!why.startsWith("13 rows received")) expect(ran.line).toContain(why);
			expect(ran.state.lists.jumpstart).toBeUndefined();
			expect(composeOverride(compiled, ran.state)).toContain("jumpstart\tset\tjmp\n");
		}
		// A page served twice hides the page not served: as many rows as the total, one of them twice.
		const fake = world();
		const compiled = compiledFor(fake);
		fake.cards.push({
			id: uuid(513),
			oracle_id: uuid(9113),
			name: "Jump 13",
			set: "jmp",
			collector_number: "13",
			lang: "en",
			is: ["jumpstart"],
		});
		fake.pageRows = 7;
		fake.fault = (path) => {
			if (!path.includes("jumpstart") || !path.includes("page=2")) return null;
			const body = structuredClone(fake.truth(path.replace("&page=2", "")).body) as { data: unknown[] };
			return { status: 200, body: { ...body, data: body.data.slice(0, 6), has_more: false } };
		};
		const ran = await runNight(fake, compiled, null, night(1));
		expect(ran.line).toMatch(/jumpstart REFUSED \(is:jumpstart lang:any: jmp\/\d+\/en is in the answer twice\)/);
	});

	test("three refusals, a 429 or the clock end the night's asking; what was read whole stands", async () => {
		const fake = world();
		const compiled = compiledFor(fake);
		fake.fault = (path) => (path.includes("/cards/search") ? { status: 500, body: null } : null);
		const dead = await runNight(fake, compiled, null, night(1));
		expect(dead.asked).toHaveLength(3);
		expect(dead.line).toContain("STOPPED (3 lists refused");
		expect(dead.state.checked).toBeNull();
		expect(composeOverride(compiled, dead.state)).toBeNull();

		const limited = world();
		limited.fault = (_path, nth) => (nth === 3 ? { status: 429, body: null, retryAfter: 30 } : null);
		const slowed = await runNight(limited, compiled, null, night(1));
		expect(slowed.asked).toHaveLength(3);
		expect(slowed.line).toContain("STOPPED (Scryfall answered 429 (Retry-After 30s)");
		// The two lists read before it are in the table.
		expect(Object.keys(slowed.state.lists)).toEqual(["intro", "invitational"]);

		const late = world();
		const work = beginNight(compiled, null, night(1));
		const over = await runSlice(work, {
			get: async (path) => late.answer(path),
			now: () => night(1) + IS_LISTS_DEADLINE_MS + 1,
			maxRequests: 30,
			deadlineMs: night(1) + 2 * IS_LISTS_DEADLINE_MS,
		});
		expect(over).toBe(true);
		expect(late.asked).toHaveLength(0);
		expect(closeNight(work).line).toContain("STOPPED (15 minutes in");
	});

	test("the work survives an alarm ending between any two requests", async () => {
		const whole = world();
		const compiled = compiledFor(whole);
		whole.cards.push({
			id: uuid(513),
			oracle_id: uuid(9113),
			name: "Jump 13",
			set: "jmp",
			collector_number: "13",
			lang: "en",
			is: ["jumpstart"],
		});
		const one = await runNight(whole, compiled, null, night(1));
		for (const perSlice of [1, 2, 3, 7]) {
			const sliced = world();
			sliced.cards.push(whole.cards.at(-1) as FakeCard);
			const many = await runNight(sliced, compiled, null, night(1), perSlice);
			expect(many.asked).toEqual(one.asked);
			expect(many.state).toEqual(one.state);
			expect(many.work.slices).toBeGreaterThanOrEqual(Math.ceil(one.asked.length / perSlice));
		}
	});

	test("a set that does not fit the night's requests is put off, and read first the next night", async () => {
		const fake = world();
		const compiled = compiledFor(fake);
		(fake.sets[2] as { card_count?: number }).card_count = 50_000;
		const first = await runNight(fake, compiled, null, night(1));
		expect(first.line).toContain("sets: 1 of 3 owed a read, 0 read, 1 left for the next night");
		expect(first.state.sets.new).toEqual({ count: null });
		delete (fake.sets[2] as { card_count?: number }).card_count;
		const second = await runNight(fake, compiled, first.state, night(2));
		expect(second.line).toContain("sets: 1 of 3 owed a read, 1 read — new (1/5/1)");
		expect(second.state.sets.new).toMatchObject({ count: 6, cov: 1, unc: 5, rel: 1, fetched: "2026-10-11" });
	});

	test("movement in a set whose count did not move is not read, and is said", async () => {
		const fake = world();
		const compiled = compiledFor(fake);
		const first = await runNight(fake, compiled, null, night(1));
		const second = await runNight(fake, compiled, first.state, night(2));
		expect(second.line).toContain("reconcile");
		// Scryfall re-tiers old/2: covered now, and its set holds as many printings as before.
		(fake.cards.find((c) => c.set === "old" && c.collector_number === "2" && c.lang === "en") as FakeCard).is.push(
			"covered",
		);
		const third = await runNight(fake, compiled, second.state, night(3));
		expect(third.asked).toHaveLength(11);
		expect(third.line).toContain(
			"sizes 3/23/3: 1 covered and -1 uncovered English rows and 0 related printings MOVED IN SETS WHOSE COUNT DID NOT",
		);
		// It stands until it is measured.
		const fourth = await runNight(fake, compiled, third.state, night(4));
		expect(fourth.line).toContain("1 covered and -1 uncovered English rows");
	});

	test("a variation is a row of its lists and of its set: every request asks for them", async () => {
		const fake = world();
		// A misprint twin of new/1, as Scryfall files one: `variation: true`, its own number, and in
		// no answer unless `include_variations=true` is sent. Not covered; a Spanish one that is.
		const twin = (n: number, lang: string, is: string[]): FakeCard => ({
			id: uuid(700 + fake.cards.length),
			oracle_id: uuid(9021),
			name: "New 1",
			set: "new",
			collector_number: `${n}†`,
			lang,
			is,
			variation: true,
		});
		fake.cards.push(twin(1, "en", ["misprint"]), twin(2, "es", ["misprint", "covered"]));
		// Hidden by default, as on api.scryfall.com — and counted by /sets all the same.
		expect(rowsOf(fake, "is:misprint lang:any")).toBe(3);
		expect((fake.rows("is:misprint lang:any", "prints", false) as FakeCard[]).length).toBe(1);
		expect(fake.printings("new")).toBe(8);
		const compiled = compiledFor(fake);
		const first = await runNight(fake, compiled, null, night(1));
		const searches = first.asked.filter((path) => path.startsWith("/cards/search"));
		expect(searches.length).toBeGreaterThan(10);
		for (const path of searches) expect(path).toContain("include_variations=true");
		const table = composeOverride(compiled, first.state) as string;
		// The list: three rows, read whole on its probe — the two variations among them.
		expect(first.line).toContain("misprint first read (3)");
		expect(table).toContain("misprint\trow\tnew\ten\t1†\n");
		expect(table).toContain("misprint\trow\tnew\tes\t2†\n");
		// The set: its two halves are its `card_count` — the English variation out of `covered`
		// by its own row, and the Spanish one a row the foreign answer does not name.
		expect(first.line).toContain("new (1/6/1)");
		expect(first.state.sets.new).toMatchObject({ count: 8, cov: 1, unc: 6 });
		expect(table).toContain("covered\tnot-row\tnew\ten\t1† 2 3 4 5 6\n");
		expect(table).not.toContain("covered\tnot-row\tnew\tes");
		// The sizes are the same scope as the reads, so the next night they reconcile.
		const second = await runNight(fake, compiled, first.state, night(2));
		expect(second.asked).toHaveLength(11);
		expect(second.line).toContain("reconcile with the sets read");
	});

	test("another compiled table starts the state over", async () => {
		const fake = world();
		const compiled = compiledFor(fake);
		const first = await runNight(fake, compiled, null, night(1));
		const regenerated = compiled.replace(COMPILED_DAY, "2026-10-20");
		const later = await runNight(fake, regenerated, first.state, night(12));
		expect(later.line).toContain("refine another table than this build's (2026-10-20): starting over");
		expect(later.state.baseDate).toBe("2026-10-20");
		expect(() => composeOverride(regenerated, first.state)).toThrow(ListRefused);
	});
});

// The ninth list is not an `is:` value: `old_artist`, the rows `new:artist` leaves out, which the
// builder turns into a bit on every OTHER row (card_engine `NEW_ARTIST`). It is asked as
// `-new:artist lang:any` and is otherwise a row list like `misprint`.
describe("the rows new:artist leaves out are the ninth list", () => {
	/** `world()` with five rows out of `new:artist` — a translation among them. */
	function artistWorld(): FakeScryfall {
		const fake = world();
		const out = new Set(["old/2/en", "old/3/es", "new/4/en", "new/5/en", "jmp/7/en"]);
		for (const card of fake.cards) {
			if (out.has(`${card.set}/${card.collector_number}/${card.lang}`)) card.is.push("old_artist");
		}
		return fake;
	}
	const ROWS = [
		"old_artist\trow\tjmp\ten\t7",
		"old_artist\trow\tnew\ten\t4 5",
		"old_artist\trow\told\ten\t2",
		"old_artist\trow\told\tes\t3",
	];
	/** `compiledFor`, with the ninth list counted and written by row, as `bun run is-lists` writes it. */
	function compiledWithArtists(fake: FakeScryfall, rows: string[] = ROWS): string {
		const count = `# old_artist: ${rowsOf(fake, "-new:artist lang:any")} rows of every language on api.scryfall.com`;
		return `${compiledFor(fake).replace("# print_tiers.tsv ", `${count}\n# print_tiers.tsv `)}${rows.join("\n")}\n`;
	}

	test("an unmoved night asks its first page and nothing else of it", async () => {
		const fake = artistWorld();
		// Six rows at five a page: one row too many to be whole on its probe.
		fake.cards.find((c) => c.set === "new" && c.collector_number === "6")?.is.push("old_artist");
		const compiled = compiledWithArtists(fake, ROWS.with(1, "old_artist\trow\tnew\ten\t4 5 6"));
		expect(readCompiled(compiled).base.totals.old_artist).toBe(6);
		const first = await runNight(fake, compiled, null, night(1));
		// The fourteen of the other world's first night, and this list's probe.
		expect(first.asked).toHaveLength(15);
		expect(pagesOf(first.asked, "-new:artist lang:any")).toBe(1);
		expect(first.line).toContain("old_artist = (6)");
		expect(first.state.lists.old_artist).toBeUndefined();
		// Not read, so the table handed to the builder keeps the compiled rows.
		expect(composeOverride(compiled, first.state)).toContain("old_artist\trow\tnew\ten\t4 5 6\n");
		const second = await runNight(fake, compiled, first.state, night(2));
		expect(second.asked).toHaveLength(12);
		expect(pagesOf(second.asked, "-new:artist lang:any")).toBe(1);
	});

	test("a row that joined or left is read with the whole list, and the table carries the rows as they are", async () => {
		const fake = artistWorld();
		const compiled = compiledWithArtists(fake);
		const first = await runNight(fake, compiled, null, night(1));
		// Whole on its probe (five rows, five a page): read the first night like any such list.
		expect(first.line).toContain("old_artist first read (5)");
		// A printing catalogued since, whose artist Scryfall has decided is not new...
		fake.cards.push({
			id: uuid(700),
			oracle_id: uuid(9021),
			name: "New 1",
			set: "new",
			collector_number: "7",
			lang: "en",
			is: ["old_artist"],
		});
		// ...and one it has decided again: Ponder's sld/7185 left the list overnight in 2026-10.
		const left = fake.cards.find((c) => c.set === "jmp" && c.collector_number === "7") as FakeCard;
		left.is = left.is.filter((v) => v !== "old_artist");
		const joined = fake.cards.find((c) => c.set === "jmp" && c.collector_number === "8") as FakeCard;
		joined.is.push("old_artist");
		const second = await runNight(fake, compiled, first.state, night(2));
		expect(pagesOf(second.asked, "-new:artist lang:any")).toBe(2);
		expect(second.line).toContain("old_artist +2 −1 (6)");
		const table = composeOverride(compiled, second.state) as string;
		expect(table.split("\n").filter((l) => l.startsWith("old_artist\t"))).toEqual([
			"old_artist\trow\tjmp\ten\t8",
			"old_artist\trow\tnew\ten\t4 5 7",
			"old_artist\trow\told\ten\t2",
			"old_artist\trow\told\tes\t3",
		]);
		expect(noteOf(second.state, COMPILED_DAY).fetched?.old_artist).toBe("2026-10-11");
	});

	test("a read that fails leaves the list as it was, and the other lists go on", async () => {
		const fake = artistWorld();
		const compiled = compiledWithArtists(fake);
		fake.fault = (path) => (path.includes("new%3Aartist") ? { status: 503, body: { object: "error" } } : null);
		const ran = await runNight(fake, compiled, null, night(1));
		expect(ran.line).toContain("old_artist REFUSED (-new:artist lang:any: 503");
		expect(ran.state.lists.old_artist).toBeUndefined();
		expect(ran.state.checked).toBe("2026-10-10");
		expect(ran.line).toContain("spikey first read (2)");
		expect(composeOverride(compiled, ran.state)).toContain("old_artist\trow\tnew\ten\t4 5\n");
	});

	test("a compiled table from before the list existed is never asked for it", async () => {
		// The import blob of a build before this one compiles a table that does not count the list
		// and refuses a table that names it — and with it every other list's refresh. So the night
		// asks only for what the blob's own table counts.
		const fake = artistWorld();
		const ran = await runNight(fake, compiledFor(fake), null, night(1));
		expect(queries(ran.asked).filter((q) => q.includes("new:artist"))).toEqual([]);
		expect(composeOverride(compiledFor(fake), ran.state)).not.toContain("old_artist");
		expect(ran.state.checked).toBe("2026-10-10");
	});
});

// Not a list of a value: which printing `unique=art` answers each artwork with. The record is the
// whole-corpus answer, one row an artwork, and the night reads its NEWEST END — newest release
// first, down to a month before the day the importer's compiled copy of the record was written —
// and hands the builder those rows under that day (is_lists.rs `ART_REP_LINE`).
describe("the newest end of the record of artwork representatives", () => {
	const WRITTEN = "2026-10-09";
	const FROM = "2026-09-09";
	/**
	 * `world()`, dated — the old set and Jumpstart in 2020, the new set a week before the table,
	 * and a set not yet released — with every English row of an odd number its artwork's
	 * representative: 13 in the three sets and `previews` in the fourth.
	 */
	function artWorld(previews = 5): FakeScryfall {
		const fake = world();
		for (const card of fake.cards) {
			card.released_at = card.set === "new" ? "2026-10-02" : card.set === "jmp" ? "2020-07-17" : "2020-01-01";
			card.rep = card.lang === "en" && Number(card.collector_number) % 2 === 1;
		}
		for (let n = 1; n <= previews; n++) {
			fake.cards.push({
				id: uuid(800 + n),
				oracle_id: uuid(9800 + n),
				name: `Preview ${n}`,
				set: "pre",
				collector_number: String(n),
				lang: "en",
				is: [],
				released_at: "2026-11-20",
				rep: true,
			});
		}
		fake.sets.push({ code: "pre", released_at: "2026-11-20" });
		return fake;
	}
	const artLines = (table: string | null) => (table ?? "").split("\n").filter((l) => l.startsWith("art_rep\t"));
	const artNight = (fake: FakeScryfall, compiled: string, stored: IsListsState | null, n: number, perSlice = 1000) =>
		runNight(fake, compiled, stored, night(n), perSlice, FROM);

	test("the day it reads back to is a month before the compiled record was written", () => {
		expect(ART_REPS_MARGIN_DAYS).toBe(30);
		expect(artRepsFrom(WRITTEN)).toBe(FROM);
		expect(artRepsFrom("2026-03-15")).toBe("2026-02-13");
		expect(() => artRepsFrom("yesterday")).toThrow(ListRefused);
		expect(() => beginNight(compiledFor(world()), null, night(1), "soon")).toThrow(ListRefused);
	});

	test("it is read from the top until a row older than the day, and no further", async () => {
		const fake = artWorld();
		const compiled = compiledFor(fake);
		const first = await artNight(fake, compiled, null, 1);
		// 18 representatives; eight released since the day; five a page: the second page holds
		// the first older row, and the third and fourth are never asked for.
		expect(rowsOf(fake, ART_REPS_QUERY)).toBeGreaterThan(18);
		expect((fake.rows(ART_REPS_QUERY, "art") as FakeCard[]).length).toBe(18);
		expect(pagesOf(first.asked, ART_REPS_QUERY)).toBe(2);
		const asked = first.asked.filter((path) => path.includes("unique=art"));
		for (const path of asked) {
			expect(path).toContain("order=released&dir=desc");
			expect(path).toContain("include_extras=true&include_variations=true");
		}
		expect(first.line).toContain(`art reps first read (8 released since ${FROM}, of 18)`);
		expect(first.state.art).toEqual({
			total: 18,
			fetched: "2026-10-10",
			from: FROM,
			lines: ["art_rep\trow\tnew\ten\t1 3 5", "art_rep\trow\tpre\ten\t1 2 3 4 5"],
		});
		// Before the sets: the one read a night that must not wait for the budget.
		const order = queries(first.asked);
		expect(order.indexOf(ART_REPS_QUERY)).toBeLessThan(order.findIndex((q) => q.startsWith("e:")));
		expect(order.indexOf(ART_REPS_QUERY)).toBeGreaterThan(order.indexOf("is:related"));

		const table = composeOverride(compiled, first.state) as string;
		expect(table).toContain(`\n# art-reps-from ${FROM}\n`);
		// After every list's lines, and nothing of a row released before the day.
		expect(
			table
				.split("\n")
				.filter((l) => l && !l.startsWith("#"))
				.slice(-2),
		).toEqual(artLines(table));
		expect(artLines(table)).toEqual(["art_rep\trow\tnew\ten\t1 3 5", "art_rep\trow\tpre\ten\t1 2 3 4 5"]);
		expect(noteOf(first.state, COMPILED_DAY).art_reps).toEqual({ from: FROM, fetched: "2026-10-10", rows: 8 });
	});

	test("a record the same size is not read again for a week: its first page, and the same lines", async () => {
		const fake = artWorld();
		const compiled = compiledFor(fake);
		const first = await artNight(fake, compiled, null, 1);
		const second = await artNight(fake, compiled, first.state, 2);
		expect(pagesOf(second.asked, ART_REPS_QUERY)).toBe(1);
		expect(second.asked).toHaveLength(12);
		expect(second.line).toContain("art reps = (18)");
		expect(second.state.art).toEqual(first.state.art as NonNullable<typeof first.state.art>);
		// Scryfall keeps another printing for an artwork and the record's size does not move:
		// seen by the weekly read, not before.
		const [was, now] = ["1", "2"].map((n) => fake.cards.find((c) => c.set === "pre" && c.collector_number === n));
		(was as FakeCard).rep = false;
		fake.cards.push({ ...(now as FakeCard), id: uuid(820), collector_number: "2a", rep: true });
		const sixth = await artNight(fake, compiled, second.state, 6);
		expect(pagesOf(sixth.asked, ART_REPS_QUERY)).toBe(1);
		const eighth = await artNight(fake, compiled, sixth.state, 8);
		expect(pagesOf(eighth.asked, ART_REPS_QUERY)).toBe(2);
		expect(eighth.line).toContain("art reps +1 −1 (8 released");
		expect(eighth.state.art?.lines).toEqual(["art_rep\trow\tnew\ten\t1 3 5", "art_rep\trow\tpre\ten\t2 2a 3 4 5"]);
	});

	test("a record that grew is read the same night", async () => {
		const fake = artWorld();
		const compiled = compiledFor(fake);
		const first = await artNight(fake, compiled, null, 1);
		fake.cards.push({
			id: uuid(830),
			oracle_id: uuid(9830),
			name: "Preview 6",
			set: "pre",
			collector_number: "6",
			lang: "ja",
			is: [],
			released_at: "2026-11-20",
			rep: true,
		});
		const second = await artNight(fake, compiled, first.state, 2);
		expect(pagesOf(second.asked, ART_REPS_QUERY)).toBe(2);
		expect(second.line).toContain("art reps +1 −0 (9 released");
		// A row is its language's.
		expect(second.state.art?.lines).toContain("art_rep\trow\tpre\tja\t6");
		expect(second.state.art?.total).toBe(19);
	});

	test("a window that fits the first page is whole on its probe", async () => {
		const fake = artWorld(1);
		const compiled = compiledFor(fake);
		const first = await artNight(fake, compiled, null, 1);
		expect(pagesOf(first.asked, ART_REPS_QUERY)).toBe(1);
		expect(first.state.art?.lines).toEqual(["art_rep\trow\tnew\ten\t1 3 5", "art_rep\trow\tpre\ten\t1"]);
		const second = await artNight(fake, compiled, first.state, 2);
		expect(pagesOf(second.asked, ART_REPS_QUERY)).toBe(1);
		expect(second.line).toContain("art reps +0 −0 (4 released");
	});

	test("another compiled record moves the day, and the window is read back to it", async () => {
		const fake = artWorld();
		const compiled = compiledFor(fake);
		const first = await artNight(fake, compiled, null, 1);
		// `bun run art-reps` was run and committed: written a month later, so the day is the 9th of October.
		const later = await runNight(fake, compiled, first.state, night(2), 1000, artRepsFrom("2026-11-08"));
		expect(later.state.art?.from).toBe("2026-10-09");
		expect(later.state.art?.lines).toEqual(["art_rep\trow\tpre\ten\t1 2 3 4 5"]);
	});

	test("an answer that is not the record's newest end is refused, and the night goes on", async () => {
		const faults: Record<string, (truth: SearchAnswer, path: string) => SearchAnswer> = {
			"not newest first (2026-11-20 after 2026-10-02)": (t) => {
				const body = structuredClone(t.body) as { data: unknown[] };
				body.data.reverse();
				return { status: 200, body };
			},
			"has no release day": (t) => {
				const body = structuredClone(t.body) as { data: Record<string, unknown>[] };
				delete (body.data[1] as Record<string, unknown>).released_at;
				return { status: 200, body };
			},
			"the list moved while it was read (18 rows, then 19)": (t, path) =>
				path.includes("page=2") ? { status: 200, body: { ...(t.body as object), total_cards: 19 } } : t,
			"answered with a warning": (t) => ({ status: 200, body: { ...(t.body as object), warnings: ["x"] } }),
			"503": () => ({ status: 503, body: { object: "error" } }),
		};
		for (const [why, mangle] of Object.entries(faults)) {
			const fake = artWorld();
			const compiled = compiledFor(fake);
			fake.pageRows = 4;
			fake.fault = (path) => (path.includes("unique=art") ? mangle(fake.truth(path), path) : null);
			const ran = await artNight(fake, compiled, null, 1);
			expect(ran.line).toContain("art reps REFUSED");
			expect(ran.line).toContain(why);
			expect(ran.state.art).toBeUndefined();
			// The lists before it and the sets after it were read all the same.
			expect(ran.line).toContain("spikey first read (2)");
			expect(ran.line).toContain("owed a read, 2 read");
			expect(ran.state.checked).toBe("2026-10-10");
			expect(composeOverride(compiled, ran.state)).not.toContain("art-reps-from");
		}
		// A failed read leaves last night's rows in the table.
		const fake = artWorld();
		const compiled = compiledFor(fake);
		const first = await artNight(fake, compiled, null, 1);
		fake.cards.push({ ...(fake.cards.at(-1) as FakeCard), id: uuid(840), collector_number: "9" });
		fake.fault = (path) => (path.includes("unique=art") && path.includes("page=2") ? "throw" : null);
		const second = await artNight(fake, compiled, first.state, 2);
		expect(second.line).toContain("art reps REFUSED (fake Scryfall: connection reset)");
		expect(second.state.art).toEqual(first.state.art as NonNullable<typeof first.state.art>);
		expect(artLines(composeOverride(compiled, second.state))).toEqual(first.state.art?.lines as string[]);
	});

	test("a record with nothing released since the day is not an answer", async () => {
		const fake = artWorld(0);
		for (const card of fake.cards) if (card.set === "new") card.released_at = "2020-02-02";
		const ran = await artNight(fake, compiledFor(fake), null, 1);
		expect(ran.line).toContain(
			`art reps REFUSED (${ART_REPS_QUERY}: no artwork representative released since ${FROM})`,
		);
		expect(ran.state.art).toBeUndefined();
	});

	test("a window that has outgrown a night's read is refused, not read short", async () => {
		const fake = artWorld(ART_REPS_MAX_PAGES + 4);
		fake.pageRows = 1;
		const compiled = compiledFor(fake);
		const ran = await artNight(fake, compiled, null, 1);
		expect(pagesOf(ran.asked, ART_REPS_QUERY)).toBe(ART_REPS_MAX_PAGES);
		expect(ran.line).toContain(
			`art reps REFUSED (${ART_REPS_QUERY}: ${ART_REPS_MAX_PAGES} pages read and still on 2026-11-20`,
		);
		expect(ran.state.art).toBeUndefined();
		// The fixed part of the worst night with the record's read at its cap still fits the night.
		const pages = (rows: number) => Math.ceil(rows / SCRYFALL_PAGE_ROWS);
		const fixed =
			pages(422) + pages(92) + pages(5989) + pages(491) + pages(2773) + pages(72) + pages(678) + pages(3226) + 3 + 1;
		expect(fixed + ART_REPS_MAX_PAGES).toBeLessThanOrEqual(IS_LISTS_NIGHT_REQUESTS - 90);
	});

	test("the read survives the end of an alarm between any two pages", async () => {
		const fake = artWorld(9);
		fake.pageRows = 2;
		const compiled = compiledFor(fake);
		const whole = await artNight(fake, compiled, null, 1);
		const sliced = await artNight(artWorld(9), compiled, null, 1, 1);
		expect(sliced.work.slices).toBeGreaterThan(20);
		expect(sliced.state.art).toEqual(whole.state.art as NonNullable<typeof whole.state.art>);
	});

	test("an importer that cannot read the lines is asked nothing and handed none", async () => {
		const fake = artWorld();
		const compiled = compiledFor(fake);
		// No day: the blob has no `art_reps_written`, so it would refuse a table with such a line.
		const ran = await runNight(fake, compiled, null, night(1));
		expect(queries(ran.asked)).not.toContain(ART_REPS_QUERY);
		expect(ran.state.art).toBeUndefined();
		// A state another build's night left: its rows are kept and not handed over.
		const first = await artNight(fake, compiled, null, 1);
		const without = composeOverride(compiled, first.state, false) as string;
		expect(without).not.toContain("art_rep");
		expect(without).not.toContain("art-reps-from");
		expect(noteOf(first.state, COMPILED_DAY, false).art_reps).toBeUndefined();
		const blind = await runNight(fake, compiled, first.state, night(2));
		expect(blind.state.art).toEqual(first.state.art as NonNullable<typeof first.state.art>);
		// Rows that are not rows under a day never reach a builder.
		const bad = structuredClone(first.state);
		(bad.art as NonNullable<typeof bad.art>).lines.push("spikey\toracle\tx\tY");
		expect(() => composeOverride(compiled, bad)).toThrow(ListRefused);
	});
});
