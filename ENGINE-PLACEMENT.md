# Engine placement: where `engine-wnam` actually is

The engine tier is sharded by region. `resolveEngine` in `src/index.ts` maps a request to one of nine
`DurableObjectLocationHint` values and routes to `engine-<region>` (or `engine-<region>-<n>`). The
whole design assumes the object is physically in the region its name claims — the ~88MB archive is
loaded once per region so that every request from that region reaches it over a short hop.

That assumption rests on one property of the platform, and the property has a sharp edge:

> **`locationHint` applies at CREATION and never again.**

Whoever first addresses a given object name fixes that object's physical region for the rest of its
life. Address `engine-apac` once from a Durable Object running in North America and every apac
request afterwards crosses the Pacific twice to reach it. Permanently. There is no API that reads a
Durable Object's location back, no way to move one, and nothing in the system that would report it —
the site keeps working, just slowly, for one region, forever.

This file is how that is prevented, how it is checked, and what to do if it ever happened.

## 1. Prevention: one module may create an engine object

`src/engine/engine-namespace.ts` is the only place a `SEARCH_ENGINE` stub is constructed, and it
offers exactly two ways to do it:

| Function | Passes a hint? | May be called from |
| --- | --- | --- |
| `placeEngineStub(env, region, shard)` | yes — `region` | a Worker isolate serving a real request, and nowhere else |
| `addressAnnouncedEngine(env, name)` | **no** | anything (it has no power to place) |

`placeEngineStub` is safe from an edge isolate for one reason: that isolate is already running in the
region the request came from, so the hint it supplies is where the traffic is. It takes the *region*
and derives the *name*, so `engine-apac` placed into `wnam` is not a state this code can express.

Everything else — the publisher's notify fan-out, anything added later — uses
`addressAnnouncedEngine`, which passes no options at all. On a name that already exists a hint would
be ignored anyway; the point is that a phase which cannot name a region cannot misplace an object
even if the set of names it walks turns out to be wrong.

`tests/engine/engine-placement.test.ts` fails if any other file under `src/` mentions
`SEARCH_ENGINE.get`, `SEARCH_ENGINE.idFromName`, or `locationHint` outside comments (`routes/rate-limit.ts`
is exempt and says why). A comment is not enough here: commit `fbc5397` added a nine-region fan-out
inside the coordinator *under a comment saying only the edge should create these*, and what stopped
it placing eight objects from the wrong place was luck — it lives in the nightly alarm chain, the
cron fires at 11:17 UTC, and the code existed for 92 minutes on the afternoon of 2026-08-12 before
`fb8ba97` replaced it.

The other half of prevention is that the publisher never *guesses* names. An engine announces itself
under `engine:live:<name>` in KV when it loads a store (`src/engine/store-kv.ts`), the fan-out visits
exactly that set, and `releaseCache` retires the announcement together with the storage — otherwise a
released shard's leftover key would bring it back into existence on the next publish, which is the
same bug wearing a different hat (`ad388bc`).

## 2. Checking: the two log lines

Nothing reports a Durable Object's location, so the objects report their own.

**The object side.** `src/engine/placement.ts` fetches Cloudflare's trace endpoint, which every colo
answers locally, naming itself:

```
[engine-wnam] placement: colo=SJC loc=US
```

It runs on a **cold store load** (the one moment an object may have just been created) and on
**publish notify to an already-warm object** (a nightly re-check that costs nothing extra, because
the object is alive and billing duration regardless). It is fire-and-forget, throttled to at most one
probe per isolate per hour, and never on the request path — an outbound request keeps a Durable
Object resident for as long as its connection is pooled, up to ~15 minutes, and duration is billed
while it is alive. At request frequency that would be ruinous; at this frequency it is ~115 GB-s per
probe against the free plan's 13,000 GB-s/day.

**The caller side.** `src/engine/remote-engine.ts` summarises warm RPC wall time per region, tagged
with the colo the calling isolate is in:

```
[wnam@SJC] warm engine rpc: n=4 min=21ms avg=38.5ms max=66ms over 2013ms
```

**The two lines are the check, and they need no lookup table.** The colos that appear in `[wnam@…]`
lines are, by definition, the colos wnam traffic arrives at — real traffic maintains that set for
free, and Cloudflare adding colos cannot rot it. `engine-wnam`'s self-reported colo either sits among
them (or plainly adjacent to them) or it does not.

### Reading them in Workers Observability

Use `view: "calculations"` — the `events` view 500s for this service. Log retention is 3 days. Both
accounts deploy from this repo on every push, and **their labels differ for the same code**: the free
account (`daveycodez`, `a93534c803a4ca115520dc3b0eb02904`) reports `origin: jsrpc`, the paid one
(`DeckGen`, `49d088b6755a2f538c6f12833e18e39b`) reports `origin: rpc`. A filter written for one
returns empty on the other with no error, so filter on the message rather than on the trigger:

- **Where is each object?** `$metadata.message` `includes` `] placement: colo=`, grouped by
  `$metadata.message`. One row per object per probe.
- **Which colos serve each region?** `$metadata.message` `starts_with` `[wnam@`, grouped by
  `$metadata.message`. Or `includes` `warm engine rpc` for every region at once.
- The paid account is the one with traffic; the free account is mostly cold, so its lines appear only
  after a deploy or a wake.

## 3. Detection: the latency floor

Reading log lines requires someone to go looking. The automatic signal is in the same warm-RPC
window:

```
[wnam@SJC] warm engine rpc floor is 310ms — engine-wnam may not be in wnam; check its placement line
```

It fires when a window's **minimum** warm RPC reaches `WARM_RPC_FAR_MS` (250ms). The bar is set to be
un-triggerable by ordinary load: same-region warm calls measure 20–70ms in production, dominated by
payload serialization, while an object on the far side of the planet cannot beat its own round trip
(150ms+ each way) before doing any work. Using the *minimum* of a window rather than an average or a
single sample is what keeps queueing, a large `/cards/search` payload, and slow neighbours out of it.

Treat the warning as "go run the placement query", not as proof. It is a distinct message string, so
it can be alerted on directly.

## 4. Remediation: a Durable Object cannot be moved

If a placement line shows an object in the wrong part of the world, the only fix is to stop using
that object and let the edge create a new one. **Do not do any of this on a latency warning alone** —
confirm with a `placement:` line first.

The order matters, because step 3 makes the object unreachable and its storage is only reclaimable
from the inside.

1. **Confirm.** Get a `placement:` line for the object. If it is not in the logs, force a cold load
   (a deploy resets every Durable Object) or wait for the nightly publish notify.

2. **Release its storage first.** The object holds ~88MB of cached archive rows against the 5GB DO
   pool (~76.6MB store + ~11.8MB residue). Call `releaseCache()` on `src/engine/search-engine-do.ts`
   — it runs `storage.deleteAll()`, and Cloudflare reclaims an object once its storage is empty. An
   abandoned object never loads again, so its own prune never runs again; skip this and those 88MB
   are stranded permanently. The publish notify already does exactly this for shards above the
   fan-out, and it is safe to invoke on any engine object (the cache is only an optimisation over
   KV).

3. **Delete its announcement.** Remove `engine:live:<old-name>` from the store KV namespace:

   ```bash
   bunx wrangler kv key delete --namespace-id <id> --remote "engine:live:engine-wnam"
   ```

   Leaving it behind means the next publish finds a name whose object is gone, addresses it, and
   **recreates it from inside the coordinator** — the misplacement bug, reintroduced by the cleanup.

4. **Change the naming scheme.** `engineName()` in `src/engine/engine-namespace.ts` is the single
   definition; a version suffix is the least surprising form:

   ```ts
   return shard === 0 ? `engine-v2-${region}` : `engine-v2-${region}-${shard}`;
   ```

   Keep `regionOfEngineName()` in step with it — its regex parses names back into regions.

5. **Deploy, and expect one cold load per region.** The first request from each region creates a
   fresh object, at the edge, correctly placed, and pays a full ~76.6MB KV load (~1-2s) in front of
   that one user. Nothing else changes: the store, the manifest and the KV layout are untouched.

6. **Verify.** The new object's first cold load probes; read its `placement:` line and compare it
   against the `[<region>@…]` colos.

**A push to `main` deploys BOTH accounts** (Workers Builds; there is no GitHub Actions gate), and a
rename abandons every existing object and its cache on both. It is not revertible — reverting the
commit does not bring the old objects back, it just abandons the new ones too. Confirm before
pushing.

## See also

- `src/engine/engine-namespace.ts` — the choke point, and the argument for it
- `src/engine/placement.ts` — the probe, and what it costs
- `src/engine/store-kv.ts` (`REGION_LIVE_PREFIX`) — why objects announce themselves instead of being
  enumerated
- `src/engine/region.ts` — how a request becomes a region, which is the same key the names use
