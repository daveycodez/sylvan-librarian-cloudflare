// Retire store generations that play no role, whether or not this deploy published one.
//
//   bun scripts/prune-kv.ts            # local simulated KV
//   bun scripts/prune-kv.ts --remote   # production KV, from inside a deploy
//
// Cleanup is not part of publishing, and tying the two together is how a leak survives a fix. The
// store sweep used to run only inside the publisher, so a deploy that correctly skipped the import
// — the common case, because a recent store is already live — skipped the sweep with it. The same
// mistake had just been made with the rulings and reference layouts, where `--if-missing` exited
// before their sweep: production shed those orphans only once the skip path learned to clean.
//
// The layout sweeps live in the two seeding scripts, which run on every deploy. This is the store's
// counterpart, and it runs unconditionally beside them.
//
// RETENTION BY ROLE (backlog x3, src/engine/kv-retention.ts): the family the LIVE MANIFEST names —
// read, not assumed, because a rollback republishes an OLDER manifest — the family that manifest
// replaced (`previous_built_at`), and the family of the upload-lease holder (store:publishing),
// which has no manifest yet and a built_at from when its build started, days before the
// deploy-built generations that land while it crawls. Both deploys on 2026-09-14/15 swept exactly
// that family out from under the coordinator. Every other generation goes. A read that FAILED is not
// "absent": the sweep is skipped and the next deploy or nightly retries it.

import { sweepGenerationsByRole } from "./deploy-upload";
import { wranglerDeployKv } from "./kv-prune";
import { requireDeployEnvironment } from "./kv-target";

const remote = process.argv.includes("--remote");
if (remote) requireDeployEnvironment();

const removed = await sweepGenerationsByRole(wranglerDeployKv(remote));
console.log(
	removed === null
		? "Retention: could not read the live manifest, the upload lease or the key list — leaving every store " +
				"generation in place; the next deploy or nightly retries."
		: removed > 0
			? `Retention: dropped ${removed} key(s) from store generations with no role.`
			: "Retention: no store generations to drop.",
);
