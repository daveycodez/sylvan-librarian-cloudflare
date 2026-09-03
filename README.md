# sylvan-librarian-cloudflare

**Live demo: [sylvan-librarian.deckgen.workers.dev](https://sylvan-librarian.deckgen.workers.dev)**

[Sylvan Librarian](https://github.com/jbylund/sylvan_librarian) — a Magic: the
Gathering card search engine — ported to run **entirely on Cloudflare's free
plan**: Workers (serving), Durable Objects (the in-memory engine and the
nightly refresh), and KV (the card index at rest). No VPS, no Postgres, no
container, no secrets, no payment method on file — connect the repo, or
`bun run deploy`, and that is the whole install.

A faithful mirror of upstream's user-facing surface: the web UI, `/search`
(full Scryfall-style query syntax via the same Rust engine, compiled to wasm),
`/card`, `/get_catalog`, `/random_search`, and all static assets. No additions.

It also carries upstream's **Scryfall-compatible API** in full — every
`/cards/*` route including rulings (#912), plus `/sets`, `/catalog/*` and
`/symbology` (#922) — so a Scryfall client can change one base URL and nothing
else. What that surface answers differently, and why, is in the deviations list
below.

## Deploy

1. Cloudflare dashboard → Workers → Create → connect this git repository
   (Workers Builds), or `bun run deploy` from a checkout.
2. There is no step 2.

The **deploy builds the card index**, and a deploy that cannot build it fails
rather than shipping a Worker without one — so a green build means a working
site. `bun install` runs `scripts/ci-postinstall.sh`, which creates the KV
namespace if absent, runs the native Rust store builder over Scryfall's bulk
data, and publishes the store to KV, all before `wrangler deploy` uploads the
Worker.

Why the build and not the Worker: Workers Builds gives 2 vCPU, 8GB and 20
minutes, against the Worker runtime's 128MB isolate and 30s alarms.

Two Workers on one account need no edits. Workers Builds injects
`WRANGLER_CI_OVERRIDE_NAME`, and the scripts derive the KV namespace from it,
so each Worker owns its own index.

Routine pushes skip the import: `scripts/store-age.ts` asks Scryfall when it
last regenerated its dumps and compares that to the live store's build time,
so a push that changes no card data downloads nothing. `FORCE_IMPORT=1`
rebuilds anyway; `SKIP_IMPORT=1` deploys code only.

A nightly cron (11:17 UTC) then keeps the index current from inside the
Worker; isolates hot-swap to each new version without dropping queries.

**Two numbers decide whether a deploy republishes.** Each dataset carries a
LAYOUT version and a CONTENT generation, the same pair the store has
(`format_version` / `STORE_CONTENT_GENERATION`), and they fail differently: a
layout change mints a new key namespace so a running reader keeps reading keys
it understands, while a content change — the same layout rendered differently —
must overwrite in place rather than orphan the old values. The deploy compares
both against what KV says it published, so "the data is there" is never mistaken
for "the data is what this build would write". Getting that wrong is not
hypothetical: the mirrors shipped one release serving bytes the build no longer
rendered, because only existence was checked.

**Three writers, and only three.** `bun dev` seeds everything local, the deploy
seeds everything on production, and the cron refreshes it nightly — where
"everything" is the card store, the rulings buckets and the `/sets`,
`/catalog/*` and `/symbology` mirrors, the last two of which come from
api.scryfall.com rather than the bulk store build. Publishing production data
from a development machine is refused rather than discouraged
([scripts/kv-target.ts](scripts/kv-target.ts)): a hand-run seed writes from a
working tree that may not be what is deployed, spends a metered daily allowance
nothing is accounting for, and — as happened once — can report success while
writing to local storage, because `wrangler kv` defaults to it without saying so.

Optional knobs (rate limiting, API-key bypass, shard cap) are in
[.env.example](.env.example).

## Architecture

```
request ──▶ static asset? served from the CDN out of public/ — the Worker is
            never invoked, so it costs no isolate and no CPU
        ──▶ Workers Cache (regional edge cache; hits skip the Worker entirely)
        └─▶ Worker isolate (thin: parses, RPCs)
              ├─ TS parser: Scryfall syntax → filter tree (port of hand_parser.py)
              ├─ engine queries: RPC to the region's SearchEngine Durable Objects
              │   (engine-<region>[-<shard>]-p<k> — one object per PARTITION per
              │   replica, in each of the nine location hints: wnam, weur, apac …),
              │   placed there by location hint; idle regions evict their DOs —
              │   scale to zero. The x-sylvan-engine response header says which
              │   DO answered
              ├─ SearchEngine DO: wasm card_engine + ONE PARTITION's rkyv archive
              │   in memory — card objects included, exactly upstream's shape —
              │   streamed from KV as immutable chunks in 4MB blocks, and cached
              │   DECOMPRESSED in the DO's own SQLite so later wakes skip both the
              │   network and the gunzip. It hot-swaps when the KV manifest
              │   advances. Results come back already JSON-encoded in the requested
              │   shape, so no card ever becomes an object in the isolate serving
              │   the request
              ├─ fan-out: a query reaching one partition is not an answer. Which
              │   routes cost 1 RPC and which cost N is a per-route table in
              │   src/engine/partitioned-engine.ts, pinned by
              │   tests/engine/partitioned-routes.test.ts. Search is a two-phase
              │   gather (sort keys, then rows); id lookups collapse to 1 RPC via
              │   the routing filter; catalog/autocomplete/named fan out
              └─ autoscaling: fan-out to engine-<region>-1..N when the DO reports
                  sustained load AND the isolate sees sustained slowness, with
                  idle fold-back. That is the REPLICA axis and it multiplies with
                  the partition axis. A new shard takes no traffic until its warm
                  ping resolves — see src/engine/shard-controller.ts

cron (nightly refresh; the deploy does the first build)
        ──▶ ImportCoordinator (SQLite-backed Durable Object, serializes runs)
              └─ alarm-chained pipeline, all inside the 128MB isolate:
                   fetch → recode → canonical → transform → tags → scores
                     → [per partition: agg → finalize → reorder → build → publish]
                     → notify → rulings → reference → purge
                   (scores is corpus-GLOBAL — the cubecobra percent-rank and the
                    illustration counts are computed ACROSS cards, so they are
                    sealed once before the per-partition loop and handed to it)
                   (the SAME Rust the native builder runs, compiled to wasm;
                    intermediates spill to DO SQLite, never to memory)
                   publish: each partition's chunks gzipped to KV, plus the
                   routing filter, then the manifest LAST (the commit point
                   readers act on); the generation before last dropped
```

**The store is partitioned, and that is not a tuning knob.** Every published
manifest names `partition_count` archives; a manifest without one is *refused*
rather than fallen back on, because there is no unpartitioned serving path left
to fall back to. The count is derived by the builder from the corpus it just
measured — not configured — and every router reads it from the manifest it is
pinned to, so a fan-out can never straddle two moduli. Read
[CARD-PARTITIONING.md](CARD-PARTITIONING.md) for the design and
`src/import-publish.ts` for the sizing rule.

The corpus is Scryfall's **`all_cards`** dump — every printing in every
language — not `default_cards`. Non-English printings live in an annex on the
same archive, which is what makes `lang:`, `include_multilingual`,
`printed_name` and `is:localizedname` answerable at all.

Concrete figures rot, so take them from the live manifest rather than from
here. As of 2026-08-16 it read: 10 partitions, `partition_hash`
`fnv1a64/oracle_id/v1`, 38,626 oracle cards, 116,712 canonical printings,
412,869,984 raw archive bytes across the ten. `STORE_CONTENT_GENERATION` is 32
(`src/engine/store-kv.ts`) and `ARCHIVE_FORMAT_VERSION` is 2026081616 (the
vendored `card_engine`); those two are bumped as a pair.

The wasm engine is the only query path. A query it cannot answer returns a
structured error, never a silently empty result.

**Two transports, and the response shape picks which — not consistency.**
`/cards/*` STREAMS: the Durable Object builds the entire response, envelope
included, and the isolate returns it without touching the bytes. `/search` and
`/random_search` stay BUFFERED, because their tail is `metadataFor` — the
compiled query and a timings tree whose `engine_query` span is measured *around*
the query, so the envelope cannot exist until the payload does. Streaming a body
you then have to splice in the isolate buys nothing and costs the stream
machinery.

This is calibrated, not stylistic. Unifying `/search` onto the streaming path
moved its Durable Object CPU 7ms → 6ms and its **isolate** 5ms → 11ms median — a
2.6× regression that took the route from under the free plan's 10ms budget to
over it, missed at the time because only the DO side was measured. Measure both
sides before moving a route between them.

**Cold starts.** The engine tier is sharded by REGION, and that is the main
thing keeping stores warm. It used to be sharded per colo with the regional DO
as a relay target for a cold colo — but the colo name was only ever a partition
key (the DO was created with no location hint, so placement was regional
anyway), so the fan-out bought no locality and cost an object per colo, each too
rarely used to stay warm. Measured on 2026-08-12: three objects for two colos in
one region, ~45 store loads in two days, and a cold `/cards/search` paying
2.38s + 1.41s of DO CPU because the relay raced two loads of the same archive.
One object per region turns that traffic into one warm store. That makes the
location hint load-bearing rather than decorative, and a hint applies only at
CREATION — so `src/engine/engine-namespace.ts` confines object creation to edge
isolates serving real requests, and `ENGINE-PLACEMENT.md` covers how to check
where an object actually is and what to do if one is wrong. What remains of
the cold path is cached decompressed in the DO's own SQLite, so a wake usually
skips the network and the gunzip both. There is deliberately no Cache API layer in front of KV: writing the
store through `caches.default` and reading it back measured 0.6–1.3s of billed
CPU per load, and KV's own `cacheTtl` gives the same colo-level caching for
free on immutable chunk keys. That argument rules out a Cache API layer, and it
rules out a "holder" Durable Object other DOs pull the store from for the same
reason twice over: DO CPU tracks bytes handled at roughly 15µs/KB, so moving
the store through an RPC bills it on both ends, and a DO lives in one place
where KV caches per colo.

The store *is* gzipped, though, which is a different question — the meter was
never what the cold path was bound by. A load-carrying invocation measures wall
p50 915ms against DO CPU p50 164ms, so ~750ms of it was waiting for the whole
archive to arrive. The cut is on RAW bytes at `KV_CHUNK_BYTES` (46,000,000, with
`KV_CHUNK_BYTES_SAFE` = 26,000,000 as a fallback cut) and each piece is gzipped
as its own member. `TARGET_PARTITION_BYTES` (43,000,000) is deliberately set
*under* the chunk cut, so a partition is normally exactly one chunk: a partition
whose raw bytes cross the cut costs an extra **sequential** round trip on every
cold load, because a partition's chunks are pulled in order.

The memory win is bigger than the transfer one and comes from a different
place. wasm-bindgen marshals a `&[u8]` by COPYING it into linear memory, so a
whole raw chunk used to land there as scratch on top of the store itself.
Decompressed, the pieces arrive in 4MB blocks and that scratch effectively
vanishes: peak linear memory measured ~102.6MB before and ~78.7MB after
(`src/engine/load-blocks.ts`; `store-kv.ts` records ~102.6 → ~89.6 for the
gzip half of the same change). Against a 128MB isolate that is the difference
that matters.

It is not free, and the ~190ms this section used to budget for decompression was
**wrong by roughly 5x**. Measured across the deploy that introduced it
(2026-08-12), cold DO CPU went 322ms → 1252ms at the median and 1050ms → 2504ms
at the max, and cold wall time went 1606ms → 2263ms: compression did not buy back
in I/O what it cost in CPU.

It stands anyway, for a reason unrelated to the original argument — the fix was
to stop paying it so often rather than to stop paying it. Engine DOs are named
per REGION now, so the ~45 cold loads a day that made this expensive collapse to
a handful, and `store-cache.ts` holds the DECOMPRESSED archive locally so most
remaining wakes skip it entirely. Reverting to uncompressed chunks would cost
~13MB of the 128MB isolate to save a cost that is now rare. See
[src/engine/store-kv.ts](src/engine/store-kv.ts) for both halves measured.

**Publishing** is one chunk per partition (each cut under KV's 25 MiB value cap
and gzipped before the put), plus the ~758KB routing filter, then the manifest
as the commit point — written last, because a manifest naming chunks that are
not in KV yet is exactly the state a reader must never see. Two generations are
retained (`KEEP_STORES_IN_KV`), so a reader mid-stream finishes and a bad build
can be rolled back by republishing the previous manifest.

**Caching.** `/search` caches for 90s plus a day of stale-while-revalidate;
`/cards/*` carries Scryfall's own tiers (16h, `no-cache` for random, private for
the collection POST); page HTML carries no card data; `no-store` routes are never
cached, and neither are the dispatch-level errors (404/405/429/500/503), though
`/cards/*` caches its OWN 400s and 404s on the route's tier, which is Scryfall's
behaviour too; the cache is per-deploy-version, so a deploy starts cold. An
import is not a deploy, so the nightly rebuild purges the cache itself, rather
than leaving a `/cards/*` object sitting on yesterday's prices for 16 hours.

The purge now runs **once, immediately** — `PURGE_PASSES = 1`, no delay. It used
to be two passes ten minutes apart, and both numbers existed for the same
reason: nothing could observe when the engine DOs had picked up the new store.
The delay was sized to outlast a 5-minute manifest recheck plus KV's 60s cache
on the manifest read, and the second pass covered the hole the first could not,
since convergence was lazy *and* deferred — a colo idle across the first window
would swap only on its next request, and that request wrote a stale answer
straight back into a cache that had just been emptied, where for `/cards/*` it
stood for 16 hours.

**The `notify` phase removed the premise.** It pushes the new store to every
region and does not advance until all of them acknowledge, so by the time the
purge runs there is no reader left holding the old store and nothing to refill
the cache with a stale answer. Purging once, immediately, is not merely
adequate — it is strictly better than waiting, because every second between the
publish and the purge is a second of old answers still served from the edge.

**Free-plan fit.** A cold engine object reads the manifest plus its own
partition's chunks — one partition, not the whole corpus, and the same load
serves `/search` and `/cards/*` because there is no second archive. Serving
touches KV only on a cold load, so the daily meters (100k Worker requests, 100k
KV reads, 1k KV writes) bound *traffic*, not architecture.

The tightest meter is a different one and it belongs to the importer, not to
serving: Durable Object SQL **rows written**, 100,000/day (5,000,000 read),
spent by the nightly import staging its corpus. The coordinator self-caps well
under the platform ceiling (`MAX_DAY_ROWS_WRITTEN` 60,000,
`MAX_DAY_ROWS_READ` 1,500,000), on day-scoped counters that survive a run reset
so restarts cannot launder a fresh allowance. That budget is driven by *bytes
staged*, not by partition count — raising the partition count does not press on
it.

The meter worth watching is the free plan's **10ms CPU per request**, and
almost all of what a `/search` spends there is **cold isolate startup, not the
query**. The same route measures 1–2ms landing on a live isolate and 7–13ms
otherwise, and `/get_catalog` — which parses nothing and returns a few KB —
costs the same as a full search. Cloudflare reports the startup directly on
upload: 10ms for this Worker against **5ms for a hello-world with the same
bindings**, so half of it is the platform and the rest is module
initialization.

What reaches it is what the isolate must *load*, and only that. Measured, each
as its own uploaded version: minifying (212KB→118KB of JS), dropping the import
pipeline (56KB of JS plus its 1.1MB wasm) and dropping the 1.4MB engine wasm
all reported the same 10ms — one of them 12ms, which puts the metric's noise at
±2ms. Do not spend effort on any of those. (The engine wasm has since grown to
~1.55MB with upstream's bitmap-materialize arms; the sizes above are the ones
that were measured, and the conclusion is that this axis does not move startup.
Re-measured on disk 2026-08-16: the engine wasm is 2,120,635 bytes and the
import wasm 1,600,289 — both larger again, and the conclusion is unchanged.)

Moving the browser's files to the CDN did move it, because it removed a ~313KB
text module the script had to carry: **10/12/13ms → 5/6/9ms**, against that 5ms
floor. That worked out to roughly 1.5ms per 100KB, and it is why the `assets`
block in [wrangler.jsonc](wrangler.jsonc) exists.

**Do not extrapolate that rate to new work without re-measuring.** It was real
when taken, and it no longer predicts anything here. Three later attempts to buy
startup CPU with a smaller script all measured zero: dropping 1,340,656 bytes of
import-only wasm (−0.14ms, 95% CI −0.72..+0.44), minifying 40% of the source
(p90/p95 identical across versions), and the floor itself — `GET /nope`, the
router's own 404, costs p50 1ms against a 3.7MB script. One mechanism explains
all three: Cloudflare compiles and snapshots the script at **deploy**, so a
starting isolate does not re-parse it.

What still costs is *structure evaluated at module load*, not bytes parsed. The
tag alias table (`src/parser/tag-aliases.gen.ts`) was 0.75ms an isolate as 2,152
`Map` literals and is 0.16ms as a string parsed on first use — same bytes, same
data. So the rule that survives is about module scope, not script size: keep out
of it anything a request does not build.

Request work itself is that 1–2ms, and the engine encodes results inside the
Durable Object so the isolate never parses, clones and re-encodes the same
rows (~28% of it). The query is 1–2ms of DO CPU, metered separately against a
30s limit rather than 10ms.

## Upstream tracking

Upstream is vendored at the commit pinned in [UPSTREAM.lock](UPSTREAM.lock).
The Rust engine (`vendor/sylvan_librarian/card_engine`) is upstream's own code
with a patch set (PyO3 optional, buffer-based store load for wasm, and a
memory-capped streaming build path whose output is verified semantically
identical to the standard build). **Filter evaluation** is untouched, so the
store the Durable Object builds is the same store the native builder produces.
`bun run gate` is what checks it, in two steps: the finalized ROWS are compared
byte-for-byte (`cmp`), because identical rows are what makes any archive
difference a build-order question rather than a data one; the ARCHIVES are then
compared by **answers**, not bytes. Byte equality of the archive is explicitly
not asserted and must not be — over the same rows the two targets differ in
~0.5% of archive bytes, all of it in the index region, because index
construction can break ties between equally-ranked rows in build order.

The **archive layout converged on upstream #912 at generation 19**: one archive,
`compat: CompatFields` on `Printing` (upstream's field list, `Vec` list fields
included), `planeswalker_loyalty_text_id` on `OracleCard`, `external_id_index`
on `CardIndexes`. The residue archive, its CSR, its field-table split and its
attach plumbing are all gone. (`all_parts` lives on `Printing`, not on
`OracleCard` — it is printing-level, which it did not look like.)

**Generations 20 onward diverge from that layout deliberately**, and the current
generation is 39. The multilingual annex, `DivergentPrinting`,
`PrintedNameIndex`, `TypeLineIndex` and the partition cut are all this port's,
not upstream's. "Matches #912 exactly" describes generation 19 and nothing
after it; `src/engine/store-kv.ts`'s generation log is the authority on what
each one changed.

The one number to watch is still the in-Worker build's memory, but the shape it
is measured on changed. `bun run gate` no longer builds a single archive — over
the multilingual corpus that build aborts under the cap, correctly and
uselessly, because production never performs it (517,746 rows in one archive
against a corpus cut ten ways). That step was **deleted rather than fixed**: a
red gate asserting an impossibility is not a gate. What runs instead is one
capped wasm build **per partition**, at the partition count read from the
build's own manifest, each in its own driver process — which is the
emit-one-release-one discipline enforced rather than described. At N=10 the
partitions measured 91.6–104.4 MB against the 124 MiB `--max-memory` (raised
from 112 for the single-archive convergence). It runs whenever
`store-build/rows.jsonl` exists and FAILS before a push could ship a nightly
that aborts.

`ARCHIVE_FORMAT_VERSION` still differs from upstream's numerically (different
constants, same discipline); that is not a sync failure.

```bash
bun run sync-upstream
```

Three-way-merges upstream into `vendor/`, updates the pin, and lists changed
files whose behavior is re-implemented here so those ports get re-reviewed.

**When a sync changes what the builder stores** — not the archive's layout, but
the values in it, like keywords becoming lowercase — bump
`STORE_CONTENT_GENERATION` in [src/engine/store-kv.ts](src/engine/store-kv.ts).
It rides in the manifest, and `store-age.ts` rebuilds on a mismatch. Nothing
else can catch this class of change: the store still loads, the header still
matches, it is newer than every Scryfall dump, and it answers queries
confidently with the old semantics. This is the port's counterpart to the data
migrations upstream ships beside such commits.

## Deviations from upstream

Everything user-visible mirrors upstream byte-for-byte (the parser is gated on
100% tree agreement with the Python parser across upstream's own test corpus).
The complete list of intentional differences:

- **No SQL fallback.** Upstream quietly falls back to Postgres when the engine
  declines a query; the wasm engine is the only path here, so an engine
  failure is a loud 500 rather than a silently different answer. On the
  `/cards/*` surface this also removes upstream's `_EngineMiss` sentinel and its
  five `except → fall back` sites: with no second branch to select, an engine
  miss **is** the 404.
- **Rulings live in KV and are read by the request isolate**, where upstream's
  come from `magic.rulings` (filled by `api/rulings_import.py`) and are selected
  by `oracle_id`. The nightly import publishes them as 256 buckets of
  pre-rendered `Ruling` objects keyed by the first byte of the oracle id
  ([src/engine/rulings-kv.ts](src/engine/rulings-kv.ts)); the route reads one
  bucket, binary-searches its index and splices one byte range into the `List`
  envelope, so it never parses the ~104KB value it read. They are deliberately
  **not** in the card store: rulings hang off `oracle_id` rather than off a
  printing, only this route reads them, and 26MB in the archive would be paid
  for by every store load.
  `import_rulings` is not a public route: like every import it sits behind
  upstream's `/_admin` mount (#963), which this port answers with the mount's
  own 401 — the nightly import replaced it, not an endpoint.
  Two consequences worth knowing: a deployment that has never run the rulings
  phase answers **503** on these routes rather than an empty `List` (an empty
  list would be a claim about the card), which
  [scripts/seed-rulings.ts](scripts/seed-rulings.ts) closes for a fresh deploy
  and for `bun dev`; and the phase runs **after** the store is published and
  cannot fail the run, so a bad night leaves the previous rulings served rather
  than a hole.
- **Rulings are served newest-date-first, which is Scryfall's order and not
  upstream's.** Upstream sorts `ORDER BY published_at, comment` — oldest first —
  and measurement says that is backwards: of 16 sampled cards whose rulings span
  more than one date, api.scryfall.com returned 16 newest-first and 0
  oldest-first (2026-08-12). Following upstream here would invert every
  multi-date card's rulings for a client that changed nothing but its base URL,
  so this port follows Scryfall. Reported upstream against #912.
  **Within a single date the order cannot be matched, and 2026-08-16 established
  why rather than just that.** The obvious candidate — preserve the bulk file's
  row order, on the theory that the file is exported in internal-id order — was
  measured against api.scryfall.com over 25 cards that have both several dates
  and a date carrying four or more rulings. It matched on **0 of 25**, as did
  the file's order reversed, whole-file order, date-ascending-then-file, and the
  `comment` ordering this port ships. The reason is visible directly: the six
  shared "kicker" rulings come back in a **different order on different cards** —
  Strength of Night, Goblin Barrage and Spell Contortion each get their own
  permutation of the same six comments — so Scryfall is ordering by a per-(card,
  ruling) row id, not by a per-ruling one, and the bulk file (one line per pair,
  grouped by card) does not reproduce it within a card. Nothing derivable from
  the dump can, so `comment` ascending stays as the deterministic stand-in, and
  determinism is load-bearing beyond tidiness: the bucket bytes are a pure
  function of the ruling set, which is what lets the publisher skip rewriting
  unchanged buckets against a 1,000-writes-per-day budget. This affects 13,847
  of the 19,770 cards that have rulings; the other 5,923 (one ruling, or one per
  date) match Scryfall exactly. End to end against api.scryfall.com over 19
  cards with rulings: same set 19/19, same `published_at` sequence 19/19,
  byte-identical order 8/19 — the remainder differ only within one date.
- **`/sets`, `/catalog/*` and `/symbology` are mirrored into KV**, where
  upstream mirrors them into Postgres (#922). Same decision, different store:
  the corpus cannot answer them (a Set object carries eight fields no card
  carries, `card_count` counts Scryfall's printings rather than this corpus's
  deliberate subset, and a card symbol has no card), so the nightly import
  fetches them from api.scryfall.com — 1,047 sets, twenty catalogs, 84 symbols,
  ~1.65MB across 38 KV values — and renders the response bodies at import time
  ([src/engine/reference-kv.ts](src/engine/reference-kv.ts)). `parse-mana` reads
  nothing: it is a pure function of its parameter and answers before any import.
  As with rulings, a value that has never been published is a **503**, not an
  empty List, and [scripts/seed-reference.ts](scripts/seed-reference.ts) closes
  that for a fresh deploy and for `bun dev`.
- **Four things on that surface are Scryfall's rather than upstream's**, each
  measured against api.scryfall.com on 2026-08-12 and each reported upstream:
  a Catalog carries a `uri` key (upstream's `catalog_object` omits it, though
  `/cards/autocomplete`'s catalog genuinely has none); a `/sets` miss says
  "No Magic set found for the given code or ID" rather than the cards surface's
  generic body; a `/catalog/<unknown>` miss uses that generic sentence **without**
  its "Please double-check your URI and try again." tail; and `parse-mana`
  answers an unparseable cost with code `validation_error`, where upstream sends
  `bad_request` with the same 422. End to end, 35 of 36 sampled responses are
  byte-identical to api.scryfall.com — every catalog, the whole set list, the
  symbol list and eight parse-mana costs.
- **A shared TCGplayer id resolves to the first set in Scryfall's order**, which
  is not always the set Scryfall picks. Six group ids are claimed by more than
  one set (id 62 by all twenty-one Judge Gift Cards sets), and Scryfall's choice
  is not derivable from the data: id 62 answers `g03`, which is neither first
  nor last by position, release date or code. Upstream has the same gap from the
  other side — its lookup is a `LIMIT 1` with no `ORDER BY`.
- **A single-set lookup reports the `card_count` the `/sets` list carries**,
  which for a few sets is not the one `/sets/:code` returns upstream at
  Scryfall. Scryfall disagrees with itself here: sampled 30 sets across the
  list, 29 matched its own single-set endpoint exactly and one (`znr`) differed
  by one card, always in `card_count` alone. Mirroring the list is what makes
  `/sets` itself exact, and fetching 1,047 single endpoints per import to
  reconcile the rest is not a trade worth making.
- **The Scryfall card object is assembled from stored fields**, not unwrapped
  from a `raw_card_blob` this port does not store — the columns, 12 derived keys
  (every `*_uri` and `image_uris` are pure functions of the id, set, collector
  number and oracle id) and the packed residue, all in a partition's single
  archive rather than in a second one, on exactly upstream's structs
  (`Printing.compat`, `Printing.all_parts`, card-level
  `planeswalker_loyalty_text_id`). Absent keys stay absent, because Scryfall
  omits rather than nulls and a card that sprouts nulls differs from Scryfall on
  every row. Generations 10–18 kept the residue in a second KV archive;
  generation 19 folded it back to match upstream, which cost the in-Worker build
  most of its memory headroom — see Upstream tracking for the per-partition
  measurement and the gate tripwire that watches it.
- **`/cards/named?exact=` prefers a whole-name match to a face match.** Upstream
  orders both by `prefer_score` alone, which on this corpus answers
  `exact=Lightning Bolt` with *Emeritus of Conflict // Lightning Bolt* — a
  two-faced card whose back face carries the name and whose score is higher.
  Matching a face is right and Scryfall does it (`exact=Delver of Secrets`
  resolves), but as a fallback rather than a peer. Reported upstream.
- **A collection identifier's `name` reads a NARROWER key set than
  `/cards/named?exact=`, and both compare collated names.** `POST
  /cards/collection`'s `{"name": …}` matches a card's two FACE names when its
  name splits in exactly two and its whole name otherwise — never both, and
  never a flavor name; `exact=` matches that set plus the joined name and the
  flavor names. Measured against api.scryfall.com on 2026-08-31, one identifier
  per request (a collection response's `data` is not in identifier order, so a
  batched probe attributes its answers to the wrong needles):
  `{"name":"Delver of Secrets"}` and `{"name":"Insectile Aberration"}` answer
  *Delver of Secrets // Insectile Aberration* (inr/60),
  `{"name":"Delver of Secrets // Insectile Aberration"}` is `not_found` where
  `exact=` of that string is the card, `{"name":"Who"}` and `exact=Who` are both
  `not_found` while `{"name":"Who // What // When // Where // Why"}` is und/75,
  and `{"name":"Godzilla, King of the Monsters"}` is `not_found` where `exact=`
  answers *Zilortha, Strength Incarnate*. Both surfaces compare with punctuation
  and spacing removed, the way `!"…"` already did: `limduls vault`,
  `Lightning-Bolt` and `delverofsecrets` all resolve on both. The identifier used
  to be built as the filter tree `name="…"` — the CONTAINMENT operator, ordered
  by edhrec and cut to one row — so `{"name":"Delver of Secrets"}` answered
  *Literal Delver of Secrets* (unk/CU06), a different card whose name merely
  contains the needle.
- **The corpus is multilingual, which is a deviation from upstream rather than
  from Scryfall.** Upstream imports `default_cards`; this port imports
  `all_cards` and keeps non-English printings in an annex on each partition's
  archive. That is what makes `lang:`, `include_multilingual`, `printed_name`,
  `printed_text`, `printed_type_line` and `is:localizedname` answerable — a
  store built before the annex cannot answer any of them, which is why the
  generation compare exists. A term that reaches the annex widens the search to
  it; `src/engine/store-kv.ts`'s generations 20–22 record which behaviours that
  changed and what each was measured against.
- **`/cards/named?fuzzy=` matches well-formed foreign names, not Scryfall's
  garbage-in slack.** The foreign-name lane holds to the same bar as the English
  one: a correctly spelled — or lightly misspelled — printed name in any
  language resolves to the printing Scryfall resolves (`fuzzy=ego à deriva`
  answers the Portuguese Unmoored Ego). What is deliberately NOT reproduced is
  Scryfall's slack on inputs that are not recognizably a name at all: its
  matcher resolves `fuzzy=red goad` to *Ego à Deriva*, an artifact of trigram
  scoring over a 247k-name space rather than behavior a client can rely on —
  the same input against the English corpus answers Scryfall's own 404. Here
  such inputs stay a 404 (or `ambiguous`), and the case is pinned as a
  KNOWN_DEVIATION in the live-parity corpus, which asserts both sides' recorded
  behavior separately.
- **`/cards/*` cache tiers are measured from**
  `api.scryfall.com` rather than inherited from `/search`: `public,
  max-age=57600` on the cacheable routes, `no-cache` on `/cards/random`, and
  `max-age=0, private, must-revalidate` on the collection POST. The tier rides
  on error responses too, as Scryfall's does. Upstream sends no cache header at
  all here and leans on an internal response cache this deployment has no
  equivalent of, which would have put every `/cards/*` request through the
  Worker and the Durable Object against a 100k/day allowance — on the surface
  mtg-seeker actually calls. Two differences from Scryfall: `/cards/named` gets
  the same 16 hours as everything else rather than Scryfall's 48, because a card
  object embeds `prices` and this store rebuilds nightly, so no cached response
  should outlive the data it was built from by more than one import cycle; and a
  500 is `no-store`, because caching a transient engine failure beside answers
  that are deterministic in the URL would pin an outage into every edge.
  `Vary: Accept` is not sent — our responses select their format from the
  `format=` query parameter, which is already part of the cache key.
  A third difference, measured 2026-08-16: `format=image` moves Scryfall's tier
  to 48 hours on **every** route including `/cards/search`, where the parameter
  is ignored and a List of card objects comes back. Here the image tier applies
  where an image is actually served — a page of card objects with prices in it
  does not become safe to hold for two days because the caller spelled a format
  the route ignored. `ETag` and `Last-Modified` are not sent either: both would
  have to be computed over a body the Durable Object streams out, and the tiers
  above already bound staleness at one import cycle.
- **Dispatch-level errors take their shape from the surface the path is on.** An
  unknown path answers Scryfall's error object —
  `{"object": "error", "code": "not_found", "status": 404, "details": "The
  requested object or REST method was not found."}`, `no-cache` — and so do a
  wrong method, a cold engine and an internal error on any `/cards/*`, `/sets`,
  `/catalog/*` or `/symbology*` path. This deployment exists so a client can
  change one base URL and stop talking to api.scryfall.com, and that has to hold
  when the client asks for something that does not exist: it parses `code` and
  `details`, and upstream's `{"title", "description": {"routes"}}` gives it
  neither. The routes listing is still built and still pinned by
  `tests/routes/dispatch.test.ts`; it is where it is *served* that changed.
  Upstream's own surface — `/`, `/card`, `/search`, `/random_search`,
  `/get_catalog`, `/get_pid`, the admin stubs — keeps falcon's
  `{title, description}`, because those bodies are rendered by this project's own
  web interface, which reads exactly those two keys
  ([public/static/app.js](public/static/app.js)). The split is by ROUTE KEY
  rather than by path prefix, because the two surfaces interleave under one
  namespace: `catalog` is Scryfall's and `get_catalog` is upstream's own, and
  only the route table can tell them apart (`SCRYFALL_SURFACE_ROUTES` in
  [src/routes/index.ts](src/routes/index.ts)).
  A wrong METHOD on that surface is Scryfall's **404 `not_found`** too, with no
  `Allow` header, because that is what api.scryfall.com answers — measured across
  eight requests (POST/PUT/DELETE/PATCH against `/cards/search`, `/cards/named`,
  `/cards/collection`, `/cards/:id` and `/sets`), none of which carries `Allow`.
  405 is the more correct HTTP answer in the abstract and is *not* used here: it
  would have needed an error `code` no measurement backs, since Scryfall never
  emits a 405, and a client that branches on 404-versus-405 has to see what
  Scryfall shows it. Upstream's own routes keep falcon's 405 + `Allow`, where
  nothing is mirroring Scryfall. One measured residue: `GET /cards/collection`
  matches on status, body and the absent `Allow`, and differs on the tier alone
  (`max-age=57600` there, `no-cache` here) — Scryfall has no GET route at that
  path, so `collection` falls through its `/cards/:id` pattern and earns that
  route's not-a-uuid tier, where here it is a method mismatch on a route of its
  own.
  Two exceptions remain, both about routes rather than errors: `GET /` is this
  project's web interface where Scryfall's API root is a `400` saying no data
  lives there, and `GET /cards` is the mirror image — an upstream route this port
  serves (a paginated all-cards List) that api.scryfall.com 404s.
- **Every `object: "error"` body is pretty-printed**, matching Scryfall, which
  renders errors through a different serializer than answers: measured across the
  whole surface, an error body is two-space-indented JSON and a data body is
  compact, and it does not negotiate (`Accept: application/json`, `text/html`, a
  bare wildcard and an explicit `?pretty=false` all give the same indented body).
  Listed here because it is the one place `pretty` is ignored rather than obeyed.
- **`/cards/search?format=csv` is served; every other `format` on every other
  route is honoured exactly where Scryfall honours it.** The measured table
  (2026-08-16, one request per cell): `csv` works on `/cards/search` **only**,
  `text` and `image` work on the single-card routes **only**, and a `format` a
  route does not implement is silently ignored rather than rejected — including
  `format=CSV`, which is ignored because the match is case-sensitive. CSV pages
  exactly like JSON (175 rows, header row repeated per page, `422` past the end,
  `404` for an empty result) and carries `has_more` in the `x-scryfall-has-more`
  response header, because it has no envelope to put it in. See
  [src/routes/scryfall-compat/csv.ts](src/routes/scryfall-compat/csv.ts).
- **`/cards/search?order=penny` falls back to name with a warning**, as an
  unrecognized order does. `penny_rank` is stored, but no sort permutation is
  built over it. `order=review` is Scryfall-internal and not reproducible at
  all.
- **`/cards/search` ignores the terms Scryfall cannot honor, and only 400s when
  none survive.** Scryfall drops an unusable term, warns about it by name and
  answers with what is left; this port used to reject the whole query, 404 an
  unknown format or language, and 503 a malformed regex. The mechanism is
  [src/routes/scryfall-compat/query-terms.ts](src/routes/scryfall-compat/query-terms.ts)
  and every table in it is a measurement against api.scryfall.com. Three
  consequences are deviations in their own right, all on the COMPAT surface only
  — `/search` keeps the whole vocabulary:
  the spellings this port added and Scryfall never had (`subtype:`, `subtypes:`,
  `types:`, `color_identity:`, `oracle_tags:`, `art_tags:`) are ignored-and-warned
  here and honored there, with the Scryfall spelling of the same predicate
  (`t:`, `otag:`, `atag:`) working on both; a negated numeric equality
  (`-cmc:3`, `-tou:1`, `-usd:0`) is ignored, because Scryfall cannot express one;
  and a keyword Scryfall knows and this port does not (`in:`, `cube:`,
  `new:`, `not:`, `stamp:`, `cheapest:`, `include:`, `direct:`) is deliberately
  NOT ignored, since ignoring it would answer a wider result than Scryfall
  silently. `SCRYFALL_ONLY_KEYWORDS` in
  `src/routes/scryfall-compat/query-terms.ts` is the live list — take it from
  there rather than from this sentence.
  A dangling operator (`q=t:`) **is** now reproduced, count and all. This used
  to be recorded here as the one unreproduced total, on the reading that
  Scryfall treats it as "this column is not null". That reading was itself
  measured wrong — it dies on `ft:` = 1,628 — and the term is now REWRITTEN
  rather than dropped (`danglingOperatorTerm` in
  `src/routes/scryfall-compat/query-terms.ts`), which reproduces the counts
  exactly: `t: or e:khm` answers 22,369, which is 22,261 + (323 − 215) to the
  card.
- **Card images come from Scryfall's CDN**, not upstream's CloudFront mirror.
  That mirror is filled by `scripts/copy_images_to_s3.py` against upstream's
  Postgres and S3, neither of which this deployment has — so it was reading a
  bucket it cannot write to, and getting the wrong bytes: for every
  transform/MDFC card the mirror's face-1 object is the **back** face's art, and
  no face-2 object exists at all (fixed upstream separately). Scryfall's path is
  a pure function of the card's id, so nothing extra is stored. Two consequences:
  `scryfall_id` is a tenth default result field (`/random_search` has no `fields`
  parameter for the page to ask for it), and the srcset advertises Scryfall's
  three real widths — 488/672/745 — rather than upstream's four renditions.
  Fonts still come from upstream's CDN, which is why the CSP keeps naming it.
- **`warnings` on a search envelope.** Present only when an in-query directive
  said something worth reporting — an unknown value that was ignored, or one
  written inside an OR or a negation where it looks scoped but applies to the
  whole search. Absent otherwise, so a query without directives has the envelope
  it always had.
- **Fixed site title**: pages always say "Sylvan Librarian" instead of
  upstream's hostname-derived name. The derivation port stays tested in
  `src/routes/site-name.ts`.
- **`stale-while-revalidate=86400` on search responses**, so repeat queries
  never pay a cold start. Upstream sends plain `max-age=90`.
- **Assets are versioned by path, not by query.** Upstream appends
  `?v=<content hash>` to a fixed path; here the hash is the filename
  (`/static/app.<hash>.min.js`), as Vite and TanStack Start emit it. Upstream
  can afford the query form because the same WSGI process serves the bytes and
  renders the hash, so the two cannot disagree. Cloudflare's asset layer
  resolves by path and ignores the query, which made `?v=` an alias for
  whatever object currently sat at that path rather than a name for specific
  bytes — a browser was found holding pre-fix `app.min.js` under the post-fix
  `?v=`, pinned by a year-long `immutable`. A content-addressed path 404s when
  the bytes are absent instead of serving different ones.
- **HTML documents revalidate**: `max-age=0, must-revalidate, s-maxage=3600`
  where upstream sends `max-age=3600`. The page is the only thing that names an
  asset URL, so a stale page is indistinguishable from a stale asset — under
  upstream's header a returning browser could render an hour-old document
  naming an hour-old bundle, which by itself delays any frontend fix by up to
  an hour. `s-maxage` keeps the edge copy, so the Worker still does not run per
  navigation. This is the half that makes `immutable` safe on the assets above;
  the two are a matched pair, not independent choices. `bun run verify-deploy`
  asserts both against the live origins after every deploy.
- **Built-in per-IP rate limit** on the engine routes: a token bucket in a
  tiny per-IP Durable Object, default 25 requests/10s, 429 + `Retry-After`.
  Enforcement is asynchronous and costs zero request latency — which also makes
  it loose, letting roughly 2x the configured number through, so 25 is about
  5/s in practice. That is half of what Scryfall asks of its own consumers, and
  far above any human. **Off by default** — see .env.example, including the
  `TRUSTED_API_KEYS` bypass (comma-separated, one key per caller). Cache hits
  never count.
- **The proxy headers that rename this origin are not trusted by default.**
  Upstream reads `X-Proxy-Host` unconditionally, which is correct for a private
  VPS behind its own proxy and wrong here for the same reason the rate limit
  exists: this is a public Worker, and it has an edge cache upstream does not.
  Those headers build every absolute URL in a card object and a search's
  `next_page`, and no cache key contains them, so an unvalidated header let one
  request decide where a 16-hour cache entry pointed for everyone. `X-Proxy-Host`
  and `x-forwarded-proto` are now honoured only from a host named in
  `TRUSTED_PROXY_HOSTS` (unset by default, which ignores both). See
  [src/routes/proxy-origin.ts](src/routes/proxy-origin.ts).
- **Static files are served by the CDN, not the Worker.** `/static/*`,
  `/favicon.ico` and `/robots.txt` come from `public/` and never invoke the
  Worker, which is what took cold start down to the platform
  floor. Bytes are byte-identical to upstream's; the response headers are not —
  content types come from the platform (`text/javascript` where upstream sends
  `application/javascript`) and cache lifetimes are set for this deployment in
  `public/_headers`. Parity is kept where it matters, on the query endpoints.
- **The `/_admin` mount is a permanent 401.** Upstream #963/#966 moved every
  data-management route — `import_*`, `setup_schema`, the backfills,
  `ingest_cubecobra`, `prefer_score_tuner` — behind HTTP Basic Auth against
  `ADMIN_PASSWORD`, hid them from the public 404 listing, and rejects every
  request under the mount when no password is set. This deployment has no
  password and no Postgres behind the routes (the Cloudflare import pipeline
  replaced them), so `/_admin/*` answers upstream's rejection verbatim — 401,
  `WWW-Authenticate: Basic realm="admin"`, `Cache-Control: no-store`,
  `{"error": "Unauthorized"}` — and the old public paths are plain 404s, as
  they are upstream. `get_common_keywords`, still public upstream, answers
  `501`. `get_pid` returns `0`.
- ~~**`set:` on a memorabilia set returns nothing.**~~ **REVERSED — nothing is
  dropped at import any more, and the rejected alternative is what ships.**
  Upstream #918 stops importing `set_type: memorabilia` printings; this port
  used to follow it, on the argument that a query-time conjunct breaks four of
  the six physical plans (`PlanePopcountOrder`, `CardRangePopcount`,
  `PrintingRangeScan`, and `all_match_known`'s constant-count arms) at +59–115 µs
  per query. That argument was correct about the cost and wrong about the
  alternative: an absent row **cannot reproduce a query-time gate in either
  direction**. `/cards/named?exact=Counters` answered 404 where Scryfall answers
  fmsc/9, and `include_extras=true` had nothing to include. So every row is now
  imported, `transform.rs` decides which ones carry `is:extra`, and
  `src/routes/extras-gate.ts` ANDs `-is:extra` unless the caller or a set term
  asks otherwise — spelled as `-is:extra` rather than as a set-type conjunct
  deliberately, which is what avoids the plan breakage the old text cites. (The
  "0 of 31,724 cards" figure was a generation-6 measurement and no longer
  describes the corpus.) **BOTH search surfaces run that gate.** It lived inside
  the compat route while the store was built from `default_cards`, whose dump has
  no art-series printings, so `/search` — the web UI's own route — never needed
  one. `all_cards` carries 2,650, and `/search?q=lightning bolt` answered three
  printings against `/cards/search`'s two until the rule was extracted and shared.
  `scripts/search-differential.ts` is what now runs the two routes against each
  other, offline, over `parity-sweep`'s generated matrix.
- **A missing sort value has a side, and the side depends on the COLUMN.**
  `order=edhrec` is the default `orderby`, and every card with no EDHREC rank
  used to lead the results — `perm_primary_key` gave every column one absent
  rule (lowest ascending, last descending), which is right for a magnitude and
  backwards for a rank. Measured one page per (column, direction) over `e:khm
  unique=prints` on api.scryfall.com: `power`, `toughness`, `usd`, `eur` and
  `tix` all LEAD ascending with their nulls, while `edhrec` and `penny` hold
  none on an ascending page of 175 and lead DESCENDING with them (33 and 103
  respectively). So `absent_sorts_highest` is a measured per-column table, not a
  rule anyone can re-derive, and the unmeasured columns keep the old side
  deliberately. The permutation is ARCHIVED, so this is a stored-content change:
  generation 37, with no format bump because only the order inside two `Vec<u32>`
  changes. `scripts/live-parity-cases.json` carries the anchor —
  `e:khm order=edhrec dir=desc` page 1, where Scryfall leads with 33 unranked
  printings — and it passes byte-for-byte after the rebuild.
- **`/cards/random?q=…` runs the extras gate; `/random_search` cannot yet.** Both
  random routes drew from the ungated corpus while the differential above
  reported 406 ok — it reaches neither of them, which is why
  `scripts/random-differential.ts` now exists. **`/cards/random` is fixed**, and
  the rule was measured rather than assumed: `t:goblin cmc=0` fires no trigger
  and holds nothing but extras, and api.scryfall.com answers 404 for
  `/cards/random?q=t:goblin cmc=0` and `Goblin // Blood` (q07/T12) with
  `include_extras=true` — the same gate `/cards/search` runs, and the parameter
  is honored here too. Before the fix `/cards/random?q=lightning bolt` drew
  astx/76 about a third of the time on a query `/cards/search` can never answer
  it for. **The bare no-`q` draw is deliberately left ungated**: it carries no
  echo to read, telling a ~14% extras share from zero would take tens of draws
  from an endpoint that rate-limits this repo, and gating it on the strength of
  the `q` measurement would remove a sixth of the corpus from it on an
  inference. **`/random_search` is fixed too, and it took an engine argument to
  do it**: the wasm export was `random_search(n, seed, fieldsJson)` — no filter
  at all — so the route had nothing to gate with and 13.6% of 1,000 draws came
  back `is:extra`. It is now `random_search(n, seed, filterTreeJson, fieldsJson)`
  and the pool it samples is the FILTER'S OWN ANSWER, produced by the ordinary
  paging path rather than by a second evaluator, so "what may this draw return"
  and "what does `/search` return for that query" are the same question answered
  by the same code. 1,000 draws, none `is:extra`, asserted flatly by
  `random-differential.ts`. **This route excludes where `/search?q=` does not**,
  which is a deliberate asymmetry: an empty search asks for everything, while the
  random lane's extras-free answer was a property it always had — the importer
  used to drop the class — so restoring it is the route's own behaviour rather
  than a new policy. **The partition weighting stays `card_count`**, measured
  rather than assumed: the gate's density is 86.29-87.93% across the ten
  partitions, so the worst weight is off by 1.07% relative, and correcting it
  would cost an N-way count fan-out (11 RPCs instead of 1) on a route the front
  page calls on every load.
- `card_is_tags` used to carry only three of upstream's `BOOLEAN_IS_TAGS`
  (`is:reserved`, `is:gamechanger`, `is:oversized`). Generation 21 took the
  stored vocabulary **from 3 entries to 30**: `BOOLEAN_IS_TAGS` grew and
  `ARRAY_IS_TAGS` is new (upstream #926), and the builder adds the computed
  `extra` tag on top. `src/parser/db-info.ts` is the live list, and it is read by
  the parser as well as the builder — an entry added on one side and not the
  other turns a working predicate into a warned no-match, or the reverse. The
  `CUSTOM_IS_TAGS` still need a per-tag Scryfall search sweep that upstream's
  *automated* import does not run either, so those remain absent on both sides.
- **Tag aliases resolve at query time, not at import.** Scryfall's tagger keeps
  alternate spellings for a tag (`art:flames` means `art:fire`), and upstream
  #914 reproduces that by stamping every alias into `card_oracle_tags` /
  `card_art_tags` as an extra key beside the slug and all its ancestors, so
  query time stays an exact match. That cost 6,252,880 bytes here — measured,
  two builds off the same dumps — which on the generation-3 store took it from
  74.8MB to 81.1MB and across the KV chunk grid from 3 values to 4, putting a
  fourth serialized read on every cold load. (Those store figures describe a
  much older, English-only, unpartitioned store; the 6,252,880-byte cost of the
  alias keys themselves is the part that still stands.) So the store keeps only
  canonical slugs and the parser folds the search term through a generated map
  (`src/parser/tag-aliases.gen.ts`, 2,152 entries, 68,243 bytes on disk as of
  2026-08-16). Results are
  identical, because the alias key was never more than a duplicate: the builder
  attached alias `a` under exactly the condition it attached slug `s`. Upstream
  keeps its design — 10MB of JSONB does not bite on Postgres, and its parser has
  no seam to resolve through; the corrected cost is recorded in that PR.
- HTML minification is off (upstream's own default).
- Engine timing fields read `0` on wasm (Workers freeze clocks during CPU work).

## Development

Prerequisites: [bun](https://bun.sh). Both wasm modules are committed
prebuilt, so TS work needs nothing else. Touching Rust needs a toolchain with
`wasm32-unknown-unknown`. No `rust-version` is declared in `Cargo.toml`, so
there is no enforced floor; the version that actually gates a change is the
**1.97.1** `scripts/clippy.sh` pins, because that is what upstream's CI runs and
a locally-green fix on an older toolchain can land red there.

Regenerating parser fixtures needs **CPython 3.13** specifically — upstream's
target, and the version whose Unicode tables (15.1) `src/parser/py-unicode-data.ts`
encodes. A newer interpreter silently reshapes the unicode fixtures:

```bash
uv venv --python 3.13 .venv && VIRTUAL_ENV=.venv uv pip install pytest pyparsing cachebox titlecase
.venv/bin/python scripts/export-parser-fixtures.py && bunx biome check --write tests/parser/fixtures
```

Do NOT install `regex` there — upstream does not, so titlecase's `re` fallback
is the production behavior and installing it makes fixtures diverge.

```bash
bun install
bun dev                 # full site at localhost. First run does the FULL import
                        # natively (~2-3 min) and seeds local KV before the dev
                        # server starts, refusing to start if it fails. Later
                        # runs start instantly. DEV_BOOTSTRAP=worker skips the
                        # seed and exercises the in-Worker pipeline instead
bun run seed:local      # the native build + local seed, on its own
bun run deploy          # publish the index, then deploy the Worker
bun run gate            # EVERYTHING that has to be green, in one command:
                        # clippy, cargo test, typecheck, biome, bun test, and
                        # performance ratios. CI (.github/workflows/ci.yml) runs
                        # the cheap half on every PR; the perf ratios need a built
                        # store and stable hardware, so they only ever run here.
                        # One command is harder to run four fifths of than five
                        # are. GATE_SKIP_PERF=1 skips the ~40s store build while
                        # iterating.
                        #
                        # The perf step builds a deterministic corpus (fixed seed,
                        # committed fixtures, no network) and asserts each by-name
                        # route stays under 3% of a full scan. That limit was set
                        # by disabling the narrowing and measuring: healthy 0.3%,
                        # regressed 14-26%. An earlier 25% limit passed every one
                        # of those regressions, which is why the number is
                        # calibrated rather than chosen.

# The individual steps, when you want just one:
bun test                # parser parity fixtures + route tests
bun run check           # biome
bun run typecheck
bun run clippy          # the RUST gate. Pinned to 1.97.1 — the toolchain
                        # upstream's CI pins — because clippy lints differ by
                        # release and a locally-green fix can land red there.
                        # CLIPPY_FORCE=1 cleans first: a repeat `cargo clippy`
                        # over an unchanged crate prints nothing and exits 0,
                        # which reads exactly like a clean pass
bun run build:wasm          # rebuild query-engine wasm after touching Rust
bun run build:wasm-import   # rebuild import wasm after touching Rust
bun run cf-typegen      # regenerate types after wrangler.jsonc changes

# The two differential harnesses, which compare this mirror against
# api.scryfall.com rather than against its own fixtures:
bun run live-parity     # KNOWN shapes, byte for byte (90 cases in
                        # scripts/live-parity-cases.json as of 2026-08-16;
                        # count them there rather than trusting this). Defaults to the
                        # DEPLOYMENT, which enforces the per-IP limiter, so a
                        # remote run needs a bypass key:
                        #   export TRUSTED_API_KEY=<one of the Worker's
                        #                           TRUSTED_API_KEYS>
                        # Without it the run REFUSES to start rather than
                        # answering 429 to every case and reporting the
                        # refusals as parity failures. `--origin
                        # http://localhost:8787` needs no key — the limiter is
                        # not enforced there.
bun run parity-sweep    # the systematic matrix, hunting UNKNOWN divergences.
                        # Defaults to localhost; --origin at the deployment
                        # takes the same TRUSTED_API_KEY.
```

Local dev has two seed paths, and they are not the same code. `bun run
seed:local` (the default, and what `bun dev` uses) runs the **native**
`sylvan-store-builder` binary; `DEV_BOOTSTRAP=worker` runs the **Durable Object**
pipeline production runs, under wrangler dev's emulator. Both share the whole
transform/tags/ranks surface through `sylvan-store-builder`, which is what makes
their rows byte-identical — and `bun run gate` asserts exactly that rather than
assuming it, because a change that compiles natively and not on wasm32 would
otherwise leave the two publishers writing stores from different transform code.
Use `DEV_BOOTSTRAP=worker` when the thing under test is the pipeline itself.

## Benchmarks

> **Measured 2026-08-13, on the English-only single-archive store, before
> partitioning.** The mechanism notes below (the per-run nonce, the 30 requests
> against a 25/10s limiter) are current; the *numbers* describe a store shape
> that no longer ships, and the cold-path story in particular needs re-deriving
> — a cold region now loads N partitions in parallel rather than one archive in
> sequence. Re-run `scripts/bench.sh` before quoting any figure here.

Same 10 queries against this deployment, upstream's own
[sylvan-librarian.com](https://sylvan-librarian.com), and the
[Scryfall API](https://api.scryfall.com) — one residential vantage in Southern
California, one **cold** request per query then the median of two immediate
**warm** repeats, every service on its own production caching, one reused
HTTP/2 connection each. Times are total wall-clock ms, door to door. Two runs
pooled, so each column below is the median of 20 cold samples per service;
upstream is read in the same runs as the ambient-network control, and moved
0.99× between them, so neither run is contaminated.

```bash
scripts/bench.sh results.tsv
```

**Space the two runs by ~90s.** One invocation is 30 requests to this port, and
the rate limiter allows 25 per 10s per IP (`RATE_LIMIT_PER_10S`), so two
back-to-back runs answer a chunk of the second with 429s and silently shrink the
sample — 18 of 60 on the run that found this. The script warns on non-200s;
treat any warning as a run to discard rather than pool.

| | cold (cache miss) | warm (repeat) | payload |
|---|---|---|---|
| **this port (Cloudflare)** | 161ms | **21ms** | ~39 KB |
| sylvan-librarian.com | **103ms** — 0.64× | 101ms — 4.8× slower | **~34 KB** |
| Scryfall API | 1460ms — 9.1× slower | 34ms — 1.6× slower | ~813 KB — 21× larger |

Worst single request: **this port 1071ms** · upstream 458ms · Scryfall 2625ms.

Re-measured 2026-08-13 (was 184 / 30 / 6799ms for this port). Upstream is the
ambient-network control and moved 0.96× across the two measurement dates, so the
improvement in this port's columns is the port's, not the network's.

Upstream is FASTER than this port on a genuine cache miss, and that is the
honest shape of the trade: they run a warm process that is always resident,
while a miss here goes through an isolate and a Durable Object that may both
be cold. What this port buys instead is the repeat — 21ms against their 101ms,
because they front `/search` with no edge cache at all and their cold and warm
numbers are the same number. Scryfall's miss is 1460ms and its worst case 2.6s;
its 34ms warm is its own CDN.

That 1071ms worst case is one request of the twenty — the first query of the
first run, landing on a region whose `SearchEngine` had been evicted, so it paid
a full store load out of KV before it could answer. It is the same wake the
store loader is built around, and it is not the median's problem: the other
nineteen cold samples span 44–497ms. Nothing about it is hidden by averaging,
which is why the worst case is printed next to the median rather than in place
of it. The equivalent sample was 6799ms when this table was last measured; what
changed between the two is not isolated here, so read it as "the worst case
moved", not as any one commit's credit.

The payload is ~39 KB against upstream's ~34 KB because `scryfall_id` is this
port's tenth default result field where upstream sends nine — card images here
come from Scryfall's CDN rather than upstream's CloudFront mirror, and that
path is a pure function of the id, so the no-JS renderer cannot build an image
URL without it.

Every URL carries a per-run nonce, so the cold column measures a real miss.
Without it the fixed query set collides with `/search`'s own
`stale-while-revalidate=86400` and every run after the first reports cache hits
as "cold" — which is what the previous table in this file did, understating
cold by roughly 5× for both cached services.

## License

Upstream sylvan_librarian is ISC-licensed (© Joseph Bylund) — see
[vendor/sylvan_librarian/LICENSE](vendor/sylvan_librarian/LICENSE). This port
keeps that license for all vendored and derived code.
