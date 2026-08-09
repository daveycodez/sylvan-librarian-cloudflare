#!/usr/bin/env bash
# Build a real card store from live Scryfall bulk data and seed it into
# wrangler's LOCAL simulated D1, so `bun dev` serves a fully working site
# without waiting on the in-DO bootstrap import.
#
# Same shared pipeline code as the production Durable Object import (the
# transform/tags/finalize/store-build Rust is identical); only the runner
# differs: a native binary writing straight into local D1.
#
#   bun run seed:local            # build store (~a few minutes) + seed local D1
#   bun run seed:local --reuse    # skip the build, re-seed the last built store
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
OUT_DIR="store-build"

if [[ "${1:-}" != "--reuse" ]]; then
    echo "Building sylvan-store-builder..."
    "$REPO_ROOT/scripts/with-rust.sh" cargo build --profile fast-native -p sylvan-store-builder
    echo "Building store from Scryfall bulk data (this streams ~450MB, takes a few minutes)..."
    ./target/fast-native/sylvan-store-builder --out "$OUT_DIR"
fi

echo "Seeding local D1..."
bun scripts/seed-local-d1.ts "$OUT_DIR"

echo "Done. Run: bun dev"
