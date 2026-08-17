# Store build in a 128MB isolate: feasibility prototype — GO

> **PROVENANCE — read this before quoting any number below.** Measured
> **2026-08-08**, on a **synthetic, English-only** corpus at `default_cards`
> scale, against the store layout of that date — content generation ≤9,
> `ARCHIVE_FORMAT_VERSION` in the `20260806`–`20260809` range, **before**
> generation 10 put the whole Scryfall card-object surface into the archive,
> before generation 19 folded the residue archive back in, and before generation
> 20's multilingual annex. A store byte count is a statement about a layout, and
> this layout is four major revisions old.
>
> **The question this document answers has also changed shape.** It asks whether
> ONE archive fits a 128MB isolate. Production no longer builds one archive: the
> store is partitioned, and over the real multilingual corpus a single-archive
> build aborts under the cap by design. The live successor to this measurement is
> the `wasm build fit per partition` step in `scripts/gate.sh`, which cuts the
> real corpus at the manifest's own partition count and runs one capped build per
> partition in its own process. At N=10 those measured 91.6–104.4 MB against a
> **124 MiB** cap.
>
> What is still true, and is why this file is kept: the mechanisms in "What made
> it fit" are all live code, every symbol it names still resolves, and the
> reproduce recipe still runs (with the two corrections marked below).

Can the rkyv store build run inside a Cloudflare Worker/Durable Object isolate
(128MB memory, free plan) instead of the 4GB import container? **Yes.**
Measured on a realistic synthetic corpus (100k printings / 35k oracle cards,
57.1MB store — real `default_cards` scale; for comparison, today's real corpus
is 540,484 rows cut into ten ~40MB archives):

| measurement | before | after |
|---|---|---|
| native build peak heap (Vec path) | 142.8 MB | 79.2 MB max phase peak |
| wasm heap peak (spilling path) | OOM-trapped at 64k rows | **75.6 MB** |
| wasm linear memory high-water | 132.9 MB (over 192MB cap run) | **94.9 MB** |
| wasm build CPU (stage + finish) | — | ~9 s total, chunkable |

The wasm module was linked with `--max-memory=112MB` (117,440,512 = 1792
pages), leaving JS-side headroom inside a real 128MB isolate; the run
completed 33MB under the platform ceiling.

**That cap is no longer 112MB.** It was raised to **124 MiB** (130,023,424) when
generation 19 folded the residue archive back in, and that is what
`package.json`'s `build:wasm-import` and `scripts/gate.sh` link against today.
The "33MB under the ceiling" arithmetic goes with the old number.

## What made it fit

1. **`SpillingStoreBuilder`** (`card_engine/src/core_api.rs`): staged rows
   leave wasm memory as encoded blobs (callers store them — DO SQLite in
   production, a JS array in this probe) instead of accumulating in a
   `Vec<CardRow>`; only interners + 56B/row sort keys stay resident. At
   finish, rows stream back in `sorted_order()` — the exact order
   `build_card_data`'s sort produces — through the same grouping/index/
   serialization code (`build_card_data_sorted`, which the Vec path also
   delegates through, so both paths are the same code by construction).
2. **Early interner-map drop** in `build_card_data_sorted`: the string→id
   hash maps are dead weight after staging; freeing them first returns a
   large contiguous region before index construction wants one.
3. **Two-pass `build_oracle_text_index`**: the old single pass materialized
   every trigram/word posting in `HashMap<_, Vec<u32>>` lists (~41MB
   transient) that the tier split then compressed ~7× into bitplanes + CSR.
   Counting first (same per-text dedup) sizes every final buffer exactly and
   fills it in place; phase peak fell from 111.8MB to 69.2MB with the same
   final structures.
4. **Streamed archive output**: `finish_to_writer` already streams
   (rkyv `IoWriter`); the probe's `ChunkWriter` hands 1MB chunks to the host
   as they are produced, so the 57MB archive is never resident.

## Parity

Archive bytes are legitimately nondeterministic run-to-run (HashMap seeding
permutes index-entry order — two runs of the *unpatched* native builder
differ), so equality is defined semantically: `memprobe compare` loads two
stores and requires identical results for full printing dumps (all fields,
engine order), catalogs, ordered/offset windows, and text searches covering
every index tier (word dictionary, exact trigram, substring
trigram+verify, name bigram). Verified identical across:

- pre-patch Vec build ≡ post-patch Vec build (refactor is behavior-neutral)
- Vec build ≡ native spilling build
- native build ≡ wasm memory-capped build

(`sample_preferred` contents are excluded: they depend on archive-internal
order, i.e. random across rebuilds today by design; sizes are compared.)

Existing suites passed at the time (card_engine 154, builder roundtrip 2, repo
TS 1854). **Those counts are long stale and are not worth updating** — every one
of the three suites has grown substantially. `bun run gate` is the current
answer to "does everything pass", and it runs `cargo test --release
--workspace` and `bun test tests` among its ten steps.

On wasm32 the build is bit-reproducible (fixed hash seeds) — same input, same
sha256. **Do not generalize that to a native-vs-wasm comparison.** Over the same
rows the two targets differ in ~0.5% of archive bytes, all of it in the index
region, because index construction can break ties between equally-ranked rows in
build order. `scripts/gate.sh` says so explicitly and compares ANSWERS rather
than bytes for exactly this reason; a reader who takes the sentence above at
face value will reach for a byte comparison the gate forbids.

## Reproduce

Every subcommand below still exists and still parses. **Two corrections since
2026-08-08:**

1. Invoke cargo through **`scripts/with-rust.sh`**, not directly — Homebrew's
   `rustc` ships no `wasm32-unknown-unknown` std, and the wrapper prefers the
   rustup toolchain and installs the target on first use.
2. `memprobe gen` gained **`--foreign-ratio`**, defaulting to **0.0**. So the
   recipe below still synthesizes the *English-only* corpus these numbers were
   taken on, which is what makes them reproducible — and also what makes them
   not a statement about production. `scripts/gate.sh` passes
   `--foreign-ratio 3.7`, the measured `all_cards` shape.

```bash
# 1. synthetic corpus at default_cards scale (sandbox can't reach Scryfall;
#    determinism is required for cross-runtime comparison anyway)
scripts/with-rust.sh cargo run --release -p sylvan-store-builder --example memprobe -- gen \
    --printings 100000 --bulk /tmp/bulk.jsonl --tags /tmp/tags.json
scripts/with-rust.sh cargo run --release -p sylvan-store-builder --example memprobe -- rows \
    --bulk /tmp/bulk.jsonl --tags /tmp/tags.json --out /tmp/rows.jsonl

# 2. native builds + parity
scripts/with-rust.sh cargo run --release -p sylvan-store-builder --example memprobe -- build --rows /tmp/rows.jsonl --out /tmp/a
scripts/with-rust.sh cargo run --release -p sylvan-store-builder --example memprobe -- spill --rows /tmp/rows.jsonl --out /tmp/b
scripts/with-rust.sh cargo run --release -p sylvan-store-builder --example memprobe -- compare \
    --a /tmp/a/card-store-*.store --b /tmp/b/spill.store

# per-phase heap attribution (switches to card_engine's counting allocator)
scripts/with-rust.sh cargo run --release --features vendor-alloc-counter -p sylvan-store-builder \
    --example memprobe -- phases --rows /tmp/rows.jsonl --out /tmp/ckpt

# 3. the memory-capped wasm run (the original go/no-go). NOTE the cap: 112MB is
#    the historical value these results were taken at; 130023424 (124 MiB) is
#    what ships.
scripts/with-rust.sh cargo rustc --release -p sylvan-wasm-builder-probe --target wasm32-unknown-unknown \
    -- -C link-arg=--max-memory=117440512
bun engine/wasm-builder-probe/driver.ts \
    target/wasm32-unknown-unknown/release/sylvan_wasm_builder_probe.wasm \
    /tmp/rows.jsonl /tmp/store-wasm.store
scripts/with-rust.sh cargo run --release -p sylvan-store-builder --example memprobe -- compare \
    --a /tmp/a/card-store-*.store --b /tmp/store-wasm.store
```

### The measurement that replaced step 3

`memprobe partition` cuts a rows file by the shared partition hash, which is how
the capped build is exercised today — one driver **process** per partition,
because the probe cannot hold two partitions' state at once and nothing outlives
a process. That process isolation is the emit-one-release-one discipline the
nightly's partition loop must keep, enforced rather than described:

```bash
./target/release/examples/memprobe partition --rows store-build/rows.jsonl \
    --parts "$N" --out-prefix /tmp/fit-rows-p
# then one driver run per k, against --max-memory=130023424
```

`scripts/gate.sh` runs exactly this, taking `$N` from the manifest of the build
that produced those rows rather than from a hardcoded guess.

## What this unlocked — all of it landed

The ImportCoordinator DO replaced the container: it stages rows into its own
SQLite via `SpillingStoreBuilder` blobs (alarm-chained to respect per-invocation
CPU), then `finish_from_sorted` streams chunks into the store distribution
layer. `src/import-coordinator.ts` is that Durable Object, bound in
`wrangler.jsonc`.

The transform/tags pipeline is ported too: **`engine/wasm-import`** is the whole
import pipeline as a wasm C ABI, sharing `transform`/`tags`/`ranks` with the
native builder through `sylvan-store-builder`, with its fetch driven from JS.
The gate compares its output against the native builder's on every run,
precisely because a wasm-only build break would otherwise leave the nightly and
the deploy writing stores from different transform code.
