// /cards/autocomplete from ONE object (n8), against today's fan-out on the REAL corpus.
//
// The claim n8 rests on is that the card-names blob, ranked by engine/wasm/src/names.rs, answers
// byte for byte what the partitioned fan-out answers: every partition's own `autocomplete`, merged
// by the production `mergeAutocomplete`. This checks it on every partition of a local store build,
// through the committed wasm, the production encoder (encodeCardNames) and the route's own needle
// folding, for:
//
//   - all 1,296 two-character needles over [a-z0-9],
//   - 5,000 random 3–6 character substrings of real collated names (seeded, so a failure repeats),
//   - the adversarial shapes: accents, punctuation that collates away, separators, digits, CJK,
//     one-letter needles that look two long, and needles nothing contains.
//
// The blob here is assembled from each archive's own name records (`store_name_records_tsv`, the
// archived twin of what the builders publish since n15's format 2; the Rust suites pin the two
// equal), each led by its partition as the publishers lead them. The fixture-sized version
// of this differential runs in CI (`cargo test`, engine/wasm/src/names.rs); this one is opt-in
// because it loads every partition of the corpus:
//
//   SYLVAN_REAL_DIFFERENTIAL=1 bun test tests/engine/autocomplete-names-real.test.ts
//
// with STORE_BUILD_DIR pointing at a store build (default: this checkout's store-build/).

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { cardNamesCount, encodeCardNames, ledByPartition } from "../../src/engine/card-names";
import { mergeAutocomplete } from "../../src/engine/partitioned-engine";
import { foldAccents } from "../../src/parser/pystr";
import { newEngine } from "./wasm-engine";

const STORE_DIR = process.env.STORE_BUILD_DIR ?? join(import.meta.dir, "../../store-build");
const MANIFEST = join(STORE_DIR, "manifest.json");
const LIMIT = 20; // MAX_AUTOCOMPLETE_VALUES, the only limit the route sends

interface Manifest {
	format_version: number;
	partitions: { store_key: string }[];
}

const opted = process.env.SYLVAN_REAL_DIFFERENTIAL === "1";
const manifest: Manifest | null =
	opted && existsSync(MANIFEST) ? (JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest) : null;
const readable = manifest !== null && manifest.format_version === newEngine().use((g) => g.store_version());

/** mulberry32: a seeded generator, so a failing needle is the same needle next run. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const ADVERSARIAL = [
	"lim-dul",
	"lim-dûl",
	"limdul",
	"Lim-Dûl's Vault",
	"eowyn",
	"éowyn",
	"ÉOWYN",
	"jotun",
	"jötun",
	"aether",
	"æther",
	"ningbolt",
	"lightning bolt",
	"LIGHT",
	"_____",
	"_____ goblin",
	"gob",
	"fire // ice",
	"fire//ice",
	"who // what",
	"b.f.m.",
	"100,000",
	"1996",
	"borrowing 100",
	"a",
	"a.",
	"a ",
	" a",
	"--",
	"''",
	"x",
	"zzzzzz",
	"qqq",
	"アク",
	"ア",
	"ß",
	"straße",
	"ø",
	"ł",
	"🙂",
	"sh",
	"ser",
	"lig",
	"ang",
	"the",
	"of the",
	"and",
	"ajani,",
	"ajani goldmane",
	"our market research",
	"elemental",
	"token",
	"shark",
	"lightning",
];

describe.skipIf(!readable)(`autocomplete from the names blob vs the fan-out, on ${STORE_DIR}`, () => {
	test(
		"byte-identical on every needle",
		() => {
			const parts = (manifest as Manifest).partitions;
			const engine = newEngine();
			const text = new TextEncoder();
			const lines: Uint8Array[] = [];
			const collated: string[] = [];

			// Every needle, folded exactly as the route folds it before the engine sees it.
			const random = rng(0x5eed);
			const needles: string[] = [];
			const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
			for (const a of alphabet) for (const b of alphabet) needles.push(a + b);

			// Pass 1, one partition at a time: its records for the blob, and its answers for the merge.
			const perPartition: string[][][] = [];
			let fanOutMs = 0;
			const loadPartition = (k: number) => {
				const bytes = new Uint8Array(readFileSync(join(STORE_DIR, (parts[k] as { store_key: string }).store_key)));
				engine.use((g) => g.init_store(bytes));
			};
			for (let k = 0; k < parts.length; k++) {
				loadPartition(k);
				const pairs = JSON.parse(engine.use((g) => g.store_autocomplete_names())) as [string, string][];
				const records = new TextDecoder().decode(engine.use((g) => g.store_name_records_tsv()));
				lines.push(text.encode(ledByPartition(k, records)));
				for (const [c] of pairs) collated.push(c);
			}
			// The substrings come from the whole corpus's names, so they are drawn once all are in.
			const withLength = collated.filter((c) => [...c].length >= 3);
			for (let i = 0; i < 5000; i++) {
				const chars = [...(withLength[Math.floor(random() * withLength.length)] as string)];
				const len = 3 + Math.floor(random() * 4);
				const start = Math.floor(random() * Math.max(1, chars.length - len + 1));
				needles.push(chars.slice(start, start + len).join(""));
			}
			needles.push(...ADVERSARIAL);
			const folded = needles.map((q) => foldAccents(q.trim().toLowerCase()));

			for (let k = 0; k < parts.length; k++) {
				loadPartition(k);
				const started = performance.now();
				perPartition.push(folded.map((q) => JSON.parse(engine.use((g) => g.autocomplete(q, LIMIT))) as string[]));
				fanOutMs += performance.now() - started;
			}

			// The blob, through the production encoder, gzipped as KV and the object caches hold it.
			const raw = encodeCardNames(lines);
			const gz = gzipSync(raw, { level: 9 });
			const loaded = engine.use((g) => g.load_names(gz));
			expect(loaded).toBe(cardNamesCount(raw));

			let differing = 0;
			let answered = 0;
			const shown: string[] = [];
			const started = performance.now();
			const fromNames = folded.map((q) => engine.use((g) => g.names_autocomplete(q, LIMIT)));
			const namesMs = performance.now() - started;
			for (let i = 0; i < folded.length; i++) {
				const q = folded[i] as string;
				const merged = mergeAutocomplete(
					perPartition.map((answers) => answers[i] as string[]),
					q,
					LIMIT,
				);
				// Byte-identical: the catalog is serialized from exactly this array.
				if (fromNames[i] !== JSON.stringify(merged)) {
					differing++;
					if (shown.length < 10)
						shown.push(`${JSON.stringify(q)}: names ${fromNames[i]} vs merge ${JSON.stringify(merged)}`);
				}
				if (merged.length > 0) answered++;
			}
			console.log(
				`names blob: ${loaded} records, ${raw.byteLength} bytes raw, ${gz.byteLength} gzip (level 9); ` +
					`${(engine.use((g) => g.names_heap_bytes()) / 1048576).toFixed(2)}MB in wasm\n` +
					`${folded.length} needles (${needles.length - ADVERSARIAL.length - 5000} two-character, 5000 substrings, ` +
					`${ADVERSARIAL.length} adversarial): ${differing} differ, ${answered} answer something; ` +
					`names ${(namesMs / folded.length).toFixed(3)}ms a needle on one instance, ` +
					`fan-out ${(fanOutMs / folded.length).toFixed(3)}ms a needle summed over ${parts.length} partitions`,
			);
			for (const line of shown) console.log(`  DIFFERS ${line}`);
			expect(differing).toBe(0);
			expect(answered).toBeGreaterThan(5000);
		},
		{ timeout: 600_000 },
	);
});
