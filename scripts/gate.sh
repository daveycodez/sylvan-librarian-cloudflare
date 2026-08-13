#!/usr/bin/env bash
# THE gate: everything that has to be green, in one command.
#
# This repo has no CI. There is no .github/, no git hooks, and bunfig.toml says so outright — "with
# no CI here, bare `bun test` is what a person or agent actually types". The only automation is
# Cloudflare Workers Builds, which hard-fails a deploy that cannot BUILD an index and checks
# nothing else. So the gate is a thing a person types, and the least it can do is be one thing
# rather than five that are easy to run four of.
#
# The four commands the README used to list (bun test, check, typecheck, clippy) are all here, plus
# the two that were never in it:
#
#   - `cargo test`. Nothing ran the Rust suite. Not one script in this repo invoked it, and
#     `scripts/clippy.sh` only ever COMPILED the tests via --all-targets. 215 assertions about the
#     engine were being carried by whoever remembered to type it.
#   - PERFORMANCE RATIOS. On 2026-08-12 three routes were found scanning the whole corpus:
#     `?fuzzy=` at 25.8ms, `named?exact=` at 884us and the fuzzy containment stage at 1,303us. Two
#     of the fixes were SLOWER than the code they replaced on the first attempt. Nothing would have
#     caught either, and nothing would catch a regression back.
#
# WHY RATIOS AND NOT MILLISECONDS. There is no CI hardware to stabilise a wall-clock threshold, and
# measured run-to-run noise on this machine reached 6% while relative ordering never moved. A ratio
# against a reference measured on the SAME store in the SAME run cancels the machine out.
#
# GATE_SKIP_PERF=1 skips the store build (~40s) when iterating on the fast checks.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

step "clippy (pinned 1.97.1, -D warnings)"
scripts/clippy.sh

step "cargo test"
scripts/with-rust.sh cargo test --release --workspace

step "typecheck"
bun run typecheck

step "biome"
bun run check

step "bun test"
bun test tests

if [[ "${GATE_SKIP_PERF:-0}" == "1" ]]; then
    printf '\n\033[1m==> perf ratios SKIPPED (GATE_SKIP_PERF=1)\033[0m\n'
    exit 0
fi

step "perf ratios"
# A deterministic corpus from a fixed seed and four committed fixtures — no network, no Scryfall
# dump, reproducible on any machine. Small (12k printings, not the real 95k) because the ratios
# this asserts hold at any corpus size and a 100k build would put minutes on every gate run.
PERF_DIR="${TMPDIR:-/tmp}/sylvan-gate-perf"
mkdir -p "$PERF_DIR"
if [[ ! -f "$PERF_DIR/rows.jsonl" ]]; then
    echo "  building the deterministic corpus (first run only)..."
    scripts/with-rust.sh cargo build --release -p sylvan-store-builder --example memprobe >/dev/null 2>&1
    ./target/release/examples/memprobe gen --printings 12000 \
        --bulk "$PERF_DIR/bulk.jsonl" --tags "$PERF_DIR/tags.json" >/dev/null 2>&1
    ./target/release/examples/memprobe rows \
        --bulk "$PERF_DIR/bulk.jsonl" --tags "$PERF_DIR/tags.json" --out "$PERF_DIR/rows.jsonl" >/dev/null 2>&1
fi
scripts/with-rust.sh cargo build --release -p sylvan-store-builder --example memprobe >/dev/null
rm -rf "$PERF_DIR/store" && mkdir -p "$PERF_DIR/store"
./target/release/examples/memprobe build --rows "$PERF_DIR/rows.jsonl" --out "$PERF_DIR/store" >/dev/null
STORE="$(find "$PERF_DIR/store" -name 'card-store-*.store' | head -1)"

./target/release/examples/memprobe routebench --store "$STORE" --iters 15 > "$PERF_DIR/route.txt" 2>/dev/null
cat "$PERF_DIR/route.txt"

# The reference is a KNOWN FULL SCAN of the same corpus, in the same process, in the same run:
# `fuzzy_card_by_name` walks every card by construction. A binary-search baseline was the obvious
# choice and is the wrong one — it lands under a microsecond, so the ratio divides by rounding
# noise, and the limit has to be so loose it stops meaning anything.
#
# THE LIMIT IS CALIBRATED, NOT GUESSED. It was set by measuring both states: the narrowing was
# deliberately disabled and the bench re-run, on this same 12k corpus.
#
#                                healthy    with narrowing removed
#     exact_card_by_name            0.4%                     14.7%
#     autocomplete                  0.3%                     13.5%
#     cards_containing_all_words    0.4%                     25.7%
#
# 3% sits ~7x above healthy and ~4x below the cheapest regression. The first attempt at this used
# 25%, which every one of those regressions passed — a gate nobody had watched fail is not a gate,
# and that one was measured failing to fail before this number replaced it.
#
# It is a TRIPWIRE for "this became a scan again", not a benchmark. Note the reference
# (`fuzzy_card_by_name`, trigram similarity per card) is far costlier per card than the scans it
# guards, which is exactly why a regressed route lands at ~15% and not ~100%.
awk '
    /^fuzzy_card_by_name/      { for (i=1;i<=NF;i++) if ($i=="us") scan  = $(i-1) }
    /^exact_card_by_name/      { for (i=1;i<=NF;i++) if ($i=="us") exact = $(i-1) }
    /^cards_containing_all_wo/ { for (i=1;i<=NF;i++) if ($i=="us") words = $(i-1) }
    /^autocomplete/            { for (i=1;i<=NF;i++) if ($i=="us") auto  = $(i-1) }
    /^card_by_illustration_id/ { for (i=1;i<=NF;i++) if ($i=="us") illus = $(i-1) }
    END {
        if (scan < 1) { print "\n  ERROR: no full-scan reference in routebench output"; exit 1 }
        fail = 0
        check("exact_card_by_name", exact, 3)
        check("cards_containing_all_words", words, 3)
        check("autocomplete", auto, 3)
        check("card_by_illustration_id", illus, 3)
        if (fail) exit 1
        printf "\n  all routes well under a full scan (reference fuzzy_card_by_name = %d us)\n", scan
    }
    function check(name, got, limit,   pct) {
        pct = 100 * got / scan
        printf "  %-28s %6d us  %6.1f%% of a full scan  (limit %d%%)%s\n", name, got, pct, limit, (pct > limit ? "   FAIL" : "")
        if (pct > limit) fail = 1
    }
' "$PERF_DIR/route.txt"

printf '\n\033[1m==> gate green\033[0m\n'
