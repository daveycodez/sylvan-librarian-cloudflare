// The TS half of the query_keys wire contract: decode the COMMITTED packet bytes — emitted by
// the REAL Rust packer off a deterministic store (engine/wasm/src/lib.rs's
// query_keys_packet_matches_the_committed_wire_fixture, the other half of this pin) — with
// gather.ts's own codec, and hold every layout fact the merge relies on. If either side changes
// its layout alone, exactly one of the two suites goes red against the shared file.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compareKeys, decodeKeyPacket, KEY_PACKET_VERSION } from "../../src/engine/gather";

const fixture = JSON.parse(readFileSync(`${import.meta.dir}/gather-wire-fixture.json`, "utf8")) as {
	packet_version: number;
	sort_key_version: number;
	total: number;
	entries: number;
	inline_rows: number;
	packed_hex: string;
};

function hexBytes(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

describe("query_keys wire fixture (Rust packer ↔ gather.ts codec)", () => {
	test("the committed packet decodes to the pinned shape", () => {
		const packet = decodeKeyPacket(hexBytes(fixture.packed_hex));
		expect(packet.total).toBe(fixture.total);
		expect(packet.entries.length).toBe(fixture.entries);
		for (const entry of packet.entries) {
			// Every key leads with the layout version and carries the fixed 57-byte tail after
			// its variable primary segment (see encode_sort_key's layout doc).
			expect(entry.key[0]).toBe(fixture.sort_key_version);
			expect(entry.key.length).toBeGreaterThan(57);
			expect(entry.vpid).toBeGreaterThanOrEqual(0);
		}
		// The stream arrives in page order: bytewise nondecreasing under the merge comparator.
		for (let i = 1; i < packet.entries.length; i++) {
			const prev = packet.entries[i - 1];
			const cur = packet.entries[i];
			if (prev === undefined || cur === undefined) throw new Error("unreachable");
			expect(compareKeys(prev.key, cur.key)).toBeLessThanOrEqual(0);
		}
	});

	test("both sides agree on the packet layout version", () => {
		expect(fixture.packet_version).toBe(KEY_PACKET_VERSION);
	});

	test("the inline-row section carries real, parseable rows for the leading entries", () => {
		// The half a keys-only fixture would leave unpinned: the framed rows that let
		// the gather answer page 1 without a phase-2 call. The fixture was emitted with
		// fields=["name"], so the row is the projected object and nothing else.
		const packet = decodeKeyPacket(hexBytes(fixture.packed_hex));
		expect(packet.inlineRows.length).toBe(fixture.inline_rows);
		const first = packet.inlineRows[0];
		if (first === undefined) throw new Error("the fixture must carry at least one inline row");
		expect(JSON.parse(new TextDecoder().decode(first))).toEqual({ name: "Wire Alpha" });
	});

	test("a truncated packet is a loud error, never a short page", () => {
		const bytes = hexBytes(fixture.packed_hex);
		expect(() => decodeKeyPacket(bytes.subarray(0, bytes.length - 3))).toThrow();
	});
});
