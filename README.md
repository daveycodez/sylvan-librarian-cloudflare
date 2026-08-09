# sylvan-librarian-cloudflare

**Live demo: [sylvan-librarian.deckgen.workers.dev](https://sylvan-librarian.deckgen.workers.dev)**

[Sylvan Librarian](https://github.com/jbylund/sylvan_librarian) — a Magic: the
Gathering card search engine — ported to run **entirely on Cloudflare's free
plan**: Workers (serving), Durable Objects (the in-memory engine and the
nightly refresh), and D1 (the card index at rest). No VPS, no Postgres, no
container to run, no secrets, no payment method on file — connect the repo, or
`bun run deploy`, and that is the whole install. The card index is built by the
deploy itself, in Cloudflare's own CI (Workers Builds), and a build that
cannot produce an index fails rather than shipping a broken site.

A faithful mirror of upstream's user-facing surface: the web UI, `/search`
(full Scryfall-style query syntax via the same Rust engine, compiled to wasm),
`/card`, `/get_catalog`, `/random_search`, and all static assets. No additions.

## Deploy

1. Cloudflare dashboard → Workers → Create → connect this git repository
   (Workers Builds), or `bun run deploy` from a checkout.
2. There is no step 2. No secrets, no build variables, no dashboard settings,
   nothing to edit in this repo.

The **deploy builds the card index**, and a deploy that cannot build it fails
instead of shipping a Worker without one — so a green build means a working
site, with no progress page to watch. Concretely: `bun install` runs
`scripts/ci-postinstall.sh`, which on Workers Builds (`WORKERS_CI=1`) creates
the D1 database if absent, runs the native Rust store builder over Scryfall's
bulk data, and publishes the store to D1 — all before `wrangler deploy`
uploads the Worker. `bun run deploy` does the same two steps in the same
order, so a laptop deploy and a git-connected build behave identically.

Why the build and not the Worker: Workers Builds gives 2 vCPU, 8GB of memory
and 20 minutes, against the Worker runtime's 128MB isolate and 30s per alarm.
The full import is comfortable in the former and a slicing exercise in the
latter.

Two Workers on one account work with no edits either. Workers Builds injects
`WRANGLER_CI_OVERRIDE_NAME` with the connected Worker's name and wrangler
prefers it over `wrangler.jsonc`'s `name`; the scripts resolve the name the
same way and derive the D1 database from it, so each Worker owns its own
index.

Routine pushes skip the import: `scripts/store-age.ts` asks D1 how old the
live store is, and only a missing or >20h-old store triggers a rebuild.
`FORCE_IMPORT=1` rebuilds anyway, `SKIP_IMPORT=1` deploys code only. Delete
the D1 database and redeploy and the full import runs again.

A nightly cron (11:17 UTC, after Scryfall's bulk refresh) then keeps the index
current from inside the Worker; isolates hot-swap to each new version without
dropping queries.

All optional knobs (rate limiting, API-key bypass, shard cap) are documented
in [.env.example](.env.example).

## Architecture

```
request ──▶ Workers Cache (regional edge cache in front of the Worker;
        │   honors the upstream-mirrored Cache-Control on every route —
        │   hits skip the Worker entirely)
        └─▶ Worker isolate (thin: parses, RPCs, serves static assets)
              ├─ TS parser: Scryfall syntax → filter tree  (port of hand_parser.py)
              ├─ engine queries: RPC to the colo's SearchEngine Durable Object
              │   (engine-<colo>, created in the colo that first names it) —
              │   sharding tracks the traffic distribution, and idle colos
              │   evict their DO: scale to zero. The x-sylvan-engine response
              │   header says which DO answered (do-<colo>)
              ├─ SearchEngine DO: wasm card_engine + ~70MB rkyv store in
              │   memory; store persisted in its embedded SQLite so wake-ups
              │   never wait on D1, hot-swapped when the D1 manifest advances
              ├─ autoscaling: latency-signal fan-out to engine-<colo>-1..N
              │   (plan-aware cap: free 1 / paid 8, no config — plan-hint.ts;
              │   SHARDS_MAX overrides), idle fold-back, warm pings and
              │   seed-ahead — see the header of src/engine/shard-controller.ts
              └─ UI: upstream's static assets, served with upstream's cache headers

cron (nightly refresh; the deploy does the first build)
        ──▶ ImportCoordinator (SQLite-backed Durable Object, serializes runs)
              └─ alarm-chained import pipeline, all inside the 128MB isolate:
                   fetch: ranged, resumable download of Scryfall's gzipped
                     dumps into DO SQLite (compressed at rest)
                   transform/tags/aggregate/finalize: the SAME Rust the native
                     dev builder runs, compiled to wasm (engine/wasm-import) —
                     row transform, tag ancestors, dedupe, prefer/cubecobra
                     scores; drafts and finalized rows spill to DO SQLite in
                     batched blobs, never accumulating in memory
                   build: card_engine's SpillingStoreBuilder streams the rkyv
                     archive out in chunks (measured ~95MB peak at full corpus
                     scale — see engine/wasm-builder-probe/RESULTS.md)
                   publish: chunks + manifest to D1, manifest LAST (the commit
                     point readers act on); old store versions pruned
```

D1 also carries a queryable `cards` table (the same finalized rows the store
is built from, hash-diffed nightly under adaptive write pacing) — the
fallback target for queries the engine declines, mirroring upstream's
engine→SQL architecture.

The store's distribution layer is D1: the builder publishes ~70MB of chunk
rows plus a manifest; each SearchEngine DO pulls the dump once per version,
persists it in its own SQLite, and serves every query from memory. **Queries
never touch D1** — the free plan's row-read metering only sees a handful of
manifest polls and version pulls per day.

Every phase of the import is restart-safe: inputs live in the coordinator's
SQLite, progress commits transactionally with outputs, and phases whose state
lives in the wasm heap record the instance nonce — an eviction mid-run redoes
minutes of compute, never producing a wrong store. Success is ultimately
judged by the D1 manifest advancing.

Queries the engine cannot answer return a structured error — never silently
empty. Upstream's Postgres-only admin/import endpoints return `501` here; the
Durable Object pipeline replaces them.

Caching notes: `/search` caches for 90s + a day of stale-while-revalidate
(nightly imports need no purge — staleness is bounded by one import cycle and
refreshes happen in the background), page HTML carries no card data
(client-side fetches stay fresh), `no-store` routes (`/random_search`) and
error statuses are never cached, and the cache is
per-deploy-version so releases can't serve stale assets.

Cold-start note: users never wait on a store wake. A colo whose DO has
evicted relays the query to the region's DO (engine-wnam, ...) while
waking itself in the background — the store loads from the DO's local
SQLite (never D1), and the wake duration is logged (`SearchEngine wake:
...`). Warm queries are sub-ms of DO CPU. The store is stored raw,
deliberately: D1 meters rows (a chunk row is one row regardless of size —
verified against a live database, where reading 146MB across 3,662 rows
metered 3,662 rows read) while decompress CPU would be metered on every load.

### Publishing a store is incremental

The store is cut into 40,000-byte chunks on a fixed grid and stored by the
hash of their contents ([store-chunks.ts](src/engine/store-chunks.ts)), with
the ordered hash list carried in the manifest. A publish uploads only the
chunks D1 does not already have, which makes three things fall out of one
mechanism: an unchanged store costs no writes at all, a rebuild after a day
of Scryfall churn costs the part that changed, and an interrupted publish
resumes rather than restarting — "already uploaded" is a property of the
bytes, not of how far the last attempt got. Two versions are kept, and they
share every chunk they have in common.

Both publishers cut on the same grid, which is the whole trick: the deploy
seeder splits a 73MB buffer, the in-Worker import re-chunks a stream of
~900KB wasm outputs, and they must agree byte-for-byte or a nightly import
and a deploy would share nothing. Measured on two real builds of identical
input, 1,551 of 1,831 chunks matched (84.7%), with every difference confined
to one band of the archive.

Deploys ask Scryfall when it last regenerated its dumps and compare that to
the live store's build time, so a code push that changes no card data
downloads nothing.

### Free-plan fit

Serving reads zero SQL rows per query (in-memory engine) and the import
writes ~1k SQLite rows plus a few hundred D1 rows per night (batched blobs,
changed chunks only), so the free tier's daily meters — 100k Worker
requests, 100k DO requests, 5M rows read, 100k rows written — bound
*traffic*, not architecture. The per-colo shard
cap is plan-aware automatically (1 on detected free — each warm shard pins
a ~70MB store copy against the 5GB storage and daily duration allowances —
8 on detected paid, 2 until the first import produces evidence), using the
same detection signal as the write pacing; `SHARDS_MAX` overrides it.

## Upstream tracking

Upstream is vendored at the commit pinned in [UPSTREAM.lock](UPSTREAM.lock).
The Rust engine (`vendor/sylvan_librarian/card_engine`) is upstream's own code
with a thin patch set (PyO3 optional, buffer-based store load for wasm, and a
memory-capped streaming build path — `SpillingStoreBuilder` — whose output is
verified semantically identical to the standard build; see
engine/wasm-builder-probe/RESULTS.md). The filter evaluation and archive
format are untouched, so the store the Durable Object builds is the same
store the native dev builder produces — the repo's tests compare them
byte-for-byte at the row level and semantically at the store level.

To pull upstream changes:

```bash
bun run sync-upstream
```

Three-way-merges upstream into `vendor/`, updates the pin, and lists any
changed files whose behavior is re-implemented here (parser, transform,
routes) so those ports get re-reviewed and their parity fixtures regenerated.

## Deviations from upstream

Everything user-visible mirrors upstream byte-for-byte (the parser is gated on
100% tree agreement with the Python parser across upstream's own test corpus).
The complete list of intentional differences:

- **SQL fallback on D1**: upstream quietly falls back to Postgres when the
  engine declines a query; this port does the same against a D1 `cards` table
  the import maintains (responses carry `"compiled": "(d1 fallback)"` so the
  path is observable). Write pacing is **adaptive** — there is no runtime API
  that says "this account is on the free plan", but D1 itself hard-errors
  when the free tier's ~100k metered row writes/day run out, so the import
  simply writes until D1 says stop, remembers where that ceiling sits, and
  paces under it from then on (re-probing monthly in case of an upgrade). On
  a paid plan the error never fires and the table fills **in one run**; on
  the free plan the one-time first fill spans a couple of nightly imports,
  and until it completes an engine failure returns a structured error
  instead of a silently empty result. Steady-state deltas are tiny — daily
  price/EDHREC churn is synced separately from structural changes. The
  `CARDS_WRITE_BUDGET` var overrides the adaptive pacing with a fixed
  per-run cap (`0` disables the fallback table entirely).
- **Fixed site title**: pages always say "Sylvan Librarian" instead of
  upstream's hostname-derived name (which could never produce it on our
  domains). The derivation port stays intact and tested in
  `src/routes/site-name.ts`.
- **`stale-while-revalidate=86400` added to search responses** (the `/search`
  API and the SSR root page): Workers Cache serves an expired cached query
  instantly while refreshing in the background, so repeat queries never pay a
  cold isolate start. Staleness is bounded by one nightly import cycle;
  upstream sends plain `max-age=90`.
- **Built-in per-IP rate limit** on the engine-computing routes (`/search`,
  `/random_search`, the SSR root with a query): a continuously-refilling
  token bucket in a tiny per-IP Durable Object, created with a location hint
  in the region the IP's traffic comes from. Default 100 requests/10s per IP,
  429 + `Retry-After` when exceeded; enforcement is asynchronous and costs
  zero request latency. **Off by default** — opt in with
  `RATE_LIMIT_ENABLED=true`; see .env.example for the knobs and the
  `TRUSTED_API_KEY` server-to-server bypass. Cache hits never count.
- Postgres-only admin/import routes answer `501`; the Durable Object pipeline
  is their replacement. `get_pid` returns `0` (isolates have no pid).
- `card_is_tags` stays empty, matching upstream's *automated* import (upstream
  only fills it via a manual admin route).
- HTML minification is off (upstream's own default configuration).
- Engine timing fields read `0` on wasm (Workers freeze clocks during CPU work).

## Development

Prerequisites: [bun](https://bun.sh). That's all for TS work — both wasm
modules (query engine, import pipeline) are committed prebuilt. Touching Rust
needs a toolchain (1.88+) with the `wasm32-unknown-unknown` target;
`wasm-pack` only for the query engine's pkg. Regenerating parser fixtures
(`scripts/export-parser-fixtures.py`) needs `python3`.

```bash
bun install
bun dev                 # full site at localhost — UI, /search, everything.
                        # Mirrors deploy: the first run does the FULL import
                        # natively (~2-3 min, same shared Rust as production)
                        # and seeds local D1 — store, manifest, AND the
                        # SQL-fallback cards table — before the dev server
                        # serves anything, and refuses to start if it fails.
                        # Later runs start instantly. DEV_BOOTSTRAP=worker
                        # skips the seed and exercises the in-Worker nightly
                        # pipeline instead (local D1 + DO SQLite + alarms)
bun run seed:local      # the native build + seed, runnable on its own
bun run deploy          # publish the index, then deploy the Worker
bun run seed:remote     # push a natively-built store to PRODUCTION D1 on its
                        # own (--with-cards also seeds the fallback table)
bun test                # parser parity fixtures + route tests
bun run check           # biome
bun run typecheck
bun run build:wasm          # rebuild query-engine wasm after touching Rust
bun run build:wasm-import   # rebuild import wasm after touching Rust
bun run cf-typegen      # regenerate worker-configuration.d.ts after wrangler.jsonc changes
```

Local dev is production-identical: the import that seeds your local D1 is the
same Durable Object pipeline production runs, executed by wrangler dev's local
emulator. The end-to-end of that pipeline against a corpus-scale fake Scryfall
is exercised by `engine/wasm-import/driver.ts` (see RESULTS.md for the
native-vs-wasm parity gates).

## Benchmarks

Same 10 queries against this deployment, upstream's own
[sylvan-librarian.com](https://sylvan-librarian.com), and the
[Scryfall API](https://api.scryfall.com) (2026-08-07, single residential
vantage in Southern California; measured on the R2-era build — the serving
path is unchanged by the D1 migration: same engine DOs, same edge cache, and
the store-distribution swap only affects rare version pulls). Per query: one
**cold** request (cache miss) then the median of two immediate **warm**
repeats; all services keep their production caching. Each service is measured
over one reused HTTP/2 connection. Times are total wall-clock request ms,
door to door.

Reproduce it yourself (only needs curl):

```bash
scripts/bench.sh results.tsv
```

**Headline (medians across the 10 queries):**

| | cold (cache miss) | warm (repeat) | payload |
|---|---|---|---|
| **this port (Cloudflare)** | **30ms** | **29ms** | **~34 KB** |
| Scryfall API | 56ms — 1.9× slower | 56ms — 1.9× slower | ~813 KB — 24× larger |
| sylvan-librarian.com | 106ms — 3.5× slower | 107ms — 3.7× slower | ~34 KB |

Worst single request: **this port (Cloudflare) 106ms** · Scryfall 323ms · upstream 434ms.

## License

Upstream sylvan_librarian is ISC-licensed (© Joseph Bylund) — see
[vendor/sylvan_librarian/LICENSE](vendor/sylvan_librarian/LICENSE). This port
keeps that license for all vendored and derived code.
