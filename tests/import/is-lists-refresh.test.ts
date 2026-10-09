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
): Promise<Ran> {
	const from = fake.asked.length;
	let work = beginNight(compiled, stored && structuredClone(stored), nowMs);
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
		for (const tag of ["intro", "invitational", "jumpstart", "misprint"] as const)
			expect(base.totals[tag]).toBeGreaterThan(0);
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
		// The fixed part of the worst night — every small list whole (422, 92, 5,989 and 455 rows of
		// 175 a page; 72 and 678 cards), the foreign rows whole, three sizes and /sets — leaves the
		// sets most of the night's requests.
		const pages = (rows: number) => Math.ceil(rows / SCRYFALL_PAGE_ROWS);
		const fixed = pages(422) + pages(92) + pages(5989) + pages(455) + pages(72) + pages(678) + pages(3226) + 3 + 1;
		expect(fixed).toBe(70);
		expect(IS_LISTS_NIGHT_REQUESTS - fixed).toBeGreaterThanOrEqual(170);
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
