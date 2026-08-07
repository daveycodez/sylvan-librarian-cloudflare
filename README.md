# sylvan-librarian-cloudflare

**Live demo: [sylvan-librarian.deckgen.workers.dev](https://sylvan-librarian.deckgen.workers.dev)**

[Sylvan Librarian](https://github.com/jbylund/sylvan_librarian) — a Magic: the
Gathering card search engine — ported to run **entirely on Cloudflare**:
Workers (serving), R2 (the card index), and a Container (data imports). No VPS,
no Postgres, no external infrastructure of any kind.

A faithful mirror of upstream's user-facing surface: the web UI, `/search`
(full Scryfall-style query syntax via the same Rust engine, compiled to wasm),
`/card`, `/get_catalog`, `/random_search`, and all static assets. No additions.

## Deploy

1. Cloudflare dashboard → Workers → Create → connect this git repository
   (Workers Builds). The build compiles the wasm engine and the import
   container image automatically.
2. Set the variables listed in [.env.example](.env.example) (three R2 secrets +
   the bucket name) under Worker → Settings → Variables and Secrets — these are
   **runtime Worker secrets only**; nothing needs to be set as a *build*
   variable (the build reads no secrets). Serving needs only the R2 *binding* —
   the three secrets are used exclusively by the import container, so if
   they're missing the symptom is a failed import run (loud, in the container
   logs), never a dead site.
3. Deploy, then open the Worker's URL. The first request bootstraps the card
   index: an import container streams Scryfall bulk data, builds the engine
   store (~70MB), and publishes it to R2 with a version manifest. The page
   shows build progress until the index is live (a few minutes), then the full
   UI works. A nightly cron (11:17 UTC, after Scryfall's bulk refresh) rebuilds
   the store; Worker isolates hot-swap to the new version without dropping
   queries.

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
              │   never wait on R2, hot-swapped when the R2 manifest advances
              └─ UI: upstream's static assets, served with upstream's cache headers

cron (nightly) / first-deploy bootstrap
        ──▶ ImportCoordinator (container-enabled Durable Object, serializes runs)
              └─ Container: native Rust builder
                   Scryfall bulk stream → row transform (port of card_processing.py)
                   → oracle/art tags → rkyv store build (upstream's own code)
                   → multipart upload to R2 + manifest
```

Queries the engine cannot answer return a structured error — never silently
empty. Upstream's Postgres-only admin/import endpoints return `501` here; the
container pipeline replaces them.

Caching notes: `/search` caches for 90s + a day of stale-while-revalidate
(nightly imports need no purge — staleness is bounded by one import cycle and
refreshes happen in the background), page HTML carries no card data
(client-side fetches stay fresh), `no-store` routes (`/random_search`, the
bootstrap page) and error statuses are never cached, and the cache is
per-deploy-version so releases can't serve stale assets.

Cold-start note: users never wait on a store wake. A colo whose DO has
evicted relays the query to the region's DO (engine-wnam, ...) while
waking itself in the background — the store loads from the DO's local
SQLite (never R2), and the wake duration is logged (`SearchEngine wake:
...`). Warm queries are sub-ms of DO CPU. The store is stored raw,
deliberately: R2 egress to Workers is free while decompress CPU would be
metered on every load.

## Upstream tracking

Upstream is vendored at the commit pinned in [UPSTREAM.lock](UPSTREAM.lock).
The Rust engine (`vendor/sylvan_librarian/card_engine`) is upstream's own code
with a thin feature-gate patch (PyO3 optional, buffer-based store load for
wasm); the store build logic, filter evaluation, and archive format are
untouched, so a store built by the container is byte-compatible with the wasm
engine by construction.

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

- **No silent SQL fallback**: where upstream quietly falls back to Postgres
  when the engine declines a query, this port returns a structured error.
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
  token bucket in a tiny per-IP Durable Object (the pattern from Cloudflare's
  rules-of-durable-objects docs), created with a location hint in the
  region the IP's traffic comes from — globally exact, unlike the Workers
  rate-limiting binding, whose eventually-consistent counters we measured
  barely enforcing. Default 100 requests/10s per IP, 429 + `Retry-After`
  when exceeded. **Enforcement is asynchronous and costs zero request
  latency**: requests are served immediately while the check reports in the
  background; an over-limit verdict blocks the IP from the next request
  onward, answered from isolate memory (a fresh burst gets a brief grace —
  measured: blocking began mid-burst). **Off by default** — opt in with
  `RATE_LIMIT_ENABLED=true` (runtime var, no redeploy); `RATE_LIMIT_PER_10S`
  tunes the allowance. Cache hits never count (served before the Worker
  runs), so repeat queries and crowds behind shared IPs are unaffected.
  Server-to-server callers bypass with the optional `TRUSTED_API_KEY` secret
  + `x-sylvan-api-key` header (see .env.example). The `x-sylvan-rl` response
  header reports the limiter's verdict. This caps engine/CPU abuse; blocking
  a mega-flood's per-invocation fees still needs zone WAF rules on a custom
  domain — the layers compose.
- Postgres-only admin/import routes answer `501`; the container pipeline is
  their replacement. `get_pid` returns `0` (isolates have no pid).
- `card_is_tags` stays empty, matching upstream's *automated* import (upstream
  only fills it via a manual admin route).
- HTML minification is off (upstream's own default configuration).
- Engine timing fields read `0` on wasm (Workers freeze clocks during CPU work).

## Development

Prerequisites: [bun](https://bun.sh), and a Rust toolchain (1.88+) for the
store builder that `bun dev`'s first run compiles. Touching the Rust engine
additionally needs `wasm-pack` + the `wasm32-unknown-unknown` target
(`bun run build:wasm` — the built pkg is committed, so TS-only work never
needs Rust). Regenerating parser fixtures (`scripts/export-parser-fixtures.py`)
needs `python3`.

```bash
bun install
bun dev                 # full site at localhost — UI, /search, everything.
                        # First run auto-builds the card store from Scryfall
                        # bulk data (a few minutes), mirroring production's
                        # first-boot bootstrap; later runs start instantly.
bun test                # parser parity fixtures + route tests
bun run check           # biome
bun run typecheck
bun run build:wasm      # rebuild wasm engine after touching Rust (pkg is committed)
bun run seed:local      # rebuild/refresh the local store on demand
bun run cf-typegen      # regenerate worker-configuration.d.ts after wrangler.jsonc changes
```

Local dev matches production behavior with one substitution: the store build
runs as a native binary instead of inside a Cloudflare Container (wrangler dev
would need a local Docker daemon to emulate the container; it is the same
builder code either way). The container path itself is exercised in production.

## Benchmarks

Same 10 queries against this deployment, upstream's own
[sylvan-librarian.com](https://sylvan-librarian.com), and the
[Scryfall API](https://api.scryfall.com) (2026-08-07, single residential
vantage in Southern California). Per query: one **cold** request (cache miss) then the median of two
immediate **warm** repeats; all services keep their production caching —
that's the point. Each service is measured over one reused HTTP/2 connection,
the way a browser behaves (an earlier revision of this harness paid a fresh
TLS handshake per request, which unfairly penalized the distant single-origin
upstream by ~300ms — spotted because the upstream site *felt* faster than the
table claimed). Scryfall requests are rate-limited to 1/s per their
etiquette. Times are **total wall-clock request ms, door to door** — network
round trip included, as a user experiences it. (Not to be confused with the
server-side "completed in Xms" the UI displays, which is the engine's
self-reported processing time from inside the response — every service here
computes in single-digit ms; the table measures who's *near you* too.)

Reproduce it yourself (only needs curl):

```bash
scripts/bench.sh results.tsv
```

The TSV columns are service, query, run, HTTP status, total seconds, TTFB
seconds, payload bytes. Expect meaningful cross-run variance in cold columns
for every service — they measure whatever cache/isolate state each provider
happens to be in (an earlier run of this same table caught Scryfall's CDN
cold at ~751ms median where this run found it warm at 99ms).

**Headline (medians across the 10 queries):**

| | cold (cache miss) | warm (repeat) | payload |
|---|---|---|---|
| **this port (Cloudflare)** | **22ms** | **20ms** | **~34 KB** |
| sylvan-librarian.com | 103ms — 4.7× slower | 100ms — 5× slower | ~34 KB |
| Scryfall API | 30ms — 1.4× slower | 31ms — 1.6× slower | ~813 KB — 24× larger |

Worst single request: **this port (Cloudflare) 54ms** · upstream 402ms · Scryfall 85ms.

<details open>
<summary>Per-query results (cold / warm, ms)</summary>

| query | this port (Cloudflare) | sylvan-librarian.com | Scryfall API |
|---|---|---|---|
| `t:goblin cmc<3 c:r` | 54 / 18 | 402 / 98 | 85 / 36 |
| `o:"draw a card" t:creature f:modern` | 19 / 21 | 101 / 99 | 26 / 38 |
| `kw:flying pow>=4 -c:w` | 19 / 20 | 102 / 103 | 30 / 33 |
| `t:instant cmc=1 c:u` | 24 / 19 | 103 / 100 | 31 / 29 |
| `t:legendary t:elf f:commander` | 22 / 21 | 103 / 101 | 29 / 28 |
| `o:"enters tapped" t:land` | 21 / 21 | 104 / 99 | 27 / 38 |
| `c:wu t:bird` | 23 / 20 | 102 / 97 | 36 / 24 |
| `r:mythic t:dragon cmc<=4` | 22 / 22 | 103 / 96 | 26 / 21 |
| `t:planeswalker c:b f:pioneer` | 25 / 19 | 103 / 101 | 28 / 22 |
| `t:instant o:damage cmc=1` | 19 / 20 | 105 / 103 | 32 / 35 |

</details>

Reading the numbers honestly:

- **~20ms flat** — one round-trip to the nearest Cloudflare colo; edge cache
  hits and warm-engine queries (0.2–3ms of compute) are both effectively
  free, so cold and warm are indistinguishable. 24× less payload than
  Scryfall's full card objects.
- **No cold tail**: a cache-miss on a cold isolate is answered by the
  regional warm-engine Durable Object while the isolate warms in the
  background — the worst cell in the table is 54ms. Before the hybrid, the
  same probe showed 1.3–3.5s spikes whenever a request landed on a cold
  machine.
- **Upstream's honest number is ~100ms** — a single always-warm origin, so
  never a cold start, but every request pays the trip to that one origin
  (plus a first-connection handshake, visible in its 402ms worst cell).
- Scryfall's numbers are its CDN serving cached responses (fast and steady);
  ours are live engine computation per cache-miss. We edge it on both
  columns from this vantage, but their API serves a far richer card object.

## License

Upstream sylvan_librarian is ISC-licensed (© Joseph Bylund) — see
[vendor/sylvan_librarian/LICENSE](vendor/sylvan_librarian/LICENSE). This port
keeps that license for all vendored and derived code.
