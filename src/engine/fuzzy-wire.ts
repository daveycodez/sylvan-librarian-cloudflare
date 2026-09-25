// The packed reply of the engine's `fuzzy_candidates` export, decoded. Its own module (not
// store.ts) so it can be tested without the wasm engine store.ts imports.

import { decodeUtf8, uuidFromBytes } from "./bytes";
import type { FuzzyCandidateWire } from "./types";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** Decode `fuzzy_candidates`' packed reply: `n: u32, then n of (score: f32, oracle_id: 16B,
 * vpid: u32, served: u8, namelen: u16, name)`, all LITTLE-ENDIAN except the oracle's raw uuid
 * bytes. */
export function decodeFuzzyCandidates(packed: Uint8Array): FuzzyCandidateWire[] {
	const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
	const n = view.getUint32(0, true);
	const out: FuzzyCandidateWire[] = [];
	let at = 4;
	for (let i = 0; i < n; i++) {
		const score = view.getFloat32(at, true);
		at += 4;
		const uuid = uuidFromBytes(packed, at);
		at += 16;
		// All-zero bytes are the engine's "no oracle id", which the wire carries as "".
		const oracleId = uuid === NIL_UUID ? "" : uuid;
		const vpid = view.getUint32(at, true);
		at += 4;
		const served = packed[at] === 1;
		at += 1;
		const len = view.getUint16(at, true);
		at += 2;
		const foldedName = decodeUtf8(packed.subarray(at, at + len));
		at += len;
		out.push({ score, served, oracleId, vpid, foldedName });
	}
	return out;
}
