# Browser Engine — shipping the card store to the client as an npm package

Status: **proposal. Phase 0 done; the server side landed independently.** Written 2026-08-11, revised after `8909a96` gzipped the KV chunks for the Durable Object — which turned out to supply the browser artifact too, so §7 no longer proposes a publish step. Numbers marked *measured* were taken against real artifacts on this machine; numbers marked *estimated* are arithmetic on top of them and are only as good as the stated assumptions.

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

It also deletes result truncation. Any client that paginates the API caps itself somewhere — a broad-but-structured query like `c:w` matches 6,732 cards (measured), and a UI showing 175-card pages shows an arbitrary slice of a popularity-ordered list because moving card JSON costs something. Locally it costs nothing, so completeness stops being a budget decision.

### The honest risks

| Risk | Severity | Mitigation |
|---|---|---|
| Version skew makes local and remote disagree silently | **High** | Hard compatibility gate, §10 |
| 76–91 MB of linear memory *per tab* | **High** | SharedWorker, §5.3 |
| Parser and store generation drift apart | Medium | Lockstep versioning + parity CI, §11 |
| Storage eviction (Safari/iOS especially) | Medium | Always degrade to remote, §13 |
| ~~`finish_store_load` validation cost is unmeasured~~ | — | **Resolved.** 0.1 ms; whole warm-up is ~14 ms of CPU, §2 |
| 33–38 MB download on a phone | Low–Medium | Deferred trigger, `saveData` respect, §8.1 |

None of these is disqualifying. The first two are design constraints that shape the package; the rest are degradation paths.

---

## 2. The numbers

All against `store-build/card-store-v2026081102-*` (content generation 10, format 2026081102).

### Artifact sizes

| Artifact | Raw | gzip -6 | gzip -9 | brotli q6 | brotli q11 |
|---|---:|---:|---:|---:|---:|
| Search store | 76,636,456 | 31,088,463 | 30,790,072 | 24,385,474 | 20,392,105 |
| Residue archive | 11,839,272 | — | 4,333,377 | 3,585,604 | 3,209,163 |

*Measured.* Compression time for the search store: gzip -9 8.5 s, brotli q6 1.8 s, brotli q11 101.6 s (M-series Mac); the residue takes 0.35 s at q6 and 23.9 s at q11.

Brotli quality is **not monotonic in output size** on this data — the residue is 3,585,604 at q6 and *larger* at q8 (3,622,695). Measure the quality you plan to ship rather than assuming higher is smaller.

Decompression to the full 76,636,456 bytes, native, three runs: brotli q6 **0.18 / 0.17 / 0.14 s** (~480 MB/s); gzip -9 **0.08 / 0.09 / 0.09 s** (~880 MB/s). *Measured.*

**Either format decompresses natively in the browser** — `Content-Encoding` is handled by the browser's own decoder during the fetch, with no JS, no `DecompressionStream`, and no intermediate buffer. So brotli's ~2× decompression cost is irrelevant on the client, and the only thing separating the two formats there is 6.7 MB over the wire.

On merit brotli wins for the browser and gzip wins for the Durable Object, whose `DecompressionStream` is gzip-only and whose CPU is the constrained resource. But **a Worker cannot produce brotli at all** (`CompressionStream` is gzip-only too), which turned a preference into a build-infrastructure question — and then `8909a96` settled it from the backend side by gzipping the KV chunks for the DO's own cold load. The browser reads those. §7.

### Download budget

A consumer that uses the `/cards/*` Scryfall card-object surface needs the residue archive as well as the search store; one that only searches does not.

| Surface | **gzip, per chunk (shipping)** | gzip, whole stream | brotli q6 | Linear memory |
|---|---:|---:|---:|---:|
| Search only | **33,345,526** | 31,088,463 | 24,385,474 | **79.30 MB** |
| Search + `/cards/*` card objects | **37,929,253** | ~35.4 MB | 27,971,078 | **91.16 MB** |

All *measured*. Linear-memory figures come from `CARD-PARTITIONING.md` §1, by reading `WebAssembly.Memory.buffer.byteLength` after load; Phase 0 independently measured 87.75 MB for the full surface (see below).

**The first column is what a client actually downloads today**, because `8909a96` gzipped the KV chunks for the Durable Object's cold load and the browser reads those same values (§7). It is ~2.3 MB worse than a single gzip over the whole archive, since each chunk compresses against its own window — the cost of a shape chosen for a resumable publisher and a chunked reader. Brotli remains a 6.7 MB upgrade needing out-of-band compression, and is now an optimization rather than a prerequisite.

### Time to usable

Phase 0 ran: the committed wasm driven from Bun against `card-store-v2026081102-1786452390` (76,636,464 bytes) and its paired residue archive. Everything below the rule is *measured*, 2026-08-11.

| Stage | 100 Mbps | 25 Mbps | Notes |
|---|---:|---:|---|
| Download 38 MB (gzipped KV chunks) | ~3.2 s | ~12 s | *Estimated.* Overlaps remote-phase queries |
| Native gzip decompress | ~0.1 s | ~0.1 s | *Estimated* from §2's 0.09 s native measurement; per response, overlaps download |
| — | | | |
| `WebAssembly.compile` | **4.3 ms** | | 1.92 MB module |
| `WebAssembly.Instance` | **0.7 ms** | | linear memory 1.50 MB |
| `begin_store_load` | **0.1 ms** | | preallocates 74.63 MB |
| `store_load_chunk` × 41 | **7.7 ms** | | 1.9 MB chunks, 76.6 MB copied |
| `finish_store_load` | **0.1 ms** | | |
| residue attach (all three calls) | **1.1 ms** | | 11.8 MB |

**Total non-download warm-up: ~14 ms.** Hydration is entirely download-bound, and every CPU stage is noise beside it.

`finish_store_load` at 0.1 ms answers the open question and disposes of the risk, but state what it actually means: at that speed it is plainly *not* walking 76 MB of structure. rkyv is zero-copy, so the archive is usable in place and "validate" here is a header and format-version check followed by a pointer swap — not a `bytecheck` pass over every field. Corrupt bytes past the header would therefore surface at query time rather than at load. That is the same bargain the Durable Object already takes in production, so it is not a new risk, but it is not the guarantee the function name suggests either.

Measured peak linear memory with both archives resident: **87.75 MB** — under `CARD-PARTITIONING.md`'s 91.16 MB, because streaming from subarray views never materializes a separate chunk buffer. Which is the loader-side saving the compressed-store work is chasing, demonstrated.

Local query latency, same run, full 175-row pages:

| Query | Time | Matches |
|---|---:|---:|
| `c:w t:creature` | 2.2 ms | 4,231 |
| `o:trample cmc=4` | 2.0 ms | 317 |
| `t:artifact r:mythic year>2019` | 1.0 ms | 264 |
| `c:w` | 0.4 ms | 6,732 |
| `lightning bolt` | 0.5 ms | 2 |

Against the 75–200 ms server-side cost of an uncached query (§1), that is **50–150×**. This is the entire argument for the package, and it is now measured rather than asserted.

---

## 3. Naming

**Recommended: `sylvan-browser`**, one package, plain TypeScript, no framework dependency of any kind.

```
sylvan-browser           the client
sylvan-browser/worker    worker entry (referenced, not usually imported)
```

**No React layer, no TanStack binding, not even as an optional subpath.** The package exposes async methods; a query library wraps them in one line at the call site:

```ts
useQuery({ queryKey: ["cards", q], queryFn: () => sylvan.search(q) })
```

There is nothing a `useCardSearch` hook could add to that except a React peer dependency, a second API surface to document, and a version to keep in lockstep. The same one-liner works for Svelte Query, Vue Query, solid-query, or a bare `await` — and framework-agnostic is the honest description of a package whose entire job is answering a query string.

The one thing a binding layer would genuinely have provided is reacting to the remote→local transition, and that is served by a plain subscription (§8) which any framework can adapt in a few lines.

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
| Query router, state machine, subscriptions | Main | Eagerly (small) |
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
  "store_bytes": 76642312,          // DECOMPRESSED — begin_store_load needs this
  "store_gzip_bytes": 33345526,     // PRESENT IFF COMPRESSED; the format flag
  "compat_bytes": 11839464,
  "compat_gzip_bytes": 4583727,
  "chunks": 3,                      // store chunk count; compat is always 1
  "card_count": 31724,
  "printing_count": 95131
}
```

**Every field here already exists on `StoreManifest`** — `store_gzip_bytes` and `compat_gzip_bytes` arrived with `8909a96`, which gzipped the KV chunks for the Durable Object's cold load. This route is a pure projection of the manifest, with no browser-specific fields at all. That is a better position than this document originally assumed, and §7's publishing section below is rewritten around it.

Note `store_gzip_bytes` is *present iff compressed* — it is a format flag, not a size hint — and `store_bytes` remains the decompressed length, so `begin_store_load` is unaffected either way.

`Cache-Control: public, max-age=300` — short enough that a nightly rebuild propagates within minutes, long enough that a page load does not always pay for it.

### `GET /store/<key>/<seq>`

One gzipped KV chunk, passed straight through. The route reads the chunk it is named for and returns those exact bytes — no decompression, no re-framing.

```js
new Response(gzippedChunkFromKV, {
  encodeBody: "manual",          // REQUIRED — see below
  headers: {
    "Content-Encoding": "gzip",
    "Content-Type": "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
  },
})
```

The client fetches `chunks` of these plus one for the residue, and pipes each into `store_load_chunk` — the same sequence the Durable Object already performs, with `fetch` where it has a KV read.

**`encodeBody: "manual"` is a correctness requirement, not a tuning knob.** Verified against the real Cloudflare edge on 2026-08-11 with a deployed throwaway Worker serving 512,000 bytes of actual store data:

| Response | Bytes to client | One brotli decode yields |
|---|---:|---|
| `encodeBody: "manual"` | 241,051 — byte-identical to the file | **the original 512,000 bytes** |
| header set, no `encodeBody` | 241,056 | **the inner `.br` stream** |
| gzip + `encodeBody: "manual"` | 266,112 — byte-identical | the original 512,000 bytes |

Without the flag the runtime treats an already-compressed body as *unencoded* and brotli-compresses it a second time, while leaving the `Content-Encoding: br` header you set in place. The +5 bytes is what brotli costs on incompressible input. Nothing errors: the header is right, the size looks right, and the client decodes exactly once and gets a brotli stream where the archive should be. Given that `finish_store_load` only checks a header (§2), that surfaces as a confusing rejection rather than a clear one.

Local `wrangler dev` and the deployed edge behaved identically, so this is runtime behaviour rather than an edge compression rule, and it is reproducible without deploying. One incidental tell: the double-encoded response omits `Content-Length`, because the runtime is compressing on the fly and no longer knows the size. A missing `Content-Length` on this route means the flag was dropped.

Keys are immutable — `store_key` already embeds format version and build timestamp, so a rebuild produces a new key and never invalidates an old URL. That is what makes `immutable` honest and lets both the HTTP cache and Cache Storage hold it indefinitely.

### Publishing — resolved by `8909a96`, and there is nothing to publish

This section previously weighed four ways to produce a compressed browser artifact. It has been overtaken: **the store is already gzipped in KV**, per chunk, as of `8909a96`. There is no browser artifact to build, because the bytes the browser wants are the bytes the Durable Object already reads.

Measured by that change, on the real import pipeline:

| | raw | gzipped | ratio |
|---|---:|---:|---:|
| store chunk 1/3 | 24.8 MB | 8.6 MB | 34.7% |
| store chunk 2/3 | 24.8 MB | 8.4 MB | 33.9% |
| store chunk 3/3 | 23.5 MB | 14.7 MB | 62.6% |
| residue 1/1 | 11.3 MB | 4.4 MB | 38.9% |
| **store total** | 76,642,312 | **33,345,526** | 43.5% |
| **residue total** | 11,839,464 | **4,583,727** | 38.7% |

So the browser route is a passthrough of existing KV values, and the publishing question disappears. Three consequences worth carrying.

**Per-chunk gzip is worse than whole-stream gzip, and that is the price of the shape.** 33,345,526 against the 31,088,463 this document measured for a single gzip over the whole archive — about 2.3 MB, because each chunk compresses against its own window with no cross-chunk redundancy. Chunk 3/3 at 62.6% is doing most of the damage.

**Concatenating the chunks is not available as a fix.** workerd's `DecompressionStream` *rejects* concatenated gzip members — "Trailing bytes after end of compressed data" — where the `gunzip` CLI accepts them. So a route cannot simply stream the three chunks back to back under one `Content-Encoding: gzip` and let the client sort it out. Per-chunk is forced, and the client must decode each chunk as its own response. (Whether browser `DecompressionStream` implementations are equally strict is untested and does not matter here, since the browser decodes per response via `Content-Encoding` rather than concatenating anything.)

**The single-KV-value property is gone, and it was worth less than it looked.** This document made much of brotli q6 fitting one value. The chunk grid is staying regardless — it is what the DO reads and what makes the publisher resumable, one chunk per alarm — so the browser fetching four responses instead of one is the normal case, not a degradation. Immutable keys mean all four cache independently.

Brotli is still a real 6.7 MB upgrade over per-chunk gzip, and still needs out-of-band compression this repo has no CI for. It is now clearly a *later* optimization against a working baseline rather than a decision blocking v1.

For the record, the four options this section used to weigh, since the reasoning still applies if brotli is revisited:

| Option | Browser download | What it costs |
|---|---:|---|
| **Passthrough of the gzipped KV chunks** | 33,345,526 | **Nothing — it exists** |
| brotli q6, precompressed out-of-band | 24,385,474 | CI that does not exist in this repo |
| brotli via a wasm encoder in the importer | 24,385,474 | Real Rust work, against a 112 MiB `--max-memory` cap |
| Serve raw, let the edge compress | ~26.5 MB | A dishonest `Content-Type`; see below |

**Option 4 does not work honestly.** Cloudflare's edge auto-compression is content-type gated, verified 2026-08-11 against a deployed Worker returning 512,000 raw store bytes:

| `Content-Type` | Bytes to client | Encoding |
|---|---:|---|
| `application/octet-stream` | 512,000 | none |
| `application/x-sylvan-store` | 512,000 | none |
| `application/wasm` | 263,070 | br |
| `application/json` | 263,067 | br |

The honest type for this artifact is `application/octet-stream`, and that is exactly the one the edge skips — reasonably, since octet-stream is assumed to be already-compressed binary. Getting edge compression means declaring the store to be wasm, which it is not. The edge's on-the-fly brotli is also ~9% worse than q6 (263,070 vs 241,051), because it runs at a low quality level, and it burns edge CPU on every cache miss. (On a custom domain, Compression Rules could force it honestly by path. On workers.dev there are no zone rules.)

**The DO and the browser now want the same bytes for opposite reasons**, which is why the passthrough is not a compromise. `8909a96` gzipped the chunks to cut ~750 ms of transfer off a cold DO load — measured at wall p50 915 ms against cpu p50 164 ms over 121 cold loads, so the cold path was waiting on bytes, not computing. The browser wants those same bytes for the same reason, over a slower link. One compression step, decided on the backend's evidence, serves both.

The asymmetry that made brotli attractive for the client is unchanged and unexploited: the DO must use gzip because `DecompressionStream` is gzip-only, while a browser would decode either natively at no cost to us. That is what the 6.7 MB is still sitting on the table for. It is just no longer a decision anyone has to make before v1.

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

**The store should ship with the app.** `source: { type: "bundled" }` points at the compressed artifact packaged alongside — an `asar`-relative path in Electron, a public asset in Capacitor. First run then costs a local read and a decompress rather than a 28 MB download, and the app works offline from the moment it installs. The build pulls the artifact from `/store/<key>.<gz|br>` at package time, which also pins the store generation at build time, where the §10 version gate becomes a build check rather than a runtime one.

28 MB clears every store limit comfortably (*verified 2026-08-11*):

| Limit | Value | 28 MB against it |
|---|---|---|
| iOS total uncompressed app size | 4 GB | 0.7% |
| iOS executable `__TEXT` sections | 80 MB | **does not apply** — a data resource is not linked into the executable |
| iOS cellular download threshold | 200 MB, user-overridable since iOS 13 | ~14%, non-blocking |
| Google Play AAB compressed download | 200 MB | ~14%, non-blocking warning only above it |

The 80 MB row is the one worth being explicit about, because it is the limit people find first and misread: it governs `__TEXT` in the compiled binary, not bundled resources. A compressed archive is a resource.

**Consider platform asset delivery instead of the bundle proper.** Both platforms have a mechanism built for exactly this shape — [Background Assets](https://developer.apple.com/documentation/backgroundassets) on iOS, [Play Asset Delivery](https://developer.android.com/guide/playcore/asset-delivery) with install-time or fast-follow on Android. Both keep the IPA/AAB small while still having the store present before first launch, and Background Assets can refresh independently of app releases. That last property matters here: a store baked into the binary goes stale at the app's release cadence, which for a nightly-rebuilt dataset means the `endpoint` update check below is doing the real work anyway. Asset delivery gets the freshness without the bundle weight, at the cost of platform-specific build integration.

**Storage is the filesystem, not Cache Storage.** Cache Storage is evictable by design and both runtimes will evict it under pressure — acceptable when the fallback is a re-download, unacceptable when there is no network. An app-data path is not evictable and survives across versions.

**`endpoint` becomes optional and means "update check".** With one configured, the client fetches `/store/manifest` opportunistically when the network is up, and downloads a newer artifact in the background to replace the bundled one. Without one, the app is pinned to whatever it shipped with — legitimate for a release-cadence app, and it should be an explicit choice rather than a silent consequence of the network being down.

One platform caveat: `SharedWorker` (§5.3) is well supported in Electron's renderer but unreliable in Capacitor's WKWebView on iOS. Embedded targets are usually single-window, so the per-tab memory argument that motivates it mostly does not apply — but the dedicated-Worker fallback should be the assumed path on iOS rather than a surprise.

---

## 9. Using it with a query library

The package ships no bindings, but the design has one property worth stating because consumers should rely on it: **the query key never changes, only the resolver underneath it does.**

```ts
useQuery({ queryKey: ["cards", q], queryFn: () => sylvan.search(q) })
```

That is the whole integration, in any query library. The `queryFn` routes remote or local by itself (§6), so the key is stable across the transition and nothing above it needs to know which engine answered. Swap `useQuery` for `createQuery`, `useSWR`, or a bare `await` and it is the same line.

For status, subscribe:

```ts
useSyncExternalStore(sylvan.subscribe, () => sylvan.status)
```

Three rules for consumers, none of which need a package to enforce.

**Do not invalidate on transition to local.** If parity holds, re-resolving cached queries locally produces identical data and buys nothing but renders. New queries route locally on their own. The exception is deliberate: a consumer that wants the *uncapped* local result to replace a truncated remote one should invalidate, and should know that is why.

**Key on the query string, not on the engine.** Adding `sylvan.status` to a query key looks like good hygiene and is actively wrong — it refetches everything on transition, which is the cost the design exists to avoid.

**SSR must no-op.** No wasm, no download, no Cache Storage on the server. `createSylvanClient` detects a non-browser environment and pins itself to `remote` permanently, so a server render and the client hydration that follows never disagree about which engine is live.

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

1. ~~**What does `finish_store_load` cost over 76 MB?**~~ **Answered by Phase 0, 2026-08-11: 0.1 ms**, and the whole non-download warm-up is ~14 ms. See §2 for the numbers and for what that speed implies about how much validation is actually happening. The remaining question this opens is smaller and not blocking: whether the package should do its own integrity check on a downloaded artifact — a length check is free, a hash is not — given that `finish_store_load` will not catch corruption past the header.
2. ~~**Does Cloudflare pass a Worker-set `Content-Encoding: br` through untouched?**~~ **Answered 2026-08-11, against the real edge: yes — but only with `encodeBody: "manual"`.** Byte-identical passthrough with it; silent double-encoding without it. The same holds for gzip, which is what shipped — the flag, not the format, is the load-bearing part. Full result and the failure mode in §7.
3. ~~**What does the residue archive compress to at q6?**~~ **Answered: 3,585,604 bytes in 0.35 s**, for a 27,971,078-byte full-surface download at brotli. That is no longer the shipping number — the residue goes over the wire gzipped at 4,583,727 (§7), for 37,929,253 total — but it is what brotli would buy if it is ever revisited. One oddity worth knowing: q8 produces a *larger* residue (3,622,695) than q6. Brotli quality is not monotonic in output size, so pick a quality by measuring, not by assuming higher is smaller.
4. ~~**Does brotli q6 fit an importer alarm's CPU budget in-Worker?**~~ **Wrong question — brotli cannot be produced in a Worker at all.** `CompressionStream` takes `"gzip" | "deflate" | "deflate-raw"`, the same gzip-only set as `DecompressionStream`. There is no CPU budget to fit because there is no API. Resolved from the other direction by `8909a96`, which gzipped the KV chunks for the Durable Object's own cold load; the browser reads those same values and there is no browser artifact to publish at all (§7).
5. **Is the parser cleanly extractable from this repo?** It is pure TypeScript with no Worker dependencies, and it got easier while this document was being written: `9b42560` collapsed `tag-aliases.gen.ts` from 2,152 map literals to a single string parsed on first use, so the generated file is now 38 lines instead of ~2,180. What remains is that the file is still *generated* — from `tag-aliases.json`, alongside the store — and that `pystr.ts` implements Python string semantics the engine depends on matching. Whether the parser vendors into the package or becomes a shared dependency both this Worker and `sylvan-browser` import still decides how §10's lockstep works, and it is now the largest open design question here.
6. **How does a consumer handle the completeness change?** Local results are uncapped where remote ones are paginated. That is the feature, but it means a UI built around 175-card pages meets a 6,732-card answer. An app-level concern, worth naming in the README.
7. **How does the store artifact reach a packaged app?** (§8.2) Size is no longer the question — 28 MB clears every platform limit, verified. What is open is the mechanism: plain bundling (simple, goes stale at the app's release cadence) versus Background Assets / Play Asset Delivery (smaller binary, independently refreshable, platform-specific build work). And whether this package ships a build-time helper that fetches the artifact and pins its generation, or leaves that to each consumer's bundler — that choice is what makes the §10 gate a build check rather than a runtime one.

---

## 15. Phases

**Phase 0 — prove it off-Cloudflare. ✅ Done 2026-08-11.** The committed wasm, driven from Bun, instantiated and stream-loaded a real store and answered queries with no Cloudflare runtime involved: ~14 ms of warm-up CPU, 0.4–2.2 ms queries, 87.75 MB peak. Numbers in §2. The engine needs nothing it does not already have to run outside a Worker, which is the assumption every phase below rests on.

**Phase 1 — serve the artifacts.** `/store/manifest` and `/store/<key>.<gz|br>` on this Worker, plus the publish step that produces the compressed copy. Independently useful and independently testable with `curl`.

**Phase 2 — the package.** `sylvan-browser`: the router, the state machine, the SharedWorker, Cache Storage, the version gate, and the SSR no-op. Plain TypeScript, no framework dependency. Validated by the parity harness. This is the whole package — there is no framework phase after it (§3).

**Phase 3 — first consumer integration.** This should *follow* that consumer moving its existing card-data path onto this port's HTTP API, not accompany it. Adopting the API is most of the value at none of the 28 MB, and it proves the consumer's query strings round-trip cleanly before any wasm ships. A consumer that cannot get correct answers over HTTP will not get them locally either.

---

## Related

- `CARD-PARTITIONING.md` — the memory ceiling this shares its measurements with
- `src/engine/types.ts` — `EngineApi`, the interface this implements; `StoreManifest`
- `src/engine/store.ts` — `feedStore`, the streaming loader the browser path mirrors
- `src/engine/store-kv.ts` — `STORE_CONTENT_GENERATION` history, the §10 argument in full
- `engine/wasm/src/lib.rs` — the chunked load API and its memory discipline
