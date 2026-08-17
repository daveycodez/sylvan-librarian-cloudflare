import { describe, expect, test } from "bun:test";
import { fnv1a64OracleId, partitionOfOracleId } from "../../src/engine/partition";
import vectors from "./partition-hash-vectors.json";

// The Rust twin (vendor/sylvan_librarian/card_engine/src/partition.rs) asserts
// the same file in cargo test. A hash disagreement between builder and router
// means cards silently vanish from results — CARD-PARTITIONING.md calls the
// hash agreement the highest-consequence detail in the design, so this suite
// is deliberately paranoid.

describe("partition hash parity", () => {
	test("vector file names the algorithm this implementation provides", () => {
		expect(vectors.algorithm).toBe("fnv1a64/oracle_id/v1");
	});

	test("vector set is large enough to trust", () => {
		expect(vectors.vectors.length).toBeGreaterThanOrEqual(32);
	});

	test("every shared vector hashes identically", () => {
		for (const v of vectors.vectors) {
			expect(fnv1a64OracleId(v.oracle_id).toString()).toBe(v.fnv1a64);
		}
	});

	test("uppercase input lands in the same partition", () => {
		const id = "5963eef1-1022-42b1-8a0c-fc9850bfc2a3";
		expect(fnv1a64OracleId(id.toUpperCase())).toBe(fnv1a64OracleId(id));
	});

	test("every residue is reachable at N=8", () => {
		const seen = new Set<number>();
		for (const v of vectors.vectors) {
			seen.add(partitionOfOracleId(v.oracle_id, 8));
		}
		expect(seen.size).toBe(8);
	});

	test("partition count must be a positive integer", () => {
		expect(() => partitionOfOracleId("x", 0)).toThrow();
		expect(() => partitionOfOracleId("x", 2.5)).toThrow();
	});
});
