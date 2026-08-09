#!/usr/bin/env bash
# Build the card store and publish it to remote D1. The one implementation
# behind every path that needs an index: `bun run deploy`, and the automatic
# postinstall that Workers Builds triggers.
#
# Ordering is import-THEN-deploy everywhere, which is why this provisions the
# D1 database itself rather than relying on `wrangler deploy` autoconfig to
# have done it. The payoff is that a Worker is never live without an index:
# by the time the deploy runs, the store is already published.
#
# Failure is always fatal to the caller (set -e, no swallowed errors) — that is
# the entire point. A deploy that cannot build an index must not happen.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
# Derived from the Worker name wrangler will actually deploy as — the CI
# override included — so two Workers on one account each own their own
# database, from an unedited fork. Never hardcoded.
DB_NAME="$(bun scripts/project-config.ts d1)"
# ...and make the deployed binding agree with the database we are about to
# publish into (no-op unless CI renamed the Worker).
bun scripts/align-d1-binding.ts

if [[ "${SKIP_IMPORT:-}" == "1" ]]; then
    echo "==> SKIP_IMPORT=1 — leaving the card store as it is."
    exit 0
fi

# 1. The database must exist before anything can be published into it. `d1
#    create` fails when it already does, which is the common case and not an
#    error — so ask first, and only create when genuinely absent.
if bunx wrangler d1 info "$DB_NAME" >/dev/null 2>&1; then
    echo "==> D1 database '$DB_NAME' exists."
else
    echo "==> Creating D1 database '$DB_NAME'..."
    bunx wrangler d1 create "$DB_NAME"
fi

# 2. Skip when a recent store is already live: without this every routine code
#    push re-downloads ~450MB to republish an identical store. The nightly
#    in-Worker refresh is what keeps it current between deploys.
if [[ "${FORCE_IMPORT:-}" != "1" ]]; then
    if age="$(bun scripts/store-age.ts 2>/dev/null)" && [[ -n "$age" ]]; then
        echo "==> A store built $age is already live — skipping the import."
        echo "    (FORCE_IMPORT=1 rebuilds it anyway.)"
        exit 0
    fi
    echo "==> No current store published — running the full bulk import."
fi

# 3. Full native import. 8GB and 20 minutes in Workers Builds, versus a 128MB
#    isolate and 30s alarms in the Worker runtime — which is why this lives in
#    the build and the in-Worker pipeline only handles nightly changes.
echo "==> Building the card store from Scryfall bulk data (~450MB, a few minutes)..."
"$REPO_ROOT/scripts/with-rust.sh" cargo build --release -p sylvan-store-builder
./target/release/sylvan-store-builder --out store-build

echo "==> Publishing the store to D1..."
bun scripts/seed-remote-d1.ts store-build

echo "==> Card index published."
