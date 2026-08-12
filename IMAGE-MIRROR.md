# Image Mirror — serving Scryfall's card art from R2, as WebP

Status: **proposal. Nothing here is built.** Written 2026-08-12. Numbers marked *measured* were taken against the live Scryfall CDN on this machine, from **one printing** (Lightning Bolt `7673784e-db4b-43a1-8d55-1bb9fc1e284f`) plus one double-faced card (Delver of Secrets `6904ea20-e504-47da-95a0-08739fdde260`) for the face check — so per-image byte counts vary with art complexity and the corpus totals below are that single sample multiplied out. Numbers marked *estimated* are arithmetic on top of them.

The idea: mirror every card image to R2 once, in WebP, and make `imageUris` point at our bucket instead of `cards.scryfall.io`. It is the last runtime dependency on Scryfall that the `/cards/*` work did not remove.

---

## 1. Verdict

**Worth building, and cheaper than expected.** Three findings drive it.

**There is a parallel WebP family, and it is not an extension swap.** Appending `.webp` to the documented variants 404s — `small`, `normal`, `large`, `art_crop` and `border_crop` all of them (*measured*). So does content negotiation: the same `.jpg` URL with `Accept: image/webp` returns byte-identical JPEG. What Scryfall's own website uses is a **different set of variant names** serving WebP at the *same pixel dimensions*. See §3.

**It is about half the bytes.** 33.6 GB of JPEG becomes 17.4 GB of WebP across the corpus (*estimated* from §2's sample), at identical dimensions.

**The storage bill is a rounding error on the paid plan.** ~$0.26/month for all five variants, ~$0.12/month for the two this stack actually renders. Egress from R2 is free, which is the entire reason this is worth owning rather than proxying.

### What it actually buys

A card image is currently a third-party request on every page view. Mirroring makes art a property of the deployment: no dependence on Scryfall's CDN being up, no dependence on their rate posture, and — the part that matters for a packaged or offline build — bytes we can bundle.

It also decouples us from an **undocumented** path. The WebP variant names below appear nowhere in Scryfall's API; `image_uris` only ever lists the six JPEG/PNG ones. They can move without notice. That is a bad thing to depend on at runtime and a fine thing to crawl once — which is an argument for doing the mirror *sooner*, not for avoiding WebP.

### The honest risks

| Risk | Severity | Mitigation |
|---|---|---|
| Undocumented variant names change or disappear | Medium | Crawl once; after that we serve our own bytes. A failed re-crawl degrades to stale art, not missing art. |
| Sample-of-one sizing is wrong | Low | Totals could move ±20%. At $0.26/month the decision does not turn on it — but measure the real distribution during Phase 1 before quoting a number anywhere else. |
| Faces collapsed into one object | **High** | §4. This is the failure upstream's mirror actually shipped. |
| Crawl looks like abuse | Medium | §5's pacing. Scryfall asks for 50–100 ms between requests; this is ~13 hours of politeness, not a burst. |
| Mirror is missing an image a client asks for | Low | §8's fallback: a miss serves Scryfall's URL rather than a broken image. |

---

## 2. The numbers

Per printing, front face (*measured*, one card):

| JPEG variant | dims | JPEG bytes | WebP variant | WebP bytes | saving |
|---|---|---|---|---|---|
| `small` | 146×204 | 12,391 | `thumb` | 7,886 | 36% |
| `normal` | 488×680 | 83,658 | `grid` | 45,098 | 46% |
| `large` | 672×936 | 125,145 | `display` | 63,248 | 49% |
| `art_crop` | 626×457 | 46,158 | `art` | 22,292 | 52% |
| `border_crop` | 480×680 | 86,146 | `crop` | 44,546 | 48% |
| `png` | 745×1040 | 843,984 | *(none found)* | — | — |

Dimensions match exactly in every row, so this is a true one-for-one substitution rather than a different rendition.

Against **95,131 printings** (the store's `printing_count`), front faces only (*estimated*):

| set | WebP | JPEG | R2 storage/month at $0.015/GB |
|---|---|---|---|
| `display` + `art` — what this stack renders today | 8.1 GB | 16.3 GB | **$0.12** |
| all five variants | 17.4 GB | 33.6 GB | **$0.26** |
| all five + `png` (JPEG only) | 97.7 GB | 113.9 GB | $1.47 |

**Skip `png`.** It has no WebP counterpart, it is 80 GB of the 114 on its own, and nothing in this stack requests it — `magic-card.tsx` asks for `large`, `magic-card-row.tsx` for `art_crop`. It can be backfilled if a print/export feature ever wants it.

One-time fill is ~476k Class A writes ≈ **$2.14** at $4.50/million (*estimated*, five variants × 95,131). Back faces add to that; see §5. Reads are Class B at $0.36/million and mostly absorbed by the edge cache in front of the bucket.

---

## 3. What the WebP family is

```
https://cards.scryfall.io/<variant>/<face>/<a>/<b>/<id>.<ext>
```

`<a>` and `<b>` are the first two characters of the printing id. `<face>` is `front` or `back`. The variant determines the extension — they are not independent:

- **JPEG**: `small`, `normal`, `large`, `art_crop`, `border_crop` → `.jpg`; `png` → `.png`
- **WebP**: `thumb`, `grid`, `display`, `art`, `crop` → `.webp`

Mixing them 404s in both directions (*measured*): `large/....webp` is a 404, and `display/....jpg` is a 404.

URLs on Scryfall's site carry a `?<timestamp>` cache-buster — e.g. `.../display/front/e/e/<id>.webp?1783930164`. That value is the printing's `image_updated_at`, which this port already stores in `CompatFields` and already appends in `imageUris`. It is what makes §9's delta re-crawl possible instead of a full refetch.

---

## 4. Key scheme, and the trap

Mirror Scryfall's own path shape, minus the host and the cache-buster:

```
<variant>/<face>/<id>.webp        e.g.  display/front/7673784e-....webp
```

**Key on `(id, face, variant)` from the first crawl.** The README's deviations list records what happens otherwise, because upstream's CloudFront mirror shipped it:

> for every transform/MDFC card the mirror's face-1 object is the **back** face's art, and no face-2 object exists at all

A mirror keyed on printing id alone silently collapses two faces into one object and serves the wrong art for every double-faced card — and it is invisible until someone looks at a specific card, because every URL still resolves. Fixing it later is a full re-crawl.

Back faces exist for the WebP variants (*measured*, Delver of Secrets): `display/back` 63,156 bytes, `art/back` 32,568 bytes. Not every printing has a back face; a 404 there is expected and must not be retried as a failure.

The `<a>/<b>` shard directories are Scryfall's, for their own filesystem layout. R2 is a flat keyspace with no directory penalty, so dropping them is fine — but keeping them costs nothing and makes a diff against the source trivially scriptable. Pick one and write it down here.

---

## 5. The crawl

**Not in a Worker.** This is hundreds of thousands of sequential fetches against a third party; it belongs in the same place the bulk import already lives — a script with the S3 API against the bucket, run from a laptop or CI, not a request-scoped isolate with a CPU budget.

Sizing (*estimated*): 95,131 printings × 5 variants ≈ 476k objects, plus back faces for double-faced printings. At Scryfall's requested 50–100 ms between requests that is **~13 hours** at 10 req/s. That is a background job with resume, not something to retry from zero.

Requirements:

- **Resumable.** Persist progress keyed by `(id, face, variant)` so an interrupted run continues. A crawl that must restart from zero will never finish.
- **Idempotent.** Skip keys already present with the current `image_updated_at`. This is what makes the nightly delta cheap (§9).
- **Politely paced**, with backoff on 429/5xx. Re-check Scryfall's current rate guidance before the first run rather than trusting the figure above.
- **A real User-Agent.** Scryfall rejects library defaults; `SCRYFALL_USER_AGENT` in mtg-seeker exists for exactly this reason.
- **Loud on partial failure.** A mirror that is 98% complete and reports success is worse than one that fails — the missing 2% becomes broken images discovered by users.

Source of truth for the printing list is the store itself, not a separate Scryfall call: every id and its `image_updated_at` is already in the residue archive.

---

## 6. Serving

**Public bucket on a custom domain**, e.g. `images.<domain>`, with a Cache Rule in front. Not a Worker binding: a Worker in the path bills an invocation per image and buys nothing, since these are immutable bytes under a content-addressed key. The bucket plus the edge cache is the whole serving story.

Cache lifetime can be long — the key changes when the art changes, because `image_updated_at` is part of how a client asks for it. `immutable` is defensible here in a way it is not for HTML.

---

## 7. Configuration

**One optional env var, and no R2 binding on the Worker.**

```
IMAGE_MIRROR_BASE_URL=https://images.example.com   # unset = Scryfall's CDN
```

That is the whole deployment-facing surface. It follows the precedent already in this codebase: `SCRYFALL_BULK_URL` is documented as "overridable for tests and self-hosted mirrors" and falls back to a constant when unset, and `RATE_LIMIT_ENABLED` treats unset as off. Same shape, same reason — a fork that does nothing gets today's behaviour, and the free plan stays a real target because there is nothing to provision.

### Why not a binding, and why not auto-detection

The tempting version is "bind the bucket and mirror if it's there". Three reasons not to:

**The Worker never touches R2 at request time.** §6 serves images from the bucket's own custom domain, so the request path is browser → R2, with no isolate in it. A binding would exist solely to be checked for truthiness, which is a config flag wearing a costume.

**A binding's presence is the wrong signal.** It tells you a bucket exists, not that it is *populated*. Detecting a binding and switching URLs would point every client at an empty bucket the moment someone provisions one — strictly worse than not mirroring, and it fails at exactly the point where the crawl has not run yet. A base URL is an operator asserting "the mirror is live", which is the precondition that actually matters.

**Auto-triggering the crawl on detected credentials is worse still.** §5 is ~476k third-party requests over ~13 hours. That is an operator action, not a deploy side effect — and the deploy already publishes a store, so bolting a half-day crawl onto it would be a bad trade twice over.

### Crawler credentials are separate, and never reach the Worker

The crawler (§5) runs as a script against the S3 API, the way mtg-seeker's `upload-cards-to-r2.ts` already does:

```
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
```

These belong to the operator's shell or CI, not to `wrangler.jsonc`, and the Worker never sees them. Keeping write credentials out of the runtime is the point: the deployment that *serves* mirrored images needs no permission to *write* them.

### The URLs do not go in the store

They are a pure function of `(id, face, variant)` and the base URL, computed at read time by `imageUris` — which is already how the Scryfall URLs work today. Baking resolved URLs into the archive would:

- couple a store build to one deployment's hostname, so the same bytes could not serve `daveycodez` and `deckgen` (let alone a fork) — the property that lets one published store answer from every colo
- grow the store for data that is derivable, against a three-chunk ceiling with ~1.36 MB of margin
- make changing the mirror's domain a full rebuild-and-republish instead of a variable change

Store the id; derive the URL. `image_updated_at` is the one image-related thing that *is* stored, because it is a fact about the art rather than about where the art is hosted.

---

## 8. Integration, and the fallback

One function. `imageUris` in `src/routes/scryfall-compat/objects.ts` builds every URL:

```ts
out[size] = `https://cards.scryfall.io/${size}/${face}/${first}/${second}/${scryfallId}.${ext}${suffix}`;
```

That is the only place the host and the variant vocabulary are decided, so pointing at the mirror is a change to one function plus the JPEG→WebP name map from §3. Note the *keys* of the returned object must stay Scryfall's documented names (`small`, `normal`, `large`, `art_crop`, `border_crop`) — a client reading `image_uris.large` must keep working. Only the URL behind each key changes.

`png` keeps pointing at Scryfall unless and until it is mirrored.

**A miss must fall through to Scryfall, not 404.** A printing added since the last crawl has no object in the bucket, and a broken image is a worse failure than a third-party request. Either the URL builder checks a manifest of mirrored keys, or the bucket's custom domain gets a fallback rule — decide in Phase 2 and record which.

mtg-seeker's `scryfallImageUrl` (`src/lib/card-image.ts`) derives its URLs the same way from the printing id, so it is the same one-line swap on that side.

---

## 9. Staying current

The nightly import already knows which printings are new or changed. `image_updated_at` moves when Scryfall re-renders art, so the delta is:

- printings in the new store whose id is not in the mirror manifest
- printings whose `image_updated_at` differs from the mirrored copy's

Both come out of the store build for free. Expected volume is a few hundred objects a night against 476k total — minutes, not hours.

---

## 10. Failure modes

| Symptom | Cause | Response |
|---|---|---|
| Wrong art on double-faced cards only | `(id, face)` collapsed | Full re-crawl. §4 exists to prevent this. |
| Broken images for recent cards | Mirror behind the store | §8's fallback covers it until the next delta run. |
| All images broken after a deploy | Variant name map wrong in `imageUris` | Single-function revert. |
| Crawl stalls at the same object | Scryfall 404 for a variant that does not exist for that printing | Expected for back faces; record and skip, do not retry. |
| Storage grows without bound | Old `image_updated_at` copies never pruned | Prune on delta, or accept it — at $0.015/GB the wrong answer is cheap. |

---

## 11. Phases

**Phase 1 — measure, do not guess.** Crawl a few hundred printings across rarities, frames and full-art treatments; record the real byte distribution per variant. §2's totals are one card multiplied by 95,131 and should not survive contact with a real sample. Cheap, and it sizes everything after it.

**Phase 2 — the crawler.** Resumable, idempotent, paced, loud on partial failure. Writes objects and a manifest of mirrored keys. Runs to completion once.

**Phase 3 — serve and switch.** Custom domain, cache rule, then `imageUris` and `scryfallImageUrl` point at it with the §8 fallback in place. Reversible in one function.

**Phase 4 — the nightly delta**, wired into the existing import.

---

## Related

- `README.md` — the deviations list, including why images come from Scryfall's CDN today and what upstream's mirror got wrong
- `src/routes/scryfall-compat/objects.ts` — `imageUris`, the one integration point
- `BROWSER-ENGINE.md` — the other half of "own the data": queries in the tab, art from the bucket
- `CARD-PARTITIONING.md` — where `image_updated_at` lives in the residue archive
