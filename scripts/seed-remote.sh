#!/usr/bin/env bash
# Seed PRODUCTION KV with a natively-built store, so a first deploy is live
# immediately instead of waiting ~10 minutes for the in-Worker bootstrap.
# Needs `wrangler login` credentials and the real database id in
# wrangler.jsonc; the deployed Worker still needs zero configuration.
#
#   bun run seed:remote               # build + push the store to KV
#                                     # (~200k metered writes — paid plan;
#                                     # on free let the nightly import fill it)
#   bun run seed:remote --reuse ...   # skip the build, push the last built store
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
OUT_DIR="store-build"

REUSE=0
PASS_ARGS=()
for arg in "$@"; do
    case "$arg" in
        --reuse) REUSE=1 ;;
        *) PASS_ARGS+=("$arg") ;;
    esac
done

if [[ "$REUSE" != "1" ]]; then
    echo "Building sylvan-store-builder..."
    "$REPO_ROOT/scripts/with-rust.sh" cargo build --profile fast-native -p sylvan-store-builder
    echo "Building store from Scryfall bulk data (this streams ~450MB, takes a few minutes)..."
    ./target/fast-native/sylvan-store-builder --out "$OUT_DIR"
fi

bun scripts/seed-remote-kv.ts "$OUT_DIR"
