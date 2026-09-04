// The draft partition-hash framing and its re-mod contract.
//
// Every draft leaves the transform framed [u64 le fnv1a64(oracle_id)][JSON]
// (engine/wasm-import emit kind 2) and lands in draft_batches with the hash in
// a parallel `part_hashes` vector. The hash — not a partition index — because
// partition_count is chosen by the BUILDER after transform (plan Decision 3b);
// the build loop groups drafts by re-modding the stored hash with whatever N
// it picked (draftsForPartition). These tests pin the codec round trip and
// that the re-mod agrees with src/engine/partition.ts for the same shared
// vectors the Rust side asserts (tests/engine/partition-hash-vectors.json) —
// disagreement here means a draft aggregates into the wrong partition's store.

import { describe, expect, test } from "bun:test";
import { fnv1a64OracleId, partitionOfOracleId } from "../../src/engine/partition";
import {
	bucketDrafts,
	draftsForPartition,
	lengthPrefixed,
	packPartHashes,
	splitBatch,
	splitDraftEmit,
	unpackPartHashes,
} from "../../src/import-spill";
import vectors from "../engine/partition-hash-vectors.json";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** The wasm's framing, reproduced byte for byte: [u64 le hash][JSON]. */
function frame(oracleId: string, json: string): Uint8Array {
	const body = enc.encode(json);
	const out = new Uint8Array(8 + body.length);
	new DataView(out.buffer).setBigUint64(0, fnv1a64OracleId(oracleId), true);
	out.set(body, 8);
	return out;
}

describe("draft emit framing", () => {
	test("splitDraftEmit recovers the vector-pinned hash and the untouched JSON", () => {
		for (const v of vectors.vectors) {
			const json = `{"oracle_id":"${v.oracle_id}"}`;
			const { partHash, draft } = splitDraftEmit(frame(v.oracle_id, json));
			// The Rust side pins these exact decimal strings in cargo test; the
			// framing must deliver the same u64 to the TypeScript side.
			expect(partHash.toString()).toBe(v.fnv1a64);
			expect(dec.decode(draft)).toBe(json);
		}
	});

	test("the stored hash re-mods to the same partition partition.ts computes", () => {
		// N-generic by construction: the draft never knew N, so the agreement
		// must hold for every modulus the builder might pick.
		for (const n of [2, 3, 8, 13]) {
			for (const v of vectors.vectors) {
				const { partHash } = splitDraftEmit(frame(v.oracle_id, "{}"));
				expect(Number(partHash % BigInt(n))).toBe(partitionOfOracleId(v.oracle_id, n));
			}
		}
	});

	test("a payload shorter than its hash prefix is an error, not a garbage hash", () => {
		expect(() => splitDraftEmit(new Uint8Array(7))).toThrow(/shorter than its hash prefix/);
	});
});

describe("part_hashes vector codec", () => {
	test("round-trips, preserving order and the full 64-bit range", () => {
		const hashes = [0n, 1n, 0xffffffffffffffffn, fnv1a64OracleId("5963eef1-1022-42b1-8a0c-fc9850bfc2a3")];
		expect(unpackPartHashes(packPartHashes(hashes))).toEqual(hashes);
		expect(packPartHashes(hashes).length).toBe(32);
	});

	test("a misaligned blob is an error", () => {
		expect(() => unpackPartHashes(new Uint8Array(12))).toThrow(/not a multiple/);
	});
});

describe("draftsForPartition", () => {
	/** Batches shaped exactly like draft_batches rows: length-prefixed drafts + parallel hashes. */
	function makeBatches(ids: string[], perBatch: number): { bytes: Uint8Array; partHashes: Uint8Array }[] {
		const out: { bytes: Uint8Array; partHashes: Uint8Array }[] = [];
		for (let at = 0; at < ids.length; at += perBatch) {
			const slice = ids.slice(at, at + perBatch);
			out.push({
				bytes: lengthPrefixed(slice.map((id) => enc.encode(`{"oracle_id":"${id}"}`))),
				partHashes: packPartHashes(slice.map((id) => fnv1a64OracleId(id))),
			});
		}
		return out;
	}

	const ids = vectors.vectors.map((v) => v.oracle_id);

	test("partitions are disjoint and their union is every draft, in emission order", () => {
		for (const n of [2, 8]) {
			const seen: string[] = [];
			for (let k = 0; k < n; k++) {
				for (const draft of draftsForPartition(makeBatches(ids, 5), k, n)) {
					const oracleId = (JSON.parse(dec.decode(draft)) as { oracle_id: string }).oracle_id;
					expect(partitionOfOracleId(oracleId, n)).toBe(k);
					seen.push(oracleId);
				}
			}
			expect(seen.length).toBe(ids.length);
			expect(new Set(seen).size).toBe(ids.length);
			// Within one partition the drafts arrive in emission order — the order
			// the dedupe's first-seen/last-wins semantics depend on.
			const partitionZero = [...draftsForPartition(makeBatches(ids, 5), 0, n)].map(
				(d) => (JSON.parse(dec.decode(d)) as { oracle_id: string }).oracle_id,
			);
			expect(partitionZero).toEqual(ids.filter((id) => partitionOfOracleId(id, n) === 0));
		}
	});

	test("a batch whose hash vector lost sync with its drafts is an error", () => {
		const batch = {
			bytes: lengthPrefixed([enc.encode("{}"), enc.encode("{}")]),
			partHashes: packPartHashes([1n]),
		};
		expect(() => [...draftsForPartition([batch], 0, 2)]).toThrow(/2 drafts but 1 hashes/);
	});

	test("refuses a non-positive or fractional partition count", () => {
		expect(() => [...draftsForPartition([], 0, 0)]).toThrow(/positive integer/);
		expect(() => [...draftsForPartition([], 0, 2.5)]).toThrow(/positive integer/);
	});

	test("bucketDrafts splits one batch into exactly what draftsForPartition yields for every k", () => {
		// The bucket phase runs this once per batch where the loop used to run
		// draftsForPartition N times over every batch: same modulus, same order,
		// one pass — so the two must agree draft for draft.
		for (const n of [2, 8]) {
			for (const batch of makeBatches(ids, 5)) {
				const buckets = bucketDrafts(batch, n);
				expect(buckets.length).toBe(n);
				for (let k = 0; k < n; k++) {
					expect((buckets[k] as Uint8Array[]).map((d) => dec.decode(d))).toEqual(
						[...draftsForPartition([batch], k, n)].map((d) => dec.decode(d)),
					);
				}
				// Every draft lands in exactly one bucket, and the bucket is a view, not a copy.
				expect(buckets.reduce((s: number, b: Uint8Array[]) => s + b.length, 0)).toBe(splitBatch(batch.bytes).length);
				const first = buckets.flat()[0];
				expect(first?.buffer).toBe(batch.bytes.buffer);
			}
		}
	});

	test("bucketDrafts refuses a desynced hash vector and a bad partition count", () => {
		const batch = { bytes: lengthPrefixed([enc.encode("{}"), enc.encode("{}")]), partHashes: packPartHashes([1n]) };
		expect(() => bucketDrafts(batch, 2)).toThrow(/2 drafts but 1 hashes/);
		expect(() => bucketDrafts(batch, 0)).toThrow(/positive integer/);
	});
});
