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

Optional knobs (rate limiting, API-key bypass, shard cap) are in
[.env.example](.env.example).

## Architecture

```
request ──▶ static asset? served from the CDN out of public/ — the Worker is
            never invoked, so it costs no isolate and no CPU
        ──▶ Workers Cache (regional edge cache; hits skip the Worker entirely)
        └─▶ Worker isolate (thin: parses, RPCs)
              ├─ TS parser: Scryfall syntax → filter tree (port of hand_parser.py)
              ├─ engine queries: RPC to the colo's SearchEngine Durable Object
              │   (engine-<colo>, created in the colo that first names it), so
              │   sharding tracks the traffic distribution and idle colos evict
              │   their DO — scale to zero. The x-sylvan-engine response header
              │   says which DO answered
              ├─ SearchEngine DO: wasm card_engine + ~70MB rkyv store in memory,
              │   streamed from KV as 3 immutable chunks; no local copy, and it
              │   hot-swaps when the KV manifest advances. Results come back
              │   already JSON-encoded in the requested shape, so no card ever
              │   becomes an object in the isolate serving the request
              └─ autoscaling: fan-out to engine-<colo>-1..N when the DO reports
                  sustained load AND the isolate sees sustained slowness, with
                  idle fold-back — see src/engine/shard-controller.ts

cron (nightly refresh; the deploy does the first build)
        ──▶ ImportCoordinator (SQLite-backed Durable Object, serializes runs)
              └─ alarm-chained pipeline, all inside the 128MB isolate:
                   fetch → transform → tags → aggregate → finalize → build
                   (the SAME Rust the native builder runs, compiled to wasm;
                    intermediates spill to DO SQLite, never to memory)
                   publish: 3 chunks + manifest to KV, manifest LAST (the
                   commit point readers act on); the store before last dropped
```

The wasm engine is the only query path. A query it cannot answer returns a
structured error, never a silently empty result.

**Cold starts.** A colo whose DO has evicted relays the query to the region's
DO while loading itself in the background, so users never wait on a store
load. There is deliberately no Cache API layer in front of KV: writing the
store through `caches.default` and reading it back measured 0.6–1.3s of billed
CPU per load, and KV's own `cacheTtl` gives the same colo-level caching for
free on immutable chunk keys. The store is stored raw for the same reason — KV
meters reads, not bytes, so compression would buy only decompress CPU.

**Publishing** is `chunk_count + 1` writes: ~25MB chunks (just under KV's 25
MiB value cap) keyed by store key, then the manifest as the commit point — so
a ~70MB store is four writes. Two versions are retained, so a reader
mid-stream finishes and a bad build can be rolled back.

**Caching.** `/search` caches for 90s plus a day of stale-while-revalidate;
`/cards/*` carries Scryfall's own tiers (16h, `no-cache` for random, private for
the collection POST); page HTML carries no card data; `no-store` routes are never
cached, and neither are the dispatch-level errors (404/405/429/500/503), though
`/cards/*` caches its OWN 400s and 404s on the route's tier, which is Scryfall's
behaviour too; the cache is per-deploy-version.

**Free-plan fit.** A store load is 4 KV reads, a publish 4 writes, and serving
touches neither — so the daily meters (100k Worker requests, 100k KV reads, 1k
KV writes) bound *traffic*, not architecture. Storage is one ~70MB copy per
retained version against KV's 1GB.

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
floor. Script size costs startup at roughly 1.5ms per 100KB, so the rule is to
keep out of the script anything a request does not read.

Request work itself is that 1–2ms, and the engine encodes results inside the
Durable Object so the isolate never parses, clones and re-encodes the same
rows (~28% of it). The query is 1–2ms of DO CPU, metered separately against a
30s limit rather than 10ms.

## Upstream tracking

Upstream is vendored at the commit pinned in [UPSTREAM.lock](UPSTREAM.lock).
The Rust engine (`vendor/sylvan_librarian/card_engine`) is upstream's own code
with a thin patch set (PyO3 optional, buffer-based store load for wasm, and a
memory-capped streaming build path whose output is verified semantically
identical to the standard build). Filter evaluation and the archive format are
untouched, so the store the Durable Object builds is the same store the native
builder produces — the tests compare them byte-for-byte at the row level.

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
- **Rulings are not served.** Upstream's come from `magic.rulings`, filled by
  `api/rulings_import.py` against Postgres, which this deployment does not have.
  A trailing `rulings` segment on any `/cards/*` path returns Scryfall's 404
  error object, and `import_rulings` is a 501 stub like the other Postgres-only
  admin routes. Deliberately **not** an empty `List`: upstream answers 200 with
  `data: []` for a card with no rulings, and reusing that here would claim the
  card has none rather than that this deployment serves none.
- **The Scryfall card object is assembled from stored fields**, not unwrapped
  from a `raw_card_blob` this port does not store — 29 columns, 12 derived keys
  (every `*_uri` and `image_uris` are pure functions of the id, set, collector
  number and oracle id) and a packed residue. Absent keys stay absent, because
  Scryfall omits rather than nulls and a card that sprouts nulls differs from
  Scryfall on every row. That residue lives in a **second KV archive** loaded
  only when a `/cards/*` route needs it: inlining it took the store past its
  three-chunk ceiling and the in-Worker import past its 112 MiB wasm cap, and
  `/search` reads none of it.
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
bun run seed:local      # the native build + seed, on its own
bun run deploy          # publish the index, then deploy the Worker
bun run seed:remote     # push a natively-built store to PRODUCTION KV
bun test                # parser parity fixtures + route tests
bun run check           # biome
bun run typecheck
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
HTTP/2 connection each. Times are total wall-clock ms, door to door.

```bash
scripts/bench.sh results.tsv
```

| | cold (cache miss) | warm (repeat) | payload |
|---|---|---|---|
| **this port (Cloudflare)** | 139ms | **21ms** | **~34 KB** |
| sylvan-librarian.com | **114ms** — 0.8× | 111ms — 5.2× slower | ~34 KB |
| Scryfall API | 928ms — 6.7× slower | 43ms — 2.0× slower | ~813 KB — 24× larger |

Worst single request: **this port 260ms** · upstream 482ms · Scryfall 4037ms.

Upstream is FASTER than this port on a genuine cache miss, and that is the
honest shape of the trade: they run a warm process that is always resident,
while a miss here goes through an isolate and a Durable Object that may both
be cold. What this port buys instead is the repeat — 21ms against their 111ms,
because they front `/search` with no edge cache at all and their cold and warm
numbers are the same number. Scryfall's miss is 928ms and its worst case four
seconds; its 43ms warm is its own CDN.

Every URL carries a per-run nonce, so the cold column measures a real miss.
Without it the fixed query set collides with `/search`'s own
`stale-while-revalidate=86400` and every run after the first reports cache hits
as "cold" — which is what the previous table in this file did, understating
cold by roughly 5× for both cached services.

## License

Upstream sylvan_librarian is ISC-licensed (© Joseph Bylund) — see
[vendor/sylvan_librarian/LICENSE](vendor/sylvan_librarian/LICENSE). This port
keeps that license for all vendored and derived code.
