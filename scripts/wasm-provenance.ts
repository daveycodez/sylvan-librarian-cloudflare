// What the committed wasm blobs were built from, recorded so CI can tell a fresh one from a stale one.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────────
//
// `engine/wasm/pkg/sylvan_engine_wasm_bg.wasm` and `engine/wasm-import/pkg/sylvan_wasm_import.wasm`
// are COMMITTED artifacts — wrangler.jsonc says why ("the built wasm-bindgen pkg is committed so
// Workers Builds needs no Rust toolchain"). Nothing in CI or in Workers Builds rebuilds them. The
// blob that production runs is whatever was last committed.
//
// On 2026-08-27 that took the site down. The sync to upstream 4983094 bumped
// ARCHIVE_FORMAT_VERSION to 2026082601; Workers Builds rebuilt the NATIVE store builder and
// republished all ten partitions at the new format, and deployed a wasm engine last built against
// 2026081704. A gen-41 engine cannot read a gen-42 archive, so every engine-backed route answered
// 500 — /search, /cards/*, and /get_catalog's cardTypeCounts alike — while /sets stayed 200 because
// it is served from KV and never touches the engine.
//
// It was the SECOND format bump in a row to ship that way: b3d1048 ("Wasm: Rebuild Both Blobs...")
// was the previous one's follow-up hotfix. Two for two is not a lapse, it is a missing check.
//
// ── WHY THE GATE DOES NOT CATCH IT ────────────────────────────────────────────
//
// `scripts/gate.sh`'s differential ("native vs wasm store: same rows, same answers") compares the
// native builder against `sylvan_wasm_import.wasm` — the wasm BUILDER. Nothing anywhere compares
// the committed QUERY engine against a store built by current code. The one artifact production
// actually runs was the one artifact nothing verified.
//
// ── WHY A HASH AND NOT A REBUILD ──────────────────────────────────────────────
//
// The obvious check — rebuild in CI and `git diff --exit-code` the blob — does not work: wasm-pack
// output moves with the toolchain version, the wasm-opt version and embedded paths, so a green
// local build would go red in CI for reasons that have nothing to do with staleness. Hashing the
// INPUTS is deterministic everywhere, needs no Rust toolchain, no corpus, and no store: it answers
// the only question that matters, which is whether the blob was built from this source tree.
//
// ── WHAT IS HASHED, AND THE DELIBERATE OVER-INCLUSION ─────────────────────────
//
// Every `.rs` under the four crates that feed the two blobs, plus their Cargo.toml files and
// Cargo.lock. That sweeps in `tests.rs` and the `bench_*.rs` files, which cannot affect either
// blob — they are `cfg(test)` and example-only. The over-inclusion is on purpose: the two ways to
// be wrong are not symmetric. A missed input ships a stale engine and darkens the site; a spurious
// input costs one `bun run build`. So the rule is mechanical with no judgement calls in it, and an
// upstream sync that touches only vendored tests still asks for a rebuild it does not strictly
// need.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** Where the record lives. Committed beside the blobs it describes. */
export const PROVENANCE_PATH = join(REPO_ROOT, "engine", "wasm-provenance.json");

/** Source trees whose every `.rs` file feeds one blob or the other. */
const SOURCE_DIRS = [
	"vendor/sylvan_librarian/card_engine/src",
	"engine/wasm/src",
	"engine/wasm-import/src",
	"engine/builder/src",
];

/**
 * Manifests that pin the dependency graph and the feature flags those sources compile under —
 * plus the two build-affecting files that live OUTSIDE any crate: the root Cargo.toml (workspace
 * membership and [profile.release]) and .cargo/config.toml (the wasm32 rustflags). Either can
 * change the emitted bytes without touching a src/ file, so omitting them let the guard bless a
 * stale blob (CodeRabbit finding on PR #5, 2026-08-28).
 */
const SOURCE_FILES = [
	"vendor/sylvan_librarian/card_engine/Cargo.toml",
	"engine/wasm/Cargo.toml",
	"engine/wasm-import/Cargo.toml",
	"engine/builder/Cargo.toml",
	"Cargo.toml",
	".cargo/config.toml",
	"Cargo.lock",
];

/** The committed blobs this record describes. */
export const BLOBS = ["engine/wasm/pkg/sylvan_engine_wasm_bg.wasm", "engine/wasm-import/pkg/sylvan_wasm_import.wasm"];

export interface WasmProvenance {
	/** sha256 over every source input, path-sorted. */
	source_hash: string;
	/** ARCHIVE_FORMAT_VERSION at build time — the number whose drift caused the outage. */
	archive_format_version: number;
	/** sha256 of each blob, so a replaced or truncated file is caught too. */
	blob_hashes: Record<string, string>;
}

function walkRustFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkRustFiles(full));
		} else if (entry.name.endsWith(".rs")) {
			out.push(full);
		}
	}
	return out;
}

/** Every source input, as repo-relative paths in a stable order. */
export function sourceInputs(): string[] {
	const files: string[] = [];
	for (const dir of SOURCE_DIRS) {
		files.push(...walkRustFiles(join(REPO_ROOT, dir)));
	}
	for (const file of SOURCE_FILES) {
		files.push(join(REPO_ROOT, file));
	}
	return files.map((f) => relative(REPO_ROOT, f)).sort();
}

/**
 * sha256 over the source inputs.
 *
 * The PATH is hashed alongside the bytes, so moving a file between crates changes the digest even
 * when its contents do not — a file's identity is part of what it compiles into.
 */
export function computeSourceHash(): string {
	const hash = createHash("sha256");
	for (const rel of sourceInputs()) {
		hash.update(rel);
		hash.update("\0");
		hash.update(readFileSync(join(REPO_ROOT, rel)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

/** ARCHIVE_FORMAT_VERSION, read from the one line that declares it. */
export function readArchiveFormatVersion(): number {
	const src = readFileSync(join(REPO_ROOT, "vendor/sylvan_librarian/card_engine/src/lib.rs"), "utf-8");
	const m = /^const ARCHIVE_FORMAT_VERSION: u32 = (\d+);$/m.exec(src);
	if (!m) {
		throw new Error(
			"could not find ARCHIVE_FORMAT_VERSION in card_engine/src/lib.rs — if its declaration moved, " +
				"update scripts/wasm-provenance.ts, because this check is load-bearing for production",
		);
	}
	return Number.parseInt(m[1] as string, 10);
}

export function computeBlobHashes(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rel of BLOBS) {
		const full = join(REPO_ROOT, rel);
		statSync(full); // a missing blob is a build error, not an empty hash
		out[rel] = createHash("sha256").update(readFileSync(full)).digest("hex");
	}
	return out;
}

export function computeProvenance(): WasmProvenance {
	return {
		source_hash: computeSourceHash(),
		archive_format_version: readArchiveFormatVersion(),
		blob_hashes: computeBlobHashes(),
	};
}

export function readProvenance(): WasmProvenance | null {
	try {
		return JSON.parse(readFileSync(PROVENANCE_PATH, "utf-8")) as WasmProvenance;
	} catch {
		return null;
	}
}

/** Write the record. Called by `bun run build`, right after both blobs are produced. */
function write(): void {
	const provenance = computeProvenance();
	writeFileSync(PROVENANCE_PATH, `${JSON.stringify(provenance, null, "\t")}\n`);
	console.log(
		`wrote engine/wasm-provenance.json (format ${provenance.archive_format_version}, ` +
			`sources ${provenance.source_hash.slice(0, 12)}…)`,
	);
}

if (import.meta.main) {
	write();
}
