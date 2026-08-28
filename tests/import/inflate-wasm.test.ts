// The resumable wasm inflater vs the PLATFORM's DecompressionStream — the
// decoder it replaces on the recode path — through the REAL committed blob.
//
// The Rust crate (engine/inflate) carries its own differential suite against
// flate2 at native speed and adversarial depth (every-byte splits, a 256MiB
// stream); what THIS file pins is the boundary that suite cannot reach: the
// committed wasm artifact, the C-ABI glue, and byte-identity against the very
// DecompressionStream whose output the recode phase used to consume — plus a
// committed fixture from a THIRD encoder (CLI gzip -9, FNAME header set) so
// the inflater is never proven against only one compressor's habits.

import { describe, expect, test } from "bun:test";
import { gzipBytes } from "../../src/engine/store-kv";
import { InflateRecodeSource } from "../../src/import-recode";
import { instantiate } from "./inflate-host";

/** Card-shaped JSONL at roughly the real dump's compression ratio. */
function makeRaw(bytes: number, seed = 7): Uint8Array {
	let s = seed >>> 0;
	const rand = () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
	const hex = (n: number) =>
		Math.floor(rand() * 2 ** (4 * n))
			.toString(16)
			.padStart(n, "0");
	const parts: string[] = [];
	let total = 0;
	for (let i = 0; total < bytes; i++) {
		const line = `{"object":"card","id":"${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}","name":"Card ${i}","lang":"en","cmc":${Math.floor(rand() * 16)},"prices":{"usd":"${(rand() * 90).toFixed(2)}"},"oracle_text":"Whenever this attacks, draw a card. ${"x".repeat(Math.floor(rand() * 40))}"}\n`;
		parts.push(line);
		total += line.length;
	}
	return new TextEncoder().encode(parts.join("")).subarray(0, bytes);
}

async function decompressionStream(gz: Uint8Array): Promise<Uint8Array> {
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(gz);
			controller.close();
		},
	});
	const reader = source.pipeThrough(new DecompressionStream("gzip")).getReader();
	const parts: Uint8Array[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(value);
	}
	return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/** One-pass decode through a single wasm instance. */
function wasmOnePass(gz: Uint8Array): Uint8Array {
	const host = instantiate();
	host.begin();
	const parts: Uint8Array[] = [];
	let at = 0;
	for (;;) {
		const { consumed, output } = host.feed(gz.subarray(at), Number.MAX_SAFE_INTEGER);
		at += consumed;
		if (output) parts.push(output);
		if (at >= gz.length && !output) break;
	}
	expect(host.atBoundary()).toBe(true);
	return concat(parts);
}

/**
 * The cross-alarm shape: decode chopped at every `memberRaw` grid line AND at
 * the given feed sizes, hopping to a BRAND-NEW wasm instance via
 * save → restore at every grid stop. Returns the reassembled raw bytes.
 */
function wasmChopped(gz: Uint8Array, memberRaw: number, feedSize: (i: number) => number): Uint8Array {
	let host = instantiate();
	host.begin();
	const parts: Uint8Array[] = [];
	let produced = 0;
	let at = 0;
	let feeds = 0;
	let pending: Uint8Array = gz.subarray(0, 0);
	for (;;) {
		if (pending.length === 0 && at < gz.length) {
			const n = Math.max(1, Math.min(feedSize(feeds++), gz.length - at));
			pending = gz.subarray(at, at + n);
			at += n;
		}
		const cap = memberRaw - (produced % memberRaw);
		const { consumed, output } = host.feed(pending, cap);
		pending = pending.subarray(consumed);
		if (output) {
			parts.push(output);
			produced += output.length;
		}
		if (produced % memberRaw === 0 && produced > 0) {
			// The alarm boundary: state out, instance discarded, state in.
			const state = host.save();
			const next = instantiate();
			const off = next.restore(state);
			expect(off).not.toBeNull();
			expect(next.totalOut()).toBe(produced);
			// A restored state must re-serialize byte-identically.
			expect(next.save()).toEqual(state);
			host = next;
		}
		if (pending.length === 0 && at >= gz.length && !output) {
			expect(host.atBoundary()).toBe(true);
			return concat(parts);
		}
	}
}

const RAW = makeRaw(6 * 1024 * 1024);
const GZ = await gzipBytes(RAW);
const NATIVE = await decompressionStream(GZ);

describe("wasm inflater vs DecompressionStream", () => {
	test("the platform decoder agrees with the source (sanity)", () => {
		expect(NATIVE).toEqual(RAW);
	});

	test("one pass is byte-identical", () => {
		expect(wasmOnePass(GZ)).toEqual(NATIVE);
	});

	test("member-grid stops with cross-instance restores are byte-identical", () => {
		// 256KB grid → 24 instance hops; varied feed sizes land the input
		// splits at uncorrelated bit positions.
		let s = 99;
		const out = wasmChopped(GZ, 256 * 1024, () => {
			s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
			return 1 + (s % (96 * 1024));
		});
		expect(out).toEqual(NATIVE);
	});

	test("single-byte feeds through the header region still decode", () => {
		// 1-byte feeds for the first 4KB (header + first blocks — every byte a
		// suspension), then large feeds to finish.
		const out = wasmChopped(GZ, 512 * 1024, (i) => (i < 4096 ? 1 : 512 * 1024));
		expect(out).toEqual(NATIVE);
	});

	test("the committed CLI-gzip fixture (third encoder, FNAME header) decodes identically", async () => {
		const gz = new Uint8Array(await Bun.file(new URL("fixtures/recode-sample.json.gz", import.meta.url)).arrayBuffer());
		const native = await decompressionStream(gz);
		expect(wasmOnePass(gz)).toEqual(native);
		const chopped = wasmChopped(gz, 64 * 1024, () => 4096);
		expect(chopped).toEqual(native);
	});
});

describe("checkpoint refusal", () => {
	test("a bumped version stamp is refused", () => {
		const host = instantiate();
		host.begin();
		host.feed(GZ.subarray(0, 100_000), Number.MAX_SAFE_INTEGER);
		const state = host.save();
		const stamped = state.slice();
		stamped[4] = 0xff; // STATE_VERSION low byte
		expect(instantiate().restore(stamped)).toBeNull();
	});

	test("a truncated or magic-corrupt blob is refused", () => {
		const host = instantiate();
		host.begin();
		host.feed(GZ.subarray(0, 100_000), Number.MAX_SAFE_INTEGER);
		const state = host.save();
		expect(instantiate().restore(state.subarray(0, state.length - 1))).toBeNull();
		const bad = state.slice();
		bad[0] = (bad[0] ?? 0) ^ 0xff;
		expect(instantiate().restore(bad)).toBeNull();
	});

	test("a valid blob restores to the exact compressed offset", () => {
		const host = instantiate();
		host.begin();
		const { consumed } = host.feed(GZ.subarray(0, 200_000), 1024 * 1024);
		const off = instantiate().restore(host.save());
		expect(off).toBe(consumed);
	});
});

describe("InflateRecodeSource over the real wasm", () => {
	async function* rows(gz: Uint8Array, rowBytes: number): AsyncGenerator<Uint8Array> {
		for (let at = 0; at < gz.length; at += rowBytes) {
			yield gz.subarray(at, Math.min(at + rowBytes, gz.length));
		}
	}

	test("chunks never cross the member grid, and reassemble identically", async () => {
		const memberRaw = 128 * 1024;
		const host = instantiate();
		host.begin();
		const source = new InflateRecodeSource(host.resumable(), rows(GZ, 7000)[Symbol.asyncIterator](), 0, memberRaw);
		const parts: Uint8Array[] = [];
		let produced = 0;
		for await (const chunk of source.stream()) {
			const boundary = memberRaw - (produced % memberRaw);
			expect(chunk.length).toBeLessThanOrEqual(boundary);
			produced += chunk.length;
			parts.push(chunk);
		}
		expect(source.produced).toBe(RAW.length);
		expect(host.totalOut()).toBe(RAW.length);
		expect(concat(parts)).toEqual(NATIVE);
	});

	test("a truncated staged stream throws instead of ending clean", async () => {
		const host = instantiate();
		host.begin();
		const cut = GZ.subarray(0, GZ.length - 9); // inside the trailer
		const source = new InflateRecodeSource(host.resumable(), rows(cut, 5000)[Symbol.asyncIterator](), 0, 128 * 1024);
		await expect(async () => {
			for await (const _ of source.stream()) {
				// drain
			}
		}).toThrow(/truncated/);
	});
});
