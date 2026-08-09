#!/usr/bin/env bash
# `bun dev`: full local dev in one command.
#
# Mirrors `bun run deploy` deliberately: the first run does the FULL bulk import
# before the dev server starts serving, so the web interface is never up without
# an index behind it. Same shared pipeline Rust, same failure posture — if the
# import fails, dev does not start, because a half-ready site is worse than an
# obvious error. Later runs start instantly from the persisted local D1.
#
# wrangler dev emulates everything this deployment uses — D1, Durable Objects
# with SQLite, alarms — so the production import pipeline also runs locally:
# DEV_BOOTSTRAP=worker skips the native seed and lets the ImportCoordinator
# bootstrap in-Worker exactly as a fresh production deploy would
# (~10-20 minutes), which is how you exercise that pipeline itself.
#
# Unlike deploy, an existing local store is never considered stale: re-importing
# on every `bun dev` would be intolerable. Delete .wrangler state (or run the
# seed by hand) to refresh it.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DB_NAME="$(bun scripts/project-config.ts d1)"
if ! bunx wrangler d1 execute "$DB_NAME" --local -c wrangler.dev.jsonc \
        --command "SELECT 1 FROM store_manifest LIMIT 1" >/dev/null 2>&1; then
    if [[ "${DEV_BOOTSTRAP:-}" == "worker" ]]; then
        echo "DEV_BOOTSTRAP=worker — skipping the native seed. The Worker will"
        echo "self-bootstrap from Scryfall bulk data via the in-Worker import"
        echo "pipeline (~10-20 minutes); the site serves the building page until"
        echo "it finishes."
    else
        # Build the store natively (same shared Rust as production) and seed
        # local D1 directly — a couple of minutes, mostly download — covering
        # everything the DO import produces: store, manifest, and the
        # SQL-fallback cards table. No toolchain check: with-rust.sh installs
        # rustup if this machine has no Rust, exactly as it does in CI, so
        # "first run works" does not depend on what happens to be installed.
        echo "==> No local card store yet — running the full bulk import first"
        echo "    (~2-3 minutes, mostly download). The dev server starts after."
        "$REPO_ROOT/scripts/seed-local.sh"
    fi
fi

exec bunx wrangler dev -c wrangler.dev.jsonc
