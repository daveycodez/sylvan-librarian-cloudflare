#!/usr/bin/env bash
# `bun dev`: production-identical local dev in one command.
#
# wrangler dev emulates everything this deployment uses — D1, Durable Objects
# with SQLite, alarms — so even the import pipeline runs locally exactly as in
# production: with no store in local D1, the first request kicks the
# ImportCoordinator, which streams Scryfall bulk data, builds the store in
# wasm, and publishes to (local) D1. That first bootstrap takes ~10-20 minutes
# and needs network; later runs start instantly from the persisted local D1.
#
# In a hurry (or offline after a first build)? `bun run seed:local` builds the
# store natively (same shared pipeline code) and seeds local D1 directly.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if ! bunx wrangler d1 execute sylvan-librarian --local -c wrangler.dev.jsonc \
        --command "SELECT 1 FROM store_manifest LIMIT 1" >/dev/null 2>&1; then
    if [[ "${DEV_BOOTSTRAP:-}" != "worker" ]] && command -v cargo >/dev/null 2>&1; then
        # Fast lane, automatic: your machine runs native code, so build the
        # store natively (same shared Rust as the production import) and seed
        # local D1 directly — a couple of minutes, mostly download — instead
        # of the production-identical in-Worker bootstrap (~10-20 minutes).
        # DEV_BOOTSTRAP=worker forces the slow path when you want to exercise
        # the real pipeline; it is also what fills the SQL-fallback cards
        # table locally (the native seed skips it — engine-only until then).
        echo "No local card store yet — building natively (~2-3 minutes)..."
        "$REPO_ROOT/scripts/seed-local.sh"
    else
        echo "No local card store yet (and no Rust toolchain found). First run"
        echo "will self-bootstrap from Scryfall bulk data via the local import"
        echo "pipeline (~10-20 minutes, once)."
    fi
fi

exec bunx wrangler dev -c wrangler.dev.jsonc
