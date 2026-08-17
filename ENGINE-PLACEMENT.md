# Engine placement: where `engine-wnam-p0` actually is

The engine tier is sharded by region. `resolveEngine` in `src/index.ts` maps a request to one of nine
`DurableObjectLocationHint` values and routes to `engine-<region>[-<n>]-p<k>`. The whole design
assumes the object is physically in the region its name claims — each archive is loaded once per
region so that every request from that region reaches it over a short hop.

**The names grew a partition axis (checked 2026-08-16).** This file was written on 2026-08-12, when a
region held one object with one ~88MB archive in it. The store is now cut into partitions, and a
region's serving set is one object *per partition* per replica: `engine-<region>[-<n>]-p<k>`, where
`<n>` names the REPLICA (the shard controller's axis, absent for shard 0) and `p<k>` names the
PARTITION (which subset of the data). They multiply. `engine-wnam-2-p3` is replica 2's copy of
partition 3. See CARD-PARTITIONING §2 and `src/engine/engine-namespace.ts`, which is where the
grammar is defined and parsed.

The partition count is **not** a constant in this repo — the builder derives it from measured corpus
bytes and writes it to the manifest, and every router reads it from there
(`src/import-publish.ts` `partitionCountFor`, `src/engine/partitioned-engine.ts`). The manifest at
`store-build/manifest.json` on 2026-08-16 carried `partition_count: 10` at ~40MB of raw archive per
partition, ~413MB across the ten. **Do not hardcode either number when reading this file later; read
the live manifest.**

None of that changes the property this document exists for. It multiplies the surface: a region now
has `replicas × partitions` names that can each be misplaced permanently and silently, and a
partition object is created by exactly the same call, from exactly the same place, as an unpartitioned
one was.

That assumption rests on one property of the platform, and the property has a sharp edge:

> **`locationHint` applies at CREATION and never again.**

Whoever first addresses a given object name fixes that object's physical region for the rest of its
life. Address `engine-apac` once from a Durable Object running in North America and every apac
request afterwards crosses the Pacific twice to reach it. Permanently. There is no API that reads a
Durable Object's location back, no way to move one, and nothing in the system that would report it —
the site keeps working, just slowly, for one region, forever.

This file is how that is prevented, how it is checked, and what to do if it ever happened.

## 0. What it said when we first asked (2026-08-12, pre-partitioning)

> The probe below ran against the single-archive shape, when a region held one object called
> `engine-wnam`. It is kept as the record of the one time placement was measured end to end rather
> than assumed. The mechanism it exercises — object self-reports its colo, caller reports its own —
> is unchanged; only the set of names is larger.


Both accounts, within minutes of the probe going live:

```
[engine-wnam]  placement: colo=LAX loc=US          # daveycodez (free) and DeckGen (paid)
[wnam@LAX]     warm engine rpc: n=1 min=10ms ...   # paid; the calling isolate was also in LAX
```

`engine-wnam` is in Los Angeles on both deployments — western North America, which is what the name
claims. The paid account's isolate was in LAX too, and its warm RPC to the object measured **10ms**,
which is the same-colo case rather than merely the same-region one. Combined with the audit in §1
(the coordinator's nine-region fan-out existed for 92 minutes on 2026-08-12 and never ran, because it
lives in the nightly alarm chain and no cron fell inside the window), placement is **confirmed
correct, not merely undisputed**.

Two things worth knowing for the next person who runs this:

- **The free account never produces a warm sample.** Three requests over ten minutes produced three
  cold loads: it has too little traffic to keep an object resident, so every request is a wake and
  `warm engine rpc` never fires there. Read its placement line, not its latency.
- **Observability ingestion lags by a minute or two.** Filtered queries returned empty for lines that
  a later unfiltered group-by found. If a line you expect is missing, widen the window and re-run
  before concluding it was never emitted.

Also observed, and it cuts against the caution in §2: the free account's object **evicted within ten
minutes of a probe**, so the "an outbound request pins a DO for up to ~15 minutes" figure did not
bind here. One observation is not a rule — the throttle stays — but the cost is likely lower than the
worst case assumed below.

## 1. Prevention: one module may create an engine object

`src/engine/engine-namespace.ts` is the only place a `SEARCH_ENGINE` stub is constructed, and it
offers exactly three ways to do it — only the first can place anything:

| Function | Passes a hint? | May be called from |
| --- | --- | --- |
| `placeEngineStub(env, region, shard, partition?)` | yes — `region` | a Worker isolate serving a real request, and nowhere else |
| `addressAnnouncedEngine(env, name)` | **no** | anything (it has no power to place) |
| `siblingStub(env, label, partition)` | **no** — built on `addressAnnouncedEngine` | the gather fan-out, from inside an engine object |

`placeEngineStub` is safe from an edge isolate for one reason: that isolate is already running in the
region the request came from, so the hint it supplies is where the traffic is. It takes the *region*
and derives the *name*, so `engine-apac` placed into `wnam` is not a state this code can express. It
gained an optional `partition` and derives that half of the name too, on the same argument.

`siblingStub` is the one caller that reaches an engine object **from inside another engine object**:
the two-phase gather asks its own partition siblings for their share of a query
(`src/engine/search-engine-do.ts`). It derives the sibling's name from the label this object already
carries, and it deliberately routes through `addressAnnouncedEngine` rather than `placeEngineStub` —
a gather object was itself placed by a real request in its region, so a sibling first created from
there lands near that traffic anyway, but passing no hint means the helper *cannot* pin a region even
if handed a mangled label. That distinction is the whole reason it is a separate function rather than
a call to `placeEngineStub` with the region parsed back out of the name.

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
[engine-wnam-p0] placement: colo=SJC loc=US
```

The label is the object's own name, so it carries the replica and partition suffixes.

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
  `$metadata.message`. One row per object per probe — which is now one row per *partition*, so a
  healthy region produces `partition_count` lines that should all name the same colo. Two colos
  under one region is not automatically wrong (they are separate objects, created in the same
  moment but placed independently), but a line naming a colo on another continent is.
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

2. **Release its storage first.** The object holds its partition's cached archive rows against the
   5GB DO pool — one partition's archive, on the order of tens of MB (the 2026-08-16 manifest's ten
   partitions were ~40MB each; read the live manifest rather than trusting that figure). Call
   `releaseCache()` on `src/engine/search-engine-do.ts` — it runs `storage.deleteAll()`, and
   Cloudflare reclaims an object once its storage is empty. An abandoned object never loads again, so
   its own prune never runs again; skip this and those bytes are stranded permanently. The publish
   notify already does exactly this for shards above the fan-out, and it is safe to invoke on any
   engine object (the cache is only an optimisation over KV).

   **A misplaced replica is `partition_count` objects, not one.** Every `-p<k>` of that replica group
   was created by the same isolate in the same moment, so if one is misplaced they all are. Release
   each of them.

3. **Delete its announcement.** Remove `engine:live:<old-name>` from the store KV namespace. Each
   partition object announces itself under its own full name, so there is one key per `-p<k>`:

   ```bash
   bunx wrangler kv key list --namespace-id <id> --remote --prefix "engine:live:engine-wnam"
   bunx wrangler kv key delete --namespace-id <id> --remote "engine:live:engine-wnam-p0"
   ```

   (`--remote` is not optional: without it wrangler reads local dev state and reports an empty
   namespace.)

   Leaving it behind means the next publish finds a name whose object is gone, addresses it, and
   **recreates it from inside the coordinator** — the misplacement bug, reintroduced by the cleanup.

4. **Change the naming scheme.** `engineName()` in `src/engine/engine-namespace.ts` is the single
   definition; a version suffix is the least surprising form:

   ```ts
   const base = shard === 0 ? `engine-v2-${region}` : `engine-v2-${region}-${shard}`;
   return partition === undefined ? base : `${base}-p${partition}`;
   ```

   Keep `parseEngineName()` in step with it — its regex (`/^engine-([a-z]+)(?:-(\d+))?(?:-p(\d+))?$/`)
   is what `regionOfEngineName` and `replicaGroupOf` are both built on, and the publish fan-out's
   width accounting groups `-p0 … -p<k>` into ONE replica through `replicaGroupOf`. A rename that
   moves the region into a position that regex no longer matches turns every name into "not an engine
   name", which the loader and the fan-out both treat as a bug rather than a fallback.
   `tests/engine/engine-naming.test.ts` pins the grammar.

5. **Deploy, and expect one cold load per region *per partition*.** The first request from each
   region creates a fresh object for every partition, at the edge, correctly placed, and each pays
   its own partition's KV load in front of that one user. They load in parallel, so the wall-clock
   cost is roughly one partition's load rather than the sum. Nothing else changes: the store, the
   manifest and the KV layout are untouched.

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
- `CARD-PARTITIONING.md` §2 — where the `-p<k>` axis comes from and why it is a separate word from
  "shard"
- `src/engine/partitioned-engine.ts` — the fan-out that turns one request into `partition_count`
  stubs, all of them placed through the same choke point
- `tests/engine/engine-naming.test.ts` — the name grammar, pinned
