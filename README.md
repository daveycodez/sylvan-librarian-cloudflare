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
   the bucket name) under Worker → Settings → Variables.
3. Deploy, then open the Worker's URL. The first request bootstraps the card
   index: an import container streams Scryfall bulk data, builds the engine
   store (~70MB), and publishes it to R2 with a version manifest. The page
   shows build progress until the index is live (a few minutes), then the full
   UI works. A nightly cron (11:17 UTC, after Scryfall's bulk refresh) rebuilds
   the store; Worker isolates hot-swap to the new version without dropping
   queries.

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

## Development

```bash
bun install
bun run build:wasm      # wasm engine → engine/wasm/pkg (needs rust + wasm-pack)
bun run dev             # wrangler dev with local simulated R2
bun test                # parser parity fixtures + route tests
bun run check           # biome
bun run typecheck
```

To seed local R2 with a store without waiting for the container flow:

```bash
bun run build:builder
./target/release/sylvan-store-builder --out store-build/   # fetches Scryfall bulk
bunx wrangler r2 object put sylvan-librarian/manifest.json --local --file store-build/manifest.json
bunx wrangler r2 object put "sylvan-librarian/$(python3 -c "import json;print(json.load(open('store-build/manifest.json'))['store_key'])")" --local --file store-build/cards.store
```

## License

Upstream sylvan_librarian is ISC-licensed (© Joseph Bylund) — see
[vendor/sylvan_librarian/LICENSE](vendor/sylvan_librarian/LICENSE). This port
keeps that license for all vendored and derived code.
