#!/usr/bin/env bash
# `bun dev`: full local dev in one command.
#
# Mirrors `bun run deploy` deliberately: the first run does the FULL bulk import
# before the dev server starts serving, so the web interface is never up without
# an index behind it. Same shared pipeline Rust, same failure posture — if the
# import fails, dev does not start, because a half-ready site is worse than an
# obvious error. Later runs start instantly from the persisted local KV.
#
# wrangler dev emulates everything this deployment uses — KV, Durable Objects
# with SQLite, alarms — so the production import pipeline also runs locally:
# DEV_BOOTSTRAP=worker skips the native seed and lets the ImportCoordinator
# bootstrap in-Worker exactly as a fresh production deploy would
# (~10-20 minutes), which is how you exercise that pipeline itself.
#
# Staleness is decided by `scripts/store-age.ts --local`: the SAME script, and
# therefore the same question, that a deploy runs against the live store. It
# used to ask only whether a manifest EXISTED, so a builder-generation change
# forced a rebuild before a deploy and was silently ignored here — dev started
# and served from a store the code could not read. A check that exists on one
# path and not on its twin is the failure this repo keeps rediscovering, so
# there is now one implementation with a flag rather than two that can drift.
#
# It therefore rebuilds for everything a deploy rebuilds for: a generation
# mismatch, a manifest whose chunks are missing, a store past the age backstop,
# and a store Scryfall has since superseded.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Says WHY on stderr either way — a rebuild that looks unexplained is how the
# "just delete .wrangler" folklore starts.
if ! bun "$REPO_ROOT/scripts/store-age.ts" --local; then
    if [[ "${DEV_BOOTSTRAP:-}" == "worker" ]]; then
        echo "DEV_BOOTSTRAP=worker — skipping the native seed. The Worker will"
        echo "self-bootstrap from Scryfall bulk data via the in-Worker import"
        echo "pipeline (~10-20 minutes); the site serves the building page until"
        echo "it finishes."
    else
        # Build the store natively (same shared Rust as production) and seed
        # local storage — a couple of minutes, mostly download — covering
        # everything the DO import produces: the store and manifest into local
        # KV. No toolchain check: with-rust.sh installs
        # rustup if this machine has no Rust, exactly as it does in CI, so
        # "first run works" does not depend on what happens to be installed.
        echo "==> Rebuilding the local card store (see the reason above)"
        echo "    (~2-3 minutes, mostly download). The dev server starts after."
        "$REPO_ROOT/scripts/seed-local.sh"
    fi
fi

exec bunx wrangler dev -c wrangler.dev.jsonc
