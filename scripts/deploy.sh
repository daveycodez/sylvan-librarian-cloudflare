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

"$REPO_ROOT/scripts/import-store.sh"

echo "==> Deploying Worker..."
bunx wrangler deploy

echo "==> Done: card index live and Worker deployed."
