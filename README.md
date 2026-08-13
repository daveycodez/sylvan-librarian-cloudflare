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
              ├─ engine queries: RPC to the region's SearchEngine Durable Object
              │   (engine-<region>, one per location hint — wnam, weur, apac …),
              │   placed there by location hint; idle regions evict their DO —
              │   scale to zero. The x-sylvan-engine response header says which
              │   DO answered
              ├─ SearchEngine DO: wasm card_engine + ~72.0MB rkyv store in memory,
              │   streamed from KV as 2 immutable chunks in 4MB blocks, and cached
              │   DECOMPRESSED in the DO's own SQLite so later wakes skip both the
              │   network and the gunzip. It hot-swaps when the KV manifest
              │   advances. Results come back already JSON-encoded in the requested
              │   shape, so no card ever becomes an object in the isolate serving
              │   the request
              └─ autoscaling: fan-out to engine-<region>-1..N when the DO reports
                  sustained load AND the isolate sees sustained slowness, with
                  idle fold-back. A new shard takes no traffic until its warm
                  ping resolves — see src/engine/shard-controller.ts

cron (nightly refresh; the deploy does the first build)
        ──▶ ImportCoordinator (SQLite-backed Durable Object, serializes runs)
              └─ alarm-chained pipeline, all inside the 128MB isolate:
                   fetch → transform → tags → aggregate → finalize → build
                   (the SAME Rust the native builder runs, compiled to wasm;
                    intermediates spill to DO SQLite, never to memory)
                   publish: 2 store chunks + the residue archive's one, each
                   gzipped, + manifest to KV, manifest LAST (the commit point
                   readers act on); the store before last dropped
```

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
archive to arrive. The cut is on RAW bytes at `KV_CHUNK_BYTES` and each piece is
gzipped as its own member; the two-way cut puts ~12.4MB and ~18.9MB in KV, the
binding one at 72% of the 25 MiB value cap.

The memory win is bigger than the transfer one and comes from a different
place. wasm-bindgen marshals a `&[u8]` by COPYING it into linear memory, so a
whole ~25MB raw chunk used to land there as scratch on top of the store itself.
Decompressed, the pieces arrive ~4KB at a time and that scratch effectively
vanishes: peak linear memory measured 99.4MB before and 74.6MB after — the
~25MB is the chunk that is no longer copied whole, not the ~12MB the smaller
KV value saves. Against a 128MB isolate that is the difference that matters.

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

**Publishing** is four writes: two store chunks and the residue archive's
one, each cut under KV's 25 MiB value cap and gzipped before the put, then
the manifest as the commit point. Two versions are retained, so a reader
mid-stream finishes and a bad build can be rolled back.

**Caching.** `/search` caches for 90s plus a day of stale-while-revalidate;
`/cards/*` carries Scryfall's own tiers (16h, `no-cache` for random, private for
the collection POST); page HTML carries no card data; `no-store` routes are never
cached, and neither are the dispatch-level errors (404/405/429/500/503), though
`/cards/*` caches its OWN 400s and 404s on the route's tier, which is Scryfall's
behaviour too; the cache is per-deploy-version, so a deploy starts cold. An
import is not a deploy, so the nightly rebuild purges the cache itself, rather
than leaving a `/cards/*` object sitting on yesterday's prices for 16 hours.

The timing is the whole trick. The purge waits ten minutes after the manifest
lands, because purging at the commit point is worse than not purging at all — a
request served in the gap before the engine DOs swap stores gets cached on the
OLD store, and pins it for the full 16 hours. Ten minutes clears the two things
that bound convergence: a 5-minute manifest recheck and a 60s KV cache on the
manifest read. Then it purges a *second* time, ten minutes later, because
convergence is deferred as well as lazy — the request that trips the recheck
gate is itself answered from the old store, so a colo that was idle across the
first window refills the cache right after it is emptied. That same request
starts the swap, so one more pass is enough to clear it for good.

**Free-plan fit.** A store load is 3 KV reads (4 on `/cards/*`, which alone
attaches the residue archive), a publish 4 writes, and serving touches neither
— so the daily meters (100k Worker requests, 100k KV reads, 1k KV writes) bound
*traffic*, not architecture. Storage is one ~82.7MB copy per retained version
(72.0MB search store plus the 10.7MB residue) against KV's 1GB.

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
that were measured, and the conclusion is that this axis does not move startup.)

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
store the Durable Object builds is the same store the native builder produces —
the tests compare them byte-for-byte at the row level.

The **archive format is not** untouched, and has not been since the card-object
work: the residue is a second archive rather than fields on `Printing`, and its
three list fields are a CSR on `CompatData` rather than `Vec`s on
`CompatFields`. Both are size decisions this deployment has to make and upstream
does not — see [Deviations](#deviations-from-upstream). `ARCHIVE_FORMAT_VERSION`
therefore diverges from upstream's on purpose; it is not a sync failure.

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
  printing, only this route reads them, and 26MB in the search archive or the
  residue would be paid for by every `/search` and every other `/cards/*` load.
  `import_rulings` stays a 501 stub, like the other Postgres-backed admin
  routes — the nightly import replaced it, not this endpoint.
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
  **Within a single date the order still cannot be matched**: Scryfall orders
  same-date rulings by an internal ruling id, and the bulk file carries no id —
  none of the file's own order, that order reversed, comment ascending or
  comment descending reproduced it on any of 10 sampled cards. `comment`
  ascending is used as a deterministic stand-in. This affects 13,847 of the
  19,770 cards that have rulings; the other 5,923 (one ruling, or one per date)
  match Scryfall exactly. End to end against api.scryfall.com over 19 cards with
  rulings: same set 19/19, same `published_at` sequence 19/19, byte-identical
  order 8/19 — the remainder differ only in the sequence within one date.
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
  from a `raw_card_blob` this port does not store — 29 columns, 12 derived keys
  (every `*_uri` and `image_uris` are pure functions of the id, set, collector
  number and oracle id) and a packed residue. Absent keys stay absent, because
  Scryfall omits rather than nulls and a card that sprouts nulls differs from
  Scryfall on every row. That residue lives in a **second KV archive** loaded
  only when a `/cards/*` route needs it: inlining it took the store across a KV
  chunk boundary and the in-Worker import past its 112 MiB wasm cap, and
  `/search` reads none of it.
- **The residue's three list fields are a CSR, where upstream keeps them as
  `Vec`s on `CompatFields`.** An archived `Vec` field costs an 8-byte relative-
  pointer header on every row whether or not it holds anything, and
  `multiverse_ids`/`promo_types`/`frame_effects` are empty on most printings:
  three of them across 95,131 printings is 2.18MB of headers carrying 0.39MB of
  payload. They are offset arrays on `CompatData` instead (`CompatLists`), 84 →
  60 bytes a printing. Deliberately **not** upstreamed: #912 declines the same
  trade at five times the size on `external_id_index` (8.34MB → 2.78MB), on the
  stated grounds that "Postgres has no archive ceiling; a deployment that serves
  the archive from a size-capped store will want the packed form." This is that
  deployment.
- **`loyalty` rides in the residue, where upstream has a column for it.**
  Upstream stores both `planeswalker_loyalty` (the integer `loy:` filters on)
  and `planeswalker_loyalty_text` (what Scryfall prints), and so excludes
  `loyalty` from the residue. This port kept only the integer — which cannot
  hold `X` (Nissa, Steward of Elements) or `1+*` — while still excluding the
  key, so every planeswalker's card object came back with no `loyalty` at all.
  It is now one interned residue field: ~2 bytes a printing, in the archive
  `/cards/*` already loads, rather than a card-level column in the main store
  that only `/cards/*` would ever read. `defense` is the same story on the face
  side — Scryfall prints it on a battle's front face and upstream's face field
  list omits it, so `Invasion of Alara`'s `defense: 7` was dropped outright.
  Both are reported upstream against #912.
- **`/cards/:code/:number/:lang` checks the language after resolving**, where
  upstream filters on it in SQL. `lang` lives in the residue archive and is not
  a query field, so the printing is resolved by set and collector number and its
  own stored language compared — which uses the real value rather than assuming
  one. A mismatch is a 404, as it is upstream.
- **`/cards/named?exact=` prefers a whole-name match to a face match.** Upstream
  orders both by `prefer_score` alone, which on this corpus answers
  `exact=Lightning Bolt` with *Emeritus of Conflict // Lightning Bolt* — a
  two-faced card whose back face carries the name and whose score is higher.
  Matching a face is right and Scryfall does it (`exact=Delver of Secrets`
  resolves), but as a fallback rather than a peer. Reported upstream.
- **`/cards/*` cache headers are Scryfall's own**, measured against
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
- **`/cards/search?order=penny` falls back to name with a warning**, as an
  unrecognized order does. `penny_rank` is stored, but in the residue archive,
  which carries no sort permutations. `order=review` is Scryfall-internal and
  not reproducible at all.
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
  `TRUSTED_API_KEY` bypass. Cache hits never count.
- **Static files are served by the CDN, not the Worker.** `/static/*`,
  `/favicon.ico`, `/robots.txt` and the tuner page come from `public/` and
  never invoke the Worker, which is what took cold start down to the platform
  floor. Bytes are byte-identical to upstream's; the response headers are not —
  content types come from the platform (`text/javascript` where upstream sends
  `application/javascript`) and cache lifetimes are set for this deployment in
  `public/_headers`. Parity is kept where it matters, on the query endpoints.
- Postgres-only admin/import routes answer `501`. `get_pid` returns `0`.
- **`set:` on a memorabilia set returns nothing.** Upstream #918 stops importing
  `set_type: memorabilia` printings — World Championship decks, Collectors'
  Edition, 30th Anniversary, the oversized promos, 99 sets in all — because
  Scryfall hides them from every search that does not name their set, and
  importing them made ordinary queries disagree: they supplied the *cheapest*
  printing for 184 cards, which is exactly the printing a price ordering
  returns. Scryfall does still serve them when you ask by name (`set:cei`
  returns its Ancestral Recall); this port has nothing to serve. **No card is
  lost** — 0 of 31,724 cards are printed only in memorabilia sets — so it
  changes which printing represents a card, never whether the card is findable.
  Filtering at query time instead would have been exact, and was measured and
  rejected: a conjunct on every query breaks four of the six physical plans
  (`PlanePopcountOrder`, `CardRangePopcount`, `PrintingRangeScan`, and
  `all_match_known`'s constant-count arms), costing +59–115 µs per query.
- `card_is_tags` carries only upstream's `BOOLEAN_IS_TAGS` — `is:reserved`,
  `is:gamechanger` and `is:oversized`, which come off booleans the bulk cards
  already carry. The
  `CUSTOM_IS_TAGS` need a per-tag Scryfall search sweep that upstream's
  *automated* import does not run either, so they are absent on both sides.
- **Tag aliases resolve at query time, not at import.** Scryfall's tagger keeps
  alternate spellings for a tag (`art:flames` means `art:fire`), and upstream
  #914 reproduces that by stamping every alias into `card_oracle_tags` /
  `card_art_tags` as an extra key beside the slug and all its ancestors, so
  query time stays an exact match. That costs 6,252,880 bytes here — measured,
  two builds off the same dumps — which took the store from 74.8MB to 81.1MB
  and across the KV chunk grid from 3 values to 4, putting a fourth serialized
  read on every cold load. So the store keeps only canonical slugs and the
  parser folds the search term through a generated map
  (`src/parser/tag-aliases.gen.ts`, 2,150 entries, ~78KB). Results are
  identical, because the alias key was never more than a duplicate: the builder
  attached alias `a` under exactly the condition it attached slug `s`. Upstream
  keeps its design — 10MB of JSONB does not bite on Postgres, and its parser has
  no seam to resolve through; the corrected cost is recorded in that PR.
- HTML minification is off (upstream's own default).
- Engine timing fields read `0` on wasm (Workers freeze clocks during CPU work).

## Development

Prerequisites: [bun](https://bun.sh). Both wasm modules are committed
prebuilt, so TS work needs nothing else. Touching Rust needs a toolchain
(1.88+) with `wasm32-unknown-unknown`.

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
                        # performance ratios. There is no CI here, so the gate is
                        # a thing you type — and one command is harder to run four
                        # fifths of than five are. GATE_SKIP_PERF=1 skips the
                        # ~40s store build while iterating.
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
```

Local dev is production-identical: the import that seeds local KV is the same
Durable Object pipeline production runs, under wrangler dev's emulator.

## Benchmarks

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
