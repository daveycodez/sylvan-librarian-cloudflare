// Ask the Worker to purge its response cache (src/cache-purge-request.ts): written after a
// deploy-path store publish, which — unlike the nightly import — has no purge of its own, so the
// answers cached from the store it replaced would otherwise be served for up to sixteen hours.
//
//   bun scripts/request-cache-purge.ts --remote ["why"]
//
// The watchdog tick honours it once the request is five minutes old, then deletes the key.

import { PURGE_REQUEST_KEY } from "../src/cache-purge-request";
import { kvBytesMetadata } from "../src/engine/kv-retention";
import { wranglerDeployKv } from "./kv-prune";
import { requireDeployEnvironment } from "./kv-target";

const remote = process.argv.includes("--remote");
if (remote) requireDeployEnvironment();
const why = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "a deploy published a store";
const json = JSON.stringify({ at: Date.now(), why });
await wranglerDeployKv(remote).put(PURGE_REQUEST_KEY, json, { metadata: kvBytesMetadata(json.length) });
console.log(`Purge requested (${why}): the Worker purges its response cache within about fifteen minutes.`);
