# Card Partitioning — the plan for when the store outgrows one Durable Object

Status: **SHIPPED.** Written 2026-08-11 as a design for "when the memory ceiling actually binds"; the ceiling bound sooner than the runway below predicted, because the corpus went multilingual (`all_cards`, ~517k drafts) rather than because English cards grew. Partitioned serving is now the *only* serving path — there is no unpartitioned code left to fall back to.

**What this document is now.** The shape it describes is the shape that shipped, so most of it reads as a description rather than a plan. Where the implementation diverged, the section says so inline. Sections marked SUPERSEDED record a decision that was reconsidered — they are kept with their reasoning intact, because the reasoning is why the alternative was rejected, but they do **not** describe current behaviour.

**Where to check it against reality (2026-08-16).** The design's parameters are no longer written down here; they are computed and published:

| Fact | Read it from | Value when this note was written |
|---|---|---|
| partition count | the published manifest's `partition_count` | 10 |
| partition hash | the manifest's `partition_hash` | `fnv1a64/oracle_id/v1` |
| the sizing rule | `TARGET_PARTITION_BYTES` in `src/import-publish.ts` and its twin in `engine/builder/src/lib.rs` | 43 MB/partition, clamped to [2, 32] |
| store generation / format | `STORE_CONTENT_GENERATION` (`src/engine/store-kv.ts`), `ARCHIVE_FORMAT_VERSION` (vendored `card_engine/src/lib.rs`) | 32 / 2026081616 |
| corpus size | the manifest's `card_count` / `printing_count` | 38,626 cards, 116,712 canonical printings (+ an annex of foreign rows) |

Do not copy those numbers forward; re-read the sources.

Every number below marked *measured* came from loading real archives into the committed wasm engine and reading `WebAssembly.Memory.buffer.byteLength` at each stage, **on the pre-multilingual English-only corpus of 2026-08-11 at commit `0d19d29`**. They are the measurements that justified the design and are left as such. Numbers marked *estimated* are arithmetic on top of those, and are only as good as their assumptions — which are stated.

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

> **The residue archive no longer exists.** Generation 19 folded it back into ONE archive, upstream's shape exactly — the `card_compat_blob` residue is packed into the printing record instead of shipping as a second `card-compat-*` archive with its own chunk family. The two-archive table above, the `R ≈ 0.155 × S` ratio, the residue-attach ceiling equation and `ensureCompat` all describe a shape that is gone. They are kept because the *method* — peak memory binds, not steady state, and the transient copy is the second term — is what the design turns on, and it did not change.

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

> **What actually tripped it (2026-08-16).** Not English card growth. Switching the corpus from `default_cards` to `all_cards` — every printing in every language — took the same store from ~77 MB to 412.9 MB of archives across 10 partitions, which no amount of chunk-size tuning reaches. The runway arithmetic above was not wrong; it was answering a question about a corpus that stopped being the corpus. That is worth keeping in view: a *definition* change moves this ceiling far faster than a growth rate does.

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

Suggested naming, keeping the existing scheme intact — and this is the naming that **shipped**:

```
replica 0, partition 0  ->  engine-<region>-p0
replica 0, partition k  ->  engine-<region>-p<k>
replica n, partition k  ->  engine-<region>-<n>-p<k>
```

`src/engine/engine-namespace.ts` is the one definition: `engineName(region, shard, partition?)` builds it, `parseEngineName` takes it apart, and `replicaGroupOf` strips the `-p<k>` so the shard controller's width accounting still counts REPLICAS rather than objects. A suffix-less name reaching the store loader is a bug and is refused loudly. `tests/engine/engine-naming.test.ts` pins the grammar; ENGINE-PLACEMENT.md covers what the extra axis does to placement.

---

## 3. The partition key: `hash(oracle_id) % PARTITION_COUNT`

> **AMENDED by Decision 3b.** `PARTITION_COUNT` is not a constant anywhere. The builder *derives* N from the corpus it just measured and writes it into the manifest; every router reads it from there. The paragraph below is right that N is small and chosen at build time, and wrong that it is fixed. See §5.7.

The count is small — order 10, not one per card — and identical for every reader of a given generation, because it is published rather than configured.

**Why oracle_id and nothing else.** Every printing of a card shares its oracle_id, so hashing on it puts all ~40 printings of Lightning Bolt in the same partition. That is what lets `unique:card` and the `prefer` scoring stay *local*: a partition can pick a card's representative printing by itself, because it can see every candidate.

Partition on set code, name range, or printing id instead and printings of one card scatter. The coordinator then has to dedup across partitions and re-run `prefer_score` itself — which drags the whole preference model out of the engine and into TypeScript, where it will drift from the Rust implementation. Do not do this.

A consequence worth banking: **single-card routes stop fanning out entirely.** `printings_of_oracle_id` can compute the owning partition and make exactly one RPC. Those routes get *cheaper* than today, because they hit a smaller object.

> **This was half right, and the other half needed a new structure.** Only routes that start from an ORACLE id can compute their partition. `/cards/<scryfall_id>`, `card_by_external_id`, the illustration lookup and `POST /cards/collection` all start from a bare UUID or integer with no derivable relationship to its card's oracle_id, so they fanned out to every partition and took the first non-null answer — and on the free plan each of those N stub calls is a separately billed Durable Object request.
>
> What fixed it is `src/engine/routing-filter.ts`: a 3-wise XOR **retrieval** filter (not a Bloom filter) mapping every addressable id to the lowest partition index owning it. For a key that was in the build set it returns the stored value exactly — no false positives — so the hinted partition is right; for a key that was not, it returns an arbitrary value, which is why a lookup is only ever a HINT and a miss at the hinted partition falls back to the full fan-out. **It can be unhelpful; it can never be wrong.** Measured against the real corpus: 1,232,730 distinct addressable keys at 1.23 cells/key and 4 bits/cell ⇒ 758 KB, one KV value, read at most once per isolate and never awaited on the request path. The plan's own sketch here was a "~9MB×N map"; this is two orders of magnitude smaller.
>
> The filter's header carries the built_at stamp, the partition count and the partition-hash name it was built against, and a filter disagreeing with the manifest the request is pinned to is discarded rather than consulted — the same discipline as `partition_hash`, for the same reason.

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

### 5.6 Staged-row budget

> **SUPERSEDED — the premise was right, the arithmetic is two orders of magnitude off.** "Staging is bounded by total bytes, not partition count" still holds, and it is still the right way to think about it. What changed is *which* bytes and *how many of them*: the paragraph below assumed the ~88 MB English store was what gets staged. It is not, on either count.

What is actually staged, on the nightly path (`src/import-coordinator.ts`, `src/import-spill.ts`):

- **Drafts**, framed `[u64 le fnv1a64(oracle_id)][RowDraft JSON]`, batched into `draft_batches` rows capped at `BLOB_GROUP_BYTES` = 1.5 MB. The real multilingual corpus measured **1,480.8 MB across 517,746 drafts** (2026-08-15), so this alone is ~1,000 rows — not the ~45 the original estimate gave for the whole import. The 8-byte prefix is the raw hash, **not** a partition index, precisely so the staged bytes stay cuttable at whatever N the builder later picks. Once N is pinned, a single `bucket` phase (between `routing` and the partition loop) cuts them: it walks `draft_batches` once, writes every draft into its partition's own `draft_parts` rows (keyed `(partition, seq)`, byte-capped groups in emission order) and deletes the source rows as it goes, so each partition's `agg` and `finalize` read 1/N of the corpus by index seek instead of walking all of it and filtering — the term that had made the nightly's alarm count, and so its write meter, grow as N × corpus. A partition's `draft_parts` are dropped when its publish completes.
- **Finalized rows**, then the same rows rewritten in build order (`spill_batches` → `ordered_rows`), per partition.
- **Archive chunks**, on a ~1.9 MB staging grid just under the DO's 2 MB per-value cap — deliberately a different grid from the KV publish cut, which re-cuts these.

Two corrections to how the free-plan meter is described here and elsewhere:

- The **100,000/day** figure is Durable Object SQL **rows written** (5,000,000 read), and it is spent by the **nightly import**, not by serving. The coordinator self-caps well under it: `MAX_DAY_ROWS_WRITTEN` is 60,000 and `MAX_DAY_ROWS_READ` is 1,500,000, day-scoped counters that survive a run reset so restarts cannot launder a fresh allowance. **Partition count does not press on this budget** — everything above is bytes-driven — and any claim that it does should be treated as this paragraph's original error repeating.
- The batching is what keeps it affordable at all, and the code says why: one row per card row "would spend 98% of the daily quota on a single import".

The storage-budget guard (`Import stopped on ${scope} storage budget in phase ${phase}`) has not needed retuning through the partitioned rebuilds.

KV writes: today's ten partitions publish ten chunks (`KV_CHUNK_BYTES` = 46,000,000, and `TARGET_PARTITION_BYTES` = 43,000,000 is deliberately *under* the cut so a partition is one chunk), plus the manifest and the routing filter, against a 1,000/day free allowance. Not a concern.

### 5.7 The new hazard: mixed-generation reads

**This does not exist today and is the one genuinely new correctness problem.**

Today one object holds the whole store, so a hot swap is atomic from any reader's point of view: the publisher pushes to every region (`notifyPublish`), `loadStore` swaps, and a query sees one generation or the other.

With partitions, each partition object polls and swaps **independently**. During a nightly publish, partition 0 may be on build B while partition 1 is still on build A, and a fan-out query mixes both.

Consequences, in order of severity:

- **`total_cards` sums counts from two generations.** Slightly wrong for a few minutes a night.
- **Card data is stale on some partitions.** Benign — it is one night's drift.
- **No duplication or loss**, as long as `PARTITION_COUNT` is unchanged. `hash(oracle_id)` is stable, so a card stays in its partition across builds.

The mitigation ladder, cheapest first: accept the window (it is minutes, nightly, and the data difference is one Scryfall refresh); or have the coordinator read the manifest once and pin a `store_key` for the whole fan-out, with partitions keeping the previous generation addressable — retention already holds it, so this is routing work rather than storage work.

> **The second rung was built.** `pinGeneration` in `src/engine/gather.ts`: every phase-1 reply carries the partition archive it answered from, and a mismatch pins the gather to the NEWEST build (by the `built_at` embedded in the chunk-family key) and re-issues phase 1 to the partitions that answered from an older one. It pins forward rather than backward because swaps are monotonic and an old generation cannot be re-asked-for once its chunks are retired. `tests/engine/gather-merge.test.ts` covers it.

> **SUPERSEDED by Decision 3b — `PARTITION_COUNT` is not a config value and changing it is not a migration.** Kept because the hazard it names is real and is exactly what the replacement design had to answer.
>
> **The original claim:** *"Changing `PARTITION_COUNT` is a migration, not a config change. Cards move between partitions, so during any window where two generations are live a card can be in both partitions (duplicate) or neither (lost). It needs a full drain: publish, wait for every object to converge, then serve. Treat it like a schema migration and give it its own runbook."*
>
> **Why it could not stand.** A hand-managed constant plus a drain runbook means every corpus growth spurt is an outage-shaped human task, and the corpus grew by 5x in one definition change (§1). The reasoning above is nonetheless correct about the failure mode, and it is what forced the shape of the fix.
>
> **What replaced it.** N is derived, published, and *pinned per request*:
>
> - The builder computes N from the corpus it just measured — `clamp(ceil(projected_store_bytes / TARGET_PARTITION_BYTES), 2, 32)` — and writes it to the manifest as `partition_count`, alongside `partition_hash`. `partitionCountFor` in `src/import-publish.ts` and `partition_count_for` in `engine/builder/src/lib.rs` are line-for-line twins, and their doc comments are explicitly kept in step.
> - N is computed **once**, at loop start, and persisted as `pp_publish.partitions.length`. A mid-loop restart reads the persisted state and *cannot* re-derive a different N — which matters because N is baked into every already-published chunk key and every draft's partition assignment. There is deliberately no second copy of the number to drift.
> - The router never holds N. It reads `partition_count` and the modulus from **the manifest it is pinned to**, so a fan-out is internally consistent by construction. `src/engine/partitioned-engine.ts` carries a stale-modulus retry: a mismatch re-reads the one manifest key rather than answering from a mixed view.
> - A manifest with no `partition_count` is **refused**, not fallen back on (`src/engine/store-kv.ts`) — an unpartitioned manifest is one this deployment cannot read, and saying so loudly is better than answering with 1/N of the corpus.
>
> The duplicate-or-lost hazard is therefore not prevented by a drain; it is prevented by never letting one request see two moduli. The mixed-generation window described above this note still exists and is still bounded by the fan-out.

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

The sort key must therefore be an opaque, totally-ordered byte string emitted by the engine, which the coordinator compares bytewise and never interprets. Do not reimplement comparison logic in TypeScript. That much shipped as designed, and `tests/engine/gather-merge.test.ts` pins the property from the coordinator's side: for any set of keys, bytewise-merging per-partition sorted streams reproduces the global bytewise sort exactly, with memcmp as the only comparison.

> **The acceptance criterion had to change, and this is what it became (checked against `scripts/gate.sh`, 2026-08-17).**
>
> The stated criterion — *"same query, partitioned vs unpartitioned, byte-identical result envelopes"* — is **not runnable on the real corpus and never will be.** The unpartitioned shape does not exist to compare against: `partitionCountFor` clamps to a floor of 2 and `writeManifest` refuses a manifest without partitions, so no publisher can emit a single archive, and a single-archive build over the multilingual corpus aborts under the 124 MiB wasm cap by design (517,746 rows in one archive against a corpus production cuts ten ways). The gate's old single-archive step was **deleted rather than fixed**, because keeping it would have meant a red gate asserting an impossibility.
>
> **What replaced it: N=2 versus N=10, byte-identical envelopes.** Both cuts are legal, both build under the cap, and equality between them asserts exactly what the original criterion was reaching for — *the answer does not depend on how the corpus was cut.* It is strictly stronger than either half of what existed before, because it joins them: the cut and the merge, end to end, at corpus scale.
>
> What the gate runs, and what each step actually proves:
>
> - **`partition differential: N=2 vs N=10, same corpus, same answers`** (`memprobe compare-parts`) — one 12k-printing / 56,227-row corpus built twice, at N=2 and at N=10, each partition through the same `build_store_partitioned` the deploy path uses. Both cuts are then queried through the reference two-phase gather (phase 1 keys at offset 0, bytewise merge, phase 2 fetch from the owning partition) over the same tie-heavy 162-case envelope grid `memprobe compare` uses, and the envelopes — `total_cards`, `has_more`, and `data` in order — must be byte-equal. Last run: **162 envelope cases / 2,226,996 rows → `THE CUT DOES NOT CHANGE THE ANSWER`.**
> - **…and its negative control, in the same invocation.** The differential is deliberately broken and must **fail**: the sort key's primary segment is replaced by that partition's *own dense rank* of it — precisely the encoding `encode_sort_key` refuses to emit (it writes the set **code**, never `set_rank`, because a rank is assigned over the rows of one archive). Last run: **38 of the 162 cases diverged, across `set`, `name` and `artist`** — the three orderings whose in-archive key really is an archive-local rank. `memprobe` exits non-zero if that substitution does *not* break the differential. This is the one check that would catch an archive-local sort key, and a differential that cannot fail is worth nothing.
> - **`native vs wasm store: same rows, same answers`** — the deploy path builds the store natively and the nightly builds it in wasm, and the whole design assumes the two are interchangeable. Rows are compared with `cmp` (byte-identical, or the two publishers are running different transform code); archives are compared by **answers**, not bytes, through the same tie-heavy grid. Byte equality of the archive is explicitly *not* asserted and must not be: over the same rows the two targets differ in ~0.5% of archive bytes, all in the index region, because index construction breaks ties between equally-ranked rows in build order. Last run: **162 envelope cases / 2,226,996 rows → `STORES SEMANTICALLY IDENTICAL`.**
> - **`wasm build fit per partition`** — the real corpus, cut at the *manifest's own* N (not a hardcoded guess), each partition through its own capped wasm build in its own driver process. That per-process isolation is the emit-one-release-one discipline of §5.5, enforced rather than described. At N=10 the partitions measured 91.5–106.2 MB against the 124 MiB cap (peak p9; unchanged by the corpus widening below, which touches only the small generated gate corpus, not the real rows this step reads).
> - **`perf ratios`** — the route-is-not-a-scan tripwires, unrelated to partitioning but in the same gate.
>
> The grid is only tie-heavy because the corpus is. Four of its twelve orderings used to be a single tie group each — the generated corpus had two distinct `cmc` values and two distinct `power`/`toughness` — so the very cases a build-order or cut difference would show up in were comparing one undifferentiated block. Widening the corpus is what makes both differentials above mean what their names say; see `Spread` in `engine/builder/examples/memprobe.rs`. The corpus cache is keyed on the generator's own `CORPUS_SHAPE` tag so a stale corpus cannot silently serve a newer gate.
>
> **What is proven, stated precisely.** At corpus scale: the answer is independent of N. On a small fixture: partitioned output equals *unpartitioned* output outright — `gathered_envelopes_equal_the_unpartitioned_pages` compares the gather against a single unpartitioned store over `differential_rows()` at N=3, across the orderby grid, every inline budget, and deep offsets. The cut itself is proven by `build_store_partitioned_cuts_by_the_shared_hash`, and the merge by `partitioned_key_streams_merge_to_the_unpartitioned_order`.
>
> **What is still NOT proven, and should be said plainly:** there is no partitioned-versus-unpartitioned comparison *at corpus scale*, and there cannot be. The N=2/N=10 differential is a consistency property, not a correctness one: two cuts that were wrong the same way would agree. Correctness against an unpartitioned reference rests on the small fixture above, and correctness against Scryfall rests on external evidence — `bun scripts/live-parity.ts` (88 passed, 2 known-deviation, 0 failed) and `bun run parity-sweep`, which compare this deployment's answers against `api.scryfall.com` directly. Quote the sweep's matrix size with any sweep number — it was 57 list-level + 1 object path on a 529-case matrix, and the matrix has since grown, so a bare count means nothing. Separately, `memprobe`'s gather is a *second* Rust implementation of the algorithm `src/engine/remote-engine.ts` performs; nothing asserts those two agree line for line, and `tests/engine/gather-merge.test.ts` pins only the merge key from the coordinator's side.

---

## 7. What gets worse

**Tail amplification.** Every request waits for the slowest partition. With 4 partitions the median request waits for roughly today's p84, and today's p99.75 becomes the new p99.

This is smaller than textbook max-of-N math implies, because every query hits every partition, so they see identical load and their slow moments correlate. What remains is host-level jitter, which does not correlate. It is a real cost that cannot be tuned away — only each partition's own variance can be tightened.

**Deep pagination.** Two-phase makes it ~17× cheaper, not free. Cost still grows with `offset`. Consider capping page depth: Scryfall pages `/cards/search` at 175 per page, and paging all 17,710 creatures is 101 pages with a worst-case `offset ≈ 17,500`. A cap trades API parity for a bounded cost; price it against real traffic first.

**Two round trips on the hot path.** Phase 2 is small and parallel, but it is a second hop on the main `/cards/*` path.

**Operational surface.** `replicas × partitions` objects per region. More to warm, more to observe, more that can be individually evicted — plus the mixed-generation window in §5.7.

## 8. What gets better

- **The memory ceiling disappears.** Need more room, and nobody does anything: the builder projects a larger N from the larger corpus on the next rebuild and publishes it. (The plan said "raise `PARTITION_COUNT`, as a migration"; see §5.7 for why that became automatic.)
- **Cold load gets faster** — smaller partitions, fetched in parallel, one round trip instead of three.
- **Single-card routes get cheaper** — one RPC to a ~19 MB object.
- **The nightly publisher's own 128 MB ceiling relaxes**, provided §5.5 is respected.
- **Cold-object risk does not multiply.** Because every query hits every partition, they warm together and idle together — one coin flip landing on N objects, not N independent flips. The residual is per-object eviction under host memory pressure, and a ~19 MB partition recovers in a single round trip.

---

## 9. Migration path

> **SUPERSEDED — this section describes a rollout that was deliberately not taken.** Phases 3 and 4 (an env-var gate, two serving paths run side by side, the unpartitioned path removed later) were built and then deleted by owner decision: the partitioned multilingual store is the setup, not a migration target, so there is no flag, no second manifest key, and no unpartitioned serving path. The cost that buys is a few minutes of errors on the single transition deploy, recorded and accepted in `scripts/import-store.sh`'s header. §5.7's "changing PARTITION_COUNT is a migration" is separately superseded by the plan's Decision 3b (the count is manifest-driven and auto-scaled). The rest of this document still describes the shape that shipped.

Land it in stages, each independently revertable, with the unpartitioned path intact until the last one.

**Phase 0 — measure.** See §11. Do not start Phase 1 without a clean `/cards/*` latency distribution; its *spread* determines the entire cost of this project.

**Phase 1 — builder and importer only.** Emit `PARTITION_COUNT` archive pairs, extend the manifest, per-partition publish cursors, retention over the new key families. The engine still loads every partition into one DO and serves exactly as today. This proves the partition, the hash agreement, and all of §5 without touching the query path, and reverts by republishing a single-partition manifest.

**Phase 2 — sort keys.** Add opaque sort-key emission to the engine and the phase-1 RPC shape, still answering from the single DO. Build the differential test harness here.

**Phase 3 — fan-out.** One DO per partition, coordinator does two-phase. Gate behind an env var so a bad rollout is one config change from the old path. Run both and compare envelopes in production before cutting over.

**Phase 4 — remove the unpartitioned path** once Phase 3 has been stable through several nightly rebuilds.

---

## 10. Reference — files this touches

This table is the 2026-08-11 plan's forecast. It is kept for the record; the "Change" column is now history, and the `N×2` / archive-pair language predates generation 19 folding the residue archive back into ONE archive (so it is `N` chunk families, not `N×2`).

| File | Role when the plan was written | Change (all landed) |
|---|---|---|
| `engine/builder/` | builds one archive pair | partition by `hash(oracle_id)`, emit N archives, one at a time (§5.5) |
| `src/import-coordinator.ts` | staging, alarm chain, KV publish, retention | per-partition cursors, N-wide publish, manifest last, retention over the new key families |
| `src/engine/store-kv.ts` | chunking, manifest, `KV_CHUNK_BYTES` | per-partition keys, `partition_count` |
| `src/engine/store.ts` | per-isolate store load, `ensureCompat` | load one partition |
| `src/engine/search-engine-do.ts` | the per-region DO, RPC surface | phase-1 / phase-2 RPCs |
| `src/engine/remote-engine.ts` | isolate-side client | fan-out + merge coordinator |
| `src/index.ts` | builds DO names, picks replica | add the partition axis to naming |
| `src/engine/shard-controller.ts` | **replica** autoscaler | untouched, as hoped — see §2 |
| `engine/wasm/src/lib.rs` | wasm boundary | sort-key emission, phase-1 shape |
| `vendor/sylvan_librarian/card_engine/` | the engine | sort-key encoding, partition-aware build |

Files the plan did not anticipate, which now carry a large share of the design: `src/import-publish.ts` (the sizing rule and the one `pp_publish` durable value), `src/import-spill.ts` (draft staging and the partition-hash vector), `src/engine/partitioned-engine.ts` (the per-route fan-out table), `src/engine/gather.ts` (two-phase, key merge, generation pinning), `src/engine/routing-filter.ts` (§3's note), `src/engine/partition.ts`, and `engine/builder/src/spill.rs`.

`vendor/` is a vendored upstream checkout synced by `scripts/sync-upstream.sh`. Changes there need the LOCAL PATCH convention used elsewhere in that tree, or the next sync will clobber them.

---

## 11. Open questions — measure these first

These were the pre-build questions. Statuses added 2026-08-16; the ones still open are still open.

1. ~~**Does `R ≈ 0.155 × S` hold?**~~ **MOOT.** The residue archive no longer exists — generation 19 folded it back into ONE archive, upstream's shape exactly. There is no residue-to-store ratio to confirm, and every §1 ceiling number that depended on it describes a shape that is gone.
2. **What is the real `/cards/*` latency distribution?** **STILL OPEN.** It shipped without this measurement, so the tail-amplification cost in §7 remains unquantified in production. Production p90/p99 are polluted by the nightly import's alarm chain (whole-service p50 wall 70 ms, p50 CPU 4 ms, but p99 wall 7.5 s is the importer). Filter to user-facing `/cards/*` invocations only.
3. **How deep does real pagination go?** **STILL OPEN.** No page-depth cap was added, so this is untested rather than decided. If ~all traffic is page 1, the deep-page analysis is theoretical; if clients walk result sets, phase-1 sizing matters a lot.
4. ~~**What is `PARTITION_COUNT`?**~~ **ANSWERED, by removing the question.** N is derived from measured corpus bytes against `TARGET_PARTITION_BYTES` and published in the manifest (Decision 3b, §5.7). Nobody picks it. Note the parameter that *is* hand-chosen moved: `TARGET_PARTITION_BYTES` = 43 MB, and its binding constraint turned out to be the KV chunk cut rather than the latency distribution question (2) was meant to inform — a partition crossing `KV_CHUNK_BYTES` costs an extra sequential round trip on every cold load.
5. **How long is the mixed-generation window in practice?** **STILL UNMEASURED, but no longer load-bearing** — the pinned-generation mitigation was built rather than deferred (`pinGeneration`, §5.7), so a fan-out that straddles a swap re-issues to the stragglers instead of returning a mixed answer.
6. **Does the card-count growth rate hold?** **OVERTAKEN.** The 3–4k oracle cards/year figure and the 95,131-printings-against-31,724-cards ratio were English-only. The corpus is now every printing in every language (~517k drafts), which is a definition change, not a growth rate — and it is what actually forced this project (§1). The current canonical figures are in the manifest: 38,626 cards, 116,712 canonical printings, plus the annex.
