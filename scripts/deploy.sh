#!/usr/bin/env bash
# `bun run deploy`: publish the card index, then deploy the Worker.
#
# Same two steps, same order, same script as a git-connected deploy — where
# scripts/ci-postinstall.sh runs step 1 automatically from `bun install`. Index
# first, Worker second, so a live Worker always has an index behind it, and a
# failed import means no deploy at all rather than a site serving nothing.
#
# The full import runs in the DEPLOY rather than the Worker runtime because
# that is where there is room for it: Workers Builds gives 2 vCPU, 8GB and 20
# minutes against a 128MB isolate and 30s-per-alarm in the runtime. The
# in-Worker pipeline keeps the nightly refresh, where the work is incremental.
#
#   bun run deploy                 # import if needed, then deploy
#   FORCE_IMPORT=1 bun run deploy  # always rebuild and republish the store
#   SKIP_IMPORT=1 bun run deploy   # deploy code only (store untouched)
#
# With several Cloudflare accounts, set CLOUDFLARE_ACCOUNT_ID — otherwise
# wrangler cannot pick one non-interactively.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# import-store.sh pins database_id into wrangler.jsonc so the deploy binds to
# the database it published into. wrangler.jsonc is TRACKED, so on a developer's
# machine that would leave the working tree dirty — and one account's database
# id committed into a fork is the same 7404 the pinning exists to prevent, now
# inherited by everyone who clones it. Restore the file once wrangler has read
# it. (In Workers Builds the workspace is ephemeral and ci-postinstall.sh runs
# the pin in a separate process from the deploy command, so this belongs here,
# in the script that owns both steps.)
CONFIG_BACKUP="$(mktemp)"
cp wrangler.jsonc "$CONFIG_BACKUP"
restore_config() {
    cp "$CONFIG_BACKUP" wrangler.jsonc
    rm -f "$CONFIG_BACKUP"
}
trap restore_config EXIT

"$REPO_ROOT/scripts/import-store.sh"

echo "==> Deploying Worker..."
bunx wrangler deploy

# "Deployed" is not "users are running it". Walk the chain a browser walks —
# page HTML -> the asset URLs IN that HTML -> the bytes behind them — and
# require the bytes to hash to what is committed here. A check that compares the
# local build against the CDN cannot see a bad pointer between the two, which is
# exactly what shipped a frontend fix that could not reach anyone.
sleep 5
echo "==> Verifying the deploy reached users..."
bun "$REPO_ROOT/scripts/verify-deploy.ts"

echo "==> Done: card index live, Worker deployed, assets verified."
