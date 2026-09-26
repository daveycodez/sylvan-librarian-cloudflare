// decodeFuzzyCandidates against a hand-packed reply, and uuidFromBytes against the spelling the old
// per-call path produced (Array.from + toString(16).padStart + join + five slices).
import { describe, expect, test } from "bun:test";
import { decodeUtf8, uuidFromBytes } from "../../src/engine/bytes";
import { decodeFuzzyCandidates } from "../../src/engine/fuzzy-wire";

function oldSpelling(bytes: Uint8Array): string {
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return hex === "00000000000000000000000000000000"
		? ""
		: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuidBytes(uuid: string): Uint8Array {
	const hex = uuid.replaceAll("-", "");
	return Uint8Array.from({ length: 16 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

function pack(rows: { score: number; oracle: Uint8Array; vpid: number; served: boolean; name: string }[]): Uint8Array {
	const names = rows.map((r) => new TextEncoder().encode(r.name));
	const size = 4 + rows.reduce((n, _, i) => n + 4 + 16 + 4 + 1 + 2 + (names[i] as Uint8Array).length, 0);
	const out = new Uint8Array(size);
	const view = new DataView(out.buffer);
	view.setUint32(0, rows.length, true);
	let at = 4;
	rows.forEach((r, i) => {
		const name = names[i] as Uint8Array;
		view.setFloat32(at, r.score, true);
		at += 4;
		out.set(r.oracle, at);
		at += 16;
		view.setUint32(at, r.vpid, true);
		at += 4;
		out[at] = r.served ? 1 : 0;
		at += 1;
		view.setUint16(at, name.length, true);
		at += 2;
		out.set(name, at);
		at += name.length;
	});
	return out;
}

describe("uuidFromBytes", () => {
	test("matches the old spelling on every byte value in every position", () => {
		for (let b = 0; b < 256; b++) {
			const bytes = Uint8Array.from({ length: 16 }, (_, i) => (b + i * 17) & 0xff);
			expect(uuidFromBytes(bytes, 0)).toBe(oldSpelling(bytes));
		}
	});

	test("the nil id spells as the nil uuid, which the decoder turns into the old path's empty string", () => {
		const nil = new Uint8Array(16);
		expect(oldSpelling(nil)).toBe("");
		expect(uuidFromBytes(nil, 0)).toBe("00000000-0000-0000-0000-000000000000");
	});

	test("reads at an offset inside a larger buffer", () => {
		const id = "e3285e6b-3e79-4d7c-bf96-d920f973b80a";
		const buf = new Uint8Array(40);
		buf.set(uuidBytes(id), 7);
		expect(uuidFromBytes(buf, 7)).toBe(id);
	});
});

describe("decodeFuzzyCandidates", () => {
	test("decodes scores, ids, the nil id, served flags and UTF-8 names", () => {
		const bolt = "e3285e6b-3e79-4d7c-bf96-d920f973b80a";
		const packed = pack([
			{ score: 0.875, oracle: uuidBytes(bolt), vpid: 123456, served: true, name: "lightning bolt" },
			{ score: 0.625, oracle: new Uint8Array(16), vpid: 7, served: false, name: "éowyn, lady of rohan" },
		]);
		expect(decodeFuzzyCandidates(packed)).toEqual([
			{ score: 0.875, served: true, oracleId: bolt, vpid: 123456, foldedName: "lightning bolt" },
			{ score: 0.625, served: false, oracleId: "", vpid: 7, foldedName: "éowyn, lady of rohan" },
		]);
	});

	test("reads a reply that is a view into a larger buffer", () => {
		const bolt = "e3285e6b-3e79-4d7c-bf96-d920f973b80a";
		const inner = pack([{ score: 0.75, oracle: uuidBytes(bolt), vpid: 9, served: true, name: "bolt" }]);
		const outer = new Uint8Array(inner.length + 11);
		outer.set(inner, 5);
		expect(decodeFuzzyCandidates(outer.subarray(5, 5 + inner.length))).toEqual([
			{ score: 0.75, served: true, oracleId: bolt, vpid: 9, foldedName: "bolt" },
		]);
	});

	test("an empty reply is an empty list", () => {
		expect(decodeFuzzyCandidates(pack([]))).toEqual([]);
	});

	test("x25: the first-printed trailer after the records is each candidate's firstReleased, in order", () => {
		const bolt = "e3285e6b-3e79-4d7c-bf96-d920f973b80a";
		const records = pack([
			{ score: 0.5714, oracle: uuidBytes(bolt), vpid: 1, served: true, name: "storm sculptor" },
			{ score: 0.5714, oracle: new Uint8Array(16), vpid: 2, served: true, name: "soul sculptor" },
		]);
		const packed = new Uint8Array(records.length + 8);
		packed.set(records, 0);
		const view = new DataView(packed.buffer);
		view.setUint32(records.length, 20170929, true);
		view.setUint32(records.length + 4, 19981012, true);
		const got = decodeFuzzyCandidates(packed);
		expect(got.map((c) => [c.foldedName, c.firstReleased])).toEqual([
			["storm sculptor", 20170929],
			["soul sculptor", 19981012],
		]);
		// An object on the build before x25 writes the records alone: no firstReleased at all.
		expect(decodeFuzzyCandidates(records).every((c) => c.firstReleased === undefined)).toBe(true);
	});

	test("the shared decoder is safe to reuse across calls", () => {
		const a = new TextEncoder().encode("Æther Vial");
		expect(decodeUtf8(a)).toBe("Æther Vial");
		expect(decodeUtf8(a.subarray(0, 2))).toBe("Æ");
		expect(decodeUtf8(new Uint8Array(0))).toBe("");
	});
});
