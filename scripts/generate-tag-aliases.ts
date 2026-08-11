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

/** One `["alias", "slug"],` line per entry, sorted, so a diff shows what upstream's dumps changed. */
function entries(map: Record<string, string>): string {
	return Object.keys(map)
		.sort()
		.map((alias) => `\t[${JSON.stringify(alias)}, ${JSON.stringify(map[alias])}],`)
		.join("\n");
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

/** Slugified alias -> canonical slug, from the \`oracle_tags\` dump. */
export const ORACLE_TAG_ALIASES: ReadonlyMap<string, string> = new Map([
${entries(oracle)}
]);

/** Slugified alias -> canonical slug, from the \`art_tags\` dump. */
export const ART_TAG_ALIASES: ReadonlyMap<string, string> = new Map([
${entries(art)}
]);
`;

	writeFileSync(OUT, source);
	console.log(`Wrote ${OUT} — ${Object.keys(oracle).length} oracle + ${Object.keys(art).length} art aliases`);
}

main();
