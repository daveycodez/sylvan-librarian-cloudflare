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
    echo "No local card store yet. First run will self-bootstrap from Scryfall"
    echo "bulk data via the local import pipeline (~10-20 minutes, once)."
    echo "Faster/offline alternative: bun run seed:local"
fi

exec bunx wrangler dev -c wrangler.dev.jsonc
