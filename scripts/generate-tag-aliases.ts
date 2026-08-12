// Turn the builder's `tag-aliases.json` into the committed parser module.
//
// This port does NOT stamp alias keys into the store the way upstream #914 does — see
// TagData::oracle_aliases in engine/builder/src/tags.rs for the measurement that drove that. The
// consequence is that the alias -> slug mapping has to reach the QUERY side instead, and this is
// how it gets there: the builder writes the map it resolved, this turns it into a module the
// parser imports, and getArtTagsComparisonKeys folds the search term through it.
//
// The map is generated rather than hand-kept because the two halves have no error between them:
// if the parser stops resolving `flames`, nothing throws — `art:flames` just quietly returns zero,
// which is exactly the state #914 existed to fix.
//
//   bun scripts/generate-tag-aliases.ts [store-build]
//
// Run by scripts/import-store.sh right after a store build, so the committed module always
// describes the dumps the live store was built from. A routine code push skips the import and
// therefore leaves this file alone, which is correct: the store did not change either.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "src/parser/tag-aliases.gen.ts";

interface AliasFile {
	oracle: Record<string, string>;
	art: Record<string, string>;
}

/**
 * The alias table as ONE JSON string literal, sorted so a diff still shows what
 * upstream's dumps changed.
 *
 * This used to emit `new Map([["alias", "slug"], ...])` — 2,152 array literals
 * the JS parser had to build at module evaluation, in every isolate, forever.
 * At 79,331 bytes it was 20% of the bundled script's source, and the isolate
 * startup that costs is charged against the free plan's 10ms-per-request CPU.
 *
 * A string literal is scanned, not structured: the parser walks to the closing
 * quote and stops. The table is then built once, lazily, by the accessors below
 * — and a query that never says `otag:` or `atag:` never builds it at all,
 * which is almost all of them.
 */
function table(map: Record<string, string>): string {
	const sorted: Record<string, string> = {};
	for (const alias of Object.keys(map).sort()) sorted[alias] = map[alias] as string;
	// SINGLE-quoted, which is both what biome formats to and the cheaper encoding:
	// JSON is all double quotes, so a single-quoted host literal carries none of
	// the `\"` escapes that would otherwise be ~2,150 extra characters to scan and
	// unescape. Only backslashes and single quotes need escaping, and slugs
	// contain neither today — the escaping is here so that stays true by
	// construction rather than by luck.
	const json = JSON.stringify(sorted).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
	return `'${json}'`;
}

function main(): void {
	const dir = process.argv[2] ?? "store-build";
	const path = join(dir, "tag-aliases.json");
	if (!existsSync(path)) {
		console.error(`No ${path}. Build a store first (bun run seed:local, or scripts/import-store.sh).`);
		process.exit(1);
	}
	const data = JSON.parse(readFileSync(path, "utf8")) as AliasFile;
	const oracle = data.oracle ?? {};
	const art = data.art ?? {};

	const source = `// GENERATED FILE - do not edit. Built by scripts/generate-tag-aliases.ts from the tag dumps,
// via the \`tag-aliases.json\` that engine/builder writes next to the store.
//
// Scryfall's tagger keeps alternate spellings for a tag in an \`aliases\` field and resolves them to
// the tag before matching, so \`art:flames\` and \`art:fire\` select the same cards there. Upstream
// #914 reproduces that by stamping every alias as an extra key next to the slug and its ancestors.
// This port resolves at query time from the map below instead, because those keys cost 6,252,880
// bytes in the archive and pushed it across the 25MB KV chunk grid from 3 values to 4 — a fourth
// serialized read on every cold store load.
//
// Safe because an alias key was never more than a duplicate: the builder attaches alias \`a\` to
// slug \`s\` under exactly the condition it attaches \`s\`, so resolving \`a\` -> \`s\` before the match
// selects the identical rows, descendants included.

// Held as JSON STRINGS and parsed on first use, not as Map literals evaluated at
// module load. See \`table()\` in the generator for why: this file is 20% of the
// bundled script, every isolate paid it at startup against a 10ms CPU budget,
// and a query without \`otag:\`/\`atag:\` never needs the table at all.

const ORACLE_JSON =
	${table(oracle)};
const ART_JSON =
	${table(art)};

let oracleMap: ReadonlyMap<string, string> | null = null;
let artMap: ReadonlyMap<string, string> | null = null;

/** Slugified alias -> canonical slug, from the \`oracle_tags\` dump. Built on first use. */
export function oracleTagAliases(): ReadonlyMap<string, string> {
	oracleMap ??= new Map(Object.entries(JSON.parse(ORACLE_JSON) as Record<string, string>));
	return oracleMap;
}

/** Slugified alias -> canonical slug, from the \`art_tags\` dump. Built on first use. */
export function artTagAliases(): ReadonlyMap<string, string> {
	artMap ??= new Map(Object.entries(JSON.parse(ART_JSON) as Record<string, string>));
	return artMap;
}
`;

	writeFileSync(OUT, source);
	console.log(`Wrote ${OUT} — ${Object.keys(oracle).length} oracle + ${Object.keys(art).length} art aliases`);
}

main();
