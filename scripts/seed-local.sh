#!/usr/bin/env bash
# Build a real card store from live Scryfall bulk data and seed it into
# wrangler's LOCAL simulated KV, so `bun dev` serves a fully working site
# without waiting on the in-DO bootstrap import.
#
# Same shared pipeline code as the production Durable Object import (the
# transform/tags/finalize/store-build Rust is identical); only the runner
# differs: a native binary writing straight into local KV.
#
#   bun run seed:local            # build store (~a few minutes) + seed locally
#   bun run seed:local --reuse    # skip the build, re-seed the last built store
#
# SYLVAN_BULK_DIR=<dir> streams already-downloaded dumps off disk instead of
# re-fetching ~470MB (see engine/builder/src/bulk.rs) — the difference between a
# two-minute iteration and a twenty-minute one when the corpus is already local.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
OUT_DIR="store-build"

if [[ "${1:-}" != "--reuse" ]]; then
    echo "Building sylvan-store-builder..."
    "$REPO_ROOT/scripts/with-rust.sh" cargo build --profile fast-native -p sylvan-store-builder
    echo "Building store from Scryfall bulk data (this streams ~450MB, takes a few minutes)..."
    # `--partitions auto` for the same reason import-store.sh passes it: this
    # deployment serves only partitioned stores, and the builder rejects unknown
    # argv — so a checkout whose builder predates the flag fails HERE, loudly,
    # instead of seeding a store the code cannot read.
    ./target/fast-native/sylvan-store-builder --out "$OUT_DIR" --partitions auto
fi

echo "Seeding local KV..."
bun scripts/seed-local-store.ts "$OUT_DIR"

# Rulings are not part of the store build (they hang off oracle_id, not off a printing, and only
# /cards/:id/rulings reads them), so they are fetched and published on their own. Without this the
# rulings routes are the one /cards/* surface that works in production and 503s in dev.
echo "Seeding local rulings..."
bun scripts/seed-rulings.ts

# Same story for the reference data behind /sets, /catalog/* and /symbology: mirrored off
# api.scryfall.com rather than built from the bulk dumps, so the store build does not produce it.
echo "Seeding local reference data..."
bun scripts/seed-reference.ts

echo "Done. Run: bun dev"
