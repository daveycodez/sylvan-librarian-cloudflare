# sylvan-librarian-cloudflare

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

The page title derives from the hostname (upstream's `hostname_to_site_name`),
so a `*.workers.dev` deployment titles itself "Workers" — point a custom domain
at the Worker and the title follows it.

## Architecture

```
request ──▶ Worker isolate (auto-scales horizontally with load)
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

## License

Upstream sylvan_librarian is ISC-licensed (© Joseph Bylund) — see
[vendor/sylvan_librarian/LICENSE](vendor/sylvan_librarian/LICENSE). This port
keeps that license for all vendored and derived code.
