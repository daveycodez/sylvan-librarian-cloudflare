// The reorder phase: rewriting the spill into build order.
//
// This is the one phase whose failure mode is silent. The build pulls rows
// positionally now, `build_store_stream` verifies only the row COUNT, and rows
// delivered out of order split a card's printings across non-adjacent groups —
// so a wrong reorder produces an archive that serializes cleanly, publishes,
// and is wrong. Nothing downstream catches it.
//
// So the round trip is pinned end to end against a real SQLite standing in for
// the Durable Object's: spill in add order → reorder in slices → build cursor,
// asserting the bytes the build sees are the spilled rows in exactly the
// permutation order, across slice boundaries and across a resume.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	blobGroups,
	exactBuffer,
	lengthPrefixed,
	orderedRowCursor,
	reorderSlice,
	spillIndex,
	splitBatch,
} from "../../src/import-spill";

/** Deterministic pseudo-random: a shuffle we can reproduce on failure. */
function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

/** Rows of varied length, each carrying its own add-index so a misplaced row
 * is identifiable rather than merely unequal. */
function makeRows(count: number, seed = 7): Uint8Array[] {
	const rand = lcg(seed);
	return Array.from({ length: count }, (_, i) => {
		const len = 4 + Math.floor(rand() * 60);
		const row = new Uint8Array(len);
		new DataView(row.buffer).setUint32(0, i, true);
		for (let at = 4; at < len; at++) row[at] = (i + at) & 0xff;
		return row;
	});
}

const addIndexOf = (row: Uint8Array) => new DataView(row.buffer, row.byteOffset, row.byteLength).getUint32(0, true);

/** The DO binds blob params as ArrayBuffer (see exactBuffer); bun:sqlite wants
 * a view. Same bytes, and the exact-buffer copy still gets exercised. */
const blobParam = (bytes: Uint8Array) => new Uint8Array(exactBuffer(bytes));

/** A permutation of 0..count-1, the stand-in for wasm's sorted_order(). */
function shuffledOrder(count: number, seed = 11): Uint32Array {
	const rand = lcg(seed);
	const idx = Array.from({ length: count }, (_, i) => i);
	for (let i = count - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[idx[i], idx[j]] = [idx[j] as number, idx[i] as number];
	}
	return Uint32Array.from(idx);
}

/**
 * The DO's spill/ordered tables against a real SQLite, driven through the same
 * functions ImportCoordinator calls. `groupBytes` is deliberately tiny so a
 * few dozen rows produce many groups — the interesting case is rows spread
 * across every group, which is what the full corpus does.
 */
class Harness {
	readonly db = new Database(":memory:");
	groupReads = 0;

	constructor(rows: Uint8Array[], groupBytes = 200) {
		this.db.exec("CREATE TABLE spill_batches (base INTEGER PRIMARY KEY, count INTEGER NOT NULL, bytes BLOB NOT NULL)");
		this.db.exec("CREATE TABLE ordered_rows (base INTEGER PRIMARY KEY, count INTEGER NOT NULL, bytes BLOB NOT NULL)");
		// Finalize's own grouping: byte-capped, keyed by the first row's index.
		let base = 0;
		let group: Uint8Array[] = [];
		let bytes = 0;
		const flush = () => {
			if (group.length === 0) return;
			this.db.run("INSERT INTO spill_batches (base, count, bytes) VALUES (?, ?, ?)", [
				base,
				group.length,
				blobParam(lengthPrefixed(group)),
			]);
			base += group.length;
			group = [];
			bytes = 0;
		};
		for (const row of rows) {
			if (group.length > 0 && bytes + 4 + row.length > groupBytes) flush();
			group.push(row);
			bytes += 4 + row.length;
		}
		flush();
	}

	get spillGroups(): number {
		return (this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM spill_batches").get() as { n: number }).n;
	}

	index() {
		const groups = this.db
			.query<{ base: number; bytes: Uint8Array }, []>("SELECT base, bytes FROM spill_batches ORDER BY base")
			.all();
		return spillIndex(groups.map((g) => ({ base: g.base, bytes: new Uint8Array(g.bytes) })));
	}

	/** One reorder slice, exactly as stepReorder commits it. */
	reorder(order: Uint32Array, from: number, to: number): void {
		const ordered = reorderSlice(order, this.index(), from, to, (base) => {
			const row = this.db
				.query<{ bytes: Uint8Array }, [number]>("SELECT bytes FROM spill_batches WHERE base = ?")
				.get(base);
			if (!row) return null;
			this.groupReads += 1;
			return new Uint8Array(row.bytes);
		});
		let base = from;
		for (const group of blobGroups(ordered)) {
			this.db.run("INSERT OR REPLACE INTO ordered_rows (base, count, bytes) VALUES (?, ?, ?)", [
				base,
				group.length,
				blobParam(lengthPrefixed(group)),
			]);
			base += group.length;
		}
	}

	/** Run the whole phase in slices of `sliceRows`. */
	reorderAll(order: Uint32Array, sliceRows: number): void {
		for (let from = 0; from < order.length; from += sliceRows) {
			this.reorder(order, from, Math.min(from + sliceRows, order.length));
		}
	}

	/** The build's pullRow handler, over this harness's ordered_rows. */
	cursor(order: Uint32Array): (index: number) => Uint8Array | null {
		return orderedRowCursor(order, (position) => {
			const row = this.db
				.query<{ base: number; bytes: Uint8Array }, [number]>(
					"SELECT base, bytes FROM ordered_rows WHERE base <= ? ORDER BY base DESC LIMIT 1",
				)
				.get(position);
			return row ? { base: row.base, bytes: new Uint8Array(row.bytes) } : null;
		});
	}

	/** What the wasm build would see, pulling in `order`. */
	drain(order: Uint32Array): Uint8Array[] {
		const pull = this.cursor(order);
		const out: Uint8Array[] = [];
		for (const idx of order) {
			const row = pull(idx);
			if (!row) break;
			out.push(row);
		}
		return out;
	}
}

describe("reorder round trip", () => {
	const ROWS = 500;

	test("the build sees every spilled row, in the permutation's order", () => {
		const rows = makeRows(ROWS);
		const order = shuffledOrder(ROWS);
		const h = new Harness(rows);
		h.reorderAll(order, 64);

		const seen = h.drain(order);
		expect(seen.length).toBe(ROWS);
		expect([...seen].map(addIndexOf)).toEqual([...order]);
		for (const [pos, row] of seen.entries()) {
			expect(row).toEqual(rows[order[pos] as number] as Uint8Array);
		}
	});

	test("a slice's rows really are scattered across the spill", () => {
		// Guards the test itself: if the fixture packed each slice's rows into a
		// handful of adjacent groups, it would not exercise the case the phase
		// exists for — the production build's lookups land in a different group
		// than the previous one ~60% of the time.
		const h = new Harness(makeRows(ROWS));
		expect(h.spillGroups).toBeGreaterThan(50);
		const index = h.index();
		const firstSlice = new Set([...shuffledOrder(ROWS).slice(0, 64)].map((i) => index.groupOf[i]));
		expect(firstSlice.size).toBeGreaterThan(48); // ~one distinct group per row
	});

	test("each spill group is read at most once per slice, not once per row", () => {
		const h = new Harness(makeRows(ROWS));
		const order = shuffledOrder(ROWS);
		const index = h.index();
		h.reorderAll(order, 100);

		// Exactly the distinct groups each slice needs — no group read twice.
		let expected = 0;
		for (let from = 0; from < ROWS; from += 100) {
			expected += new Set([...order.slice(from, from + 100)].map((i) => index.groupOf[i])).size;
		}
		expect(h.groupReads).toBe(expected);
		// The point of the phase: reads scale with groups, not with rows.
		expect(h.groupReads).toBeLessThan(ROWS);
	});

	test("slicing does not change the result", () => {
		const rows = makeRows(ROWS);
		const order = shuffledOrder(ROWS);
		const whole = new Harness(rows);
		whole.reorderAll(order, ROWS);
		const sliced = new Harness(rows);
		sliced.reorderAll(order, 37); // ragged: 500 is not a multiple of 37
		expect(sliced.drain(order)).toEqual(whole.drain(order));
	});

	test("a slice that dies mid-phase resumes from reorder_done", () => {
		const rows = makeRows(ROWS);
		const order = shuffledOrder(ROWS);
		const h = new Harness(rows);
		// Three slices land, the alarm is killed, the next one picks up the
		// committed cursor — the case an eviction mid-reorder produces.
		h.reorder(order, 0, 100);
		h.reorder(order, 100, 200);
		h.reorder(order, 200, 300);
		h.reorder(order, 300, 400);
		h.reorder(order, 400, ROWS);
		expect([...h.drain(order)].map(addIndexOf)).toEqual([...order]);
	});

	test("a retried slice overwrites its own output instead of appending", () => {
		// The alarm chain retries a failed slice with reorder_done unchanged, so
		// the same range is written twice. Duplicated rows here would be a store
		// with duplicate printings and no error anywhere.
		const rows = makeRows(ROWS);
		const order = shuffledOrder(ROWS);
		const h = new Harness(rows);
		h.reorder(order, 0, 100);
		const afterFirst = h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM ordered_rows").get() as { n: number };
		h.reorder(order, 0, 100); // the retry
		const afterRetry = h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM ordered_rows").get() as { n: number };
		expect(afterRetry.n).toBe(afterFirst.n);
		h.reorder(order, 100, ROWS);
		expect([...h.drain(order)].map(addIndexOf)).toEqual([...order]);
	});

	test("an identity permutation is still a faithful copy", () => {
		const rows = makeRows(120);
		const order = Uint32Array.from(rows.map((_, i) => i));
		const h = new Harness(rows);
		h.reorderAll(order, 16);
		expect(h.drain(order)).toEqual(rows);
	});

	test("a single row is not a special case", () => {
		const rows = makeRows(1);
		const order = Uint32Array.from([0]);
		const h = new Harness(rows);
		h.reorderAll(order, 64);
		expect(h.drain(order)).toEqual(rows);
	});
});

describe("reorderSlice memory discipline", () => {
	test("rows are copied out, not viewed into their group blob", () => {
		// A subarray would keep its whole group's buffer reachable for as long
		// as the row lives. Since a slice's rows are spread across effectively
		// every group, that pins the entire spill (~30-48MB at full corpus) in
		// an isolate whose wasm heap is already holding ~90MB of interners.
		// A row that owns a buffer exactly its own size retains nothing else.
		const rows = makeRows(200);
		const h = new Harness(rows);
		const ordered = reorderSlice(shuffledOrder(200), h.index(), 0, 200, (base) => {
			const row = h.db
				.query<{ bytes: Uint8Array }, [number]>("SELECT bytes FROM spill_batches WHERE base = ?")
				.get(base);
			return row ? new Uint8Array(row.bytes) : null;
		});
		for (const row of ordered) {
			expect(row.byteOffset).toBe(0);
			expect(row.buffer.byteLength).toBe(row.byteLength);
		}
	});
});

describe("orderedRowCursor guards the order it assumes", () => {
	const rows = makeRows(200);
	const order = shuffledOrder(200);

	function staged(): Harness {
		const h = new Harness(rows);
		h.reorderAll(order, 64);
		return h;
	}

	test("a pull out of order throws instead of building a wrong store", () => {
		const h = staged();
		const pull = h.cursor(order);
		pull(order[0] as number);
		// The build asking for a row the reorder did not put here means the two
		// derived different permutations — the silent-corruption case.
		expect(() => pull(order[7] as number)).toThrow(/build pulled row/);
	});

	test("the guard names both the requested and the written row", () => {
		const h = staged();
		const pull = h.cursor(order);
		expect(() => pull(order[3] as number)).toThrow(new RegExp(`row ${order[3]}.*position 0.*wrote ${order[0]}`));
	});

	test("pulling past the last row returns null rather than throwing", () => {
		const h = staged();
		const pull = h.cursor(order);
		for (const idx of order) expect(pull(idx)).not.toBeNull();
		expect(pull(0)).toBeNull();
	});

	test("a truncated ordered_rows table stops rather than serving wrong bytes", () => {
		const h = staged();
		// Drop everything past the first group: the shape a reorder killed
		// part-written would leave behind if its cursor were ever trusted.
		h.db.run("DELETE FROM ordered_rows WHERE base > 0");
		const pull = h.cursor(order);
		let served = 0;
		for (const idx of order) {
			if (pull(idx) === null) break;
			served += 1;
		}
		expect(served).toBeGreaterThan(0);
		expect(served).toBeLessThan(order.length);
	});
});

describe("reorderSlice failure modes", () => {
	test("an order naming a row that was never spilled is fatal", () => {
		const rows = makeRows(50);
		const h = new Harness(rows);
		const order = Uint32Array.from([...Array(50).keys(), 999]);
		expect(() => reorderSlice(order, h.index(), 0, 51, () => null)).toThrow(/unspilled row 999/);
	});

	test("a missing spill group is fatal rather than a short slice", () => {
		const rows = makeRows(50);
		const h = new Harness(rows);
		expect(() => reorderSlice(shuffledOrder(50), h.index(), 0, 50, () => null)).toThrow(/spill group \d+ missing/);
	});
});

describe("spill codec", () => {
	test("length-prefixed groups round trip", () => {
		const rows = makeRows(64);
		expect(splitBatch(lengthPrefixed(rows))).toEqual(rows);
	});

	test("zero-length rows survive the round trip", () => {
		// A legitimately empty row must decode as empty, not as a missing row.
		const rows = [new Uint8Array(0), Uint8Array.from([1, 2, 3]), new Uint8Array(0)];
		expect(splitBatch(lengthPrefixed(rows))).toEqual(rows);
	});

	test("spillIndex locates every row in its group", () => {
		const rows = makeRows(300);
		const h = new Harness(rows);
		const index = h.index();
		for (const [i, row] of rows.entries()) {
			expect(index.lengthOf[i]).toBe(row.length);
			expect(index.groupOf[i]).toBeLessThanOrEqual(i);
		}
	});
});
