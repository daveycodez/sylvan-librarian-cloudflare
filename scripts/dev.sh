#!/usr/bin/env bash
# `bun dev`: production-equivalent local dev in one command.
#
# Mirrors production's first-boot behavior without Docker: if the local
# simulated R2 has no store manifest, build one from live Scryfall bulk data
# (the same sylvan-store-builder the production import container runs) and
# seed it, then start wrangler dev. Subsequent runs skip straight to serving.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if ! bunx wrangler r2 object get "sylvan-librarian/manifest.json" --local -c wrangler.dev.jsonc --pipe >/dev/null 2>&1; then
    echo "No local card store yet — building one from Scryfall bulk data (first run only, a few minutes)..."
    scripts/seed-local.sh
fi

exec bunx wrangler dev -c wrangler.dev.jsonc
