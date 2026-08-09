#!/usr/bin/env bash
# `bun run deploy`: deploy the Worker AND make sure a card store is live.
#
# The bulk import belongs to the DEPLOY, not to the runtime. Building the store
# natively here gets 8GB of memory and 20 minutes of wall time (Workers Builds
# free tier: 2 vCPU, 8GB, 20min, 3000 build-minutes/month) instead of the
# Worker runtime's 128MB isolate and 30s-per-alarm budget — the constraints the
# in-Worker pipeline has to slice itself to death to respect. The in-Worker
# import stays for the NIGHTLY refresh, where the work is incremental.
#
# This is the same script whether you run it from a laptop or Cloudflare runs
# it for you, which is the point: attach a repo or type `bun run deploy`, and
# either way the first deploy ends with a working site. For Workers Builds set
#   Settings > Build > Deploy command:  bun run deploy
#
# The import failing FAILS THE DEPLOY (set -e, no swallowed errors), so a green
# build means a live index — nobody has to watch a loading screen to find out.
#
#   bun run deploy                 # deploy, then import if the store is stale
#   FORCE_IMPORT=1 bun run deploy  # always rebuild and republish the store
#   SKIP_IMPORT=1 bun run deploy   # deploy code only (store untouched)
#
# With several Cloudflare accounts, set CLOUDFLARE_ACCOUNT_ID — otherwise
# wrangler cannot pick one non-interactively, the store check cannot read the
# manifest, and every deploy re-runs the full import to be safe.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# 1. Deploy first: this is what provisions the D1 database on a fresh account
#    (Wrangler autoconfig), and the import needs somewhere to publish to.
echo "==> Deploying Worker..."
bunx wrangler deploy

if [[ "${SKIP_IMPORT:-}" == "1" ]]; then
    echo "==> SKIP_IMPORT=1 — leaving the card store as it is."
    exit 0
fi

# 2. Skip the import when a recent store is already published. Without this,
#    every routine code push would re-download ~450MB and republish an
#    identical store; the nightly in-Worker refresh is what keeps it current.
STORE_FRESH=0
if [[ "${FORCE_IMPORT:-}" != "1" ]]; then
    echo "==> Checking for a published store..."
    if built_at="$(bun scripts/store-age.ts 2>/dev/null)" && [[ -n "$built_at" ]]; then
        echo "    a store built ${built_at} is already live"
        STORE_FRESH=1
    else
        echo "    no current store found — importing"
    fi
fi

if [[ "$STORE_FRESH" == "1" ]]; then
    echo "==> Store is current; skipping the bulk import (FORCE_IMPORT=1 overrides)."
    exit 0
fi

# 3. Full bulk import, natively. Any failure here fails the deploy.
echo "==> Building the card store from Scryfall bulk data (~450MB, a few minutes)..."
"$REPO_ROOT/scripts/with-rust.sh" cargo build --release -p sylvan-store-builder
./target/release/sylvan-store-builder --out store-build

echo "==> Publishing the store to D1..."
bun scripts/seed-remote-d1.ts store-build

echo "==> Done: Worker deployed and card index live."
