# `order=name` for reversible printings

**Status:** open, deliberately parked 2026-08-17. The *search* half of this shipped in `33b073b`;
this document is the *sort* half, which did not.

## The defect

81 printings over 71 cards print a joined name their card does not have — a reversible Secret Lair
printing of Temple Garden prints `Temple Garden // Temple Garden`, while its card is `Temple
Garden`. Under `order=name`, Scryfall sorts those printings by **the name the printing prints**;
this port sorts them by **the card's name**.

Observable as an adjacent transposition. In the parity sweep's `domain-layout-reversible_card`
case, both cards are present at indices 39 and 40 and are swapped: `assign_name_ranks` ranks
`mechtitan` before `mechtitancore`, where Scryfall orders `mechtitancore…` before
`mechtitanmechtitan`.

Ruled out by measurement: this is **not** a punctuation or collation bug. `name:/^Fire/ t:instant`
orders identically to Scryfall.

## What it is worth

Small, and worth being honest about before spending on it.

- Reversible printings are **extras**. A plain `temple garden` search returns 20 printings and does
  not include one. They surface only when a query trips the extras gate — `include_extras=true`,
  `is:reversible`, `layout:…` (which forces extras by itself, which is why
  `layout:reversible_card` answers 81 with no flag).
- Nothing is lost or duplicated. Our order is deterministic and total; paging through it returns
  every row exactly once. It is a *different* order from Scryfall's for 81 rows, not a broken one.
- The card objects are already correct — joined name, faces and layout all match — and since
  `33b073b` so does exact-name search.

So a caller that never sends `include_extras` never sees this.

## Why it is not a small fix

`encode_sort_key`'s `SortCol::Name` arm calls `collated_name(card, &data.strings)`. It has the
printing in scope (the Artist arm beside it already uses `p`), so taking the divergent name when
`divergent_of(card, p)` is `Some` is a few lines — and `DivergentPrinting.card_name_folded_id`,
added by the search-half commit, is exactly the string it needs (`collate_name` applied to it gives
the comparison form, with no new storage).

**Doing only that would be worse than doing nothing.** The cross-partition gather merges on the
sort key, but the in-partition walk does not use it: `SortCol::Name` reads `card.name_rank` and
`indexes.sort_perms`, a precomputed **card-space permutation**. Fix the key alone and the merge and
the walk disagree about order — a harder bug than the transposition it replaces.

### The permutation is an optimisation, not a requirement

Worth recording, because it corrects an earlier reading of this code. `sort_perms.get()` returns
`None` for `Released`, `PriceUsd`, `PriceEur`, `PriceTix`, `Rarity`, `Color`, `Set` and `Artist` —
every printing-level column. Those go through a comparison path that already reads per-printing
values, and the code says so: the permutation is *"the streaming fast path, not correctness."*

So printing-aware ordering is routine here. What is specific to `Name` is that it **has** a
permutation, and that permutation is card-keyed by construction.

## The three options

| | Correct? | Cost |
|---|---|---|
| Cross-partition sort key only | **no** — merge and walk disagree | few lines |
| Drop `Name` from the streaming fast path | yes | the most common sort order loses its optimisation for the whole corpus |
| Rebuild the `Name` permutation in printing space | yes | a real data-structure change touching the paging path |

The third is the right answer. The second trades a corpus-wide performance property for 81 rows and
should not be taken without measuring what it costs first — `sort_perms` exists because someone
measured that it was worth having.

## Why it was parked rather than done

Not because the change is dangerous in principle. Because the correct version is a paging-adjacent
data-structure change, and landing it at the end of a long session — folded into a push that
already carries a format bump and a dozen other fixes — means **nothing would exercise it before it
went live**. The failure mode of a wrong page permutation is rows appearing twice or not at all
across a page boundary, which is exactly the class the two-phase gather and the opaque sort keys
were built carefully to avoid.

It should be its own change, on its own rebuild.

## Doing it later

1. Rebuild the `Name` permutation (and its inverse) in printing space, so a printing whose own name
   differs from its card's sorts by its own. `DivergentPrinting.card_name_folded_id` is the source;
   `collate_name` gives the comparison form.
2. Change `encode_sort_key`'s `SortCol::Name` arm in the same commit, so the cross-partition key and
   the local walk cannot disagree.
3. Verify:
   - `domain-layout-reversible_card` orders identically to Scryfall at indices 39/40;
   - `name:/^Fire/ t:instant` still matches — guard against regressing the working case;
   - a **page-boundary** case where the transposed pair straddles the boundary, paged forward and
     back, asserting every row appears exactly once;
   - the N=2 vs N=10 differential still byte-identical, which is what would catch a key that
     disagrees with the walk;
   - the perf ratios, since this touches the streaming path for the most common sort.

## Routing

The ordering **rule** is engine-generic and belongs upstream (#927 is the base of the stack). The
cross-partition byte encoding in `encode_sort_key` is this port's local patch — upstream has no
partitions. Note upstream's SQL path may already be correct here: `preprocess_card` lifts the card's
top-level name before the face overlay, so `magic.cards.card_name` holds the joined name per
printing, and an `ORDER BY card_name` sorts it correctly. Confirm that before writing an upstream
hunk; the divergence may be ours alone.
