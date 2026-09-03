#!/usr/bin/env bash
# THE gate: everything that has to be green, in one command.
#
# THIS GATE IS STRICTLY WIDER THAN CI, and that is the whole reason it exists as a separate thing
# a person types. .github/workflows/ci.yml runs the cheap half on every PR and main push —
# typecheck, biome, `bun test tests`, clippy, `cargo test`, both wasm targets — plus a production
# /search smoke test after main deploys. What it CANNOT run is everything below that needs a built
# store or stable hardware: the performance ratios, the wasm-vs-native answer differential, and the
# per-partition wasm fit. So CI is the floor and this is the bar; a green PR is not a green gate.
#
# (This comment used to open "This repo has no CI. There is no .github/, no git hooks" — true when
# it was written, false since the 2026-08-23 outage put ci.yml there.)
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
# WHY RATIOS AND NOT MILLISECONDS. No hardware here is stable enough for a wall-clock threshold —
# a GitHub runner least of all, which is why these stay out of ci.yml — and
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

# ── the nightly's own build ───────────────────────────────────────────────────
# EVERY STEP ABOVE BUILDS NATIVE, AND THE NIGHTLY IMPORTER DOES NOT RUN NATIVE CODE. It runs
# engine/wasm-import compiled to wasm32 inside the ImportCoordinator DO, sharing transform_row
# and the whole transform/tags/ranks surface with the native builder through
# sylvan-store-builder. So a change that compiles natively and NOT on wasm32 — a native-only
# dependency reaching shared code, or a `#[cfg(not(target_arch = "wasm32"))]` that swallows the
# module below it — left this gate GREEN while `bun run build:wasm-import` was broken.
#
# That is the worst shape the failure can take, because it is not a build error anyone sees: the
# nightly keeps running whatever blob was last committed while the deploy path runs the new code,
# so the two publishers write stores from DIFFERENT transform code. It surfaces as a store whose
# values disagree with the other publisher's, and nothing compares them.
#
# The REAL link under the REAL cap, not a `cargo check`, because the cap is a link argument. No
# `cp` into engine/wasm-import/pkg/ — refreshing the committed blob is `bun run build:wasm-import`'s
# job, and a gate that dirties the tree is a gate people stop trusting.
step "wasm targets (what the nightly actually builds)"
scripts/with-rust.sh cargo rustc --release -p sylvan-wasm-import \
    --target wasm32-unknown-unknown -- -C link-arg=--max-memory=130023424
scripts/with-rust.sh cargo check --release -p sylvan-engine-wasm --target wasm32-unknown-unknown

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
# dump, reproducible on any machine. Small (12k canonical printings, not the real 95k) because
# the ratios this asserts hold at any corpus size and a 100k build would put minutes on every
# gate run. FOREIGN ROWS INCLUDED (--foreign-ratio 3.7, the measured all_cards shape): the
# name-path ratios below are only meaningful against the corpus whose annex the routes actually
# search.
#
# THE CACHE DIRECTORY IS NAMED BY THE GENERATOR'S OWN SHAPE TAG, not by hand. The corpus is cached
# across runs because synthesising it is pure and deterministic — of the generator that wrote it.
# After that generator changes, a cached bulk.jsonl is the OLD corpus wearing the new corpus's
# path, and every ratio, envelope case and fit measurement in the run is read off it. The `-ml`
# suffix was added by hand for exactly this reason once already (a pre-multilingual corpus serving
# a multilingual gate); `memprobe corpus-shape` is the version of that fix that cannot be
# forgotten, because the constant lives beside the code that would invalidate it.
scripts/with-rust.sh cargo build --release -p sylvan-store-builder --example memprobe >/dev/null
CORPUS_SHAPE="$(./target/release/examples/memprobe corpus-shape)"

# TWO DIRECTORIES, BECAUSE THEY HAVE OPPOSITE LIFETIMES.
#
# CORPUS_DIR is shared and PERSISTENT on purpose (see the shape-tag note above): the corpus is a
# pure function of a fixed seed and the generator's shape tag, so caching it across runs is what
# keeps a gate from paying ~40s to re-synthesise identical bytes.
#
# PERF_DIR is PER RUN. Everything downstream of the corpus — rows.jsonl, the native store, the
# routebench output, the wasm fit partitions, the wasm-built rows and store, the N=2/N=10 cuts —
# is the OUTPUT OF THE CODE UNDER TEST, and it all used to land in the shared, fixed directory
# with no lock and no run identifier — so two gates overlapping in time wrote to the same paths
# and read each other's results. Every one of those files is truncate-and-rewrite: a second run
# rewrites rows.jsonl while the first is building from it, `rm -rf .../store && mkdir` empties
# the store directory out from under a running `routebench`, `find .../store | head -1` can
# return the OTHER run's archive, and route.txt is overwritten between the write and the awk
# that grades it. The failure this produces is a ratio regression in a run whose own code is
# fine, which is the worst kind: it looks like the thing the gate exists to catch. Several
# late-step reds on 2026-08-17 have this shape. A private mktemp directory per run is the whole
# fix; it is torn down on success and on every failure path by the trap, matching
# import-store.sh and sync-upstream.sh.
CORPUS_DIR="${TMPDIR:-/tmp}/sylvan-gate-perf-${CORPUS_SHAPE}"
mkdir -p "$CORPUS_DIR"
CORPUS_BULK="$CORPUS_DIR/bulk.jsonl"
CORPUS_TAGS="$CORPUS_DIR/tags.json"

PERF_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sylvan-gate-run-XXXXXXXX")"
trap 'rm -rf "$PERF_DIR"' EXIT

# The CORPUS is cached; the ROWS are not. bulk.jsonl/tags.json are deterministic INPUTS from a
# fixed seed, so synthesising them once is free and safe. rows.jsonl is the OUTPUT OF THE CODE
# UNDER TEST — transform + finalize — and caching an output across runs means a gate that
# measures, and compares, whatever the pipeline produced on some earlier day. It cost real
# confusion: after a transform change the cached rows still held the old values, so the store
# built from them was stale while everything else in the run was current.
#
# Populated VIA THE RUN DIRECTORY AND A RENAME, never in place. `gen` writes its two files
# incrementally, so a concurrent gate that finds bulk.jsonl already present would otherwise start
# reading a corpus still being written. Both files are generated privately and moved in, tags
# first, so the presence of bulk.jsonl implies the pair is complete. Two runs racing to populate
# an empty cache both win: the bytes are identical by construction, and rename is atomic.
if [[ ! -f "$CORPUS_BULK" || ! -f "$CORPUS_TAGS" ]]; then
    echo "  synthesising the deterministic corpus '${CORPUS_SHAPE}' (first run only)..."
    ./target/release/examples/memprobe gen --printings 12000 --foreign-ratio 3.7 \
        --bulk "$PERF_DIR/corpus-bulk.jsonl" --tags "$PERF_DIR/corpus-tags.json" >/dev/null 2>&1
    mv -f "$PERF_DIR/corpus-tags.json" "$CORPUS_TAGS"
    mv -f "$PERF_DIR/corpus-bulk.jsonl" "$CORPUS_BULK"
fi
./target/release/examples/memprobe rows \
    --bulk "$CORPUS_BULK" --tags "$CORPUS_TAGS" --out "$PERF_DIR/rows.jsonl" >/dev/null
mkdir -p "$PERF_DIR/store"
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
# `cards_containing_all_words` grew a tier when containment took on Scryfall's rule, where a query
# word may span the name's own separators ("goad" inside "Ego à Deriva"): the index windows names
# WITH their separators in, so one word is probed as several spellings of itself. Re-measured over
# eight 60-iteration runs on this corpus at 10-29 us against a ~1.1 ms scan — 1.1-2.6%, against
# 0.4% before — so the limit stands at 3 and the number below still means what it says. The tier
# that could have moved it (unioning those probes over EVERY word, in the printed-name pass) is
# skipped whenever a name IS the query, which the whole-name needle this bench uses always is.
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
    # Presence flagged separately from the measurement: a healthy printed-exact hit measures 0-1
    # us, so "value < 1" cannot double as the missing-line check.
    /^printed_exact_hit/       { seen_pexact = 1; for (i=1;i<=NF;i++) if ($i=="us") pexact = $(i-1) }
    END {
        if (scan < 1) { print "\n  ERROR: no full-scan reference in routebench output"; exit 1 }
        if (!seen_pexact) { print "\n  ERROR: no printed-name route in routebench output (foreign corpus missing?)"; exit 1 }
        fail = 0
        check("exact_card_by_name", exact, 3)
        check("cards_containing_all_words", words, 3)
        check("autocomplete", auto, 3)
        check("card_by_illustration_id", illus, 3)
        # The foreign name lane: a printed-name exact hit must stay index-driven (sorted-record
        # binary search + trigram halves), same tripwire as its English twin. printed_fuzzy_hit
        # is reported above but ungated — fuzzy IS the sanctioned scan class.
        check("printed_exact_hit", pexact, 3)
        if (fail) exit 1
        printf "\n  all routes well under a full scan (reference fuzzy_card_by_name = %d us)\n", scan
    }
    function check(name, got, limit,   pct) {
        pct = 100 * got / scan
        printf "  %-28s %6d us  %6.1f%% of a full scan  (limit %d%%)%s\n", name, got, pct, limit, (pct > limit ? "   FAIL" : "")
        if (pct > limit) fail = 1
    }
' "$PERF_DIR/route.txt"

# ── wasm build fit ────────────────────────────────────────────────────────────
# The in-Worker nightly build runs under wasm-import's --max-memory cap, so
# corpus growth or a format change can silently take the NIGHTLY from green to
# aborting. This tripwire runs the real capped build over the real corpus
# whenever one exists (store-build/rows.jsonl, produced by every
# `bun run seed:local`), so the cap is breached HERE, before a push, rather than
# some night in production.
#
# It measures the PARTITIONED shape only, because that is the only shape that
# exists: partitionCountFor clamps to MIN_PARTITION_COUNT=2 and writeManifest
# refuses a manifest without partitions, so no publisher can emit a single
# archive. The old single-archive step was deleted rather than fixed — over the
# multilingual corpus it aborted, correctly and uselessly, on a build nothing
# performs (517,746 rows in one archive; production cuts the same corpus nine
# ways). Keeping it would have meant a red gate asserting an impossibility.
#
# N comes from the manifest of the build that produced these rows, so the
# tripwire measures the partition size production actually ships rather than a
# hardcoded guess — at the 43MB target this corpus cuts nine ways, and a
# hardcoded N=4 measured 131k-row partitions that only the gate would ever build.
if [[ -f store-build/rows.jsonl ]]; then
    scripts/with-rust.sh cargo rustc --release -p sylvan-wasm-builder-probe \
        --target wasm32-unknown-unknown -- -C link-arg=--max-memory=130023424 >/dev/null 2>&1
    FIT_OUT="$PERF_DIR/wasm-fit.txt"
    FIT_PARTS=4
    if [[ -f store-build/manifest.json ]]; then
        FIT_PARTS=$(bun -e 'const m=await Bun.file("store-build/manifest.json").json();console.log(m.partition_count??4)')
    fi

    # The same corpus cut by the shared hash at the production N, each partition through its own
    # capped build. One driver PROCESS per partition — the probe cannot hold two partitions' state
    # at once because nothing outlives a process — which is the emit-one-release-one discipline the
    # nightly's partition loop must keep (plan §5.5).
    step "wasm build fit per partition (N=$FIT_PARTS, real corpus)"
    ./target/release/examples/memprobe partition --rows store-build/rows.jsonl \
        --parts "$FIT_PARTS" --out-prefix "$PERF_DIR/fit-rows-p" 2>/dev/null
    for ((k = 0; k < FIT_PARTS; k++)); do
        if bun engine/wasm-builder-probe/driver.ts \
            target/wasm32-unknown-unknown/release/sylvan_wasm_builder_probe.wasm \
            "$PERF_DIR/fit-rows-p${k}.jsonl" "$PERF_DIR/store-wasm-p${k}.store" > "$FIT_OUT" 2>&1; then
            echo "  p${k}: $(grep -E 'linear_memory' "$FIT_OUT" | sed 's/<--.*//' | xargs)"
        else
            tail -5 "$FIT_OUT" | sed 's/^/  /'
            echo "  ERROR: partition ${k}'s capped wasm build ABORTED under the 124MiB cap."
            echo "  The nightly builds exactly this shape, one partition at a time — it would die."
            exit 1
        fi
    done
else
    echo "  (wasm build fit: skipped — no store-build/rows.jsonl; run bun run seed:local to enable)"
fi

# ── the two publishers answer the same ────────────────────────────────────────
# A DEPLOY BUILDS THE STORE NATIVELY AND THE NIGHTLY BUILDS IT IN WASM, and the whole partitioned
# design assumes the two are interchangeable. The step above proves the wasm build FITS; it does
# not prove it produces the same store, and the gate builds both targets without ever comparing
# their output — one step short of the property anyone actually depends on.
#
# Byte equality of the archive is NOT that property and must not be asserted: over the same rows
# the two targets differ in ~0.5% of archive bytes, all of it in the index region, because index
# construction can break ties between equally-ranked rows in build order. What matters is whether
# a query can SEE that difference, so this compares ANSWERS — `memprobe compare`'s tie-heavy
# envelope grid (low-cardinality orderings in both directions, all three unique modes, with and
# without the annex, deep offsets) row for row, plus the text-index tiers.
step "native vs wasm store: same rows, same answers"
bun engine/wasm-import/driver.ts \
    target/wasm32-unknown-unknown/release/sylvan_wasm_import.wasm \
    "$CORPUS_BULK" "$CORPUS_TAGS" \
    "$PERF_DIR/rows-wasm.jsonl" "$PERF_DIR/store-wasm.store" >"$PERF_DIR/wasm-import.txt" 2>&1 || {
    tail -8 "$PERF_DIR/wasm-import.txt" | sed 's/^/  /'
    echo "  ERROR: the wasm import path failed on the gate corpus — the NIGHTLY runs this path."
    exit 1
}
# The rows first: identical rows are what makes an archive difference a build-order question
# rather than a data one, so a divergence here localises the fault immediately.
if ! cmp -s "$PERF_DIR/rows.jsonl" "$PERF_DIR/rows-wasm.jsonl"; then
    echo "  ERROR: wasm-built rows differ from native-built rows over the same corpus."
    echo "  The deploy and the nightly would write stores from DIFFERENT transform output."
    cmp "$PERF_DIR/rows.jsonl" "$PERF_DIR/rows-wasm.jsonl" | sed 's/^/  /' | head -3
    exit 1
fi
./target/release/examples/memprobe compare --a "$STORE" --b "$PERF_DIR/store-wasm.store" | sed 's/^/  /'

# ── the cut does not change the answer ────────────────────────────────────────
# CARD-PARTITIONING §6 asked for "byte-identical envelopes, partitioned vs unpartitioned". No such
# thing can be built: partitionCountFor floors at MIN_PARTITION_COUNT=2, writeManifest refuses a
# manifest without partitions, and a single archive over the multilingual corpus aborts under the
# cap by design. The old single-archive step was deleted rather than fixed, correctly — and that
# left the CUT proven on a small fixture, the MERGE proven in isolation
# (partitioned_key_streams_merge_to_the_unpartitioned_order), and nothing joining the two end to
# end.
#
# This is the achievable form and it is strictly stronger, because it joins them: the same corpus
# cut N=2 and N=10, both legal, both under the cap, run through the same reference two-phase
# gather the serving DO implements, over the SAME tie-heavy 162-case envelope grid `compare` uses
# above. Byte equality between the two cuts is exactly what the original criterion wanted — that
# the answer does not depend on how the corpus was cut.
# It carries its own NEGATIVE CONTROL, in the same invocation and over the same two cuts. A
# differential that cannot fail is worth nothing, and this repo produced two of those in one night
# (a compare grid whose four low-cardinality orderings were single tie groups, and a plane-path
# "ordering" assertion over a column that was None on every row). So the check is made to FAIL
# deliberately, by substituting the partition-local dense rank for the sort key's primary segment —
# precisely the encoding `encode_sort_key` refuses to write (the set CODE, never `set_rank`) — and
# memprobe exits non-zero if that substitution does NOT break it.
step "partition differential: N=2 vs N=10, same corpus, same answers"
./target/release/examples/memprobe compare-parts --rows "$PERF_DIR/rows.jsonl" \
    --work "$PERF_DIR/cuts" --a 2 --b 10 2>&1 | grep -v '^  p[0-9]*:' | sed 's/^/  /'

printf '\n\033[1m==> gate green\033[0m\n'
