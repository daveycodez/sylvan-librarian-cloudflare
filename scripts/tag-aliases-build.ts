// The native builder's `tag-aliases.json` sidecar, for both deploy-path seeders.
//
// Written by engine/builder/src/main.rs beside every store it builds (`TagData::aliases_json`):
// the alias -> slug maps the build resolved, in the one shape the Worker reads
// (src/engine/tag-aliases.ts). The nightly publisher reaches the same map through the wasm
// import's `tag_aliases_export`; this is the deploy path's half.
//
// Absent sidecar IS an error, unlike the routing filter's. A store published without its alias
// map answers every alias tag spelling with nothing, and the builder has written the file beside
// every store since the map left the store (generation 4), so a build dir without one is not a
// store this deployment should publish.

import { existsSync, readFileSync } from "node:fs";
import { parseTagAliasTables } from "../src/engine/tag-aliases";

export const TAG_ALIASES_FILE = "tag-aliases.json";

/**
 * The sidecar's path, validated: the same parse the Worker runs, so a file the reader would refuse
 * fails here, at publish time, rather than on every request.
 */
export function tagAliasesFileFromBuildDir(dir: string): string {
	const path = `${dir}/${TAG_ALIASES_FILE}`;
	if (!existsSync(path)) {
		throw new Error(
			`No ${path}: the builder writes it beside every store, so this is not a complete build dir. ` +
				`Rebuild with \`sylvan-store-builder --out ${dir} --partitions auto\`.`,
		);
	}
	const tables = parseTagAliasTables(readFileSync(path, "utf8"));
	console.log(`  ${TAG_ALIASES_FILE}: ${tables.oracle.size} oracle + ${tables.art.size} art aliases`);
	return path;
}
