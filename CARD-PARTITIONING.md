# Card Partitioning — the plan for when the store outgrows one Durable Object

Status: **not started, not needed yet.** This is a design to pick up when the memory ceiling actually binds, written down while the measurements behind it were fresh (2026-08-11) so the next person does not have to re-derive them.

Every number below marked *measured* came from loading real archives into the committed wasm engine and reading `WebAssembly.Memory.buffer.byteLength` at each stage. Numbers marked *estimated* are arithmetic on top of those, and are only as good as their assumptions — which are stated.

---

## 1. Why this exists

A Durable Object gets 128 MB. The whole card store lives inside one, in wasm linear memory, and it is queried in place rather than parsed — so linear memory tracks the archive almost exactly.

Measured, 2026-08-11, at commit `0d19d29`:

| | Bytes | MB |
|---|---:|---:|
| Search archive (`card-store-v2026081102`) | 76,636,456 | 76.64 |
| Residue archive (`card-compat-v2026081102`) | 11,839,272 | 11.84 |
| Linear memory, `/search`-only object | — | **79.30** |
| Linear memory, `/cards/*` object (residue attached) | — | **91.16** |
| Worker script (JS + both compiled wasm modules) | ~3,600,000 | ~3.6 |

`/cards/*` is the main path — mtg-seeker points at it, per the comment at `src/engine/search-engine-do.ts` in the Scryfall-compat section. So the second row is the one that matters: in practice every object attaches the residue almost immediately and sits at ~91 MB, and the lazy attach in `store.ts` (`ensureCompat`) is a cold-start optimization, not a steady-state saving.

### The ceiling

Peak memory, not steady state, is what binds. Two moments compete:

```
search archive load   =  1.57 engine + S + KV_CHUNK_BYTES + 3.63 script
residue attach        =  1.57 engine + S + 1.05 index + R + min(chunk, R) + 3.63 script
```

With `R ≈ 0.155 × S` (measured once, at one build — **see open questions**) and `KV_CHUNK_BYTES = 26_000_000`, the residue attach binds first at **S ≤ 93.0 MB**.

That is 16.4 MB of headroom over today's 76.64 MB. At the measured 2.42 KB per oracle card that is roughly **6,800 more cards**, and at 3-4k new oracle cards per year, **about 1.9 years** (*estimated*).

### Do the cheap thing first

Shrinking `KV_CHUNK_BYTES` and fetching several chunks concurrently is far less work than this document and buys most of a year. It only moves the transient copy, though, never the resident one — the asymptote with an infinitely small chunk is `S ≤ 105.4 MB`, roughly 3.4 years.

| Bytes in flight | Binding ceiling | Runway (*estimated*) |
|---|---:|---:|
| 26 MB (today) | 93.0 MB | ~1.9 yr |
| 16 MB | 93.0 MB | ~1.9 yr — **no gain**, 16 MB is still above the 11.84 MB residue so it ships as one chunk |
| 8 MB | 98.5 MB | ~2.6 yr |
| 4 MB | 101.9 MB | ~3.0 yr |
| 1 MB | 104.5 MB | ~3.3 yr |

**Trigger for starting this document's work:** when `store_bytes` in the published manifest crosses ~90 MB, or when the loader work above has landed and the runway is still under about 18 months. Not before.

---

## 2. Naming — two words are already taken

This is the easiest thing to get wrong, because this codebase already uses both obvious words for other things.

**"shard" means replica.** `src/engine/shard-controller.ts` implements replica sharding: N Durable Objects per region, each holding a *complete copy* of the store, with `pickShard()` spreading requests across them by `Math.random()`. It spreads CPU load and does nothing for memory — every replica holds the whole 91 MB. Names are built in `src/index.ts`:

```
shard 0  ->  engine-<region>
shard n  ->  engine-<region>-<n>
```

`<region>` is one of the nine `DurableObjectLocationHint` values (`wnam`, `enam`, `weur`, `eeur`, `apac`, `oc`, `sam`, `afr`, `me`), chosen by `regionHint()` in `src/engine/region.ts`. It used to be `<colo>`; see the routing comment in `src/index.ts` for why that changed.

**"slice" means one alarm's unit of work.** `src/import-coordinator.ts` uses it throughout for a single alarm invocation's step, including in log lines you will read in production: `Publish slice: KV chunk 1/3`, and error text like *"a slice is being killed, not failing"*.

So this document uses **partition** for a subset of the card data, and `PARTITION_COUNT` for how many there are. Replicas spread load; partitions spread *data*. They multiply: `replicas × partitions` objects per region.

Do not overload `activeShards`, `pickShard`, `currentShardWidth`, or `adoptShardWidth`. Those are the replica autoscaler and its rendezvous protocol, and it took a production ramp and a real fix (the 73/17/10/5 imbalance documented at the top of `shard-controller.ts`) to get them right. Adding a second meaning will break that.

Suggested naming, keeping the existing scheme intact:

```
replica 0, partition 0  ->  engine-<region>-p0
replica 0, partition k  ->  engine-<region>-p<k>
replica n, partition k  ->  engine-<region>-<n>-p<k>
```

---

## 3. The partition key: `hash(oracle_id) % PARTITION_COUNT`

`PARTITION_COUNT` is a small fixed number chosen at build time — 4 or 8, not one per card.

**Why oracle_id and nothing else.** Every printing of a card shares its oracle_id, so hashing on it puts all ~40 printings of Lightning Bolt in the same partition. That is what lets `unique:card` and the `prefer` scoring stay *local*: a partition can pick a card's representative printing by itself, because it can see every candidate.

Partition on set code, name range, or printing id instead and printings of one card scatter. The coordinator then has to dedup across partitions and re-run `prefer_score` itself — which drags the whole preference model out of the engine and into TypeScript, where it will drift from the Rust implementation. Do not do this.

A consequence worth banking: **single-card routes stop fanning out entirely.** `/cards/<scryfall_id>`, `printings_of_oracle_id`, and `card_by_external_id` can compute the owning partition and make exactly one RPC. Those routes get *cheaper* than today, because they hit a ~19 MB object instead of a 91 MB one.

---

## 4. The builder

Today `engine/builder` emits one archive pair and the coordinator publishes it.

- The builder partitions cards by `hash(oracle_id) % PARTITION_COUNT` during the commit pass — after rows are grouped by oracle_id, which is where the grouping already happens — and emits `PARTITION_COUNT` archive pairs.
- The hash must be **identical** in the Rust builder and in the TypeScript router, and pinned: a stable hash written down in both places with a shared test vector. If they disagree, the router asks the wrong partition and cards silently vanish from results rather than erroring. This is the highest-consequence detail in the design.
- `content_generation` bumps, since this changes what a structurally-valid store contains.

Each partition is ~1/N the size, so it needs fewer KV chunks, and all partitions load in parallel. Cold load should get *faster*: today's 76.64 MB is 3 sequential chunk fetches (measured ~337 ms median for 3 chunks, per the history in `store-kv.ts`); four partitions of ~19 MB are one chunk each, fetched simultaneously — roughly one round trip instead of three.

---

## 5. The cron importer

The nightly rebuild (`triggers.crons`, `17 11 * * *`) runs the whole pipeline inside `ImportCoordinator` as an alarm chain, with every phase's inputs in that DO's SQLite so a killed invocation resumes rather than restarting. Partitioning touches it in six places.

### 5.1 Publish is one KV chunk per alarm

`publish` writes exactly one chunk and returns (`return; // next alarm continues`), so the number of publish alarms equals the number of chunks. Today that is 3 store chunks + 1 residue chunk + the manifest.

With 4 partitions at today's 26 MB chunk size: each partition is ~19 MB search (1 chunk) + ~3 MB residue (1 chunk), so 8 chunks + manifest — about twice the alarm hops. Combined with the recommended smaller chunks (4 MB), it is ~20 store chunks + 4 residue chunks + manifest, so **~25 publish alarms against ~4 today**.

This is fine on wall-clock — it is a nightly job and each alarm is mostly I/O — but it is the thing most likely to make the run feel slow, and `MAX_PHASE_ATTEMPTS` (12) is a per-phase stuck-detector that should be checked against the new hop count before it starts tripping on a healthy run.

### 5.2 Resume cursors become per-partition

The publish cursor is currently three meta keys for the store and three for the residue:

```
kv_chunks_published / kv_cursor_seq / kv_cursor_off
kv_compat_published / kv_compat_seq / kv_compat_off
```

These need a partition dimension. Prefer one JSON meta value holding an array of per-partition cursors over multiplying flat keys — the reset block (`metaSet("kv_chunks_published", "0")` and friends) has to stay exhaustive, and a forgotten key there is a resume bug that only shows up on a mid-publish restart.

### 5.3 The manifest stays the single commit point

Today the manifest is written last, and the reason is spelled out in the code: *"the manifest naming a compat_key whose chunks are not in KV yet is exactly the state a reader must never see."*

That generalizes rather than changes. The manifest names all `PARTITION_COUNT` archive pairs and is written **after every chunk of every partition is in KV**. A reader must never see a manifest naming a partition whose chunks are absent. Since chunk keys carry `built_at`, a partial publish leaves orphaned chunks that nothing references — same property as today, just N-wide.

### 5.4 Retention sweeps N×2 key families

`kv_store_history` keeps `KEEP_STORES` generations and deletes the retired ones, already handling both archives (*"Both archives, or the residue's chunks leak: they are keyed by their own name"*). With partitions that becomes `PARTITION_COUNT × 2` key families per generation. The same leak applies with more surface: a missed family is dead KV storage nothing will ever collect.

Rollback still works the same way — republish the previous manifest — but only because retention keeps the whole previous generation's partitions together. Retention must be all-or-nothing per generation.

### 5.5 Build-side memory gets easier, not harder

The reader is not the only 128 MB isolate. `store-kv.ts` notes the real constraint on `KV_CHUNK_BYTES` is *"the 128MB isolate the nightly publisher assembles chunks in"*, and that this only fits because the build releases the wasm group (~75 MB of linear memory that never shrinks) before publish runs.

Partitioning relieves this, provided the builder emits partitions **one at a time** and releases each before starting the next. If it holds all `PARTITION_COUNT` archives simultaneously it has gained nothing and the importer hits the ceiling before the reader does. This ordering is a requirement, not an optimization.

### 5.6 Staged-row budget is roughly unchanged

Staging is bounded by total bytes, not partition count — the same ~88 MB goes into DO SQLite at the 2 MB per-value cap either way, so the row count is about the same (~45 rows). Against the free plan's 100k rows/day this is noise. The storage-budget guard (`Import stopped on ${scope} storage budget in phase ${phase}`) should not need retuning, but confirm rather than assume, since partitioning adds staging tables.

KV writes go from ~5 per publish to ~9 (26 MB chunks) or ~25 (4 MB chunks), against a 1,000/day free allowance. Not a concern.

### 5.7 The new hazard: mixed-generation reads

**This does not exist today and is the one genuinely new correctness problem.**

Today one object holds the whole store, so a hot swap is atomic from any reader's point of view: the publisher pushes to every region (`notifyPublish`), `loadStore` swaps, and a query sees one generation or the other.

With partitions, each partition object polls and swaps **independently**. During a nightly publish, partition 0 may be on build B while partition 1 is still on build A, and a fan-out query mixes both.

Consequences, in order of severity:

- **`total_cards` sums counts from two generations.** Slightly wrong for a few minutes a night.
- **Card data is stale on some partitions.** Benign — it is one night's drift.
- **No duplication or loss**, as long as `PARTITION_COUNT` is unchanged. `hash(oracle_id)` is stable, so a card stays in its partition across builds.

The mitigation ladder, cheapest first: accept the window (it is minutes, nightly, and the data difference is one Scryfall refresh); or have the coordinator read the manifest once and pin a `store_key` for the whole fan-out, with partitions keeping the previous generation addressable — retention already holds it, so this is routing work rather than storage work.

**Changing `PARTITION_COUNT` is a migration, not a config change.** Cards move between partitions, so during any window where two generations are live a card can be in both partitions (duplicate) or neither (lost). It needs a full drain: publish, wait for every object to converge, then serve. Treat it like a schema migration and give it its own runbook.

---

## 6. Query path: two-phase (query-then-fetch)

The problem: rows `[offset, offset+limit)` in global sort order cannot be identified without consulting every partition, because the sort order is scattered.

The naive approach — every partition returns its own top `offset + limit` rows and the coordinator merges — is correct, simple, and degrades badly with depth. At `offset=5000, limit=100, 4 partitions` that moves 20,400 rows to return 100, roughly 9 MB at the measured ~440 bytes/row, and forces each partition to materialize 5,100 rows (measured: ~17.5 MB of wasm memory and ~19 ms of CPU for 5,000 rows).

Use two phases instead. This is what Elasticsearch calls query-then-fetch.

**Phase 1 — query.** Each partition runs the filter, sorts, and returns only `(sort_key, row_id)` for its top `offset + limit` — roughly 24 bytes per row against ~440 for a full row. Returns its own unpaginated match count alongside.

**Phase 2 — fetch.** The coordinator merges the N key lists, applies `offset`/`limit` to determine which ids win, then asks only the owning partitions for those rows, in parallel.

| `offset=5000`, `limit=100`, 4 partitions | Naive | Two-phase |
|---|---:|---:|
| Bytes moved | ~9 MB | ~534 KB |
| Rows materialized per partition | 5,100 full | 5,100 keys |
| Round trips | 1 | 2, second is small and parallel |

Per-route notes:

- **`total_cards`** — sum the per-partition counts from phase 1. Stays the unpaginated count, as `EngineSearchOptions` requires.
- **`catalog()`** — sum the type and keyword histograms. Cacheable per loaded store exactly as `catalogOnce` does today.
- **`random_search` / `randomCardsAsJson`** — pick one partition weighted by card count and sample within it. No fan-out. Seed handling stays per-request.
- **`autocomplete` and `fuzzy_card_by_name`** — genuinely need fan-out plus a merge, since name order is global. Small result sets, so naive scatter-gather is fine.
- **Single-card routes** — route directly to the owning partition, as in §3.

### The sort-key contract

Phase 1 requires the coordinator to reproduce the engine's ordering *exactly* from sort keys alone, including tiebreaks. Today ordering lives entirely in Rust (`SortCol`, `prefer_score`, the `set_rank`/`artist_rank` dense ranks that exist precisely because a set code is a string and intern order is not alphabetical).

The sort key must therefore be an opaque, totally-ordered byte string emitted by the engine, which the coordinator compares bytewise and never interprets. Do not reimplement comparison logic in TypeScript. A differential test — same query, partitioned vs unpartitioned, byte-identical result envelopes — is the acceptance criterion for this whole project.

---

## 7. What gets worse

**Tail amplification.** Every request waits for the slowest partition. With 4 partitions the median request waits for roughly today's p84, and today's p99.75 becomes the new p99.

This is smaller than textbook max-of-N math implies, because every query hits every partition, so they see identical load and their slow moments correlate. What remains is host-level jitter, which does not correlate. It is a real cost that cannot be tuned away — only each partition's own variance can be tightened.

**Deep pagination.** Two-phase makes it ~17× cheaper, not free. Cost still grows with `offset`. Consider capping page depth: Scryfall pages `/cards/search` at 175 per page, and paging all 17,710 creatures is 101 pages with a worst-case `offset ≈ 17,500`. A cap trades API parity for a bounded cost; price it against real traffic first.

**Two round trips on the hot path.** Phase 2 is small and parallel, but it is a second hop on the main `/cards/*` path.

**Operational surface.** `replicas × partitions` objects per region. More to warm, more to observe, more that can be individually evicted — plus the mixed-generation window in §5.7.

## 8. What gets better

- **The memory ceiling disappears.** Need more room, raise `PARTITION_COUNT` (as a migration — see §5.7).
- **Cold load gets faster** — smaller partitions, fetched in parallel, one round trip instead of three.
- **Single-card routes get cheaper** — one RPC to a ~19 MB object.
- **The nightly publisher's own 128 MB ceiling relaxes**, provided §5.5 is respected.
- **Cold-object risk does not multiply.** Because every query hits every partition, they warm together and idle together — one coin flip landing on N objects, not N independent flips. The residual is per-object eviction under host memory pressure, and a ~19 MB partition recovers in a single round trip.

---

## 9. Migration path

Land it in stages, each independently revertable, with the unpartitioned path intact until the last one.

**Phase 0 — measure.** See §11. Do not start Phase 1 without a clean `/cards/*` latency distribution; its *spread* determines the entire cost of this project.

**Phase 1 — builder and importer only.** Emit `PARTITION_COUNT` archive pairs, extend the manifest, per-partition publish cursors, retention over the new key families. The engine still loads every partition into one DO and serves exactly as today. This proves the partition, the hash agreement, and all of §5 without touching the query path, and reverts by republishing a single-partition manifest.

**Phase 2 — sort keys.** Add opaque sort-key emission to the engine and the phase-1 RPC shape, still answering from the single DO. Build the differential test harness here.

**Phase 3 — fan-out.** One DO per partition, coordinator does two-phase. Gate behind an env var so a bad rollout is one config change from the old path. Run both and compare envelopes in production before cutting over.

**Phase 4 — remove the unpartitioned path** once Phase 3 has been stable through several nightly rebuilds.

---

## 10. Reference — files this touches

| File | Role today | Change |
|---|---|---|
| `engine/builder/` | builds one archive pair | partition by `hash(oracle_id)`, emit N pairs, one at a time (§5.5) |
| `src/import-coordinator.ts` | staging, alarm chain, KV publish, retention | per-partition cursors, N-wide publish, manifest last, retention over N×2 families |
| `src/engine/store-kv.ts` | chunking, manifest, `KV_CHUNK_BYTES` | per-partition keys, `partition_count` |
| `src/engine/store.ts` | per-isolate store load, `ensureCompat` | load one partition |
| `src/engine/search-engine-do.ts` | the per-region DO, RPC surface | phase-1 / phase-2 RPCs |
| `src/engine/remote-engine.ts` | isolate-side client | fan-out + merge coordinator |
| `src/index.ts` | builds DO names, picks replica | add the partition axis to naming |
| `src/engine/shard-controller.ts` | **replica** autoscaler | ideally untouched — see §2 |
| `engine/wasm/src/lib.rs` | wasm boundary | sort-key emission, phase-1 shape |
| `vendor/sylvan_librarian/card_engine/` | the engine | sort-key encoding, partition-aware build |

`vendor/` is a vendored upstream checkout synced by `scripts/sync-upstream.sh`. Changes there need the LOCAL PATCH convention used elsewhere in that tree, or the next sync will clobber them.

---

## 11. Open questions — measure these first

1. **Does `R ≈ 0.155 × S` hold?** The residue-to-store ratio comes from exactly one build on 2026-08-11. Every ceiling number here depends on it. Confirm across several generations before betting a design on it.
2. **What is the real `/cards/*` latency distribution?** Production p90/p99 are polluted by the nightly import's alarm chain (whole-service p50 wall 70 ms, p50 CPU 4 ms, but p99 wall 7.5 s is the importer). Filter to user-facing `/cards/*` invocations only. The spread decides whether tail amplification is tolerable.
3. **How deep does real pagination go?** If ~all traffic is page 1, the deep-page analysis is theoretical and a cap costs nothing. If clients walk result sets, phase 1 sizing matters a lot.
4. **What is `PARTITION_COUNT`?** Fewer partitions means a smaller tail penalty and a bigger memory footprint each. Pick against the measured distribution from (2), not from first principles — and remember changing it later is a migration (§5.7).
5. **How long is the mixed-generation window in practice?** It used to be bounded by a 5-minute manifest poll; convergence is now pushed (the coordinator's `notify` phase waits for every region to acknowledge), so the window is the fan-out itself. Partitions would still swap independently within it. Measure before deciding whether §5.7 needs the pinned-generation mitigation or just a note in the runbook.
6. **Does the card-count growth rate hold?** 3-4k new oracle cards/year drives the runway estimate, and printings grow faster than cards — 95,131 printings against 31,724 cards today. Reprints inflate the store without adding a card, so per-card density is an average that assumes the ratio holds.
