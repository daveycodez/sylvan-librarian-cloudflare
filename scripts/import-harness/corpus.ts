// The harness's six dumps, synthesised — no network, no 392MB download.
//
// The corpus itself is `memprobe gen`, the same deterministic generator
// scripts/gate.sh caches for its perf ratios: seeded from a fixed constant,
// built by overlaying real Scryfall card fixtures, and — the reason it is
// usable here at all — its `--bulk` output IS Scryfall all_cards line format,
// required fields and multilingual spread included.
//
// The other five dumps are derived from it, because memprobe emits only the
// bulk file and a tag map in its own shape:
//
//   all_cards      the bulk file, GZIPPED. Gzip on purpose: it is the only kind
//                  the coordinator recodes, and the resumable wasm inflater
//                  (engine/inflate, the checkpoint path) only runs when the
//                  staged bytes carry the gzip magic. A plain fixture would
//                  quietly take the from-byte-0 fallback and leave the newest,
//                  least-proven code in the pipeline untested.
//   default_cards  `{"id": …}` for every ENGLISH line — the canonical rule the
//                  generator itself documents (memprobe cmd_rows: lang == "en"
//                  is canonical, coinciding by construction with production's
//                  id-membership rule). canonical_add_lines reads nothing else.
//   oracle_tags    memprobe's tag map INVERTED into Scryfall tagger JSONL: one
//   art_tags       record per slug carrying its taggings, because that is what
//                  TagAccumulator::add_line parses. The map is id → slugs; the
//                  dump is slug → ids.
//   oracle_cards   one `{"id": …}` per distinct oracle_id — the representative
//                  printing pins. labels_add_lines reads only `id`, and zero
//                  labels is explicitly legal, so this is the cheap one.
//   rulings        synthesised against the same oracle_ids, carrying the four
//                  fields parseRulingLine requires.
//
// Everything is cached under one directory keyed by the generator's own shape
// tag AND the printing count, for the reason gate.sh spells out at length: a
// cached corpus from an older generator is the OLD corpus wearing the new
// corpus's path, and every number measured off it is a lie.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DUMP_KINDS } from "../../src/import-phases";

export interface Corpus {
	kinds: readonly string[];
	dumps: Record<string, Uint8Array>;
	sizes: Record<string, number>;
	/** all_cards lines. */
	printings: number;
	/** all_cards RAW (decompressed) bytes — the honest scale for every phase
	 * whose cost follows the dump rather than the row count. */
	rawBytes: number;
	updatedAt: string;
}

const MEMPROBE = "./target/release/examples/memprobe";
/** The measured all_cards shape: ~3.7 foreign printings per English one. */
const FOREIGN_RATIO = "3.7";

function run(cmd: string[], cwd: string): string {
	const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`${cmd.join(" ")} failed (${result.exitCode}):\n${result.stderr.toString()}`);
	}
	return result.stdout.toString();
}

/** A stable 32-hex id for a synthetic tag, so a re-run produces byte-identical
 * dumps and the cache stays honest. */
function slugId(slug: string): string {
	const hash = new Bun.CryptoHasher("sha256").update(slug).digest("hex").slice(0, 32);
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

interface Derived {
	all_cards: string;
	default_cards: string;
	oracle_tags: string;
	art_tags: string;
	oracle_cards: string;
	rulings: string;
	printings: number;
}

/** Turn memprobe's bulk + tag map into the five derived dumps. */
function derive(bulk: string, tags: string): Derived {
	const lines = bulk.split("\n").filter((l) => l.length > 0);
	const canonicalIds: string[] = [];
	const oracleRepresentative = new Map<string, string>();
	for (const line of lines) {
		const card = JSON.parse(line) as { id?: string; oracle_id?: string; lang?: string };
		if (card.lang !== "en" || !card.id) continue;
		canonicalIds.push(card.id);
		if (card.oracle_id && !oracleRepresentative.has(card.oracle_id)) {
			oracleRepresentative.set(card.oracle_id, card.id);
		}
	}

	const map = JSON.parse(tags) as { oracle: Record<string, string[]>; art: Record<string, string[]> };
	const taggerDump = (byId: Record<string, string[]>, key: "oracle_id" | "illustration_id"): string => {
		const bySlug = new Map<string, string[]>();
		for (const [id, slugs] of Object.entries(byId)) {
			for (const slug of slugs) {
				const ids = bySlug.get(slug);
				if (ids) ids.push(id);
				else bySlug.set(slug, [id]);
			}
		}
		const out: string[] = [];
		for (const [slug, ids] of [...bySlug.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
			out.push(
				JSON.stringify({
					object: "tag",
					id: slugId(slug),
					slug,
					parent_ids: [],
					aliases: [],
					taggings: ids.map((id) => ({ [key]: id })),
				}),
			);
		}
		return `${out.join("\n")}\n`;
	};

	// Four rulings per oracle card, which is roughly the real dump's density and
	// enough that all 256 buckets are non-empty at any corpus size worth running.
	const rulings: string[] = [];
	for (const oracleId of oracleRepresentative.keys()) {
		for (let i = 0; i < 4; i++) {
			rulings.push(
				JSON.stringify({
					object: "ruling",
					oracle_id: oracleId,
					source: i % 2 === 0 ? "wotc" : "scryfall",
					published_at: "2026-01-01",
					comment: `Harness ruling ${i} for ${oracleId}.`,
				}),
			);
		}
	}

	return {
		all_cards: bulk,
		default_cards: `${canonicalIds.map((id) => JSON.stringify({ id })).join("\n")}\n`,
		oracle_tags: taggerDump(map.oracle, "oracle_id"),
		art_tags: taggerDump(map.art, "illustration_id"),
		oracle_cards: `${[...oracleRepresentative.values()].map((id) => JSON.stringify({ id })).join("\n")}\n`,
		rulings: `${rulings.join("\n")}\n`,
		printings: lines.length,
	};
}

export async function buildCorpus(printings: number, cacheRoot: string): Promise<Corpus> {
	const repo = join(import.meta.dir, "..", "..");
	if (!existsSync(join(repo, MEMPROBE))) {
		console.log("  building memprobe (first run only)...");
		run(
			["scripts/with-rust.sh", "cargo", "build", "--release", "-p", "sylvan-store-builder", "--example", "memprobe"],
			repo,
		);
	}
	const shape = run([MEMPROBE, "corpus-shape"], repo).trim();
	const dir = join(cacheRoot, `${shape}-p${printings}-f${FOREIGN_RATIO}`);
	mkdirSync(dir, { recursive: true });

	const bulkPath = join(dir, "bulk.jsonl");
	const tagsPath = join(dir, "tags.json");
	if (!existsSync(bulkPath) || !existsSync(tagsPath)) {
		console.log(`  synthesising corpus '${shape}' at ${printings} printings (first run only)...`);
		// Written privately and renamed in, tags first, exactly as gate.sh does:
		// memprobe writes incrementally, so a second harness finding bulk.jsonl
		// present must be able to conclude the pair is complete.
		run(
			[
				MEMPROBE,
				"gen",
				"--printings",
				String(printings),
				"--foreign-ratio",
				FOREIGN_RATIO,
				"--bulk",
				`${bulkPath}.tmp`,
				"--tags",
				`${tagsPath}.tmp`,
			],
			repo,
		);
		renameSync(`${tagsPath}.tmp`, tagsPath);
		renameSync(`${bulkPath}.tmp`, bulkPath);
	}

	const derivedPath = join(dir, "derived.json");
	let derived: Derived;
	if (existsSync(derivedPath)) {
		derived = JSON.parse(readFileSync(derivedPath, "utf8")) as Derived;
	} else {
		derived = derive(readFileSync(bulkPath, "utf8"), readFileSync(tagsPath, "utf8"));
		writeFileSync(`${derivedPath}.tmp`, JSON.stringify(derived));
		renameSync(`${derivedPath}.tmp`, derivedPath);
	}

	const encoder = new TextEncoder();
	const dumps: Record<string, Uint8Array> = {
		// GZIPPED: see the header note — this is the only kind that reaches the
		// recode phase and the resumable inflater.
		all_cards: Bun.gzipSync(encoder.encode(derived.all_cards) as Uint8Array<ArrayBuffer>),
		default_cards: encoder.encode(derived.default_cards),
		oracle_tags: encoder.encode(derived.oracle_tags),
		art_tags: encoder.encode(derived.art_tags),
		oracle_cards: encoder.encode(derived.oracle_cards),
		rulings: encoder.encode(derived.rulings),
	};
	const sizes: Record<string, number> = {};
	for (const [kind, bytes] of Object.entries(dumps)) sizes[kind] = bytes.byteLength;

	return {
		kinds: DUMP_KINDS,
		dumps,
		sizes,
		printings: derived.printings,
		rawBytes: encoder.encode(derived.all_cards).byteLength,
		updatedAt: new Date().toISOString(),
	};
}
