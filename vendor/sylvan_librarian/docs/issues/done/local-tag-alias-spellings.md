# Tag alias spellings: `art:flames` finds nothing, `art:fire` finds 3564

## Problem

Scryfall's tagger stores alternate spellings for a tag in an `aliases` field and resolves them to
the tag before matching. `art:flames` and `art:fire` both return 3564 artworks there. Here,
`art:fire` worked and `art:flames` returned nothing, because the import read only `slug` and
dropped `aliases` on the floor.

Probing Scryfall live (`/cards/search?unique=art`) pins down the exact semantics:

```
art:fire 3564   art:flames 3564   art:flame 3564
art:loose-lips 6807   art:"open mouth" 6807   art:open-mouth 6807   art:"mouth open" 6807
art:right-facing 2633   art:"looks right" 2633   art:looks-right 2633
art:"right facing" 2633   art:"three figures" 1411
otag:removal-creature 7806   otag:"creature removal" 7806   otag:creature-removal 7806
```

Two things fall out of that.

1. **An alias behaves exactly like the slug it stands for, descendants included.** `fire` has
   18 child tags and only 2,225 direct taggings, but `art:flames` returns the same 3,564 as
   `art:fire` — so the alias resolves to the tag *before* the hierarchy expands, not after.
2. **A hyphenated slug is also accepted spelled with spaces.** `art:"right facing"` matches
   `right-facing`, and no alias is involved. That is a second, independent gap: every multi-word
   tag was reachable only in its hyphenated form.

## What the dumps actually contain

Audited against both dumps (2026-08-09):

| | art_tags | oracle_tags |
|---|---|---|
| tags | 11,517 | 4,522 |
| tags with aliases | 1,024 | 719 |
| aliases | 1,332 | 819 |
| alias equal to some tag's slug | 0 | 0 |
| alias claimed by two tags | 0 | 0 |
| same two checks after slugifying the alias | 0 / 0 | 0 / 0 |
| aliases not already slug-shaped | 690 (52%) | 229 (28%) |

Aliases occupy a namespace disjoint from the slugs, with no duplicates — so resolution is
unambiguous. Every slug in both dumps matches `[a-z0-9]+(-[a-z0-9]+)*`, which is what makes
normalizing the search term safe: it can only turn a miss into a hit.

## Approach

Aliases are resolved at **import** time, by writing them as additional keys in `card_art_tags` /
`card_oracle_tags` alongside the slug. Search-term normalization is the **query**-side half, in
the one helper both backends share.

This follows the decision the ancestor propagation already made — resolve tag semantics once at
import, keep query time a dumb exact key match — and it is the reason the fix needs no engine
change: the SQL path (`card_art_tags @> {...}`) and the Rust engine (interned `coll_vocab` ids)
both read the same column, and both take their search term from
[card_query_nodes.py](../../../api/parsing/card_query_nodes.py).

Aliases have to be stamped onto the ancestors' taggings too, not just the tag's own, since an
alias must reach descendants (point 1 above).

### Cost

Measured over the dumps, counting keys written per tagging:

- **art:** +536,636 keys on a 1,024,627-key baseline (**+52.4%**), touching 51% of 472,398 taggings
- **oracle:** +143,913 on 471,738 (**+30.5%**), touching 39.5% of 229,289 taggings

Relative growth looks steep, absolute is roughly 10MB of JSONB plus a comparable GIN increment and
about 1MB of extra `u16` postings in the engine. Most of it comes from aliases on popular ancestors
(`dominaria-origin`, with its 257 descendants) reaching every descendant tagging. Engine
`coll_vocab` grows by ~2,150 strings, from ~17k, against a `u16` ceiling of 65,536.

### Rejected: a query-time alias table

The alternative was persisting `alias -> slug` (`magic.art_tag_aliases`, `magic.oracle_tag_aliases`)
and resolving on the way in: a `COALESCE` scalar subquery on the SQL path, and the map pushed into
the engine at reload so `bind` could fall back to it when a value misses `coll_vocab`. That keeps
stored data canonical — no alias keys in a `fields=card_art_tags` projection — and costs no space.

It was rejected as the wrong trade for ~10MB: it touches schema, import, SQL generation and Rust
instead of one import loop, and it introduces a second copy of the tag vocabulary whose refresh has
to be kept in step with the engine's. Worth revisiting if the JSONB growth ever bites, or if
canonical output starts to matter.

## Behavior changes

- Every alias spelling now resolves: `art:flames`, `art:open-mouth`, `art:"open mouth"`.
- Multi-word tags are reachable spelled with spaces: `art:"right facing"`, `otag:"creature removal"`.
- Tag searches are now case-insensitive in the same normalization step (`art:Flames`).
- A `fields=card_art_tags` projection now lists alias keys next to the slug. Art tags are not a
  Scryfall card-JSON field and the frontend never requests them, so nothing else surfaces this.
- The query half takes effect on deploy; the data half only after the next tag import re-stamps
  `card_art_tags` / `card_oracle_tags` and the engine reloads.
- An alias that ever does collide with a slug, or that two tags claim, is dropped with a warning
  rather than guessed at — the slug wins. Neither dump contains one today.
