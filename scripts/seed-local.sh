#!/usr/bin/env bash
# Build a real card store from live Scryfall bulk data and seed it into
# wrangler's LOCAL simulated R2, so `bun dev` serves a fully working site.
#
# Same code path as the production import container (sylvan-store-builder);
# only the destination differs: local R2 simulation instead of the S3 API.
#
#   bun run seed:local            # build store (~a few minutes) + seed local R2
#   bun run seed:local --reuse    # skip the build, re-seed the last built store
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
OUT_DIR="store-build"
BUCKET="sylvan-librarian"

if [[ "${1:-}" != "--reuse" ]]; then
    echo "Building sylvan-store-builder..."
    cargo build --release -p sylvan-store-builder
    echo "Building store from Scryfall bulk data (this streams ~450MB, takes a few minutes)..."
    ./target/release/sylvan-store-builder --out "$OUT_DIR"
fi

STORE_KEY=$(python3 -c "import json;print(json.load(open('$OUT_DIR/manifest.json'))['store_key'])")

echo "Seeding local R2 ($BUCKET)..."
bunx wrangler r2 object put "$BUCKET/$STORE_KEY" --local --file "$OUT_DIR/$STORE_KEY" -c wrangler.dev.jsonc
bunx wrangler r2 object put "$BUCKET/manifest.json" --local --file "$OUT_DIR/manifest.json" -c wrangler.dev.jsonc

echo "Done. Run: bun dev"
