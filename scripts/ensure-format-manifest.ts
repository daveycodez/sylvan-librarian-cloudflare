// Give this build's archive format its own manifest key before `wrangler deploy` (backlog x19).
//
//   bun scripts/ensure-format-manifest.ts --remote   # from import-store.sh, on every production deploy
//
// Readers read `store:manifest:v<their format>` (src/engine/store-kv.ts). A namespace no x19
// publisher has written yet holds only the legacy `store:manifest`; when that is THIS build's format,
// it is copied to the per-format key here, so the code about to be deployed finds its own key. The
// legacy key stays exactly as it is — the build still serving reads it until the switch — which is
// why the first deploy of x19 has no dark window whether or not it also bumps the format.
//
// Every later deploy: one read, nothing written. Never fatal — readManifest falls back to a
// same-format legacy manifest while the per-format key is absent.

import { ARCHIVE_FORMAT_VERSION, formatManifestKey, MANIFEST_KEY } from "../src/engine/store-kv";
import { ensureFormatManifest } from "./deploy-upload";
import { wranglerDeployKv } from "./kv-prune";
import { requireDeployEnvironment } from "./kv-target";

const remote = process.argv.includes("--remote");
if (remote) requireDeployEnvironment();

const key = formatManifestKey(ARCHIVE_FORMAT_VERSION);
const outcome = await ensureFormatManifest(wranglerDeployKv(remote), ARCHIVE_FORMAT_VERSION);
console.log(
	{
		present: `${key} is published — this build reads its own manifest.`,
		copied: `${key} was absent; copied the same-format manifest from ${MANIFEST_KEY} (the migration from the single key).`,
		absent: `No manifest at ${key} or ${MANIFEST_KEY} yet — the import publishes one.`,
		"other-format": `${MANIFEST_KEY} holds another archive format; this build's store is ${key}, which the import publishes.`,
		failed: `Could not read ${key} or ${MANIFEST_KEY}; readers fall back to a same-format ${MANIFEST_KEY} meanwhile.`,
	}[outcome],
);
