#!/usr/bin/env bash
# Root `postinstall`. Exists so that a forked repo needs ZERO configuration:
# Workers Builds always runs `bun install`, so this fires on its own, whereas
# the "Deploy command" and `[build]` custom-build settings both need a human in
# the dashboard (Workers Builds does not honor wrangler.jsonc custom builds).
#
# Gated on WORKERS_CI, which Workers Builds injects (=1) and nothing else does:
#   - in Workers Builds: build the card index, and FAIL THE BUILD if it cannot
#     be built, so a Worker is never deployed without an index behind it
#   - anywhere else (a plain `bun install` on a laptop): do nothing at all,
#     because installing dependencies must not download 450MB of Scryfall data
set -euo pipefail

if [[ "${WORKERS_CI:-}" != "1" ]]; then
    exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "==> Workers Builds detected (WORKERS_CI=1): building the card index before deploy."
exec "$REPO_ROOT/scripts/import-store.sh"
