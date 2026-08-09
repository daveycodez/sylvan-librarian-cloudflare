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
request ──▶ Workers Cache (regional edge cache; hits skip the Worker entirely)
        └─▶ Worker isolate (thin: parses, RPCs, serves static assets)
              ├─ TS parser: Scryfall syntax → filter tree (port of hand_parser.py)
              ├─ engine queries: RPC to the colo's SearchEngine Durable Object
              │   (engine-<colo>, created in the colo that first names it), so
              │   sharding tracks the traffic distribution and idle colos evict
              │   their DO — scale to zero. The x-sylvan-engine response header
              │   says which DO answered
              ├─ SearchEngine DO: wasm card_engine + ~70MB rkyv store in memory,
              │   streamed from KV as 3 immutable chunks; no local copy, and it
              │   hot-swaps when the KV manifest advances
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
page HTML carries no card data; `no-store` routes and error statuses are never
cached; the cache is per-deploy-version.

**Free-plan fit.** A store load is 4 KV reads, a publish 4 writes, and serving
touches neither — so the daily meters (100k Worker requests, 100k KV reads, 1k
KV writes) bound *traffic*, not architecture. Storage is one ~70MB copy per
retained version against KV's 1GB. The one meter worth watching is the free
plan's **10ms CPU per request**: a cache-missing `/search` currently spends
6–11ms in the isolate, almost all of it marshalling the ~34KB response rather
than computing it (the engine itself is 0–1ms of DO CPU).

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

## Deviations from upstream

Everything user-visible mirrors upstream byte-for-byte (the parser is gated on
100% tree agreement with the Python parser across upstream's own test corpus).
The complete list of intentional differences:

- **No SQL fallback.** Upstream quietly falls back to Postgres when the engine
  declines a query; the wasm engine is the only path here, so an engine
  failure is a loud 500 rather than a silently different answer.
- **Fixed site title**: pages always say "Sylvan Librarian" instead of
  upstream's hostname-derived name. The derivation port stays tested in
  `src/routes/site-name.ts`.
- **`stale-while-revalidate=86400` on search responses**, so repeat queries
  never pay a cold start. Upstream sends plain `max-age=90`.
- **Built-in per-IP rate limit** on the engine routes: a token bucket in a
  tiny per-IP Durable Object, default 100 requests/10s, 429 + `Retry-After`.
  Enforcement is asynchronous and costs zero request latency. **Off by
  default** — see .env.example, including the `TRUSTED_API_KEY` bypass. Cache
  hits never count.
- Postgres-only admin/import routes answer `501`. `get_pid` returns `0`.
- `card_is_tags` stays empty, matching upstream's *automated* import.
- HTML minification is off (upstream's own default).
- Engine timing fields read `0` on wasm (Workers freeze clocks during CPU work).

## Development

Prerequisites: [bun](https://bun.sh). Both wasm modules are committed
prebuilt, so TS work needs nothing else. Touching Rust needs a toolchain
(1.88+) with `wasm32-unknown-unknown`; regenerating parser fixtures needs
`python3`.

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
| **this port (Cloudflare)** | **30ms** | **29ms** | **~34 KB** |
| Scryfall API | 56ms — 1.9× slower | 56ms — 1.9× slower | ~813 KB — 24× larger |
| sylvan-librarian.com | 106ms — 3.5× slower | 107ms — 3.7× slower | ~34 KB |

Worst single request: **this port 106ms** · Scryfall 323ms · upstream 434ms.

Measured before the KV migration; the serving path is unchanged by it (same
engine DOs, same edge cache), which only affects version pulls.

## License

Upstream sylvan_librarian is ISC-licensed (© Joseph Bylund) — see
[vendor/sylvan_librarian/LICENSE](vendor/sylvan_librarian/LICENSE). This port
keeps that license for all vendored and derived code.
