# Browser Engine — shipping the card store to the client as an npm package

Status: **proposal, nothing built.** Written 2026-08-11. Numbers marked *measured* were taken against real artifacts on this machine; numbers marked *estimated* are arithmetic on top of them and are only as good as the stated assumptions.

The idea: an npm package that answers Scryfall-compatible card queries on the client. It starts by proxying to this port's HTTP API, downloads the compiled store in the background, and once the store is resident it answers every subsequent query from wasm in the tab — no network, no cap, no round trip.

Two targets, sharing one engine. On the **web** the network is assumed present and is the fallback for everything that can go wrong. In a **packaged app** (Capacitor, Electron) it is assumed absent: the store ships inside the bundle, initialization happens at boot before any query runs, and there is no remote to fall back to. §8.2 covers the second; everything before it describes the first.

---

## 1. Verdict

**Worth building.** Three things make it unusually tractable, and they are not the obvious ones.

**The engine is already a browser target.** `engine/wasm/pkg` is built with `wasm-pack --target bundler`, which is a browser target — `src/engine/wasm-shim.ts` exists only because workerd's `CompiledWasm` rule hands back a `Module` instead of instantiated exports, a problem a browser bundler does not have. No new build, no new crate.

**The parity risk is structural, not behavioural.** Local and remote are not two implementations that have to agree. They are the same wasm module, the same store bytes, and the same `src/parser` TypeScript producing the same filter tree. The only way they diverge is *version skew*, which is detectable at load time and gated on. That is a much stronger position than any dual-backend design normally gets.

**The interface already exists.** `EngineApi` in `src/engine/types.ts` defines the full surface — `search`, `searchSerialized`, `scryfallSearch`, `scryfallCardById`, `scryfallFuzzyName`, `scryfallAutocomplete`, and the rest. `RemoteEngine` (`src/engine/remote-engine.ts`) already implements it over RPC. The browser package is a *third* implementation of the same interface, and its remote phase is nearly the shape `RemoteEngine` already has. The abstraction this needs was drawn a while ago for a different reason.

### What it actually buys

The measured API latency for an uncached query is **177–298 ms TTFB** against **61–104 ms warm** (*measured*, from a laptop, so absolute numbers include client network latency — the ~100–200 ms delta is the server-side cost). A local query is sub-millisecond. That difference is the entire argument for search-as-you-type and for interactive refinement.

It also deletes result truncation. Any client that paginates the API caps itself somewhere — a broad-but-structured query like `c:w` matches 7,037 cards, and a UI showing 175-card pages shows an arbitrary slice of a popularity-ordered list because moving card JSON costs something. Locally it costs nothing, so completeness stops being a budget decision.

### The honest risks

| Risk | Severity | Mitigation |
|---|---|---|
| Version skew makes local and remote disagree silently | **High** | Hard compatibility gate, §10 |
| 76–91 MB of linear memory *per tab* | **High** | SharedWorker, §5.3 |
| Parser and store generation drift apart | Medium | Lockstep versioning + parity CI, §11 |
| Storage eviction (Safari/iOS especially) | Medium | Always degrade to remote, §13 |
| `finish_store_load` validation cost is unmeasured | Medium | Measure before committing to a warm-up budget, §15 |
| 28 MB download on a phone | Low–Medium | Deferred trigger, `saveData` respect, §8.1 |

None of these is disqualifying. The first two are design constraints that shape the package; the rest are degradation paths.

---

## 2. The numbers

All against `store-build/card-store-v2026081102-*` (content generation 10, format 2026081102).

### Artifact sizes

| Artifact | Raw | gzip -9 | brotli q6 | brotli q11 |
|---|---:|---:|---:|---:|
| Search store | 76,636,456 | 30,790,072 | 24,385,474 | 20,392,105 |
| Residue archive | 11,839,272 | not measured | not measured | 3,209,163 |

*Measured.* Compression time for the search store: gzip -9 8.5 s, brotli q6 1.8 s, brotli q11 101.6 s (M-series Mac).

Decompression to the full 76,636,456 bytes, native, three runs: brotli q6 **0.18 / 0.17 / 0.14 s** (~480 MB/s); gzip -9 **0.08 / 0.09 / 0.09 s** (~880 MB/s). *Measured.*

**Brotli for the browser.** The browser decompresses `Content-Encoding: br` in its own native decoder during the fetch — no JS, no `DecompressionStream`, no intermediate buffer. Brotli's ~2× decompression cost lands on a client with CPU to spare, and buys 6.4 MB less over the wire. (This is the opposite of the right answer for the Durable Object, where `DecompressionStream` is gzip-only and CPU is the constrained resource. See the separate backend evaluation.)

### Download budget

A consumer that uses the `/cards/*` Scryfall card-object surface needs the residue archive as well as the search store; one that only searches does not.

| Surface | Compressed download | Linear memory |
|---|---:|---:|
| Search only | ~24.4 MB | **79.30 MB** |
| Search + `/cards/*` card objects | ~28 MB (*estimated*, residue q6 unmeasured) | **91.16 MB** |

Linear memory figures are *measured*, from `CARD-PARTITIONING.md` §1, by reading `WebAssembly.Memory.buffer.byteLength` after load.

### Time to usable (*estimated*)

| Stage | 100 Mbps | 25 Mbps | Notes |
|---|---:|---:|---|
| Download 28 MB | ~2.3 s | ~9 s | Parallel with remote-phase queries |
| Native brotli decompress | ~0.2 s | ~0.2 s | Streaming, overlaps download |
| `store_load_chunk` memcpy | ~0.05 s | ~0.05 s | 88 MB of copies |
| `finish_store_load` validation | **unknown** | **unknown** | §15 — the one real gap |
| wasm instantiate | ~0.02 s | ~0.02 s | 1.9 MB module |

Everything except validation is small or overlapped. Validation is the number that decides whether warm-up is "a few seconds" or "unpleasant," and it is measurable outside a browser entirely.

---

## 3. Naming

**Recommended: `sylvan-browser`**, one package, with subpath exports.

```
sylvan-browser           core, framework-agnostic
sylvan-browser/react     TanStack Query bindings
sylvan-browser/worker    worker entry (referenced, not usually imported)
```

One package rather than two: subpath exports give the same peer-dependency isolation and lazy-chunk boundaries as a split, without a second release to keep in version lockstep with the first — and lockstep is already load-bearing here (§10).

### On the `sylvan-librarian-*` shape

Worth being deliberate. Upstream is `jbylund/sylvan_librarian`, and `sylvan-librarian.com` is jbylund's deployment, not this one. Publishing `sylvan-librarian-client` to npm claims the upstream project's full name for a package upstream did not write and does not maintain. `sylvan-browser` keeps the lineage legible without implying endorsement — and the README should say plainly what it is a port of.

| Alternative | Read |
|---|---|
| `sylvan-browser` | **Recommended.** Says what it does, does not claim upstream's name |
| `@sylvan/browser` | Cleaner if the scope is available; check first |
| `sylvan-librarian-client` | Implies upstream ownership; avoid |
| `scryfall-local` | Leans on Scryfall's trademark instead — worse, not better |
| `sylvan-wasm` | Names the implementation rather than the capability; ages badly |

---

## 4. What the package is not

It does not build stores — that is the nightly importer's job. It does not serve them — that is this Worker's job (§7). It does not interpret natural language; a consumer doing that keeps it server-side and hands this package a finished query string.

It is one thing: **a Scryfall-compatible query surface that migrates itself from remote to local.**

---

## 5. Architecture

### 5.1 Three states

```
  remote ──────────► hydrating ──────────► local
     │                    │                   │
     │  every query       │  every query      │  every query
     │  over HTTP         │  over HTTP        │  in wasm
     │                    │  + download       │
     └────────────────────┴───────────────────┘
              any failure falls back to remote, permanently or with retry
```

`remote` is the initial and the fallback state. `hydrating` is indistinguishable from `remote` to the caller — the transition to `local` is the only observable event, and even that should not change any answer (§11).

Under `offline-first` (§8.2) the same machine runs with the first state removed: startup goes straight to `hydrating`, queries arriving there await `ready()` rather than proxying, and a failure is terminal instead of a fallback.

### 5.2 Where code runs

| Component | Thread | Loaded |
|---|---|---|
| Query router, state machine, TanStack bindings | Main | Eagerly (small) |
| Parser (`src/parser` port) | Worker | With the engine chunk |
| wasm engine + store | Worker | Lazily, on hydration |
| Cache Storage I/O | Worker | With the engine chunk |

The 1.9 MB wasm module must not be in the main bundle. It is behind a dynamic `import()` that only runs when hydration starts, so a consumer who never hydrates pays only for the router.

The parser runs in the worker, not the main thread: the main thread posts the raw query string across and receives results. That keeps one parser instance, keeps `tag-aliases.gen.ts` out of the main bundle, and makes the worker boundary the same shape as the HTTP boundary — a string in, results out.

### 5.3 SharedWorker, not Worker

**This is the design decision most likely to be got wrong.** A dedicated Worker per tab means 91 MB of linear memory per tab. Three tabs is 273 MB, which on a mid-range phone is a tab kill.

Use a `SharedWorker` so all same-origin tabs share one engine instance and one copy of the store. Download and hydration happen once per browser, not once per tab.

Fall back to a dedicated `Worker` where `SharedWorker` is unavailable, and in that mode default hydration to off — a per-tab 91 MB copy should be something the consumer opts into explicitly, not something they get by default because of a capability check they never saw.

The exception is embedded targets (§8.2), which are single-window: there the dedicated Worker is the expected path, not a degraded one, and hydration stays on.

### 5.4 Interface symmetry

The package's local engine implements the same `EngineApi` shape as `src/engine/types.ts`. This is worth preserving rather than inventing a new surface, because it means:

- the remote implementation is close to the existing `RemoteEngine`;
- the parity harness (§11) can drive both through one interface;
- a method added server-side has an obvious client-side home.

Where the shapes must differ, differ deliberately and write down why. `baseUrl` threading in the `scryfall*` methods is one such place — the browser knows its own origin, the DO does not.

---

## 6. Query routing

Every call goes through one router:

```
query(q, opts)
  ├─ state === "local"  → worker.query(q, opts)     sub-ms
  └─ otherwise          → fetch(endpoint + path)     ~60–300 ms
```

The router owns two things the caller never sees.

**One canonical field set.** `query_rows` takes `fields_json`; the HTTP API returns whatever its route decides. If those differ, the two phases return different objects and the transition is visible. The package defines the field set once and sends it on both paths.

**One canonical URL builder.** The HTTP phase must emit byte-identical URLs to anything else hitting the same API, because the Workers Cache in front of this port keys on the raw query string with no `Vary` header. Two spellings of one query are two cache entries. A shared builder makes SSR renders and client fetches warm the same entries.

---

## 7. Server contract

Two new routes on this Worker. Neither exists yet.

### `GET /store/manifest`

Small JSON, short TTL. The one mutable pointer.

```jsonc
{
  "store_key": "card-store-v2026081102-1786449226",
  "built_at": "2026-08-11T04:53:00Z",
  "format_version": 2026081102,     // must equal wasm store_version()
  "content_generation": 10,         // must equal the package's pinned generation
  "store_bytes": 76636456,          // DECOMPRESSED — begin_store_load needs this
  "store_url": "/store/card-store-v2026081102-1786449226.br",
  "store_compressed_bytes": 24385474,
  "compat_key": "card-compat-v2026081102-1786452390",
  "compat_bytes": 11839272,
  "compat_url": "/store/card-compat-v2026081102-1786452390.br",
  "compat_compressed_bytes": 3209163,
  "card_count": 31724,
  "printing_count": 97803
}
```

Everything here except the three `*_url` and `*_compressed_bytes` fields already exists on `StoreManifest` in `src/engine/types.ts`. This route is mostly a projection of it.

`Cache-Control: public, max-age=300` — short enough that a nightly rebuild propagates within minutes, long enough that a page load does not always pay for it.

### `GET /store/<key>.br`

The compressed artifact, brotli q6.

```
Content-Encoding: br
Content-Type: application/octet-stream
Cache-Control: public, max-age=31536000, immutable
```

Keys are immutable — `store_key` already embeds format version and build timestamp, so a rebuild produces a new key and never invalidates an old URL. That is what makes `immutable` honest and lets both the HTTP cache and Cache Storage hold it indefinitely.

**Publishing.** brotli q6 is 1.8 s of compression, which likely fits an importer alarm; q11 is 101.6 s and certainly does not. If in-Worker compression turns out not to fit, compress out-of-band in CI against the published store and write the browser copy back under its own key — the browser artifact lagging the nightly by minutes is harmless, because the manifest is not updated until the artifact exists.

Note that the brotli store at 24,385,474 bytes fits in a **single KV value** (cap 26,214,400), so the browser copy needs none of the `splitStore` / `chunkKey` grid the raw store requires. One key, one read, one fetch.

---

## 8. Public API

```ts
import { createSylvanClient } from "sylvan-browser"

const sylvan = createSylvanClient({
  endpoint: "https://sylvan-librarian.daveycodez.workers.dev",

  // Default "web": assumes the API is reachable and degrades to it.
  // "offline-first" does not — see §8.2 for Capacitor / Electron.
  mode: "web" | "offline-first",

  // When to start downloading. Default "after-first-result" — see §8.1.
  hydrate: "after-first-result" | "eager" | "idle" | "manual" | false,

  // "search" skips the residue archive (~3.2 MB) and cannot answer /cards/*.
  surface: "search" | "full",

  // Cache Storage by default; "none" re-downloads every session. The
  // filesystem form is for packaged apps and is not evictable (§12).
  storage: "cache-api" | "none" | { type: "filesystem", path: string },

  // Refuse to hydrate on metered or slow connections. Default true.
  respectSaveData: boolean,
})

await sylvan.search("c:w t:creature", { order: "name", limit: 175 })
await sylvan.cardById(scryfallId)
await sylvan.autocomplete("light")
await sylvan.fuzzyName("lightning bolt")

sylvan.status          // "remote" | "hydrating" | "local" | "unavailable"
sylvan.progress        // 0..1 during hydrating, else null
sylvan.subscribe(fn)   // status/progress changes
await sylvan.hydrate() // start hydrating now; resolves local, rejects on failure
await sylvan.ready()   // resolves when queries can be answered at all (§8.2)
sylvan.unload()        // drop the store; returns to remote, or to hydrating
```

`search` resolves identically in every state. That is the contract, and §11 is how it is kept.

`hydrate()` and `ready()` differ by what they promise. `hydrate()` is about the *local* engine: it forces a download and resolves only on `local`. `ready()` is about answering *at all* — in `web` mode it resolves immediately, because `remote` already answers; under `offline-first` it is the boot gate, resolving when the store is resident and rejecting when it cannot be.

### 8.1 When hydration starts

The default is **`"after-first-result"`: hydration begins once the first query's response has resolved, deferred through `requestIdleCallback`** (with a timeout fallback for browsers that lack it, and for the case where the page never goes idle).

Both halves of that matter, and for different reasons.

**Waiting for the first response** avoids the obvious failure — a 28 MB download contending with the very query the user is waiting on. Hydrating eagerly on client construction makes the first answer slower, which is the one answer whose latency the user is definitely watching.

**Waiting for idle after that** avoids the less obvious one. A results page does not stop using the network when the JSON arrives; it starts pulling card images from Scryfall's CDN, potentially dozens of them. Firing the store download the instant the response resolves puts 28 MB in front of that queue and makes the page *look* slower even though its data arrived on time. Yielding to idle costs a second or two of hydration latency and buys back the visible part of the page load.

The trigger deliberately does **not** wait for a second query. Running a query at all is already the engagement signal — by the time someone types a second one they have been paying remote latency for the entire session, and hydration has not even begun. The bounce case that argues for waiting is real but cheap: egress is free on this platform, the download is idle-priority, and `respectSaveData` already excludes the connections where wasted bytes actually cost the user something.

The other three settings cover what the default cannot know:

| Setting | Starts | For |
|---|---|---|
| `"eager"` | At client construction, before any query | A consumer certain of engagement — a dedicated search page, or a session resuming from a cached store where hydration is nearly instant. Implied by `offline-first` |
| `"idle"` | First idle callback after load, without waiting for a query | Prefetching on a landing page that has not searched yet but is about to |
| `"manual"` | Only on `hydrate()` | A consumer putting it behind their own UI — a settings toggle, an "enable offline" button |
| `false` | Never | Remote only; useful for A/B and for debugging a parity failure |

### 8.2 Embedded and offline targets

Capacitor and Electron invert the central assumption. Everything above treats `remote` as the safe state that every failure degrades to; in a packaged app there may be **no network at all**, at any point, including first run. The fallback is the thing that is missing.

That is a distinct mode, not a tuning of the default:

```ts
const sylvan = createSylvanClient({
  mode: "offline-first",          // default "web"
  hydrate: "eager",               // implied by offline-first
  source: { type: "bundled", url: bundledStoreUrl },
  storage: { type: "filesystem", path: appDataPath },
  endpoint,                       // optional — update checks only
})

await sylvan.ready()              // call at app boot, before any query
```

**`ready()` is the initialization hook.** It resolves when the engine can answer queries and rejects if it cannot. An app calls it during startup — behind a splash screen, an Ionic app-launch lifecycle event, or Electron's `whenReady` — so the first query the user issues is already local.

Four things change under `offline-first`.

**Queries before ready queue, they do not proxy.** In `web` mode a query arriving during hydration goes over HTTP. Here it awaits `ready()` instead. Proxying to an endpoint that may be unreachable turns a two-second wait into a network timeout, and silently reintroduces a network dependency into an app that advertises working without one.

**The store should ship with the app.** `source: { type: "bundled" }` points at the compressed artifact packaged alongside — an `asar`-relative path in Electron, a public asset in Capacitor. First run then costs a local read and a decompress rather than a 28 MB download, and the app works offline from the moment it installs. The build pulls the artifact from `/store/<key>.br` at package time, which also pins the store generation at build time, where the §10 version gate becomes a build check rather than a runtime one.

28 MB clears every store limit comfortably (*verified 2026-08-11*):

| Limit | Value | 28 MB against it |
|---|---|---|
| iOS total uncompressed app size | 4 GB | 0.7% |
| iOS executable `__TEXT` sections | 80 MB | **does not apply** — a data resource is not linked into the executable |
| iOS cellular download threshold | 200 MB, user-overridable since iOS 13 | ~14%, non-blocking |
| Google Play AAB compressed download | 200 MB | ~14%, non-blocking warning only above it |

The 80 MB row is the one worth being explicit about, because it is the limit people find first and misread: it governs `__TEXT` in the compiled binary, not bundled resources. A `.br` file is a resource.

**Consider platform asset delivery instead of the bundle proper.** Both platforms have a mechanism built for exactly this shape — [Background Assets](https://developer.apple.com/documentation/backgroundassets) on iOS, [Play Asset Delivery](https://developer.android.com/guide/playcore/asset-delivery) with install-time or fast-follow on Android. Both keep the IPA/AAB small while still having the store present before first launch, and Background Assets can refresh independently of app releases. That last property matters here: a store baked into the binary goes stale at the app's release cadence, which for a nightly-rebuilt dataset means the `endpoint` update check below is doing the real work anyway. Asset delivery gets the freshness without the bundle weight, at the cost of platform-specific build integration.

**Storage is the filesystem, not Cache Storage.** Cache Storage is evictable by design and both runtimes will evict it under pressure — acceptable when the fallback is a re-download, unacceptable when there is no network. An app-data path is not evictable and survives across versions.

**`endpoint` becomes optional and means "update check".** With one configured, the client fetches `/store/manifest` opportunistically when the network is up, and downloads a newer artifact in the background to replace the bundled one. Without one, the app is pinned to whatever it shipped with — legitimate for a release-cadence app, and it should be an explicit choice rather than a silent consequence of the network being down.

One platform caveat: `SharedWorker` (§5.3) is well supported in Electron's renderer but unreliable in Capacitor's WKWebView on iOS. Embedded targets are usually single-window, so the per-tab memory argument that motivates it mostly does not apply — but the dedicated-Worker fallback should be the assumed path on iOS rather than a surprise.

---

## 9. React / TanStack layer

The elegant part of the original idea, preserved: **the query key does not change, the resolver underneath it does.**

```tsx
import { SylvanProvider, useCardSearch, useSylvanStatus } from "sylvan-browser/react"

<SylvanProvider client={sylvan}>
  <App />
</SylvanProvider>

function Results({ q }) {
  const { data, isPending } = useCardSearch(q, { order: "name" })
  const { status, progress } = useSylvanStatus()
  // ...
}
```

`useCardSearch` is a thin `useQuery` whose `queryFn` calls `sylvan.search`. Components never learn which phase served them.

**Do not invalidate on transition to local, by default.** If parity holds, re-resolving cached queries locally produces identical data and buys nothing but renders. New queries route locally on their own. Expose `revalidateOnReady: true` for the one case where it does matter — a consumer that deliberately wants the *uncapped* local result to replace a truncated remote one.

**SSR must no-op.** No wasm, no download, no Cache Storage on the server. `createSylvanClient` detects a non-browser environment and pins itself to `remote` permanently. This is required for any server-rendered consumer: SSR renders through the API, and the client hydrates afterward without the two disagreeing about which engine is live.

---

## 10. Version safety

Three things must agree before a single query is answered locally. Any mismatch means stay remote.

| Check | Source of truth | Failure mode if unchecked |
|---|---|---|
| `format_version` | manifest vs. wasm `store_version()` | `finish_store_load` rejects — loud, safe |
| `content_generation` | manifest vs. the package's pinned constant | **Store loads and answers differently — silent** |
| Parser generation | package's `tag-aliases.gen.ts` vs. store generation | **Wrong tag expansion — silent** |

The first is already enforced in the engine. The other two are not, and they are the dangerous ones, because a structurally-valid store from the wrong generation loads cleanly and returns wrong answers.

`STORE_CONTENT_GENERATION` history in `src/engine/store-kv.ts` shows exactly why. Generation 4 moved tag-alias resolution from the store into the parser; generation 5 merged card faces and changed which printing represents a multi-face card; generation 6 dropped memorabilia printings and changed which printing a price ordering returns. Every one of those is invisible to a header check and visible in results.

**So: the package pins a content generation, and refuses to go local against any other.** A store older or newer than its pin means stay remote and log once. This makes the package's release cadence coupled to the store's generation bumps, which is a real cost and the correct one — the alternative is a client that quietly disagrees with the server.

---

## 11. Parity

Parity is the product. If local and remote disagree, this package is worse than not existing, because the disagreement appears as the UI changing under a user who did nothing.

Ship a parity harness in the package and run it in this repo's CI:

- a fixed corpus of query strings — the existing parser fixtures under `tests/parser` are the obvious seed, spread deliberately across result-set sizes: narrow (tens of matches), middle (thousands), and broad-structured (`c:w`, `t:creature`, tens of thousands), since truncation and ordering bugs only surface at the top end;
- run each against both a local store and the deployed API;
- diff total counts first, then row-by-row on ids, then on the full field set;
- fail on any difference.

Two things this catches that nothing else does: a generation bump that changes representative printings, and a parser change that lands in the package but not the Worker (or the reverse).

Run it against the *deployed* API rather than a local Worker. The point is to catch skew between what the package ships and what production serves, and a local Worker is by construction in step with the package.

---

## 12. Storage

Two backends, chosen by target: **Cache Storage** on the web, **filesystem** for embedded (§8.2). The difference is eviction — Cache Storage is best-effort and the browser may reclaim it at any time, which is fine when the fallback is a re-download and unacceptable when there is no network.

Cache Storage is keyed by the artifact URL — which is immutable, so the key rotates automatically on a rebuild and stale entries become unreachable rather than wrong.

**Cache the compressed bytes, not the decompressed store.** 28 MB against origin quota instead of 88 MB, at the cost of ~0.2 s of native brotli per session. Quota is the scarcer resource, especially on iOS.

Sweep old keys on successful hydration: hold the current artifact and nothing else. Without a sweep, a month of nightly rebuilds is a month of 28 MB entries.

Handle eviction as an ordinary event, not an error. Cache Storage is best-effort; a missing entry means download again, and a quota rejection means run from memory this session and do not cache.

---

## 13. Failure modes

Every one of these degrades to remote. The package must never break search.

**Under `offline-first` (§8.2) this table does not apply as written.** There is no remote to degrade to, so each row becomes either "retry" or "fail loudly from `ready()`" — and failing loudly at boot is correct there, because an app that silently ships a broken search is worse than one that reports it. The rows that stay identical are the two that never involved the network: quota and eviction.

| Failure | Behaviour |
|---|---|
| Manifest fetch fails | Stay remote, retry with backoff |
| Version gate fails (§10) | Stay remote **permanently** this session, log once |
| Artifact download fails or is truncated | Stay remote, retry once, then give up this session |
| `finish_store_load` rejects | Stay remote permanently, log loudly — this is a bug, not a condition |
| Cache Storage quota exceeded | Hydrate from memory anyway, skip caching |
| Cache Storage evicted mid-session | No effect; the store is already in linear memory |
| `SharedWorker` unavailable | Dedicated Worker, hydration off by default (§5.3) |
| `saveData` / slow connection | Do not hydrate unless `hydrate: "manual"` was called explicitly |
| Worker crashes after `local` | Revert to `remote`, attempt one re-hydration |

The permanent-for-this-session rule on version and load failures matters: a client that retries a failing 28 MB download every few minutes is worse than one that quietly uses the API.

---

## 14. Open questions

Ordered by how much they change the design.

1. **What does `finish_store_load` cost over 76 MB?** rkyv validation is the one warm-up stage with no measurement behind it, and it is a plausible multi-second stall. **Measure this first** — it needs no browser, just Bun driving the committed wasm with a real store, and it gates whether the whole warm-up story is pleasant.
2. **Does Cloudflare pass a Worker-set `Content-Encoding: br` through untouched?** If not, the fallback is gzip at 30.8 MB, which also exceeds the single-KV-value cap and reintroduces chunking for the browser path. Cheap to test.
3. **What does the residue archive compress to at q6?** Only q11 (3,209,163) was measured. Affects the `surface: "full"` download budget, not the design.
4. **Does brotli q6 fit an importer alarm's CPU budget in-Worker?** 1.8 s on a Mac is promising but not decisive. If not, CI compression (§7).
5. **Is the parser cleanly extractable from this repo?** It is pure TypeScript with no Worker dependencies, which is promising, but `tag-aliases.gen.ts` is generated and `pystr.ts` implements Python string semantics. Whether it vendors, or becomes a shared package both this Worker and `sylvan-browser` depend on, decides how §10's lockstep actually works.
6. **How does a consumer handle the completeness change?** Local results are uncapped where remote ones are paginated. That is the feature, but it means a UI built around 175-card pages meets a 7,037-card answer. An app-level concern, worth naming in the README.
7. **How does the store artifact reach a packaged app?** (§8.2) Size is no longer the question — 28 MB clears every platform limit, verified. What is open is the mechanism: plain bundling (simple, goes stale at the app's release cadence) versus Background Assets / Play Asset Delivery (smaller binary, independently refreshable, platform-specific build work). And whether this package ships a build-time helper that fetches `/store/<key>.br` and pins its generation, or leaves that to each consumer's bundler — that choice is what makes the §10 gate a build check rather than a runtime one.

---

## 15. Phases

**Phase 0 — prove it off-Cloudflare.** Drive the committed wasm from Bun: instantiate, stream-load a real store, run queries, time every stage. Answers open question 1 and de-risks everything downstream. No package, no browser, no new code in this repo.

**Phase 1 — serve the artifacts.** `/store/manifest` and `/store/<key>.br` on this Worker, plus the publish step that produces the compressed copy. Independently useful and independently testable with `curl`.

**Phase 2 — core package.** `sylvan-browser` with the router, the state machine, the SharedWorker, Cache Storage, and the version gate. No React. Validated by the parity harness.

**Phase 3 — React layer.** `sylvan-browser/react`, TanStack bindings, SSR no-op.

**Phase 4 — first consumer integration.** This should *follow* that consumer moving its existing card-data path onto this port's HTTP API, not accompany it. Adopting the API is most of the value at none of the 28 MB, and it proves the consumer's query strings round-trip cleanly before any wasm ships. A consumer that cannot get correct answers over HTTP will not get them locally either.

---

## Related

- `CARD-PARTITIONING.md` — the memory ceiling this shares its measurements with
- `src/engine/types.ts` — `EngineApi`, the interface this implements; `StoreManifest`
- `src/engine/store.ts` — `feedStore`, the streaming loader the browser path mirrors
- `src/engine/store-kv.ts` — `STORE_CONTENT_GENERATION` history, the §10 argument in full
- `engine/wasm/src/lib.rs` — the chunked load API and its memory discipline
