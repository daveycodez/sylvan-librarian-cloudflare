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

# Stamp the commit into the bundle. Workers Builds injects WORKERS_CI_COMMIT_SHA; the Worker
# sends it back as `x-sylvan-build`, and the post-push smoke test waits for the pushed commit to
# answer rather than for "something" to answer (the previous version answers with cards for the
# whole build). The workspace is ephemeral here, so rewriting a tracked file is safe; a laptop
# deploy leaves the committed "unknown" in place.
if [[ -n "${WORKERS_CI_COMMIT_SHA:-}" ]]; then
    sed -i.bak "s/^export const BUILD_COMMIT = \"[^\"]*\";/export const BUILD_COMMIT = \"${WORKERS_CI_COMMIT_SHA}\";/" \
        "$REPO_ROOT/src/build-info.gen.ts"
    rm -f "$REPO_ROOT/src/build-info.gen.ts.bak"
    echo "==> Build stamped as ${WORKERS_CI_COMMIT_SHA}."
else
    echo "==> WORKERS_CI_COMMIT_SHA is unset; x-sylvan-build will report 'unknown'."
fi

exec "$REPO_ROOT/scripts/import-store.sh"
