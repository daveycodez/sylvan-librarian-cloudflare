// Write the deploy fence (`import:deploy-fence`, backlog x3): every nightly import run that began
// before this moment retires at its next alarm or its next KV write, and publishes nothing more.
//
//   bun scripts/deploy-fence.ts --remote   # from import-store.sh, before `cargo build`
//
// BEFORE THE BUILD, deliberately: the build takes minutes, and KV takes up to 60 seconds to show a
// write everywhere. By the time seed-remote-kv.ts deletes the nightly's half-uploaded family, the
// coordinator has long been able to see why (it waits out DEPLOY_FENCE_SETTLE_MS itself when the
// fence is younger than that). Two writers on one KV are how the site went dark twice; the deploy
// is the writer a human is watching, so the deploy wins.

import { writeDeployFence } from "./deploy-upload";
import { wranglerDeployKv } from "./kv-prune";
import { requireDeployEnvironment } from "./kv-target";

const remote = process.argv.includes("--remote");
if (remote) requireDeployEnvironment();
const fence = await writeDeployFence(wranglerDeployKv(remote));
console.log(
	`Deploy fence at ${new Date(fence.at).toISOString()}: every nightly import started before it retires, and this ` +
		"deploy owns the store upload.",
);
