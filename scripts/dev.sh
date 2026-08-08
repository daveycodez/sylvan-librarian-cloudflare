#!/usr/bin/env bash
# `bun dev`: full local dev in one command.
#
# First run with no local store: builds the card store NATIVELY (same shared
# pipeline Rust as production) and seeds local D1 — store, engine, and the
# SQL-fallback cards table — in ~2-3 minutes, mostly download. Later runs
# start instantly from the persisted local D1.
#
# wrangler dev emulates everything this deployment uses — D1, Durable Objects
# with SQLite, alarms — so the production import pipeline also runs locally:
# DEV_BOOTSTRAP=worker skips the native seed and lets the ImportCoordinator
# bootstrap in-Worker exactly as a fresh production deploy would
# (~10-20 minutes).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if ! bunx wrangler d1 execute sylvan-librarian --local -c wrangler.dev.jsonc \
        --command "SELECT 1 FROM store_manifest LIMIT 1" >/dev/null 2>&1; then
    if [[ "${DEV_BOOTSTRAP:-}" != "worker" ]] && { command -v cargo >/dev/null 2>&1 || [[ -x "$HOME/.cargo/bin/cargo" ]]; }; then
        # Fast lane, automatic: your machine runs native code, so build the
        # store natively (same shared Rust as the production import) and seed
        # local D1 directly — a couple of minutes, mostly download — instead
        # of the production-identical in-Worker bootstrap (~10-20 minutes).
        # The seed covers everything the DO import produces: store, manifest,
        # and the SQL-fallback cards table. DEV_BOOTSTRAP=worker forces the
        # slow path when you want to exercise the real pipeline itself.
        echo "No local card store yet — building natively (~2-3 minutes)..."
        "$REPO_ROOT/scripts/seed-local.sh"
    else
        echo "No local card store yet (and no Rust toolchain found). First run"
        echo "will self-bootstrap from Scryfall bulk data via the local import"
        echo "pipeline (~10-20 minutes, once)."
    fi
fi

exec bunx wrangler dev -c wrangler.dev.jsonc
