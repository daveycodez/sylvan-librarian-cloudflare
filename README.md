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
        │   hits skip the Worker, and its cold starts, entirely)
        └─▶ Worker isolate (auto-scales horizontally with load)
              ├─ TS parser: Scryfall syntax → filter tree  (port of hand_parser.py)
              ├─ wasm card_engine: evaluates tree against the in-memory store
              ├─ store: ~70MB rkyv archive, loaded per-isolate from R2 (Cache API),
              │         hot-swapped when the R2 manifest advances
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

Cold-start note: the store is published gzipped (~2.5x smaller) and streamed
through `DecompressionStream` into a wasm buffer preallocated from the
manifest's `store_bytes`, cutting the one-time cold-isolate store load to
well under a second in-region.

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
seconds, payload bytes. Numbers below predate the gzipped-store cold-start
work, so a rerun should beat the cold column.

| query | this port (cold/warm) | sylvan-librarian.com | Scryfall API |
|---|---|---|---|
| `t:goblin cmc<3 c:r` | 3554 / 56 | 377 / 393 | 913 / 96 |
| `o:"draw a card" t:creature f:modern` | 1680 / 52 | 463 / 465 | 1164 / 97 |
| `kw:flying pow>=4 -c:w` | 50 / 50 | 455 / 457 | 94 / 120 |
| `t:instant cmc=1 c:u` | 2132 / 47 | 387 / 381 | 651 / 96 |
| `t:legendary t:elf f:commander` | 3531 / 48 | 466 / 463 | 1145 / 93 |
| `o:"enters tapped" t:land` | 1906 / 59 | 381 / 383 | 1117 / 94 |
| `c:wu t:bird` | 3215 / 55 | 403 / 374 | 350 / 93 |
| `r:mythic t:dragon cmc<=4` | 55 / 49 | 368 / 367 | 73 / 89 |
| `t:planeswalker c:b f:pioneer` | 113 / 54 | 394 / 375 | 851 / 78 |
| `t:instant o:damage cmc=1` | 1336 / 54 | 383 / 382 | 575 / 85 |
| **median** | **1793 / 53** | **391 / 382** | **751 / 94** |
| median payload | ~34 KB | ~34 KB | ~813 KB |

Reading the numbers honestly:

- **Warm (the common case): 53ms** — network round-trip to the nearest
  Cloudflare colo, since edge cache hits and warm-isolate engine queries
  (0.2–3ms of compute) are both effectively free. ~7× upstream, ~2× Scryfall's
  CDN-warm, with 24× less payload than Scryfall's full card objects.
- **Our cold column is bimodal**: 50–113ms when the request reaches an
  already-warm isolate, 1.3–3.5s when it lands on a cold one and pays the
  one-time ~70MB store load from R2. Real traffic keeps isolates warm and
  Workers Cache absorbs repeats, so this cost concentrates on the first
  request per colo after idle — but it is the architecture's honest trade.
- **Upstream is impressively consistent** (~370–460ms always): a single
  always-warm origin, so no cold starts ever — and no edge, so no 53ms
  either. The two architectures trade tails for medians.

## License

Upstream sylvan_librarian is ISC-licensed (© Joseph Bylund) — see
[vendor/sylvan_librarian/LICENSE](vendor/sylvan_librarian/LICENSE). This port
keeps that license for all vendored and derived code.
