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
        └─▶ Worker isolate (auto-scales horizontally with load)
              ├─ TS parser: Scryfall syntax → filter tree  (port of hand_parser.py)
              ├─ wasm card_engine: evaluates tree against the in-memory store
              ├─ store: ~70MB rkyv archive, loaded per-isolate from R2 (Cache API),
              │         hot-swapped when the R2 manifest advances
              ├─ COLD isolate: forwards to the region's SearchEngine Durable
              │   Object (one per continent, session-warm, store persisted in
              │   its embedded SQLite so wake-ups never wait on R2) while the
              │   isolate warms itself in the background — the x-sylvan-engine
              │   response header says which path answered (isolate | do-<region>)
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

Cold-start note: cold isolates never make users wait on a store load — the
request is served by the regional warm-engine DO (~100-200ms) while the
isolate loads in the background. The store is stored raw, deliberately: R2
egress to Workers is free while decompress CPU would be metered on every
isolate warm-up.

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
[Scryfall API](https://api.scryfall.com) (2026-08-07, single US residential
vantage). Per query: one **cold** request (cache miss) then the median of two
immediate **warm** repeats; all services keep their production caching —
that's the point. Scryfall requests spaced 600ms per their rate etiquette.
Times are total request ms.

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
| **this port (Cloudflare)** | **111ms** | **57ms** | **~34 KB** |
| sylvan-librarian.com | 397ms — 3.6× slower | 381ms — 6.7× slower | ~34 KB |
| Scryfall API | 87ms — 1.3× faster | 89ms — 1.6× slower | ~813 KB — 24× larger |

Worst single request: **this port (Cloudflare) 164ms** · upstream 594ms · Scryfall 128ms.

<details open>
<summary>Per-query results (cold / warm, ms)</summary>

| query | this port (Cloudflare) | sylvan-librarian.com | Scryfall API |
|---|---|---|---|
| `t:goblin cmc<3 c:r` | 164 / 58 | 594 / 423 | 128 / 99 |
| `o:"draw a card" t:creature f:modern` | 117 / 51 | 467 / 460 | 84 / 88 |
| `kw:flying pow>=4 -c:w` | 113 / 56 | 451 / 458 | 114 / 80 |
| `t:instant cmc=1 c:u` | 137 / 61 | 408 / 379 | 103 / 103 |
| `t:legendary t:elf f:commander` | 99 / 52 | 465 / 465 | 118 / 102 |
| `o:"enters tapped" t:land` | 107 / 46 | 387 / 383 | 88 / 97 |
| `c:wu t:bird` | 101 / 52 | 380 / 370 | 71 / 75 |
| `r:mythic t:dragon cmc<=4` | 80 / 66 | 364 / 364 | 70 / 66 |
| `t:planeswalker c:b f:pioneer` | 109 / 64 | 382 / 372 | 74 / 81 |
| `t:instant o:damage cmc=1` | 148 / 99 | 381 / 376 | 86 / 90 |

</details>

Reading the numbers honestly:

- **Warm (the common case): ~57ms** — network round-trip to the nearest
  Cloudflare colo, since edge cache hits and warm-isolate engine queries
  (0.2–3ms of compute) are both effectively free. ~7× upstream, with 24× less
  payload than Scryfall's full card objects.
- **No cold tail**: a cache-miss on a cold isolate is answered by the
  regional warm-engine Durable Object (~100–200ms) while the isolate warms in
  the background — the worst cell in the table above is 164ms. Before the
  hybrid, the same probe showed 1.3–3.5s spikes whenever a request landed on
  a cold machine.
- **Upstream is impressively consistent** (~360–600ms): a single always-warm
  origin, so it never cold-starts — but every request pays the trip to that
  one origin, which is why the hybrid's worst case now beats upstream's best.
- Scryfall's numbers are its CDN serving cached responses (fast and steady);
  ours are live engine computation per cache-miss. Comparable feel, different
  mechanics.

## License

Upstream sylvan_librarian is ISC-licensed (© Joseph Bylund) — see
[vendor/sylvan_librarian/LICENSE](vendor/sylvan_librarian/LICENSE). This port
keeps that license for all vendored and derived code.
