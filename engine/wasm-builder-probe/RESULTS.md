# Store build in a 128MB isolate: feasibility prototype — GO

Can the rkyv store build run inside a Cloudflare Worker/Durable Object isolate
(128MB memory, free plan) instead of the 4GB import container? **Yes.**
Measured on a realistic synthetic corpus (100k printings / 35k oracle cards,
57.1MB store — real `default_cards` scale):

| measurement | before | after |
|---|---|---|
| native build peak heap (Vec path) | 142.8 MB | 79.2 MB max phase peak |
| wasm heap peak (spilling path) | OOM-trapped at 64k rows | **75.6 MB** |
| wasm linear memory high-water | 132.9 MB (over 192MB cap run) | **94.9 MB** |
| wasm build CPU (stage + finish) | — | ~9 s total, chunkable |

The wasm module is linked with `--max-memory=112MB` (117,440,512 = 1792
pages), leaving JS-side headroom inside a real 128MB isolate; the run
completes 33MB under the platform ceiling.

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

Existing suites pass: card_engine 154, builder roundtrip 2, repo TS 1854.
On wasm32 the build is bit-reproducible (fixed hash seeds) — same input,
same sha256.

## Reproduce

```bash
# 1. synthetic corpus at default_cards scale (sandbox can't reach Scryfall;
#    determinism is required for cross-runtime comparison anyway)
cargo run --release -p sylvan-store-builder --example memprobe -- gen \
    --printings 100000 --bulk /tmp/bulk.jsonl --tags /tmp/tags.json
cargo run --release -p sylvan-store-builder --example memprobe -- rows \
    --bulk /tmp/bulk.jsonl --tags /tmp/tags.json --out /tmp/rows.jsonl

# 2. native builds + parity
cargo run --release -p sylvan-store-builder --example memprobe -- build --rows /tmp/rows.jsonl --out /tmp/a
cargo run --release -p sylvan-store-builder --example memprobe -- spill --rows /tmp/rows.jsonl --out /tmp/b
cargo run --release -p sylvan-store-builder --example memprobe -- compare \
    --a /tmp/a/card-store-*.store --b /tmp/b/spill.store

# per-phase heap attribution (switches to card_engine's counting allocator)
cargo run --release --features vendor-alloc-counter -p sylvan-store-builder \
    --example memprobe -- phases --rows /tmp/rows.jsonl --out /tmp/ckpt

# 3. the memory-capped wasm run (the actual go/no-go)
cargo rustc --release -p sylvan-wasm-builder-probe --target wasm32-unknown-unknown \
    -- -C link-arg=--max-memory=117440512
bun engine/wasm-builder-probe/driver.ts \
    target/wasm32-unknown-unknown/release/sylvan_wasm_builder_probe.wasm \
    /tmp/rows.jsonl /tmp/store-wasm.store
cargo run --release -p sylvan-store-builder --example memprobe -- compare \
    --a /tmp/a/card-store-*.store --b /tmp/store-wasm.store
```

## What this unlocks (not in this prototype)

The ImportCoordinator DO replaces the container: stage rows into its own
SQLite via `SpillingStoreBuilder` blobs (alarm-chained to respect per-
invocation CPU), then `finish_from_sorted` streaming chunks into the store
distribution layer. The transform/tags pipeline (`bulk.rs`/`transform.rs`/
`tags.rs`) still needs its wasm port + resumable fetch; this prototype
de-risked the one step that had no fallback if it didn't fit.
