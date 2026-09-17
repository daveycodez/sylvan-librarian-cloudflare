// Streamed dumps (all_cards, default_cards): the checkpoint invariant everything rests on.
//
// Since 2026-09-17 the transform and canonical phases stream their dumps straight from Scryfall
// instead of staging them in Durable Object storage. Each alarm restores the wasm gzip decoder from
// a snapshot taken on a grid line (InflateRecodeSource's onGrid), issues ONE ranged request at the
// compressed offset the snapshot names, and re-inflates at most one grid step before its first line.
// If a snapshot described any offset other than exactly its grid line, every resumed slice would
// feed shifted or duplicated bytes into a store that builds anyway. These pin that it does not —
// against the real wasm decoder and a real multi-member gzip, the way recode-resume.test.ts pins
// the checkpoints it grew out of.

import { describe, expect, test } from "bun:test";
import { gzipBytes } from "../../src/engine/store-kv";
import { InflateRecodeSource, skipBytes } from "../../src/import-recode";
import { instantiate } from "./inflate-host";

const GRID = 4096;

function makeRaw(bytes: number, seed = 11): Uint8Array {
	let s = seed >>> 0;
	const rand = () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
	const lines: string[] = [];
	let total = 0;
	for (let i = 0; total < bytes; i++) {
		const line = `{"object":"card","seq":${i},"name":"card ${i}","pad":"${"y".repeat(Math.floor(rand() * 60))}"}\n`;
		lines.push(line);
		total += line.length;
	}
	return new TextEncoder().encode(lines.join("")).subarray(0, bytes);
}

/** A file served in network-sized pieces from a compressed offset, like a ranged response body. */
function served(file: Uint8Array, fromComp: number, piece = 1337): AsyncIterator<Uint8Array> {
	let at = fromComp;
	return {
		next: async () => {
			if (at >= file.length) return { done: true, value: undefined };
			const value = file.slice(at, Math.min(file.length, at + piece));
			at += value.length;
			return { done: false, value };
		},
	};
}

async function collect(source: AsyncIterable<Uint8Array>, limit = Number.POSITIVE_INFINITY): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	let n = 0;
	for await (const chunk of source) {
		parts.push(chunk.slice());
		n += chunk.length;
		if (n >= limit) break;
	}
	const out = new Uint8Array(n);
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return limit === Number.POSITIVE_INFINITY ? out : out.subarray(0, limit);
}

/** Scryfall's files are one gzip member; a concatenation of members must stream just as well. */
async function gzipFile(raw: Uint8Array, members = 1): Promise<Uint8Array> {
	const cut = Math.ceil(raw.length / members);
	const parts: Uint8Array[] = [];
	for (let at = 0; at < raw.length; at += cut) parts.push(await gzipBytes(raw.subarray(at, at + cut)));
	return new Uint8Array(await new Blob(parts).arrayBuffer());
}

describe("stream checkpoints", () => {
	for (const members of [1, 3]) {
		test(`every grid snapshot restores to exactly its raw offset (${members} gzip member(s))`, async () => {
			const raw = makeRaw(GRID * 9 + 777);
			const file = await gzipFile(raw, members);

			const host = instantiate();
			host.begin();
			const snapshots: { raw: number; state: Uint8Array }[] = [];
			const source = new InflateRecodeSource(host.resumable(), served(file, 0), 0, GRID, (produced) => {
				expect(host.totalOut()).toBe(produced);
				snapshots.push({ raw: produced, state: host.save() });
			});
			expect(await collect(source.stream())).toEqual(raw);
			expect(snapshots.map((s) => s.raw)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => k * GRID));

			for (const snap of snapshots) {
				const fresh = instantiate();
				const compOffset = fresh.restore(snap.state);
				expect(compOffset).not.toBeNull();
				expect(fresh.totalOut()).toBe(snap.raw);
				const resumed = new InflateRecodeSource(fresh.resumable(), served(file, compOffset as number), snap.raw, GRID);
				expect(await collect(resumed.stream())).toEqual(raw.subarray(snap.raw));
			}
		});
	}

	test("a consumer that stops mid-grid resumes from the newest snapshot at or before its cursor, then skips", async () => {
		// The coordinator's shape: the line scanner stops somewhere past a grid line
		// (and the decoder may have run ahead to the next one); the persisted
		// snapshot is the newest at or before the cursor, and the next alarm
		// re-inflates from it and skips to the cursor.
		const raw = makeRaw(GRID * 6);
		const file = await gzipFile(raw);
		const cursor = GRID * 3 + 1234;

		const host = instantiate();
		host.begin();
		const snapshots: { raw: number; state: Uint8Array }[] = [];
		const source = new InflateRecodeSource(host.resumable(), served(file, 0), 0, GRID, (produced) => {
			snapshots.push({ raw: produced, state: host.save() });
		});
		expect(await collect(source.stream(), cursor + GRID / 2)).toEqual(raw.subarray(0, cursor + GRID / 2));
		const snap = [...snapshots].reverse().find((s) => s.raw <= cursor);
		expect(snap?.raw).toBe(GRID * 3);

		const fresh = instantiate();
		const compOffset = fresh.restore((snap as { state: Uint8Array }).state) as number;
		const resumed = new InflateRecodeSource(fresh.resumable(), served(file, compOffset), GRID * 3, GRID);
		expect(await collect(skipBytes(resumed.stream(), cursor - GRID * 3))).toEqual(raw.subarray(cursor));
	});

	test("a body cut off mid-member is an error, not a silently short dump", async () => {
		const raw = makeRaw(GRID * 3);
		const file = await gzipFile(raw);
		const host = instantiate();
		host.begin();
		const source = new InflateRecodeSource(host.resumable(), served(file.subarray(0, file.length - 40), 0), 0, GRID);
		await expect(collect(source.stream())).rejects.toThrow(/truncated/);
	});
});
