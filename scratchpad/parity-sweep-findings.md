# Negated comparisons on api.scryfall.com — the measured boundary

> **Provenance.** Scryfall counts are store-independent and stand on their own. The **ours** column
> and the sweep totals below were measured on a store rebuilt at `STORE_CONTENT_GENERATION` **29** /
> `ARCHIVE_FORMAT_VERSION` **2026081614**, with `engine/wasm/pkg` rebuilt to match (the committed
> blob was one format behind the Rust source and produced `archive header mismatch` until
> `bun run build:wasm` was re-run). `bun run parity-sweep` on that store: **71 NEW** list-level +
> 1 object path over 529 cases, both before and after this change — see §8.

All counts measured against **api.scryfall.com**, 2026-08-16, serial requests, one per row.
The anchor throughout is `e:khm t:creature` = **151**. A row that answers **151** is a term that
did nothing.

The whole default corpus is **33,599** (`unique=cards`, no `include:extras`) — that is the number a
lone tautology answers.

---

## 1. The headline: `-` on a comparison leaf is not honored

`-<kw><op><value>` where `<op>` ∈ `>` `>=` `<` `<=` `!=` does not filter. It is **silent** — no
`warnings` array, no `bad_request` — and it behaves as a **TAUTOLOGY**, not as a removed term
(§4 proves the difference).

| term | positive form | negated form | verdict |
|---|---|---|---|
| `pow>=1` | 146 | **151** | negation dropped |
| `pow>1` | 125 | **151** | negation dropped |
| `pow<10` | 151 | **151** | (indistinguishable, positive is already all) |
| `tou>=1` | 150 | **151** | negation dropped |
| `tou!=1` | 133 | **151** | negation dropped |
| `pt>=3` | 141 | **151** | negation dropped |
| `cmc>=3` | 112 | **151** | negation dropped |
| `cmc!=3` | 106 | **151** | negation dropped |
| `mv>=3` / `manavalue>=3` | 112 | **151** | negation dropped |
| `loy>=3` / `loyalty>=3` | 1 | **151** | negation dropped |
| `usd>=1` | 28 | **151** | negation dropped |
| `usd!=1` | 141 | **151** | negation dropped |
| `eur>=1` | 27 | **151** | negation dropped |
| `tix>=1` | 0 (404) | **151** | negation dropped |
| `year>=2022` | 11 | **151** | negation dropped |
| `year!=2021` | 11 | **151** | negation dropped |
| `cn>=100` / `number>=100` | 112 | **151** | negation dropped |
| `edhrec>=5000` | 112 | **151** | negation dropped |
| `artists>=2` | 0 (404) | **151** | negation dropped |
| `paperprints>=2` | 87 | **151** | negation dropped |
| `papersets>=2` | 86 | **151** | negation dropped |
| `pow>=tou` (cross-column) | 106 | **151** | negation dropped |
| `cmc>=notanumber` | 0 (404) | **151** | negation dropped |
| `pow>="1"` (quoted value) | — | **151** | negation dropped |

Every one of `>` `>=` `<` `<=` `!=` was probed on `pow`, `tou`, `cmc`, `loy`, `usd`, `eur`, `tix`,
`year`, `cn`, `edhrec`, `artists`, `paperprints`, `papersets` — 65 rows, **all 151**.

### It also swallows the negation on text columns and unknown keywords

Here the positive form already matches nothing, so "negated = everything" is ordinary boolean
negation rather than a bug — but the answer to reproduce is the same tautology.

| term | positive | negated | note |
|---|---|---|---|
| `name>zzz` | 0 (404) | **151** | |
| `o>draw` | 0 (404) | **151** | |
| `t>creature` | 0 (404) | **323** (all of KHM) | |
| `a>zzz`, `kw>flying`, `ft>zzz`, `wm>zzz` | 0 (404) | **151** | |
| `layout>normal`, `border>black`, `st>expansion` | 0 (404) | **151** | |
| `lang>en`, `f>modern`, `is>foil` | 0 (404) | **151** | |
| `otag>ramp`, `atag>forest` | 0 (404) | **151** | |
| `e>khm` / `s>khm` | 0 (404) | **151** | |
| `t!=creature` | 0 (404) | **323** | |
| `o!=flying`, `name!=a` | 0 (404) | **151** | |
| `nonsense>=1` (unknown kw) | 0 (404), **no warning** | **151**, no warning | |
| `subtype>=1` (upstream-only kw) | 0 (404), **no warning** | **151**, no warning | |
| `arena>=1`, `mtgo>=1`, `spells>=1`, `lands>=1`, `penny>=1` | 0 globally | **151** | not real columns |

---

## 2. Where the rule STOPS — negation IS honored

The set-membership / ordering columns negate correctly, for every operator:

| term | positive | negated | 151 − positive |
|---|---|---|---|
| `r>=rare` / `rarity>=rare` | 52 | **99** | 99 ✓ |
| `r>rare` | 15 | 136 | 136 ✓ |
| `r<rare` | 99 | 52 | 52 ✓ |
| `r<=rare` | 136 | 15 | 15 ✓ |
| `r!=rare` | 114 | 37 | 37 ✓ |
| `c>=2` (and `color`/`colors`/`ci`/`commander`/`identity`) | 19 | **132** | 132 ✓ |
| `c!=2` | 135 | 16 | 16 ✓ |
| `id>=2` | 19 | 132 | 132 ✓ |
| `m>=2` / `mana>=2` | 102 | **49** | 49 ✓ |
| `m!=2` | 151 | 0 (404) | 0 ✓ |
| `produces>=2` | 5 | **146** | 146 ✓ |
| `produces!=g` | 147 | 4 | 4 ✓ |
| `produces:2` | 0 (404) | 151 | 151 ✓ |
| `devotion>={r}{r}` | 7 | **144** | 144 ✓ |
| `devotion:{r}{r}` | 7 | 144 | 144 ✓ |

So the boundary is **not** the operator alone and **not** "numeric". It is the column: the columns
Scryfall implements as bitmask/enum comparisons (`c`, `id`, `r`, `m`, `produces`, `devotion`)
negate; everything else does not.

`devotion` with a non-symbol value (`devotion>2`) is ignored-and-warned
(`Devotion can only match single color or hybrid mana.`) in **both** polarities — that is a value
check, not a negation rule.

---

## 3. `date` is a third behaviour: the `-` is DISCARDED, the term applied POSITIVELY

Not dropped, not honored — `-date<X` ≡ `date<X`. Measured on every operator:

| term | positive | negated | honored would be |
|---|---|---|---|
| `date>=2022` | 11 | **11** | 140 |
| `date<2022` | 141 | **141** | 11 |
| `date>2021` | 11 | **11** | 141 |
| `date<=2021` | 141 | **141** | 11 |
| `date!=2021` | 11 | **11** | 141 |
| `date:2021` | 141 | **141** | 11 |
| `date=2021` | 141 | **141** | 11 |

`year` (the other spelling of `released_at`) does **not** do this — `year>=2022` = 11 and
`-year>=2022` = 151, which is the tautology of §1.

---

## 4. It is a TAUTOLOGY, not a removed term

This is the measurement that decides the implementation. Scryfall's *ignore* machinery removes a
term and warns; this rule does neither.

| query | count | reading |
|---|---|---|
| `-pow>=1` (alone) | **200, 33,599** | the whole corpus — survives as a term that matches everything |
| `-cmc>=3` (alone) | 200, 33,599 | " |
| `-cn>=100` (alone) | 200, 33,599 | " |
| `-year!=2000` (alone) | 200, 33,599 | " |
| `-edhrec>=5000` (alone) | 200, 33,599 | " |
| `-artists>=2` (alone) | 200, 33,599 | " |
| `-pow:1` (alone) | **400** `All of your terms were ignored.` + warning | the *ignore* machinery — a different mechanism |
| `-cmc:3` (alone) | 400 `All of your terms were ignored.` + warning | " |
| `(-pow>=1 or t:god) e:khm` | **323** (all of KHM) | tautology in an `or` arm ⇒ the group matches everything |
| `(t:god) e:khm` | 13 | what a *removed* arm would have given |
| `(-pow:1 or t:god) e:khm` | **13** + warning | the ignore machinery really does remove the arm |
| `(-pow>=1 or -tou>=1) e:khm` | 323 | two tautologies |
| `-cmc>=3 or t:god` (alone) | 33,599 | |
| `-pow>=1 -pow>=1 e:khm t:creature` | 151 | idempotent |
| `-pow>=1 -cmc:3 e:khm t:creature` | 151, warns only for `-cmc:3` | the two mechanisms coexist, one silent one loud |
| `-pow>=1 f:notaformat e:khm t:creature` | 151, warns only for `f:notaformat` | " |

---

## 5. Negated EQUALITY (`:` / `=`) — the existing rule, re-measured

Unchanged from what `query-terms.ts` already implements, and the existing comment's claim that
`-cmc!=3` is "honored" is **false** (`-cmc!=3` = 151, a no-op; see §1).

| term | negated result | warning |
|---|---|---|
| `-pow:1`, `-pow=1` | 151 | `Unknown keyword “-pow”.` |
| `-tou:1`, `-loy:3`, `-usd:1`, `-eur:1`, `-tix:1`, `-year:2000` | 151 | `Unknown keyword “-<kw>”.` |
| `-edhrec:5000`, `-artists:2`, `-paperprints:2`, `-papersets:2` | 151 | `Unknown keyword “-<kw>”.` |
| `-cmc:3`, `-cmc=3` | 151 | `The value must be a number, or “even”/“odd”` |
| `-cn:100`, `-cn=100`, `-number:100` | **150** | none — **HONORED** |
| `-nonsense:1` | 151 | `Unknown keyword “-nonsense”.` |

`cn` is the tell for why the boundary is where it is: `cn:100` is the **string** collector-number
column (honored under negation) and `cn>=100` is the **integer** one (dropped). Independent
confirmation: `-cn:100` alone answers **38,562**, not 33,599 — a print-specific term is present, so
Scryfall switched to prints mode, which only happens because the term was *kept*.

Also note `nonsense:1` warns and is ignored, while `nonsense>=1` does **not** warn and matches
nothing (404). The unknown-keyword rule is operator-dependent too.

---

## 6. `-(…)` — a parenthesised group — is honored

The fault is in how `-` binds to a comparison **leaf**, not in negation itself.

| query | count | bare-leaf twin |
|---|---|---|
| `-(cmc>=3) e:khm t:creature` | **39** (= 151 − 112) | `-cmc>=3` = 151 |
| `-(cmc>=3 or cmc>=3) e:khm t:creature` | 39 | |
| `-(year>=2022) e:khm t:creature` | 141 | `-year>=2022` = 151 |
| `-(usd>=1) e:khm t:creature` | 114 | `-usd>=1` = 151 |
| `-(date>2021) e:khm t:creature` | **141** (= 151 − 11) | `-date>2021` = **11** |
| `-(r>=rare) e:khm t:creature` | 99 | `-r>=rare` = 99 (agree) |
| `-(t:god) e:khm` | 310 | |
| `-(name:a) e:khm t:creature` | 19 | |
| `-(pow>=1)`, `-(pow>1)`, `-(pow!=1)`, `-(tou>=1)` | **0** (404) | `pow<1` = 5, so not the honored answer either |

`pow`/`tou` under `-( )` answer 0 rather than the 5 that `pow<1` reports — a *separate* Scryfall
anomaly (power/toughness are text columns with `*` values on their side). Not addressed here.

---

## 7. The rule, stated

> A leading `-` on a **leaf** whose operator is `>`, `>=`, `<`, `<=` or `!=` is not applied.
>
> * If the keyword is one of `c` `color` `colors` `colour` `colours` `id` `identity` `ci`
>   `commander` `coloridentity` `color_identity` `r` `rarity` `m` `mana` `produces` `devotion`
>   — the negation IS applied. Normal.
> * If the keyword is `date` — the `-` is discarded and the term is applied positively, for every
>   operator including `:` and `=`.
> * Otherwise — the term becomes a **tautology**: it matches every card, silently (no warning, no
>   400), and composes as a term rather than being removed.
>
> `-<kw>:<v>` / `-<kw>=<v>` are a *different*, pre-existing mechanism (ignore-and-warn), except on
> `cn`/`number`, where they are honored.
>
> `-( … )` is honored throughout.

---

## 8. What this changed, and what the sweep could not see

`bun run parity-sweep` (329 query + 200 peripheral = 529 cases) answers **71 NEW** list-level
findings and 1 object path both before and after. That is not "no effect": the matrix contains **no
negated-comparison case at all**. Its per-column `neg` probes are all negated *equality*
(`-a:guay`, `-c:w`, `-ci:c`, `-frame:2015`, `-kw:flying`, `-name:the`, `-subtype:human`) and its
`cmp` probes are all *positive* comparisons. Nothing in the 529 crosses the two, which is exactly
why this family stayed invisible to the sweep while the equality half was found and fixed.

`bun scripts/live-parity.ts --origin http://localhost:8787`: 69 passed, 2 known-deviation, 0
drifted, **0 failed**.

Direct verification, ours after the change vs the Scryfall column above — every row equal:

| query | Scryfall | ours before | ours after |
|---|---|---|---|
| `-pow>=1 e:khm t:creature` | 151 | 5 | **151** |
| `-cmc!=3 e:khm t:creature` | 151 | 45 | **151** |
| `-cn>=100 e:khm t:creature` | 151 | 60 | **151** |
| `-cn:100 e:khm t:creature` | 150 | 150 | **150** |
| `-r>=rare e:khm t:creature` | 99 | 99 | **99** |
| `-c>=2 e:khm t:creature` | 132 | 132 | **132** |
| `-produces>=2 e:khm t:creature` | 146 | 146 | **146** |
| `-nonsense>=1 e:khm t:creature` | 151 | 151 (+ a warning Scryfall omits) | **151**, silent |
| `-date<2022 e:khm t:creature` | 141 | — | **141** |
| `-pow>=1` (alone) | 33,599 | — | **33,599** |

The one residual: `-date:2021 e:khm t:creature` is 141 on Scryfall and **0** here, because our
`date:<bare year>` is already wrong in the POSITIVE direction — `date:2021 e:khm t:creature` is 0
for us and 141 for Scryfall, while `date:2021-02-05`, `date<2022` and `year:2021` are all right.
That is a parser-side value-parsing bug (#926 territory), pre-existing and independent; the rewrite
here just makes the negated form agree with our own positive form instead of disagreeing with both.

---

# The reach of the sweep — a standing statement of what this harness cannot see

> **Scope.** Everything above this line is about ONE divergence family. What follows is about the
> INSTRUMENT: why that family and four others were found by hand or by live comparison while
> `bun run parity-sweep` reported green over 529 cases, and what now stops the next five.
>
> The five are not five mistakes. They are four STRUCTURAL properties of a generated matrix, each of
> which hides an unbounded number of families. Each now has a guard rather than a patch.
>
> **Measured** against api.scryfall.com on 2026-08-16/17, against a store at
> `STORE_CONTENT_GENERATION` **32** / `ARCHIVE_FORMAT_VERSION` **2026081616**.

---

## 9. The four reasons, and where each guard now lives

| | property | what it hides | guard |
|---|---|---|---|
| **A** | the matrix is generated per-column from a FIXED PROBE TEMPLATE | a combination the template omits is omitted for **every column at once** | `REQUIRED_CELLS` / `UNREACHABLE_CELLS` over a four-axis reach grid computed from the cases themselves (§10) |
| **B** | probes are ANCHORED to a set | any anchor lacking a feature hides that feature for every probe using it | `anchorProbes` — one local request per (anchor, feature) pair (§11); `ENUM_DOMAINS` for the values no anchor reaches (§11.2) |
| **C** | a fixture field held CONSTANT across all rows | cannot discriminate any rule about that field | the audit in §12, and the counter-fixtures it justifies |
| **D** | a test written from the SAME MODEL as the code | cannot falsify that model | §13 — where a rule has arithmetic, the corpus needs a case whose expected value EXCEEDS what the wrong model can produce |

The five escaped families map onto these one for one:

* **negated comparison** — A. The cell `>= × negated-leaf` held **0 of 529** cases.
* **per-face colour** — A. Every colour probe was single-colour `c:`, the one shape a union bitmask
  already agrees with. NEW read 71 before the fix and 71 after.
* **per-face layout** — B. `e:khm` has no transform printing and no reversible printing at all.
* **generic mana** — C. `mana_fixture_store` has generic 0 in every one of its eight costs.
* **hybrid devotion** — D. `devotion:{r/g}` = 62 is reproduced *exactly* by the wrong model.

A harness whose blind spots are undocumented reads as thorough while being structurally unable to
observe what is wrong. §§10-13 are the documentation; the guards are what keep it true.

---

## 10. A — exactly what the generator can and cannot emit

Four axes, scanned off the generated cases by `scanLeaves` so the statement cannot drift from the
matrix it describes:

| axis | values |
|---|---|
| **operator** | `:` `=` `!=` `>` `>=` `<` `<=`, plus a bare word and `!`-exact |
| **polarity** | positive, negated leaf (`-cmc>=3`), negated group (`-(cmc>=3)`) |
| **value form** | bare word, quoted phrase, regex, mana symbols, number, date, colour letters, another column's name (`pow>=tou`) |
| **grouping** | top level, inside parens, an `or` arm, inside a negated group |

### 10.1 `operator × polarity` — the crossing that hid §1 for the life of this file

**Before** the backfill:

| operator | positive | negated-leaf | negated-group |
|---|---|---|---|
| `:` | 690 | 42 | 5 |
| `=` | 22 | **0** | **0** |
| `!=` | **0** | **0** | **0** |
| `>` | **0** | **0** | **0** |
| `>=` | 23 | **0** | **0** |
| `<` | 12 | **0** | **0** |
| `<=` | 11 | **0** | **0** |
| bare | 4 | **0** | **0** |
| `!`-exact | 6 | **0** | **0** |

Every negated cell but `: × negated-leaf` was empty. The template has exactly ONE negation slot per
column, always spelled `-<kw>:<v>`, and ONE comparison slot, always spelled `<kw><op><v>` with no
`-`. Nothing crosses them — not for `cmc`, not for `pow`, not for any of the 33 columns. So a rule
that applies to every comparison operator on every non-bitmask column was invisible in a matrix that
probed 33 columns and 529 cases.

That is property A in one table. The template's gaps are not per-column gaps; they are matrix-wide
gaps, and iterating the template over 33 columns makes a gap look like breadth.

**After**, with the negation and group families backfilled:

| operator | positive | negated-leaf | negated-group |
|---|---|---|---|
| `:` | 694 | 42 | 5 |
| `=` | 22 | — | — |
| `!=` | — | 6 | — |
| `>` | — | 2 | 1 |
| `>=` | 23 | 25 | 6 |
| `<` | 12 | 2 | — |
| `<=` | 11 | — | — |
| bare | 4 | — | — |
| `!`-exact | 6 | — | — |

`grouping × polarity` gained `in-negated-group × negated-group` = 12, the cell that separates
`-(cmc>=3)` = 39 from `-cmc>=3` = 151 — a binding fact about `-`, and the reason §1 is a *leaf* bug
rather than a negation bug.

### 10.2 `value-form × operator`, 33 populated cells

```
word × :=635          number × >==37        number × :=29         colour-letters × :=26
mana-symbols × :=23   quoted × :=14         word × ==11           number × <=9
column-ref × :=8      number × <==7         word × >==6           quoted × !exact=6
date × >==5           colour-letters × ==5  mana-symbols × >==4   word × bare=4
colour-letters × <==3 regex × :=3           date × :=3            date × <=3
date × !==3           number × !==2         date × >=2            number × ==2
mana-symbols × ==2    quoted × ==2          colour-letters × >==1 colour-letters × <=1
word × <=1            date × <==1           number × >=1          column-ref × >==1
word × !==1
```

Four of those cells were empty before the backfill, and each was a family nobody could see:

* **`word × =`** — `=` on a text column, where Scryfall collates exactly as `:` does. The matrix only
  ever spelled `=` against numeric and enum columns.
* **`colour-letters × =` and `colour-letters × <=`** — exact colour and colour subset. `c:rg` and
  `c:colorless` were the only colour shapes in the matrix, and they are the two a union bitmask gets
  right.
* **`mana-symbols × :` with a generic component** — `m:{2}`. The template's `m:{R}{R}{R}` and
  `m:{2}{W}{W}` are exact-symbol forms whose generic part never varies. That is property **C**
  happening inside the *matrix* rather than inside a fixture — the same defect class, one layer up.

### 10.3 What is NOT emitted, on purpose

Asserted empty, so a stale entry is itself a finding:

| cell | why it is not a gap |
|---|---|
| `regex × >=`, `regex × <=` | Scryfall has no ordering on a regex; `o>=/x/` is a parse error, not a query |
| `!exact × negated-leaf`, `!exact × negated-group` | `-!"Name"` is not syntax upstream accepts |
| `date × !exact`, `colour-letters × !exact`, `mana-symbols × !exact`, `column-ref × !exact` | `!` is a name-only operator, so it crosses with no typed value form |

The distinction between this table and §10.2 is the whole point of writing either down. Without it a
reader of the grid cannot tell a gap from an impossibility, and every future audit re-derives the
list from scratch — which is how `>= × negated-leaf` stayed empty through several rounds of people
looking at this file and concluding it was thorough.

---

## 11. B — anchor adequacy: eleven probes were comparing empty against empty

`anchorProbes` derives (anchor, feature) pairs from the CASES rather than from a declaration, so a
new anchored case is covered the day it is written. It runs against our own origin only — Scryfall
never sees it, because a vacuous anchor is a fact about the matrix, not about upstream.

Two rules, because negated probes need more than positive ones:

* **positive probe** — the anchor must contain at least one row matching the feature. Otherwise the
  probe compares an empty list against an empty list, which is not evidence of anything.
* **negated probe** — the anchor must be **split** by the feature (`0 < matching < anchor total`). A
  set every row of which matches answers 0 under an honored negation *and* 0 under a dropped one,
  which is precisely the shape of §1.

**Eleven of 75 pairs failed the first time it ran.**

| probe(s) | anchor | feature | measured |
|---|---|---|---|
| `op-card_layout-eq0` | `e:khm` | `layout:transform` | **0** — KHM has no transform printing at all |
| `op-card_frame_data-neg` | `e:tsp` | `frame:2015` | 0 |
| `op-creature_power-neg`, `op-devotion-neg`, `op-card_rarity_int-neg`, `op-card_legalities-eq0`, `op-price_eur-cmp1` | `e:khm` | `t:goblin` | 0 — **KHM has no Goblin**, and five probes leaned on it |
| `op-price_usd-eq0` | `e:khm` | `usd:0.02` | 0 |
| `op-price_usd-neg` | `e:lea` | `usd:0` | 0 |
| `op-price_usd-cmp1` | `e:khm` | `usd<0.03` | 0 |
| `op-flavor_text-quoted` | `e:dom` | `ft:"the multiverse"` | 0 (47 corpus-wide) |
| `op-card_watermark-neg` | `e:nph` | `wm:none` | 0 |
| `op-card_border-neg` | `e:khm` | `border:black` | **323 of 323** — negating it removes the whole anchor |
| `op-card_lang-neg` | `e:khm` | `lang:en` | **323 of 323** — see §11.1 |

The layout row is the third escaped family, exactly. All three `op-card_layout-*` probes anchor to
`e:khm`; `layout:transform e:khm` is 0 on both sides and `-layout:normal e:khm` is 0 on both sides,
so all three read `ok` before the per-face layout fix, after it, and throughout the period the data
was wrong. **A comparison of two empty lists had been counted as coverage for the entire life of the
file, three times over.**

The `t:goblin` row is the same defect with the multiplier visible: one wrong assumption about one
anchor silenced five probes across five unrelated columns.

All eleven are re-anchored in `VALUES` — `e:tsr` splits 289/410 on frame, `e:sld` splits 669/1722 on
border, `t:dwarf` replaces the Goblin KHM does not have, `usd:0.15 e:khm` has ten rows where
`usd:0.02 e:khm` has none, `ft:"the multiverse"` drops its anchor entirely. The check now reports
**0 inadequate anchors** over 73 pairs.

One of them converted straight into a divergence: `op-flavor_text-quoted`, vacuous before, now
reports a real representative-choice divergence on `Thirst for Knowledge`.

### 11.1 One declared exemption, with its reason

`e:khm` / `lang:en` is exempt. A bare `/cards/search` returns one English row per card on BOTH
sides, so no set anchor can split on language — every row matches `lang:en` by construction. The
`multilingual` group asks the same question the only way it can be asked: `lang-negated` runs
`-lang:en e:khm t:god` with `unique=prints`, where the non-English printings exist to be removed.

A **stale** exemption — one whose probe has since become adequate — is itself reported, so the list
cannot quietly outlive its reason.

### 11.2 The other half of B: an anchor's GAPS, not an anchor's emptiness

The adequacy check catches a probe whose anchor lacks the feature it NAMES. It cannot catch a probe
whose anchor lacks a *different value of the same column* — and that is the shape that hid the
reversible-card data, because `layout:reversible_card` was a value no probe ever spelled at all.

`ENUM_DOMAINS` is the standing answer: the full value domain of each enumerable column, one
corpus-wide case per value, no anchor to be wrong about.

| column | values | cases |
|---|---|---|
| `layout` | `normal` `split` `flip` `transform` `modal_dfc` `meld` `leveler` `class` `case` `saga` `adventure` `mutate` `prototype` `battle` `planar` `scheme` `vanguard` `token` `double_faced_token` `emblem` `augment` `host` `art_series` `reversible_card` | 24 |
| `border` | `black` `white` `silver` `gold` `borderless` `yellow` | 6 |
| `frame` | `1993` `1997` `2003` `2015` `future` | 5 |
| `rarity` | `common` `uncommon` `rare` `mythic` `special` `bonus` | 6 |

The list is the DOMAIN, not a sample: a layout Scryfall adds and this table does not carry becomes a
value the sweep *says* it cannot see, rather than nothing at all.

It paid immediately. `domain-layout-vanguard` is the only case in 665 that returns a Vanguard card,
and it found **`life_modifier` and `hand_modifier` absent from our card object** — two top-level
Scryfall fields this port never emitted, on a layout no anchored probe had ever selected.
`domain-layout-reversible_card` reports an `ordering-primary` divergence (a *different card* at the
same index, not a tiebreak) — the reversible family, finally visible.

---

## 12. C — the fixture constant-field audit

A field held constant across every row of a fixture cannot discriminate any rule about that field.
`mana_fixture_store`'s generic-0 is the proven case; this is the same audit run over every other
fixture that builds card-like rows — 15 `*_fixture_store()` helpers in
`vendor/sylvan_librarian/card_engine/src/tests.rs`, the two builder integration tests, the two engine
JSON fixtures, the four parser JSON fixtures, and the `memprobe gen` corpus the gate rests on.

Ranked by how load-bearing the crippled assertion is.

### 12.1 `memprobe gen` — the GATE's own corpus has 2 distinct cmc values

`engine/builder/examples/memprobe.rs`, `fn printing()`. It clones one of four template fixtures and
overwrites only id/name/text/set/number/artist/rarity/date/flavor/prices. **Every other Scryfall key
is verbatim from the template**, so across all 12,000 gate rows:

| field | distinct values corpus-wide |
|---|---|
| `cmc` | **2** — `1.0` (80%), `4.0` (20%) |
| `power`, `toughness` | **2** — absent (70%), `"1"` (30%) |
| `edhrec_rank` | **4** |
| `border_color`, `frame`, `watermark`, `finishes` | **1** each |
| `promo` `full_art` `digital` `oversized` `textless` `variation` `reserved` `story_spotlight` `game_changer` | **1** each — all `false` |
| legality `restricted` | **0 occurrences** |

Two gate steps rest on that corpus:

* **`memprobe compare`** (`scripts/gate.sh`, "native vs wasm store: same rows, same answers") orders
  by `cmc`, `power`, `toughness` and `cubecobra` among others. `cubecobra_score` is NULL on every
  row by construction; the other three have 2, 2 and 2 distinct values. **Those four orderings are
  one tie group each**, so a native-vs-wasm comparator divergence on any of them cannot be seen. The
  grid's own comment claims "`cmc` ~10 distinct values, `color` 6"; the true counts are 2 and 3.
* **`memprobe querybench`**, whose "OVER 1ms" flag is calibrated against these numbers, runs nine
  filter rows that match **nothing at all** on this corpus — `cmc>=5`, `power>=4`, `devotion>=3`,
  `mana:{2}{R}`, `c>=3`, `restricted:vintage`, `t:"artifact creature"`, and both multi-leaf `And`/`Or`
  rows. A regression in any of those code paths reports as healthy because it is timing an empty
  result set.

### 12.2 `roundtrip.rs` — `card_colors` and `card_color_identity` are the same object

`engine/builder/tests/roundtrip.rs`, 3 rows / 2 oracle cards. `card_row()` builds one `color_obj`
and assigns it to **both** columns. In `result_fields_reach_the_response()` — the test whose stated
purpose is "an extractor wired to the wrong source field returns null":

* `assert_eq!(card["color_identity"], json!(["R"]))` **cannot fail** if the extractor reads
  `card_colors`. That is exactly the wrong-source-field bug the test says it exists to catch.
* `card_rarity_int` is `0` on all three rows, so a hardcoded `0` passes `rarity == "common"`.
* `card_layout` is `"normal"` on all three, so a hardcoded default passes.
* Only games bit 0 is ever set, so a bitset with `mtgo`/`arena`/`astral` permuted passes.
* `planeswalker_loyalty_text` is `"X"` on every row *including the Instant*, so failing to gate
  printed loyalty on card type is invisible.

Also: the partition test cuts **2 oracle ids into 3 partitions**, so at least one is empty; and every
`illustration_id` is distinct, so `unique=artwork` is never distinguishable from `unique=printing`.

### 12.3 `plane_fixture_store()` — `edhrec_rank` is `None` on all 10 cards

`tests.rs:8688`, the most-reused fixture in the file (9 tests).
`run_query_plane_path_parity()` orders by `edhrec` and asserts the two paths return equal *pages*.
With `edhrec_rank` `None` everywhere the whole result is one tie group, so a plane path returning the
right SET in the wrong ORDER passes, as does a comparator that inverts or that treats `None` as `0`
rather than `u32::MAX`. The "pages must agree" assertion is a set assertion. The same test loops
`unique ∈ {card, printing, artwork}` over a store with one printing per card and all-distinct
illustration ids — it runs the identical query three times.

### 12.4 `numeric_plane_fixture_store()` — the "noncreature" is a creature

`tests.rs:9264`. The doc comment advertises "a noncreature card whose power/toughness are absent",
but the builder passes `TYPE_CREATURE` for all seven rows. `card_types` is constant, so any rule of
the form "`pow`/`tou` must be `Tri::Null` on a non-creature" cannot fail — the fixture has no
noncreature to admit.

### 12.5 `color_fixture_store()` — identity is assigned the same `u8` as colours

`tests.rs:13101`. `filter.rs`'s `ColorField::ColorIdentity => card.card_color_identity` could be
changed to `card.card_colors` and every assertion in both tests passes, including the exhaustive
6-op × 32-mask × 2-field grid. (`plane_fixture_store` does hold the two apart, so
`plane_parity_color_and_type_ops` closes that specific gap elsewhere — but the colour file itself
does not.) `color_indicator` is `0` on every card and every face.

### 12.6 `devotion_fixture_store()` — `mana_cost.cmc` is `0.0` on all 10 rows

`tests.rs:10771`. `mana_cost_of()` hardcodes `cmc: 0.0` and this fixture, unlike `mana_fixture_store`,
never overwrites it. A devotion implementation that leaked `cmc` into the comparison — added it, or
used it as a fallback when devotion is 0 — is invisible, because 0 is the additive identity on every
row. Cards 0 (no cost) and 9 (Instant, devotion zeroed) are indistinguishable to any predicate that
confuses the two. Every generic pip is 0 here as well, which is §12's headline defect present in a
second fixture.

### 12.7 Smaller, still real

* `legality_without_a_filter.rs` — 1 row, 3 formats. `FORMAT_SHIFTS` only ever gets 0/2/4, so a
  shift bug past three formats passes; with one card, a decoder that returns card 0's word for any
  lookup passes.
* `tests/engine/gather-wire-fixture.json` — 2 rows differing only in name/ids, `fields:["name"]`,
  `inline_rows:1`. The fixed 57-byte key tail is byte-identical between the two keys, so
  `compareKeys` mis-slicing the tie-break segments cannot be caught; the projection and the
  second-row frame offset are never walked.
* `tests/engine/partition-hash-vectors.json` — 48 vectors, all already lowercase and canonically
  hyphenated, so normalization is never exercised by the shared-vector test.
* Parser fixtures — 2,213 query→AST rows, genuinely broad (12 node types, 35 attributes). One
  constant: `error.type` is `"ValueError"` on all 518 error rows, and `parity.test.ts` asserts
  exactly that — an assertion about the FIXTURE, unfalsifiable by construction.

### 12.8 Structural constants shared by every `tests.rs` fixture

Via `stub_card` / `stub_printing` / `store_of`, unless a fixture explicitly overwrites them:

* **`foreign: vec![]` on every fixture store** — `include_multilingual` is a no-op throughout
  `tests.rs`. `core_api.rs`'s `multilingual_store()` is the only place that is not true.
* `card_artist_vid`, `card_set_code`, `card_rarity_int`, `card_border_id`, `price_usd/eur/tix`,
  `collector_number_id`, `card_legalities` — constant on every stub printing.
* `released_at_int` and `prefer_score` are functions of the printing's index *within its card*, so
  the first printing of every card carries the identical date. `orderby=released` over any
  single-printing fixture is a total tie.
* `illustration_id` is strictly increasing, so `unique=artwork ≡ unique=printing` in every fixture
  but the one that overwrites it deliberately.

### 12.9 The counter-example worth copying

`fuzz_store_n()` (`tests.rs:2272`, backing ~25 tests) is the right model and shows the audit is not
asking for the impossible: independent random draws for colours, a corpus-weighted cmc with a
deliberate half-mana injection, type-gated power/toughness/loyalty, per-format random legality words,
a six-value border domain including `None`, three independently fuzzed price columns. Nothing
meaningful is pinned. `rarity_plane_fixture_store`, `narrow_fixture_store`, `border_planes_fixture_store`
and `legal_plane_fixture` are clean for the same reason.

---

## 13. D — a test written from the code's own model cannot falsify it

The devotion case is the proof. A per-lane-OR model of `devotion:{r/g}` reproduces Scryfall's
headline **62 exactly**, and every unit test written from that model passed. The model is wrong, and
the only way to see it is a case whose expected value exceeds what the wrong model can produce:

| query | Scryfall | what per-lane-OR can produce |
|---|---|---|
| `devotion:{r}{r}` | 7 | 7 |
| `devotion:{g}{g}` | 8 | 8 |
| `devotion:{r/g}` | 62 | 62 — **agrees, and proves nothing** |
| `devotion:{r/g}{r/g}` | **16** | at most **15** (7 ∪ 8) |

16 > 15 is the entire falsification. `{r/g}` sums into BOTH lanes, so a card costing `{R/G}{R/G}`
has R-devotion 2 and G-devotion 2 and satisfies a query no union of the two mono buckets can reach.

**The rule this gives the corpus:** where a rule has arithmetic, a case is only evidence if its
expected value lies outside the range the plausible wrong model spans. A case inside that range is a
case that agrees with both models, and adding more of them adds confidence without adding
information — which is what 529 green cases were doing.

Three such margins are now in the matrix, one per arithmetic rule:

| rule | margin case | wrong model's answer | true answer |
|---|---|---|---|
| hybrid devotion sums into both lanes | `devotion:{r/g}{r/g}` | ≤ 15 | **16** |
| generic mana is a counted pip, not a cmc | `m={r}{r} m:{2} t:creature` | 24 (cmc reading) | **0** |
| generic mana, anchored | `m:{2} e:khm t:creature` | 142 (cmc) | **102** |

The Rust side carries the same discipline: `generic_mana_is_a_counted_pip_not_a_cmc` exists
*because* `mana_fixture_store` cannot see the rule, and says so in its own comment rather than
extending the blind fixture.

---

## 14. Before and after — the count RISES, and that is the blind spot becoming visible

| | cases | NEW list-level | NEW object paths | harness blind spots |
|---|---|---|---|---|
| **before** | 329 query + 200 peripheral = **529** | **63** | **1** | not measured — there was no check |
| **after** | 465 query + 200 peripheral = **665** | **82** | **3** | 11 found, 11 fixed, **0 remaining** |

**+19 list-level and +2 object paths is the instrument getting better, not the port getting worse.**
Not one line of `src/` or `engine/` changed in this work; the entire delta is cases that did not
exist and anchors that could not discriminate. Read the other way round: 63 was never the number of
divergences, it was the number of divergences a matrix with 15 populated operator×polarity cells and
eleven empty-vs-empty probes was able to reach.

### 14.1 What the new cases actually found

| family | finding |
|---|---|
| `colour-exact-five` (`c=wubrg`) | Scryfall 60 vs ours **61** — the extra row is `Mechtitan // Mechtitan (sld/1969)`, a **reversible card**. Exact colour on a reversible printing, the per-face colour class the sweep could not reach. |
| `mana-x-and-generic` (`m:{X} m:{2} t:sorcery`) | Scryfall 25 vs ours **28** — the three extra are split cards (`Cut // Ribbons`), so our mana matching unions both halves' costs where Scryfall does not. |
| `eq-text-artist` (`a="rebecca guay"`) | 166 vs 165, and `eq-text-artist-bare` reports a 7-row representative divergence. `=` on a text column had never been spelled. |
| `eq-text-watermark` (`wm=izzet`) | 33 vs 32. |
| `domain-layout-vanguard` | **`life_modifier` and `hand_modifier` absent from our card object** — two top-level fields no other case in 665 could select. |
| `domain-layout-reversible_card` | `ordering-primary`: a *different card* at index 39, not a tiebreak. |
| `domain-frame-*`, `domain-rarity-*`, `domain-border-*` | the representative-choice family at corpus scale — 31 rows on `frame:1993`, 16 on `frame:1997`, 14 on `frame:2003`. Pre-existing, newly measurable across the whole value domain instead of inside one set. |
| `op-flavor_text-quoted` | a probe that was vacuous, re-anchored, and immediately produced a real divergence. |

### 14.2 What the new cases DID NOT find, which is also a result

**The whole negation family — 45 cases — is green.** Every tautology row answers the anchor's 151,
every honored row keeps its count, the `date`/`year` asymmetry reproduces on both sides, and every
`-( … )` group form matches. Likewise `devotion` (9 cases, including the 16 > 15 margin) and the
generic-mana anchored rows. The backfill's job here was to *confirm* §1's fix against the boundary it
claims, and it does — including the half a careless fix would break.

### 14.3 Movement not attributable to this change

Eight `order=released` tie findings moved between the two runs (`order-ties-released`,
`page-artist-guay-released` ×4, `real-recent-legendaries`, and a kind-flip on `real-art-search` and
`real-flavor-hunt`). Those cases tie on a live release date and the runs straddle a Scryfall corpus
update; they are vintage noise in both directions, not signal from the backfill.

### 14.4 Gate

`bun scripts/live-parity.ts --origin http://localhost:8787`: **88 passed, 2 known-deviation, 0
drifted, 0 failed.**

---

## 15. One harness defect found on the way: the cache was not written atomically

`fetchScryfall` wrote its per-day cache entry with a bare `writeFileSync`. A run killed part-way
through a write leaves a **truncated** entry at a key every later run reads as a hit, and the parse
failure does not surface as a cache error — it surfaces as `SyntaxError: Unterminated string` filed
as a NEW divergence against whatever case happened to want that path. One `^C` produced five
invented divergences against five innocent queries, on five different cards.

Fixed twice over: the write is now temp-file-plus-`rename` (atomic within a directory, with the pid
in the temp name so two harnesses cannot collide), and the read treats an unparseable entry as a
MISS rather than an exception, because `scripts/live-parity.ts` shares this directory and its
pre-existing entries were written the old way.

This is the same defect class as everything above: a failure whose observable form is a false
statement about the SUBJECT rather than an error in the INSTRUMENT.

---

# 16. `order=released`: which SET comes first inside a shared release date is NOT derivable

The date grouping and the within-set collation are settled (`478815e`): `order=released` groups a
shared release date by SET first, then by `(collector_number_int, collector_number)` inside the set.
What was still open is the **set half** — given two sets whose cards share a release date, which set
comes first. `set_rank`, the dense rank of the set CODE, is the proxy currently packed into
`order=released`'s second key. This section is the attempt to replace that proxy with the real rule,
and its result is a negative one: **there is no rule to find in anything a client can see.**

Everything below is offline. api.scryfall.com was returning 60-second rate-limit bodies on every
request, so not one probe was sent; the evidence is the on-disk per-day response cache
(`live-parity-cache/`, 5,096 entries over 2026-08-16 and 2026-08-17) plus the cached `/sets`
listing (1,047 sets) and the six 2026-08-16 bulk dumps.

## 16.1 The evidence: 34 adjacent same-date set pairs, recovered from the cache

The cache keys are hashes, so an entry does not record the path it answered. The ordering evidence
was recovered structurally instead. 3,870 cached bodies are card Lists; a body is accepted as an
`order=released` listing only if

- its `released_at` sequence is monotone (which fixes the orientation, `asc` or `desc`), and
- inside every `(date, set)` run the collector numbers ascend under the established
  `(collector_number_int, collector_number)` collation once normalised to ascending, and
- no set reappears inside a date group (the 102/102 contiguity result), and
- at least one run is 3 cards long, so the collation test is not vacuous.

That last clause is load-bearing. **A first pass without it admitted `order=name` listings and
manufactured two false pairs** — `khm < akhm` came from a 3-row `Firja` listing that is alphabetical
by NAME and only incidentally date-ascending, and it is exactly the kind of pair that would have
sent the derivation off after an Art-Series rule. The strict pass rejects 149 of 188 candidate
listings and keeps 39, yielding **34 distinct adjacent same-date set pairs, with zero
contradictions** — no pair is observed in both orders anywhere in the cache.

Four of the 34 are confirmed from BOTH an ascending and a descending listing (`3ed<fbb`,
`4ed<4bb`, `sos<psos`, `tdm<tdc`), which independently re-confirms that `dir=desc` is the exact
reversal of `dir=asc`.

Sets whose cards carry a release date different from the SET's own date show up here and are kept —
`fdn` cards dated 2026-04-24, `mar` cards dated 2026-06-26, `plst`, `pmei`, `pf26`, `psus`. The
grouping key is the CARD's `released_at`, not the set's.

## 16.2 Fit counts on those 34 pairs

| key | fit |
| --- | --- |
| **set `code` ASC (what ships today)** | **30 / 34** |
| `code` with digits stripped ASC | 30 / 34 (degenerate variant of the same) |
| `icon_svg_uri` path ASC | 24 / 34 (also code-derived) |
| `tcgplayer_id` DESC, nulls first | 22 / 34 |
| `card_count` ASC | 21 / 34 |
| `set_type` ASC | 20 / 34 |
| `id` (set UUID) DESC | 18 / 34 |
| `/sets` listing index ASC | 18 / 34 |
| `name` DESC | 18 / 34 |
| `set_type` in the API-docs enum order DESC | 17 / 34 |
| `parent_set_code` grouping (`parent or self`) ASC | 11 / 34 |

The set code's four misses are `4ed<4bb`, `snc<psnc`, `sos<psos`, `tdm<tdc` — in every one, a CHILD
set whose code sorts earlier than its parent's is nevertheless placed AFTER the parent.

To answer a question left open by the earlier pass: the rejected `id` IS the set UUID — `/sets`
carries exactly one `id`, the UUID, and `uri` is derived from it. There is no second identifier to
try. Byte order and reversed-byte order were both tested.

## 16.3 Proof that no sort key over the visible fields exists

A lexicographic sort key `(f1, f2, …)` can only fit the data if `f1` decides no observed pair
WRONGLY — a key's first component never gets a second chance. Remove the pairs `f1` decides, and the
same must hold of `f2` on what is left. Iterating that to a fixpoint is exact, not greedy: if a
feature is zero-wrong on the remaining pairs it can always be inserted at that position without
harm, so the fixpoint is independent of which zero-wrong feature is taken first.

Run over **40 features** — every field `/sets` returns (`code`, `name`, `id`, `set_type`,
`card_count`, `printed_size`, `digital`, `foil_only`, `nonfoil_only`, `tcgplayer_id`, `mtgo_code`,
`arena_code`, `block_code`, `block`, `parent_set_code`, `released_at`, `icon_svg_uri`, plus the
listing position) and derived forms of each (presence flags, lengths, the icon path, the icon cache
buster, code with digits split off, `parent or self`, the parent's name, the parent's release date,
the doc-order `set_type` enum, case- and punctuation-folded names) — in **both directions**, the
fixpoint leaves **9 pairs undecided**:

```
4ed<4bb  ecc<ecl  eoc<eoe  hob<hoc  lcc<lci  soc<sos  tdm<tdc  tmc<tmt  trc<trk
```

**No lexicographic key over the visible set attributes, at any depth, in any order, reproduces the
observed order.** Two flat contradictions inside those 9 say why:

- `soc`(commander) before `sos`(expansion), but `tdm`(expansion) before `tdc`(commander). Any
  `set_type` rank must put commander both before and after expansion.
- `tmc`(child) before `tmt`(parent), but `tdm`(parent) before `tdc`(child). Any parent/child rule
  must put the child both before and after the parent.

Both come out of **one** cached response — a single 175-row `dir=desc` listing holds `sos, soc` …
`tmt, tmc` … `tdc, tdm` … `khm, khc`. There is no orientation ambiguity to appeal to.

## 16.4 The airtight version: two pairs identical in every visible field comparison, ordered opposite

Stronger than "no lexicographic key": no comparator that reads the two sets' visible attributes and
compares them can work, because two of the observed pairs have **the same sign on all 40 field
comparisons and opposite observed orders**.

| | `set_type` | `parent` | `card_count` | `tcgplayer_id` | `code` | `name` | `id` | `mtgo` | `block` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ecc` Lorwyn Eclipsed Commander | commander | `ecl` | 176 | 24464 | `ecc` | …Commander | `805b5a0c…` | `ecc` | `cmd` |
| `ecl` Lorwyn Eclipsed | expansion | — | 408 | 24463 | `ecl` | — | `5d293ad8…` | `ecl` | — |
| `tdc` Tarkir: Dragonstorm Commander | commander | `tdm` | 413 | 24234 | `tdc` | …Commander | `bca9779c…` | `tdc` | `cmd` |
| `tdm` Tarkir: Dragonstorm | expansion | — | 427 | 24232 | `tdm` | — | `1361ca81…` | `tdm` | — |

Child-vs-parent: same type pair, same block, child's code sorts EARLIER, child's name sorts LATER,
child's card count LOWER, child's tcgplayer id HIGHER, child's UUID HIGHER, child's mtgo code
earlier. Identical in every comparison. api.scryfall.com answers **`ecc` before `ecl`** and **`tdm`
before `tdc`**. Different dates (2026-01-23 and 2025-04-11), so no "one import batch" escape.

Two more witnesses of the same exact-signature kind: `lcc<lci` against `tdm<tdc`, and `tmc<tmt`
against `tdm<tdc`. `eoc<eoe` and `trc<trk` are one field short of being a fourth and fifth (they
differ from `tdm<tdc` only in `/sets` listing position and in UUID order respectively — neither of
which fits the rest of the data).

## 16.5 The dead lead, recorded so it is not re-run: the bulk dumps are id-sorted

The hope was that a dump preserves an insertion sequence the API does not expose. It does not. Every
2026-08-16 bulk file is sorted by its own identifier, with zero descents:

| file | rows | order |
| --- | --- | --- |
| `default_cards` | — | `id` ascending |
| `unique_artwork` | 54,143 | `id` ascending, 0 descents |
| `art_tags` | 11,530 | `id` ascending, 0 descents |
| `oracle_tags` | 4,522 | `id` ascending, 0 descents |
| `oracle_cards` | 38,626 | `oracle_id` ascending, 0 descents (19,268 descents on `id`, which is the wrong key for that file) |

A UUID sort carries no sequence information. The dumps cannot answer this question.

## 16.6 What this is, most likely, and what would confirm it

The shape of the residue fits a **stored sequence** — an internal auto-increment on Scryfall's sets
table, i.e. the order the set rows were created. It is alphabetical by code most of the time because
a release's sets are created in one batch; it deviates exactly where a set was added off-batch
(`4bb` and `fbb`, the Foreign Black Border reprints; `psos`/`psnc`, promo sets filled in after the
main set) or created in a different order (`tdc`). Nothing about that is a function of any field the
API publishes.

That story is not proven — it is the hypothesis consistent with a proof that the order is not
derivable. What would confirm it is **temporal instability**: a stored sequence can be re-issued,
a computed key cannot. The cache holds two consecutive days and they agree, which is far too short a
baseline to say anything. That test needs months, not a session.

## 16.7 Verdict, and why the code was not touched

`assign_set_ranks` keeps ranking by set code. At **30/34** it is the best key available by a wide
margin — the next INDEPENDENT candidate (`tcgplayer_id` DESC) fits 22 — and the 4 it misses are not
reachable by any comparator that reads only what `/sets` publishes. No code changed, so no
`set_rank` values changed, so no store rebuild and no generation bump is implied by this section.

The four misses are worth naming as the permanent cost, since they will not be fixed: `4ed`/`4bb`,
`snc`/`psnc`, `sos`/`psos`, `tdm`/`tdc`. Each puts one small set on the wrong side of one boundary
inside one shared release date.

---

# 17. Triage of the 78 NEW findings at generation 37, matrix 665

> **Provenance.** `bun run parity-sweep --gap 1000` re-run 2026-08-17 against a local dev server on
> the current tree, store `card-store-v2026081702-1787001512`, `STORE_CONTENT_GENERATION` **37**.
> Reproduced the reported run exactly: **465 query + 200 peripheral = 665 cases**, **78 NEW**
> list-level + **1 NEW object path**, 31 INCONCLUSIVE, and **0 requests to api.scryfall.com against
> 700 cache hits**. Every count below is at matrix size 665 and is NOT comparable with any figure
> taken at 529.
>
> Triage cost **163 live requests**, serial, spaced 1.1 s. Everything else came from
> `live-parity-cache/`.

## 17.1 The buckets, and the count in each

Sections 16 and commit `5440875` between them retire one class; snapshot skew was the expected
second; real defects the third. The 78 do not fit in three, and forcing them would hide the most
useful distinction in the set — so there are six, and the two extra ones are named rather than
smuggled into a neighbour.

| bucket | n | what it means |
|---|---|---|
| **(a) proven NOT DERIVABLE** | **10** | an unpublished ordinal on Scryfall's side; a proof exists |
| **(b) snapshot skew** | **0** | see §17.2 — there is none, and that is a measurement, not an omission |
| **(c) real defect** | **28** | a rule that IS derivable and this port gets wrong |
| **(d) recorded residual** | **33** | a known, measured, deliberately-accepted loss — NOT proven undecidable |
| **(e) not a defect** | **4** | this port answers a question Scryfall does not implement |
| **(f) could not determine** | **3** | stated plainly rather than forced |

## 17.2 (b) is zero, and the reason is checkable

`scripts/store-age.ts --local` reports Scryfall's newest dump (2026-08-17T21:18:06Z) already in the
served store, and the sweep's own volatile-shape line shows the two corpora within 1% on every
price and rank column. Every membership divergence in the 78 was chased to a rule rather than a
vintage: `!"Abomination"`, `!"Active Volcano"`, `!"Angelic Page"`, `!"Burakos, Party Leader"`,
`!"Daxos, Blessed by the Sun"` and `!"Aang, Swift Savior"` return **byte-identical printing lists**
on both sides under `unique=prints`, so where the two answers differ it is the SELECTION that
differs and not the corpus. The `usd>=500` gap looked exactly like skew — 205 against 84 — and
§17.3 shows it is not.

## 17.3 (c) The seven real defects

### C9 — `has:` is a TOTAL alias of `is:` — **FIXED in this commit**

`has:split` is 126 upstream and a 404 here. `HAS_EXPANSIONS` was built by probing `has:`-FLAVOURED
candidates, so every value nobody thought to spell against `has:` was missing. Measured on 22
values spanning the whole `is:` vocabulary: `is:X` and `has:X` agree on `total_cards` **22 of 22**,
and a value that is neither stays a 400 upstream. `src/parser/rewrite.ts` now falls back
`has:X` → `is:X` for every supported `is:` value, with `HAS_EXPANSIONS` keeping precedence so
`has:watermark` stays a presence test. **LOCAL** — the parser is this port's.

### C8 — `t:<canonical type>` matches the type WORD, not a substring

`t:god` is 96 upstream and **104** here; the 8 extra are every **Demigod** in the corpus. Scryfall's
`t:` is a substring match in general — `t:gob` = `t:goblin` = 563, `t:emigod` = `t:demigod` = 8,
`t:reature` = `t:crea` = 18,753, all agreeing on both sides — and switches to an exact TYPE-WORD
match when the value is a canonical type name. `warrior` shows the same rule from the other side:
`t:rrior` is 1,294 on both, and `t:warrior` is **1,298** upstream because the canonical path reaches
subtypes Scryfall indexes but never prints (`Burakos, Party Leader` matches `t:orc` and all four
party classes while its `type_line` is `Legendary Creature — Orc` on BOTH sides).

**This one anchor poisoned three probes.** `op-card_set_code-neg`, `op-released_at-eq0` and
`op-released_at-cmp0` are all filed against `-e:khm`, `date:` and `date>=` and every one of their
extra rows is a Demigod. That is property **B** of §11 happening again, and the adequacy check
cannot see it: `t:god` is not a vacuous anchor, it is a WRONG one.

Route: **#927** (engine — the filter needs the canonical type catalog, which
`CATALOG_NAMES` already carries). Not fixed here: it needs a Rust filter change and a wasm rebuild.
The Burakos half is *not* derivable from any published field and is a separate, permanent 1-card
residual per party class.

### C10 — `usd`/`eur` are `COALESCE(nonfoil, foil)` upstream; this port reads nonfoil only

`usd>=500` is 205 upstream and **84** here, `eur>=400` 375 against 198. Measured on the 175 rows of
`usd>=500 unique=prints`: **99 have `prices.usd` NULL and `usd_foil >= 500`**, 76 have a plain
`usd >= 500`, and **zero** have `usd < 500` with a high foil. So it is a fallback when nonfoil is
absent, not a maximum — foil-only serialized and borderless printings are precisely the expensive
ones. `tix` has no foil column and agrees exactly (14 = 14), which is the control.

Route: **#927** (engine/builder — the stored price column). Not fixed here: it changes a stored
column, so it needs `STORE_CONTENT_GENERATION` bumped and a full rebuild.

### C1 — the printing rank has no LANGUAGE key, so a foreign-only slot outranks the English one

`ranks.rs` orders DISTINCT `(released_at, set_code, collector_number)` slots by
`pin, released_at DESC, cn ASC`, and its module doc claims "ENGLISH STILL LEADS ITS OWN SLOT". It
does — and nothing makes it lead ACROSS slots. `RANK_STEP` is 2048, so `prefer_score`'s `+40`
language term (and `+14` border, `+6` paper, `+42` frame) can never influence a cross-slot choice.
A set printed only in one foreign language therefore wins on date alone. Four narrowed pairs,
measured live, one request each:

| card | candidates (in scope) | Scryfall | ours |
|---|---|---|---|
| Active Volcano | `leg/130:en@1994-06-01` `bchr/43:ja@1995-07-01` `chr/43:en@1995-07-01` | `chr/43:en` | `bchr/43:ja` |
| Abomination | `leg/87:en@1994-06-01` `4bb/117:es@1995-04-01` `ren/46:fr@1995-08-01` | `leg/87:en` | `ren/46:fr` |
| Abyssal Specter | `8ed/117:en` `8ed/117★:en` `ddc/40:en` `dpa/18:en` `ps11/60:es@2011-01-01` | `ddc/40:en` | `ps11/60:es` |
| Darksteel Juggernaut | `som/150:en@2010-10-01` `pmei/2010-1:ja@2010-12-01` | `som/150:en` | `pmei/2010-1:ja` |

Scryfall picks an English printing in every one. Adding an `is_english` key directly after `pin`
fixes three of the four outright; Abyssal Specter still lands on `dpa/18` rather than `ddc/40`,
which is the ordinary §17.4 residual and a different question. Note `bchr/43` and `chr/43` share a
release date AND a collector number, so today the two slots are separated by nothing at all —
`sort_unstable_by_key` on an exact tie, which is not even deterministic.

Route: **LOCAL** — `engine/builder/src/ranks.rs` is this port's crate; upstream computes the
representative from `prefer_score` alone, where `+40` does decide it, so upstream does not have
this bug to fix. Not fixed here: it changes every `prefer_score` in the archive, so it needs a
`STORE_CONTENT_GENERATION` bump and a rebuild.

### C11 — autocomplete: the length metric and the extras exclusion

The one NEW object path, resolved on its own as asked. `data.*` differs at 18 of 20 positions for
`q=lig`, and it is two independent rules, both measured, plus one residual:

1. **Ordering.** Upstream's engine (`core_api.rs::autocomplete`) mirrors upstream's SQL
   `ORDER BY rank, length(card_name), card_name`, and `src/engine/partitioned-engine.ts`'s
   `mergeAutocomplete` mirrors that in turn. **Scryfall measures the length with spaces and
   punctuation REMOVED.** Counting adjacent inversions in Scryfall's own output, over four
   prefixes: `lig` 2 squashed / 6 raw, `sha` 2 / 6, `bol` **0** / 2, `goblin w` **0** / 3. Ours is
   0 raw by construction and 1–5 squashed. `Light 'Em Up` (9 squashed, 12 raw) sitting third,
   before `Lightwalker` (11), is the whole difference in one row.
2. **Selection.** Scryfall's catalog EXCLUDES extras. The three names in our 20 and not theirs are
   `Shark` and `Shard` (Token Creature / Token Enchantment), `Lightning` (a `memorabilia`
   front-card) and `Lightning Colt` (`cmb2`, a funny playtest set).
3. **Residual, unexplained.** `Light of Promise` (14 squashed, a normal m21 card) is excluded while
   `Light Up the Night` (15) is included, and the order WITHIN one length is not alphabetical. That
   is one inversion in 20 and I could not derive it.

Route: **#927** (the catalog is the engine's). Not fixed here: (1) and (2) are proven and (3) is
not, and the differential `autocomplete_merge_key_matches_the_single_store` pins the TS merge to the
Rust key, so the two must move together.

### C12 — `order=name` ties between DISTINCT cards sharing a name break on `oracle_id` here

Five findings, one rule. Where several different cards print the same name, our secondary key is the
store's row order, which is `oracle_id` ASC — verified: the oracle-id prefixes of our
`Knight of the Kitchen Sink`, `Everythingamajig`, `Alien`, `Elemental // Elemental` and
`Fast // Furious` runs are strictly ascending in every case. `oracle_id` is a UUID, so this is a
hash order with no relation to anything Scryfall does. Scryfall's is consistent with
`(set_code, collector_number)` on four of the five — `ust/12a…12f`, `tust/11` then `tust/17`,
`mh2/123` then `unk/CR15a`, `tmsh` `tpip` `twho` — and contradicts it on `Everythingamajig`
(`ust/147c, 147f, 147b, 147a, 147e, 147d`), which is the stored-sequence signature again.

Route: **LOCAL**, and expensive — the tie-break lives in `encode_sort_key`'s tail, so changing it is
an `ARCHIVE_FORMAT_VERSION` bump. Recorded, not fixed. Worth doing on the 4-of-5 evidence, not on
this session's budget.

### C14 — `next_page` echoes the query's smart quotes

`q=o:“draw”` comes back as `q=o:"draw"` in Scryfall's `next_page` and verbatim here. One row,
cosmetic, and a client that follows the link is unaffected because our own parser accepts both.
Route: **#928** (responder).

### Also found while triaging the INCONCLUSIVE, and bigger than anything above

**`*` power/toughness compares as 0 upstream.** `toughness<1` is 434 there and **273** here;
`tou=0` is 432 against 272; and Scryfall's `tou:*` answers **432** — the same 432 — while ours is a
400. `Abominable Treefolk` is `*/*` and matches upstream. §6 of this file noted the anomaly in
passing ("power/toughness are text columns with `*` values on their side. Not addressed here") and
never sized it: it is **160 cards**. Route **#927**.

**`is:vanilla` is 363 upstream and 18,753 here** — which is exactly `t:creature`. Noted once,
in passing, from the `has:` work; it is not one of the 78 and is not chased here.

## 17.4 (d) The 33 recorded residuals — and why `plst` is NOT the proven class

**The instruction was to check rather than assume, and the answer is that these are a different
question from the `unique=art` proof.** `5440875` proved the ARTWORK representative is a fixed
internal ordinal: no field separates the 4 from the 35. The `unique=cards` representative is not
that. `ranks.rs` establishes by Kahn's algorithm over 24,943 constraints that **0 of 10,557 cards
contradict a total order**, so a score exists; the pin answers it exactly (.9999) whenever the
filter contains the pinned printing; and 96.24% of the pin-EXCLUDED class falls out of
`released_at DESC, cn ASC`. The 28 `plst`/variant findings are that rule's residual, which
`ranks.rs` names in its own module doc — `plst/USG-4`, `plst/MMQ-172`, `plst/FUT-174`,
`plst/DDN-42`, `sld/901` — and declines to fix, because demoting `plst` by set code is worth
+0.35pp and "a hardcoded set code is the wrong trade for a third of a point".

New evidence, three narrowed pairs, one request each, that says the residual is SIGNAL and not
noise — in every one Scryfall picks the OLDEST candidate, which is the exact opposite of the
fitted `released_at DESC`:

| scope | candidates | Scryfall | ours |
|---|---|---|---|
| `!"Angelic Page" a:guay` | `usg/4@1998-10-12` `brb/4@1999-11-12` `plst/USG-4@2024-08-02` | `usg/4` | `plst/USG-4` |
| `!"Arms Dealer" frame:1997 t:goblin` | `mmq/172@1999-10-04` `plst/MMQ-172@2024-08-02` | `mmq/172` | `plst/MMQ-172` |
| `!"Kiki-Jiki…" t:goblin r:rare` | `chk/175@2004-10-01` `plst/CHK-175@2022-02-18` | `chk/175` | `plst/CHK-175` |

And the pin itself is not in doubt: `!"Angelic Page"`, `!"Arms Dealer"` and `!"Kiki-Jiki, Mirror
Breaker"` under bare `unique=cards` answer `jmp/88`, `m13/120` and `ima/136` on BOTH sides. The
divergence appears only where the filter excludes the pin, exactly as `ranks.rs` says.

So: **not proven undecidable, and not snapshot skew.** A derivable feature exists and was measured
and declined. It stays declined here — one session's three pairs is not the evidence that should
overturn a 16,045-observation fit with a held-out 30% — but it is filed as an open engine question
rather than as a closed one.

The other 5 in (d) are already-recorded deferrals: `unique=art`'s cross-card SCOPE (`c7d8cf3`,
`5440875` — 3 findings, and `scripts/live-parity-cases.json` is being extended for it by another
agent right now, so nothing here touches it) and the reversible-card name (`c1b087a`, 2 findings).

## 17.5 (e) Four that are not defects

`order=cubecobra` is an UPSTREAM ordering; api.scryfall.com does not implement it. Proved rather
than assumed: Scryfall's `order=cubecobra` output is **byte-identical to its `order=name`** in both
directions on `e:khm unique=prints`, so it silently falls back. Serving an ordering Scryfall lacks
cannot break a client that only calls Scryfall's — the same argument the ledger already makes for
`/cards`. **These want a ledger entry in `scripts/live-parity-cases.json`, which this session did
not write because another agent holds that file.**

## 17.6 (f) Three I could not determine

* `multilingual-true` (2) — with `include_multilingual=true`, Scryfall's `order=name` tie puts
  `khm/40 de` ahead of `khm/302` and ours the reverse. A cross-LANGUAGE tie-break, which C1's
  cross-slot fix does not reach and which no probe here separated.
* `order-color-desc` (1) — `e:khm order=color dir=desc unique=prints`: `Faceless Haven (khm/255)`
  against `A-Bretagard Stronghold (khm/A-253)`, both `[]`. A tie among colourless rows where one
  side is an Arena-rebalanced row; the `dir=asc` twin is INCONCLUSIVE rather than NEW, so the two
  directions do not even agree about what kind of divergence this is.

## 17.7 The 31 INCONCLUSIVE

Every one is INCONCLUSIVE for the SAME structural reason and it is the harness's, not the subject's:
the sweep marks a total or a membership divergence inconclusive when the result exceeds one page,
because page-1 evidence cannot account for rows in a tail neither side showed. That is a correct
refusal, not a gap in the corpus — no reference data is missing, and no mode is unsupported.

Underneath the refusal, **29 of the 31 resolve to causes already named above**, which is what says
nobody had looked rather than that nobody could:

| findings | cause |
|---|---|
| 5,6,7,8,21,22 | **C10** — `usd`/`eur` foil coalesce |
| 3,4 | **`*` power/toughness compares as 0** (§17.3), 160 cards |
| 1,2 | **C8** — `Burakos, Party Leader`, the party-class subtypes Scryfall indexes and never prints; the permanent, non-derivable half |
| 25,26,27,29 | **C1** — foreign-only slot outranks English (`psal/C14 es`, `ren/46 fr`, `bchr/43 ja`) |
| 28 | **C2** — `plst` |
| 20,23,24,30,31 | **C3** — same-card variant blocks |
| 9,10,11,12,…,19 | ties on `order=color` / `order=usd` / `order=eur` over `e:khm`, 3 rows each, all four `dir=` spellings of the same case counted separately |

The remaining 2 are the `order=color asc/auto/nodir` group, which is §17.6's second undetermined
item seen from the other direction.

## 17.8 What was fixed here, and what was not

Fixed: **C9** only. Everything else in (c) needs either a Rust filter change plus a wasm rebuild
(C8, C11, the `*` p/t family) or a stored-column change plus a `STORE_CONTENT_GENERATION` bump and
a full rebuild (C10, C1) or an `ARCHIVE_FORMAT_VERSION` bump (C12) — none of which is a thing to
start behind a triage pass, and `bun run gate` was off-limits this session. Each carries its route
above so the next unit of work does not re-derive the rule.

---

# 18. `/sets` intra-date ordering is NOT derivable either — and it is a DIFFERENT ordinal from §16

§16 proved that which SET comes first inside a shared release date, in an `order=released` CARD
listing, is not a function of anything `/sets` publishes. The four `/sets` object findings
(`ref-sets-list`, `http-sets-trailing-slash`, `data.0.code` and `data.0.search_uri`) are the same
QUESTION asked of the `/sets` listing itself, and they are not the same ORDERING.

## 18.1 The divergence is entirely intra-date

Both sides return **1,047 sets**, and matching by `id` there are **0** code, name or date mismatches
— the objects agree. **352 of 1,047 positions differ, and all 352 have the same `released_at` as
the row the other side put there.** So `released_at DESC` is exactly right on both sides and the
whole divergence is the collation inside a date. `data.0` differs only because Scryfall leads with
`ttrk` (Star Trek Tokens) and we lead with `trk` (Star Trek), both 2026-11-13 — the sweep's
positional object comparison then reports six leaf paths for one ordering fact.

## 18.2 It is not §16's ordinal

§16 observed `trc < trk` in a card listing. Scryfall's `/sets` gives `ttrk, trc, trk, sds` for
2026-11-13, whose reverse predicts `trk < trc`. So the two orderings are not each other and not
each other's reverse, and §16's proof does not carry over. It had to be redone.

## 18.3 Redone, on 17× the evidence, and the result is stronger

591 adjacent same-date pairs (against §16's 34), read straight off one cached `/sets` response.
**60 features** — every field `/sets` returns, plus presence flags, lengths, the icon path and
cache-buster, code split into alpha and digits, folded names, `parent or self`, the parent's listing
index, the `set_type` doc-order enum — each tried in **both directions**, 120 candidate keys.

The §16.3 fixpoint (a key's first component never gets a second chance; drop the pairs it decides
and repeat) returns **the EMPTY key**. Not "nine pairs undecided" — *nothing can be the first
component at all*: every one of the 120 candidates orders at least one observed adjacent pair
backwards. The best single key over the pairs it decides is `parent_idx` ASC at **71.6%**.

```
fixpoint key: (empty)
pairs left UNDECIDED at any depth: 591 of 591
```

That is the airtight form of §16.4 obtained for free: if no feature is even zero-wrong on the full
set, no lexicographic key over these features exists at any depth. Consistent with §16.6's stored
sequence — one internal ordinal, exposed by neither listing.

## 18.4 Verdict

No code changes. The `/sets` order stays as it is, for the same reason `assign_set_ranks` keeps
ranking by set code: there is nothing better to rank by. The four findings are bucket (a).

# 19. C11 resolved: autocomplete's order is `pg_trgm` similarity, and its residual is a THIRD proven ordinal

§17.3's C11 recorded two proven rules and one residual it could not derive. Both rules survive —
and the first one turns out to be the shadow of a bigger rule that also derives the residual. The
thing left over afterwards is a different question from the one C11 named, and it *is* the
underivable-ordinal class, proven the way §16 and §18 prove theirs.

## 19.1 The metric is not a length. It is `similarity()`

C11 established that "Scryfall's length metric strips spaces and punctuation before comparing".
That is right as far as it goes, and it is a special case. The rule is Postgres `pg_trgm`'s
`similarity(a, b)` = `|A ∩ B| / |A ∪ B|`, where a string's trigrams are the 3-character windows of
`"  " + s + " "`, computed over the **collated** name (`collate_name`, the same column
`card_name_collated` already holds).

Collated length is what that reduces to when the name has no repeated window: strip the separators
and each of `n` characters contributes one window plus the two edges. The two terms C11's metric
cannot see are exactly the two places it was wrong:

| shape | evidence |
|---|---|
| a REPEATED window shrinks the set | `Light Up the Night` (`igh`, `ght` twice) sorts with the 13-letter names, ahead of the 14-letter `Lightning Angel` — **the C11 residual, in one row**. `Shapesharer` and `Shambleshark` repeat `sha` and each sort one group early, which is `sha`'s two inversions. |
| a name ENDING in the query's tail shares the closing window | `q=ser`: the six promoted names (`Serum Raker`, `Serum Powder`, `Serene Master`, `Serra Avenger`, `Serra Redeemer`, `Serendib Sorcerer`) are **exactly** the six ending in `er`. `q=ang`: the four promoted are **exactly** the four ending in `ng`. `q=bla`: `Blazing Rootwalla` (`la`). `q=ele`: `Elektra, Femme Fatale` and `Elemental Spectacle` (`le`). `q=dra`: `Drake Umbra` (`ra`). |

**Measured, 30 prefixes off api.scryfall.com (2026-08-17), 546 adjacent pairs of Scryfall's own
output.** Inversions under each candidate key:

```
pg_trgm over the collated name (2 leading spaces, 1 trailing)     0 / 546
collated length (C11's metric)                                   18 / 375   (the first 20 prefixes)
printed length (what shipped)                                    71 / 375
pg_trgm with ONE leading space                                    7 / 375
pg_trgm applied PER WORD (Postgres' real word splitting)         61 / 375
```

Ten of the thirty prefixes (`vor sun tem cha spi hel war mir "elf w" zom`) were held out of the
derivation and are among the zero. There are no fitted parameters — the padding convention is
Postgres', and it was the only one of four that reached zero.

Two more rules fall out and are measured, not assumed:

- **The rank split is asked of the COLLATED name.** `q=gob` answers `_____ Goblin` FIRST (it
  collates to `goblin`, a prefix), while `q=ang` never answers `Defang` even though its similarity
  0.2222 beats six of the twenty names that are there. So rank still leads the key.
- **The PREDICATE is collated.** `q=ningbolt` answers `Lightning Bolt`; `ningbolt` is a substring of
  `lightningbolt` and of no spelling that keeps the space. `q=goblinw` answers the same 15 names as
  `q=goblin w`, and `q=light e` leads with `Light 'Em Up`.

## 19.2 What is left is an ordinal, and the §16/§18 proof applies to it

C11's second sentence about the residual — "the order WITHIN one length is not alphabetical" — is a
separate question from the inversion, and it is the one that survives. Under the similarity key
every one of the 30 prefixes is correctly ordered and every set disagreement is a **tie at the cut
score** or a stale-corpus artifact; what remains is which of several equally-similar names Scryfall
lists first.

1,121 tie-ordered pairs, 28 features from the bulk (name, folded name, collated name, name length,
word count, first/last release, printing count, EDHREC rank, penny rank, oracle id, Scryfall id,
multiverse/MTGO/Arena/TCGplayer/Cardmarket id, rarity, first set, collector number, layout, type
line, digital/booster/reprint/paper-only), each in both directions — 56 candidate keys.

```
best single feature over the pairs it decides:  layout, 1104/1121 — separating 36 pairs
best feature with real separating power:        ~53%, i.e. chance
fixpoint key: (empty)
pairs left UNDECIDED at any depth: 1121 of 1121
```

The §16.3/§18.3 fixpoint returns **the empty key**: no feature is consistent even on the pairs it
separates, so nothing can be the first component at any depth. And it is not noise — the
2026-08-16 and 2026-08-17 cached answers for `q=lig` and `q=jötun` agree **name for name**, so it
is a fixed internal ordinal. **A third instance of the class**, alongside §16's `/sets`-adjacent
release ordinal and the `unique=art` representative.

The tiebreak shipped is the printed name ascending: total, deterministic, and — the binding
constraint — recomputable by `mergeAutocomplete` from the names alone.

## 19.3 Result on `route-autocomplete-lig`, and what shipped

Measured against the built store in `store-build/`, all 10 partitions merged the way the deployment
merges them:

| | positions carrying Scryfall's own similarity value | names Scryfall does not list |
|---|---|---|
| before | 12 / 20 | 3 (`Lightning`, `Lightning Colt`, `Lightmine Field`) |
| after | **20 / 20** | 2, both TIED at the cut score with the two it keeps |

`q=jötun` and `q=ningbolt` now answer byte-for-byte what api.scryfall.com answers, in Scryfall's
order. The negative invariants hold and are pinned: `q=ego à deriva` and `q=アク` answer empty, and
autocomplete still has no `include_multilingual`.

**No store change.** This reads `card_name_collated` and `card_is_tags`, both already archived, so
neither `ARCHIVE_FORMAT_VERSION` nor `STORE_CONTENT_GENERATION` moves and the built stores answer
the new order without a rebuild.

Route: **#927**, confirming C11. `/cards/autocomplete` and `autocomplete_names` were introduced by
**#912**, whose copy is four commits ahead of #927's — but `collate_name`, `card_name_collated` and
`EXTRA_IS_TAG` exist only on **#927**, which is the only branch carrying every prerequisite AND the
function AND the route. The two branches diverged at 16af3d8 and a trial merge of #912 into #927
conflicts in `lib.rs`, `filter.rs`, `tests.rs` and `routes.py`, so the dependency was resolved by
authoring where the prerequisites already are rather than by dragging nine unrelated commits into a
branch with three writers. #912's own `autocomplete_names` will need the same body when the stack
lands; its doc comment already names the defect ("some relevance signal we do not have here").

Local `10fc323`; upstream `9df17a3` on `multilingual-store`.

**Wanted, not added here** (`scripts/live-parity-cases.json` is another agent's): a case for
`q=ser`, which is the one prefix that separates similarity from *every* length metric in both
directions — `Serra Avenger` (12 collated characters) must lead `Serenity` (8).

---

# 20. `unique=cards`: the representative is FIRST-IN-SORT-ORDER, and its tie-break is a FOURTH internal ordinal — with one derivable component worth +1.9pp

§17.4 left the 28 `plst` findings as "not proven undecidable, and not snapshot skew — a derivable
feature exists and was measured and declined", on the strength of three narrowed pairs in which
Scryfall kept the OLDEST candidate. This section settles it on 20,321 labelled representative
decisions and 152 complete printing orders read straight off api.scryfall.com. Three results, and
they do not all point the same way:

* **`released_at ASC` is dead.** Across 13,041 date-differing pairs the newest-first rule is right
  11,003 times and wrong 2,038. The three pairs were real, but they were three members of a
  residual class, not evidence about the direction of the key.
* **The residual is NOT derivable, and it is proven the way §18 proves `/sets`.** Scryfall's own
  printing order can be read directly — under `order=name` every printing of one card ties, so the
  row order IS the tie-break — and a sweep of 254 candidate keys × 2 directions (every field the
  card object publishes, plus presence/length variants, plus 15 `/sets` fields including
  `printed_size`) returns the fixpoint `pin ASC` **and nothing else**. 153 of 164 date-inversions
  are unexplained by any published field.
* **One component of it IS derivable and is not a set code.** A collector number with an alphabetic
  PREFIX (`plst/USG-4`, `wc04/mb278`, `ptc/…`) sorts after one without, ahead of the date key. On
  ten scopes never used in the fit it beats today's rule by **+1.90pp** and beats the hardcoded
  `plst` demotion §17.4 quoted at +0.35pp on its own corpus (+1.67pp on these).

## 20.1 The corpus, and the request budget

**174 requests to api.scryfall.com**, serial, ≥1.15s apart, all cached. Everything else came from
data already paid for: the session's `live-parity-cache` (5,264 responses, 4,023 of them card
lists) and the local origin at `localhost:8787` (a dev server that was already running; nothing was
started or stopped).

| corpus | what it is | size |
|---|---|---|
| **A — cache-mined merges** | 1,170 cached `unique=cards` pages whose `next_page` names their own query; winners joined to candidate sets fetched from the LOCAL origin under `unique=prints` with the same `include_*` flags | 266,700 winner rows → **18,638 decisions** with ≥2 candidates over 45 scopes; 7,999 pin-EXCLUDED |
| **B — printing orders** | `!"<name>" unique=prints order=name`, one request per card: the primary key ties on every row, so the response IS Scryfall's internal order | **152 cards, 2,942 printings, 2,748 same-oracle adjacent pairs**, 164 of them date-inversions |
| **C — fresh scopes** | 10 scopes chosen AFTER the rule was fitted, never used for fitting | **1,683 decisions** |

Corpus A's reconstruction is validated per card, not per scope: the winner Scryfall returned had to
be in the candidate set the local origin produced. It was, 266,697 times out of 266,700 — three
misses in total, which is also the tightest membership check on `/cards/search` this repo has run.

## 20.2 The mechanism, which was not what the port assumes

**`unique=cards` keeps the row that sorts FIRST in the requested order.** Two independent proofs:

* The same query under a different `order=` keeps a DIFFERENT printing. `e:one` cached under six
  orderings: 28 of 271 cards shared between them change representative, and every change is
  `order=usd dir=desc` picking the most expensive print (`one/414 ph` over `one/10`). `e:bro`: 17 of
  292. Under `order=name` all printings of a card tie, which is why the tie-break decides.
* The first row of a card's `order=name` print list IS the merge winner: over the 468 corpus-A
  decisions that corpus B covers, the earliest-ranked candidate is the one Scryfall kept **463
  times (98.9%)**.

This port cannot express that: `prefer_score` is a stored per-printing VALUE, so the representative
is fixed no matter what `order=` asks for. That is a real divergence class of its own, it is not
what §17.4 was about, and nothing here fixes it — it is recorded so the next person does not
rediscover the mechanism from the residual again.

## 20.3 The direction is settled: newest-first, decisively

| key, on corpus A's 7,999 pin-excluded decisions | decided | right | wrong | acc |
|---|---|---|---|---|
| `released_at` DESC | 4,615 | 3,501 | 1,114 | **.7586** |
| `released_at` ASC | 5,243 | 721 | 4,522 | .1375 |

Whole-rule, same 7,999: `pin > released DESC > cn ASC` **.8546**; `pin > released ASC > cn ASC`
**.4282**. On pairwise constraints (17,776 of them) DESC is right 11,003 / wrong 2,038; ASC is the
mirror. The pin itself re-measures at **10,628 / 10,639 = .9990** on this corpus, independently of
`ranks.rs`'s own harvest, so nothing about the pin is in doubt either.

**And the residual is one-sided.** Of the 1,152 decisions `pin > released DESC > cn ASC` gets wrong,
the printing Scryfall keeps is OLDER than ours in 1,114 and NEWER in **0**. So whatever is missing
demotes some printings below all others; it does not reorder dates.

## 20.4 `plst` is not a `set_type` question, and not a set question at all

`plst`'s `set_type` is `masters` — and so is the `set_type` of the printings that beat it. The
largest error class in corpus A is **`masters` losing to `masters`** (402 of 1,152: `cmm`, `ima`,
`a25`, `2xm`, `mma`, `vma`, `uma` all beat `plst`). Every `is_st_*` one-hot was tried in both
directions; none is admissible.

Nor is it a SET ordinal — i.e. it is not §16/§18's stored set sequence wearing a different hat:

* Corpus A's cross-set constraints contain a confident cycle:
  `vma > plst > prm > 2x2 > a25 > vma` (edges of 19, 7, 5, 3 and 5 observations, each ≥2× its
  reverse). A set-level total order cannot exist.
* A set's printings are not even contiguous in the order. `Canopy Vista`: `msc/227` sits in the
  first date-descending run and `msc/462` in the second — same set, same release date, opposite
  groups. The key is a per-PRINTING property.

## 20.5 The proof, on the §18.3 template

Corpus B is exact evidence: 2,748 adjacent pairs of Scryfall's own order, no reconstruction, no
scope semantics, no snapshot skew between two sides. A component of a lexicographic sort key must
be non-decreasing along that order; fix one, drop the pairs it decides, repeat.

```
254 candidate keys x 2 directions tested at every level
  fix pin ASC   decides 163 pairs (11 of them date-inversions); 2,585 pairs left

fixpoint key: [pin ASC]
pairs left UNDECIDED at any depth: 2,585 of 2,748
date-inversions left UNEXPLAINED:    153 of 164
```

The sweep covers every scalar the card object publishes (`booster`, `promo`, `promo_types`,
`frame_effects`, `border_color`, `full_art`, `textless`, `variation`, `oversized`, `finishes`,
`games`, `digital`, `image_status`, `highres_image`, `security_stamp`, `watermark`, `reserved`,
`arena_id`/`mtgo_id`/`tcgplayer_id`/`cardmarket_id`, `multiverse_ids`, `illustration_id`, prices,
…) plus `has:`/`len:` variants of each, plus the `/sets` object (`printed_size`, `card_count`,
`set_type`, `digital`, `foil_only`, `nonfoil_only`, `parent_set_code`, `block`, listing index) and
the derived `collector_number > printed_size` / `> card_count` flags. After the pin, **every one of
them orders at least one observed adjacent pair backwards.** The best non-admissible key is
`released_at` DESC itself, which is wrong on 153 of the 1,980 pairs it decides (7.7%).

A supervised check says the same thing from the other side. Labelling each printing by which
date-descending RUN it lands in (577 printings, 48 multi-run cards) and hunting for a predictor:
best single field .974 only by memorising `tcgplayer_id`; best depth-2 boolean conjunction
`has:multiverse_ids × has:promo_types` at **.825** against a .546 majority baseline. Within one set
the runs are clean (`promo_types: ["boosterfun"]`, `frame_effects`, `booster:false` — the base
printing precedes its own showcase/extended variants) and ACROSS sets the same fields explain
nothing: `gnt` (box, `booster:false`) leads run 1 of `Air Elemental` while `dpa`, `ps11`, `btd`,
`brb` (box, `booster:false`) sit in run 2.

**So the `unique=cards` tie-break is a fourth proven ordinal**, alongside `unique=art` (`5440875`),
`order=released`'s intra-date set order (§16) and `/sets` (§18). Unlike `unique=art`, most of it is
derivable — the pin plus date plus collector number already reach .9370 — and what is left is not.

## 20.6 The one component that IS derivable: an alpha-prefixed collector number

`cn_sort_key` already splits a collector number into (leading non-digits, digits, remainder). The
finding is that the FIRST element being non-empty is itself a sort key, and it sits between the pin
and the date: `mma/196` beats `plst/MMA-196`, `usg/4` beats `plst/USG-4`, `2x2/361` beats `sld/901`.
It fires on **7,489 of 114,068 English printings (6.57%)** — 5,028 of them `plst`, the rest `unk`,
`ptc`, `td0` and the `wc**` world-championship decks.

| rule | corpus A, all 18,638 | A, pin-excluded | **C — 10 FRESH scopes, 1,683** |
|---|---|---|---|
| today: `pin > rel DESC > cn ASC` | .9370 | .8546 | **.9156** |
| + demote `set == "plst"` (§17.4's declined hack) | .9587 | .9052 | **.9323** |
| + demote **alpha-prefixed cn** | **.9616** | **.9120** | **.9346** |

On corpus A the prefix key fixes 594 decisions and breaks 135; on corpus B's simulated merges it
lifts pin-excluded accuracy .4700 → .5079; on corpus C it never loses a scope by more than a
rounding error and gains 13pp on `frame:2003` (.7808 → .9110). It is strictly better than the
hardcoded set code on every corpus, and it is a property of the printing rather than a list of sets
to maintain.

The residual after it is `plst` beating the DIGITAL remaster sets (`klr`, `akr`) and the paper
remasters (`tsr`, `sir`, `sis`) — the 135 breakages are almost entirely that shape. `digital` as a
companion key does not fix it (.9468 combined, worse than .9616 alone).

## 20.7 What NOT to ship, and why it is recorded

`cn-prefix OR NOT booster` scores **.9783** on corpus A (pin-excluded .9509) and survives a
scope-hash holdout inside that corpus (.9190 → .9905). On corpus C it scores **.9228 — below the
prefix key's .9346** — and on corpus B's full pairwise order it is worse than doing nothing
(.7867 against .8539). Corpus A is dominated by `frame:1997`, `st:masters` and `border:white`,
three scopes whose candidate sets all have the same shape, so an in-corpus holdout does not
separate them. **A holdout drawn from the same scope family is not a holdout**; that is the
methodological finding here and it applies to the +0.35pp figure §17.4 quotes as well.

## 20.8 The specification, for whoever owns `ranks.rs`

Exactly one key is inserted, between the pin and the date, in `PrintingRanks::seal`:

```rust
ordered.sort_unstable_by_key(|(released_at, set, cn)| {
    let key: PinKey = (oracle_id.clone(), set.clone(), cn.clone());
    (
        u8::from(!pins.contains_key(&key)),          // unchanged, still first
        u8::from(!cn_sort_key(cn).0.is_empty()),     // NEW: a prefixed cn sorts last
        Reverse(released_at.clone()),                // unchanged
        cn_sort_key(cn),                             // unchanged
    )
});
```

* **Direction**: prefixed sorts AFTER unprefixed. The prefix STRING must not be compared —
  `cn_prefix ASC` as an ordering scores .8961 against the boolean's .9120, because among two
  prefixed numbers the date is right and the prefix is not.
* **Must not disturb**: the pin stays the first key, so pin-in-scope stays bit-for-bit exact
  (.9990, unchanged in every measurement above); `RANK_SPAN`, `RANK_STEP`, `PIN_BONUS` and the
  f32 encoding are untouched (this adds no bits — it permutes ranks within a card); the DISTINCT
  slot key is unchanged, so languages still share a rank and `+40` still orders them; cross-card
  order still turns on the old score alone.
* **Cost**: none. `cn_sort_key` is already computed on the same line.
* **Regression to accept**: 10 of 3,702 same-set pin-excluded decisions (.9949 → .9922 on that
  slice). Every other slice improves.
* **Release**: `prefer_score` is a stored VALUE, so this is a `STORE_CONTENT_GENERATION` bump with
  **no** `ARCHIVE_FORMAT_VERSION` change — the same shape as generation 26, which is the entry that
  introduced this rank. `store-age.ts` rebuilds on the generation, so the bump is the whole
  deployment story.
* **Do not** add `booster`, `digital`, `promo`, `promo_types` or `frame_effects` to this key
  (§20.7), and do not name a set code.

Expected effect on the sweep: of the 28 `unique=cards` findings, the ones whose loser is a
prefixed collector number go away; `plst` beating `tsr`/`klr`/`akr` and the `cmm`-vs-`mb2` class
stay, and by §20.5 they stay for good.

## 20.9 What this does not claim

The 3.8% `ranks.rs` reports and the 6.30% here are not the same denominator — this corpus is
deliberately weighted toward cross-set scopes (`is:unique`, `st:masters`, `frame:1997`,
`border:white`, artist scopes), where `ranks.rs`'s 16,045 observations were 12,594 single-set ones,
in which `released_at` almost never differs. That is why the date key looked stronger there and why
its direction was under-determined by that fit: the corpus that chose it barely exercised it.

No file in the repo was touched. Counts elsewhere may have moved under this section while other
agents changed `t:` matching, prices, `*` power/toughness and `is:vanilla`; nothing above depends
on those, because corpus B is Scryfall-only and corpora A and C use the local origin only for
membership, which those changes do not reach.

---

# 21. C8, C10, `*` and `is:vanilla` — all four fixed, measured on a rebuilt store

Store rebuilt at content generation **29** with both wasm blobs rebuilt; every "after" below is
`/cards/search` on that store, every "Scryfall" is api.scryfall.com on 2026-08-17, serial.

| query | before | after | Scryfall | |
|---|---|---|---|---|
| `t:god` | 104 | **96** | 96 | exact |
| `t:ape` | 273 | **45** | 45 | exact |
| `t:bat` | 92 | **54** | 54 | exact |
| `t:gob` | 563 | 563 | 563 | unmoved, and must be |
| `t:ir` | 1,906 | 1,906 | 1,906 | unmoved, and must be |
| `t:warrior` | 1,294 | 1,294 | 1,298 | the Burakos residual, §17.3 C8 |
| `tou=0` | 272 | **432** | 432 | exact |
| `toughness<1` | 273 | **433** | 434 | one card, see §21.3 |
| `usd>=500` | 84 | **205** | 205 | exact |
| `eur>=400` | 198 | **375** | 375 | exact |
| `tix>=1` | 3,293 | 3,293 | — | the control, unmoved |
| `is:vanilla` | 18,753 | **352** | 363 | face-level residual, §21.4 |
| `has:vanilla` | 18,753 | **352** | 363 | follows `is:`, as C9 requires |

## 21.1 C8 — the anchor is a CATALOG, not the corpus's own type words

The rule is substring **except** when the value names a type, and the naming is decided by the
union of the nine `/catalog/*` type lists (531 names, fetched 2026-08-17), not by tokenising the
corpus's type lines. Three measurements kill the corpus-derived version, which was the obvious
implementation and is wrong:

```text
t:ir    1906 = 1906   `Plane — Ir` is a printed type line and "Ir" is in no catalog
t:las     43 =   43   `Plane — Las Vegas`; Scryfall still matches Bolas and Class
t:art   4171 = 4171   `Creature — Art Lizard`; Scryfall still matches Artifact
```

Plane types are printed, are published in no catalog, and Scryfall does **not** anchor on them. A
vocabulary built from type-line tokens would have anchored `t:ir` and answered **0** where Scryfall
answers 1,906.

The boundary is a type-word boundary with `'`, `-` and `.` BOUND, because the catalog spells all
three inside names: `Urza's`, `Assembly-Worker`, `B.O.B.`. That is what keeps `t:urza` (a
planeswalker type) off `Land — Urza's Mine` while `t:worker` (in no catalog) still substring-matches
`Assembly-Worker`, both matching Scryfall.

**Re-checking what §17.3 said this poisoned.** The `t:god` anchor is now exact, so the three probes
filed with it (`op-card_set_code-neg`, `op-released_at-eq0`, `op-released_at-cmp0`) no longer carry
Demigod rows. Nothing else in this file leans on a `t:` probe with a canonical single-word value:
the anchors elsewhere are `e:khm t:creature` (151, unmoved — `creature` never occurs inside another
type word) and the `t:` rows of §10.2, which use `card_types`/`card_subtypes` shapes rather than
counts.

One stale number found in passing, not a defect: `filter.rs`'s type-line comment records
`t:"artifact creature"` as **360**. It is **1,309** on api.scryfall.com today and 1,309 here —
the two agree exactly, before and after this change. Whatever scope produced 360 is not the default
corpus.

## 21.2 C10 — etched is in the chain, and the STORED COLUMN MUST NOT MOVE

Two additions to §17.3's evidence, both measured, one request each:

```text
Mox Opal          sld    usd null, foil null, etched 381.19   ->  matches usd>=300
Force of Negation h1r    usd null, foil 113.66, etched 67.45  ->  matches usd>=100
```

The first says the chain reaches `usd_etched` (892 printings are etched-priced and nothing else);
the second says foil comes **first** (etched-wins would fail at 100). So the key is
`COALESCE(usd, usd_foil, usd_etched)`, and `eur` is two long — Scryfall sends no `eur_etched`.

**The naive fix is wrong, and quietly.** §17.3 routed this as "the stored price column", but
Scryfall serves `"usd": null` for that same Force of Negation *while* answering `usd>=100` with it.
Writing the coalesced value into `price_usd` at import fixes the filter and corrupts the card
object on **12,865** printings — and `live-parity` strips every value under `prices` as volatile, so
nothing in the suite would ever have caught it.

So the coalesce went onto the SEARCH KEY, in the three places that must agree with each other:
`filter::field_num`, the printing-space range index the planner narrows with, and the `order=usd`
sort key plus the representative pick that feeds it. A query-time-only coalesce is **not** sufficient
and is the trap worth recording: `numeric_candidates` narrows on `indexes.price_usd`, so a filter
that matched more rows than the index carries would lose them before verification ever ran.

Confirmed after the rebuild: `prices` for `Force of Negation` (h1r) still reads
`{"usd": null, "usd_foil": "113.66", "usd_etched": "67.45", "eur": null, "eur_foil": "141.52",
"tix": null}` — byte-identical to Scryfall's own object — while `usd>=500` is 205.

`order=usd dir=desc` now leads with a foil-only printing (Aragorn, the Uniter, foil $8,000), the
same shape §4323 of `lib.rs` recorded for Scryfall's khm/407.

**Side finding, recorded once and not chased.** `order=usd` CHANGES THE RESULT SET on Scryfall:
`usd>=500` is 205 there, and `usd>=500&order=usd` is **35**, with or without `dir=desc`. Ours is
205 in all three. Only 35 cards have their cheapest printing at $500 — so on that route Scryfall
appears to apply the predicate to the representative rather than to any printing. Unrelated to the
coalesce (a coalesce cannot shrink a total), unmeasured beyond these two requests, and a candidate
for its own investigation.

## 21.3 `*` is zero — and the last card in `toughness<1` is a different bug

The arithmetic is substituted, not replaced. One card per printed form, measured 2026-08-17:
Allosaurus Rider (`1+*`) answers `pow=1`; Souls of the Lost (`*+1`) answers `tou=1`; Aysen Crusader
(`2+*`) answers `pow=2` and **not** `pow=0`. The corpus prints `*`, `1+*`, `*+1`, `2+*`, `7-*` and
one `*²`; anything else stays absent.

It had to move in TWO parsers — the builder's column and the engine's per-face parse — because the
numeric planes are built from FACE values. `front_face_stats_match_card_columns` is the test that
would have caught a one-sided change, and it did.

Loyalty was deliberately left alone: the two cards printing `*` there (Personal Decoy, B.O.B.) are
funny-set cards api.scryfall.com answers **404** for even bare, so there is no measurement to follow.

**`toughness<1` is 433 against 434 and the missing card is `Little Girl`**, whose printed toughness
is `½`. `!"Little Girl" tou<1` is 1 on Scryfall and `!"Little Girl" tou=0` is 404 — Scryfall keeps
the fraction, this port truncates it to 0 through `int(float(...))`. That is the power/toughness
twin of the fractional-mana-value fix (`a_fractional_mana_value_is_not_rounded`), and it is not
free: `creature_power`/`creature_toughness` are `i8` columns, so it is an `ARCHIVE_FORMAT_VERSION`
question. Recorded, not fixed.

**One expansion improved for free.** `is:commander`'s `toughness>=0` term now reaches the 62
legendary `*/*` creatures it was silently excluding, and Scryfall agrees they belong:
`!"Abomination of Llanowar" is:commander` and `!"Ashaya, Soul of the Wild" is:commander` are each 1.
Ours is 3,714 against Scryfall's 3,679; the remaining over-catch is the shape's own, not the star's.

## 21.4 `is:vanilla` — shape 2 of the three, and NOT a filter bug

The diagnosis asked for: the empty-text condition is **present in the compiled plane and vacuous**,
and it is vacuous on Scryfall too. `o=""` and `o:""` are each a **400** there ("All of your terms
were ignored"), and `t:creature o=""` answers **18,753** on api.scryfall.com — the same number this
port answered. Nothing was dropped and nothing failed to compile: `=` on a text column is a
SUBSTRING test (itself a measured parity fix), and every string contains the empty one.

So the fix is in the rewrite, not the filter: `t:creature -o:/./`, the presence regex the `has:`
family already uses, negated. 352 on Scryfall, 352 here.

The 11-card gap is one class and is not reachable by any rewrite: Scryfall's `is:vanilla` is
FACE-level. All 12 rows of its own `is:vanilla o:/./` are adventures and their kin whose CREATURE
face is textless while the other face is not (`Beluna's Gatekeeper // Entry Denied`); this port's
`oracle_text` is the merged row. Closing it needs a face-scoped predicate — `OracleFace` already
carries `oracle_text_id`.

**No other `is:` value shares the shape.** `is:vanilla` was the only expansion in the map spelling
an empty value, and every conjunctive expansion was checked against each of its own conjuncts on the
rebuilt store — all strictly narrowing:

```text
is:party  3,861 < 3,879 & 18,753     is:pathway 10 < 11 & 1,224
is:bear   1,072 < 4,707 & 5,733      is:manland 48 < 121 & 1,224
is:oathbreaker 302 < 337             is:commander 3,714 < 3,722
is:brawler 2,120 < 3,722 & 15,722    is:vanilla 352 < 372 & 18,753
```

## 21.5 Release and routing

`STORE_CONTENT_GENERATION` **must be bumped** for this set: `creature_power`/`creature_toughness`
change stored VALUES and the `price_usd`/`price_eur` range indexes change CONTENT. No
`ARCHIVE_FORMAT_VERSION` change — no column was added and no layout moved. (The bump itself is
another agent's single edit; it is not made here.)

Upstream, routed per hunk by where the code lives rather than by subject:

* **#907** `engine-regex-parity` — the type-word anchor, because that PR introduced
  `TypeLineContains`; #927 has the variant only in a comment.
* **#927** `multilingual-store` — the `*` stat rule (`card_processing.py` + `card_engine`) and the
  price search key.
* **#926** `parser-lang-operator` — the `is:vanilla` expansion, and its `test_rewrite.py` row.

**Wanted, not added here** (`scripts/live-parity-cases.json` is another agent's): a `/cards/search`
case for `q=usd>=500&unique=prints` — the one shape that would have caught a coalesce written into
the stored column, since the parity reduction strips price VALUES but not the row SET.

## 22. `is:vanilla` — the residual closed, and the eleven were twelve forward and one back

`is:vanilla` answered **352** here against api.scryfall.com's **363** after §21.4's rewrite fix. It
now answers **363**, and card for card rather than merely to the same total: the full 363 was
fetched in three pages and diffed by `oracle_id` against this store's own, and **both set
differences are empty**. `has:vanilla` is 363 too, through the total alias §17.3/C9 established.

**§21.4's diagnosis was right about the mechanism and incomplete about the arithmetic.** It read the
gap as one class of 11. It is two classes, +12 and −1, and the second one moves the other way.

### 22.1 The twelve, and why no rewrite reaches them

`is:vanilla o:/./` is 12 on api.scryfall.com. All 12 are adventures whose creature FRONT prints
nothing while the Instant/Sorcery half does:

```text
Beluna's Gatekeeper // Entry Denied     Minecart Daredevil // Ride the Rails
Besotted Knight // Betroth the Beast    Shepherd of the Flock // Usher to Safety
Cheeky House-Mouse // Squeak By         Silverflame Squire // On Alert
Curious Pair // Treats to Share         Tuinvale Treefolk // Oaken Boon
Embereth Shieldbreaker // Battle Display  Vantress Transmuter // Croaking Curse
Garenbrig Carver // Shield's Might      Merfolk Secretkeeper // Venture Deeper
```

Every one has `card_faces[0].oracle_text == ""` exactly, confirmed on the Scryfall objects. The
stored `oracle_text` is the merged row — the faces' texts joined — so every predicate a rewrite can
compose sees the adventure half. This is not a rewrite that was chosen badly; it is a question the
merged row cannot be asked.

### 22.2 The one that goes the other way — and it is NOT a face question

`t:creature -o:/./ -is:vanilla` is **exactly 1** on api.scryfall.com, and it is **Dryad Arbor**.
It was in this port's 352 and is not in Scryfall's 363. Its land types grant `{T}: Add {G}` with
nothing printed to say so, and Scryfall counts that as rules text.

Measured, not inferred from one card: `is:vanilla t:land` is **0** there, with AND without
`include_extras`, while `t:creature t:land -o:/./` is **2** — Dryad Arbor and the `Forest Dryad`
token. Both candidates, neither vanilla. Over the whole 540,484-row import those same 2 rows are the
only ones the land clause removes, because a creature with no printed text produces mana only
through a land type.

So the arithmetic is **352 + 12 − 1 = 363**, and §21.4's "the 11 are one class" was one card short in
each direction.

### 22.3 The FRONT face, not any face — the shape an existential got wrong

The obvious reading of §22.1 is "some creature face is blank". That reading answers **367**, which
was measured on the rebuilt store before it was corrected. The four extras are transform cards with a
blank creature BACK behind a front that prints:

```text
Kaslem's Stonetree // Kaslem's Strider   Artifact (text)            // Artifact Creature — Golem ("")
Ecstatic Awakener // Awoken Demon        Creature — Human Wizard    // Creature — Demon ("")
Chosen of Markov // Markov's Servant     Creature — Human           // Creature — Vampire ("")
Skin Invasion // Skin Shedder            Enchantment — Aura         // Creature — Insect Horror ("")
```

`is:vanilla` over those four is **0** on api.scryfall.com. The token rows settle it from the other
direction: `is:vanilla is:dfc` is **18** there, and it HOLDS `Servo // Thopter`, `Goblin // Blood`,
`Gremlin // Energy Reserve` and `Saproling // Elf Knight` (blank front, printing back) while LEAVING
OUT `Elemental // Centaur`, `Fish // Kraken`, `Weird // Goblin`, `Incubator // Phyrexian`,
`Illusion // Saproling`, `Snake // Zombie`, `Soldier // Soldier` and `Wurm // Saproling` (printing
front, blank back). Both directions, on real cards, on the same axis.

### 22.4 The creature test is the CARD's, not that front's

Two of those 18 have a front that is not a creature at all — `City's Blessing // Elemental` and
`Copy // Horror` — and Scryfall calls both vanilla. So the predicate is a pair of separately-scoped
tests: **`card_types` for the type half** (creature somewhere, land nowhere) and **`faces[0]` for the
text half**. Requiring the front itself to be a creature drops those two.

### 22.5 The text is the SEARCHABLE form, and that is what makes Dryad Arbor a LAND question

`Icehide Golem` ("({S} can be paid with one mana from a snow source.)") and `Infinity Elemental`
("(This creature has INFINITE POWER.)") are both **`is:vanilla`** on api.scryfall.com and neither
prints an empty string. So reminder text comes off before the blankness test — the same text `o:`
searches, which is why all three of these are in `-o:/./` on both sides.

That is also what rules OUT the tempting simpler story. "Vanilla means the raw `oracle_text` is
empty" would have excluded Dryad Arbor for free — and would have excluded Icehide Golem and Infinity
Elemental too, which Scryfall includes. The land clause is doing work no text rule can do.

### 22.6 What shipped

`FilterExpr::VanillaFace`, an engine predicate, reusing the gen-28 face machinery from task 31
(`OracleFace::oracle_text_id`) rather than adding a parallel one. It reads three fields the archive
already holds:

```rust
let bits = u16::from(card.card_types);
if bits & TYPE_CREATURE == 0 || bits & TYPE_LAND != 0 { return false; }
match card.faces.first() {
    None => str_at(strings, card.oracle_text_lower_id).is_none_or(str::is_empty),
    Some(front) => str_at(strings, front.oracle_text_id).is_none_or(text_blank_after_reminders),
}
```

The unfaced arm reads the already-stripped `oracle_text_lower_id`; a FACE carries the printed string,
so `strip_reminder_text` runs there — on the ONE front face, never a list. **Nothing is stored and no
generation or format moves**: `card_types`, `oracle_text_lower_id` and `OracleFace::oracle_text_id`
have all been in the archive since gen 28. The rebuilt blobs in `11c0f6b` were built from `c77bf49`
plus only the three engine files, so they carry no other agent's in-flight tree.

`vanilla` moves out of `_DERIVED_EXPANSIONS` into `ENGINE_IS_VALUES` beside `localizedname` and
`unique`, in `rewrite.py` and its `src/parser/rewrite.ts` mirror, so the leaf reaches `filter.rs` as
`card_is_tags` and is intercepted there. `SUPPORTED_IS_VALUES` still covers it, so `has:vanilla`
follows for free and no warning appears.

### 22.7 One thing this broke, caught by upstream CI and not by anything here

`client/query_sampler.py`'s `STATIC_VALUES["tag"]` is asserted to be EXACTLY the expandable `is:`
values (`test_is_tags_match_the_rewrite_table`) — the sampler ships in a client image with no `api/`
to import. Removing the expansion left the two sides one value apart. Fixed on the PR branch AND in
`vendor/` (`437aa14`), because a fix on a PR branch never reaches the vendored tree. The comment
beside that list also claimed 73 against a list of 75; it is now the 74 it actually holds.

### 22.8 Routing, and one doc left stale

Both PRs are green as of this writing.

* **#927** `multilingual-store` — `card_engine/src/{filter,estimator,tests}.rs` (`37ce298`). It
  already owns the `localizedname`/`unique` interception this sits beside. Upstream has no
  `strip_reminder_text` yet, so the port's `text_blank_after_reminders` is a non-allocating paren-
  depth walk with a note to collapse onto the strip when that work lands.
* **#926** `parser-lang-operator` — `api/parsing/rewrite.py`, `test_rewrite.py` (`ef75e81`) and the
  sampler (`50ef3a5`). It already owns both `_DERIVED_EXPANSIONS` and `ENGINE_IS_VALUES`.

**The split is not a new cross-PR dependency.** `localizedname` and `unique` are ALREADY split the
same way — Python half on #926, Rust half on #927 — so `vanilla` follows an existing seam rather than
cutting one. Nothing was merged between the branches.

**Stale, not fixed here:** `vendor/sylvan_librarian/docs/issues/local-engine-empty-text-narrowing.md`
is an open issue doc whose whole premise is that `is:vanilla` desugars to a `= ''` equality with no
index. It no longer desugars to anything. It needs rewriting or closing, in both trees.

**Wanted, not added here** (`scripts/live-parity-cases.json` is another agent's): a `/cards/search`
case for `q=is:vanilla`. It is the shape that distinguishes all three rules at once, and the parity
reduction keeps the row SET, which is exactly what this predicate changes.

**Scryfall requests for this task: 17**, serial, one per 1.2 s.

---

# 23. The rank keys, `order=name` in printing space, and the one where the diagnosis was wrong

Four items, landed at `ARCHIVE_FORMAT_VERSION` **2026081703** / `STORE_CONTENT_GENERATION` **38**,
every "after" below measured on a store rebuilt at that pair. Two of the four came out differently
from their specification, and those two are the sections worth reading: §23.3 records a rule that is
correct on the surface it was fitted to and a **regression** on a surface nobody had measured, and
§23.5 records a defect whose named cause was not its cause.

| item | before | after | Scryfall | |
|---|---|---|---|---|
| C1, four narrowed pairs | 0/4 | **3/4** | — | the 4th is §17.4's residual, predicted |
| cn-prefix, five recorded `plst` losses | 0/5 | **5/5** | — | and `sld/901` with them |
| `layout:reversible_card order=name` | 1 transposition | **0** | 81 rows | positionally identical |
| C12, five name-groups | 2/5 | **2/5** | — | attempted, measured, BACKED OUT (§23.4) |
| `toughness<1` | 433 | **434** | 434 | exact — the cause was `?`, not the fraction |
| `power<1` | 1054 | **1058** | 1058 | exact |
| `tou=0` / `pow=2` | 433 / 5733 | **432** / **5730** | 432 / 5730 | the fraction, over-catching its floor |
| `tou=0.5` / `pow=2.5` | 0 / 0 | **1** / **3** | 1 / 3 | and the half becomes reachable |

## 23.1 The printing rank gains TWO keys, and the order between them is reasoned, not fitted

`PrintingRanks::seal` now orders a card's DISTINCT slots by

```text
pin ASC > NOT has_english > cn HAS AN ALPHABETIC PREFIX > released_at DESC > cn_sort_key ASC
```

**C1 (language).** Ranking is over DISTINCT slots, so `prefer_score`'s `+40` language term orders a
slot's languages among themselves and nothing ordered slots against each other; `RANK_STEP` is 2048,
so nothing riding under a rank can ever cross one. Verified live on the rebuild, one request per
side, narrowed to the pin-excluded candidate sets §17.3 named:

```text
!"Active Volcano" (e:leg or e:bchr or e:chr)          chr/43:en   = chr/43:en    (was bchr/43:ja)
!"Abomination" (e:leg or e:4bb or e:ren)              leg/87:en   = leg/87:en    (was ren/46:fr)
!"Darksteel Juggernaut" (e:som or e:pmei)             som/150:en  = som/150:en   (was pmei/…:ja)
!"Abyssal Specter" (e:8ed or e:ddc or e:dpa or e:ps11) ddc/40:en  ≠ dpa/18:en    (residual, predicted)
```

**§23.1a WHICH OF THE TWO KEYS GOES FIRST IS NOT DECIDABLE FROM ANY CORPUS HERE, and the reason is
worth recording because it generalises.** Scryfall's default search is English-only, so every corpus
§20 fitted the prefix key on is English throughout and cannot constrain the two against each other.
Language first leaves §20.6's measured gain exactly intact — within an English scope `has_english` is
constant, so the prefix is the effective first non-pin key — while the other order lets a prefixed
ENGLISH slot lose to an unprefixed foreign-only one, which is the thing C1's four pairs refute. So
the composition is settled by which order is a no-op on the evidence that exists, not by a fit.

**cn-prefix.** All five losses §17.4 recorded now go the right way, and the sixth from §20.6 with
them:

```text
!"Angelic Page" (e:plst or e:usg)              usg/4      !"Rushwood Legate" (e:plst or e:mmq)  mmq/266
!"Venser, Shaper Savant" (e:plst or e:fut)     fut/46     !"Sol Ring" (e:sld or e:2x2)          sld/2560
```

## 23.2 `order=name` is a PRINTING-space order, and the permutation had to go for it

81 printings print a name their card does not. `assign_name_ranks` now ranks cards and divergent
printing names over ONE number line and `DivergentPrinting` stores its rank, so `sort_primary_f32`
and `encode_sort_key` substitute the printing's name with no scaling and no offset.

**The key alone would have been worse than the defect**, and this is the trap `REVERSIBLE-NAME-SORT.md`
named. `encode_sort_key` and `sort_primary_f32` hold the printing; the permutation walk does not,
because it is indexed by CARD and emits every printing of a card at that card's name position. Fixing
one and not the other leaves the cross-partition MERGE and the in-partition WALK ordering by different
rules, which is a repeated or dropped row at a page boundary. So `SortPermutations` loses its
`name`/`name_inv` pair outright — removed from the struct, not left unread, so the fact is structural.
Its one other reader was already gone: `narrow_rec`'s ExactName arm binary-searched that array and has
gone through `indexes.name_trigram` since gen 35, which the struct's own doc comment still claimed
otherwise. A stale comment on a dead index is exactly how this gets re-wired by accident.

**Result:** `layout:reversible_card order=name unique=prints` is 81 rows on both sides with **0
positional mismatches**, `Mechtitan Core` ahead of `Mechtitan // Mechtitan` as Scryfall orders them.

**What it costs**, memprobe on the rebuilt production corpus, partition 0, 3,902 cards, limit 175,
offset 0, 30 iterations — `order=name` moves out of the permutation band into the band four shipped
columns already occupy:

```text
permutation-backed   edhrec 82us    cmc 79us    power 81us
permutation-free     set 104us   artist 106us   released 115us   usd 154us
name                 144-149us      (was 128us with the permutation)
```

`REVERSIBLE-NAME-SORT.md` parked this on the belief that dropping the fast path traded "a corpus-wide
performance property for 81 rows". It costs ~17us per partition against a request that measures in
milliseconds, and it is the same cost `order=set` has always paid. **The parking note over-priced it.**

## 23.3 THE cn-PREFIX KEY IS A REGRESSION ON THE SURFACE §20 DID NOT MEASURE

This is the finding of this section, and it contradicts §20.8's "every other slice improves".

§20 fitted and validated the prefix key on **merges** — which printing a `unique=cards` scope keeps,
i.e. the ARGMAX of the rank. It never scored the key on the **full print ORDER**, which is the same
rank read as a sequence: printings are stored prefer-descending, so `prefer_score` IS the order
`unique=prints order=name` returns, and §20.2 established that the two are the same ordinal (the
merge winner is the first row of the print list, 463 of 468).

Scored on corpus B's own shape — `!"<name>" unique=prints order=name`, whose primary ties on every
row so the response IS Scryfall's internal ordinal — over **28 cards, 1,047 adjacent pairs**, with the
pin taken from each card's own `unique=cards` answer and the old rule reconstructed over the same
slots:

```text
pin > released DESC > cn ASC                   1008 / 1047 = .9628
+ demote alpha-prefixed cn (what shipped)       971 / 1047 = .9274
```

It loses on 24 of the 28 cards and gains on none. The mechanism is not mysterious: demoting a
prefixed printing to the BOTTOM of its card fixes the argmax whenever a prefixed printing was wrongly
winning, and scrambles the middle of the sequence, where Scryfall interleaves those same printings by
date. `Fireblast` is the clean example — Scryfall runs `dmr/119, jvc/55, vma/159, dd2/55, vis/79,
plst/VIS-79, dmr/319, …`, keeping `plst/VIS-79` at position 6 next to `vis/79`, and the key sends it
to position 11.

**Both surfaces are shipped**, so this is a genuine trade and not a mistake to unwind on sight:

* merges gain — .9156 -> .9346 on §20's ten fitted-after scopes, 1,683 decisions;
* print order loses — .9628 -> .9274 on 1,047 adjacent pairs of Scryfall's own order.

**It cannot be split.** `prefer_score` is one stored value serving both the representative choice and
the row order; there is no second ordering in the archive to put the prefix key in. A "demote only
out of rank 0" variant does not reach §20.6's gain either, because a merge winner is the min-rank
slot IN SCOPE and is usually not global rank 0.

**It is left as shipped**, on the larger evidence base (20,321 labelled merge decisions against 1,047
order pairs) and because §20.8 specified it, but the trade is now on the record with a number instead
of being unmeasured. The reproduction is `scratchpad/printorder.py` in this session's scratch; it is
56 requests, serial, and it re-runs against any rebuild. **Whoever revisits it should decide on which
surface matters, not on which corpus is bigger.**

Methodologically this is §20.7's own lesson arriving from the other direction. §20.7 established that
a holdout drawn from the same scope family is not a holdout; §23.3 adds that a holdout drawn from the
same *question* is not one either. Every corpus in §20 asked "which printing wins", and none asked
"in what order do the rest follow".

## 23.4 C12 was attempted, measured, and backed out — the second key cannot be scoped to cross-card

Giving `SortCol::Name` the (set code, collector number) second key `released` carries fixed three of
the five recorded name-groups outright: `ust/12a…12f`, `Alien` as `tmsh` `tpip` `twho/2` `twho/34`,
and `Elemental // Elemental` as `tust/11` then `tust/17` — all previously in `oracle_id` order, which
is a UUID hash and was right only by accident.

**And a lexicographic second key applies to every tie on the primary, which under `order=name`
includes every printing of ONE card.** There the correct order is the `unique=cards` ordinal, which
this port already reproduces for free through `page_cmp`'s `cid`-then-`pid` tail over
prefer-descending storage. The key sat above that tail and re-sorted every multi-printing card
alphabetically by set code: `name:/^Fire/ t:instant` went from matching Scryfall's `Fireblast` run to
answering `dd2/55, dmr/119, dmr/319, f01/12, …`. Three name-groups against the intra-card order of the
whole corpus is not a trade, and it was reverted in the commit after the one that added it.

**What that says about the rule underneath.** Scryfall has ONE printing ordinal below the name, not
two rules. The (set, collector number) fit is what that ordinal looks like when each tied row happens
to be the only printing of its own card — true of all three groups it fixed. The ordinal itself is
§20.5's, proven non-derivable over 254 keys in both directions, and the fifth group contradicts (set,
collector number) outright on the very sample the fit came from: `Everythingamajig` is `ust/147c,
147f, 147b, 147a, 147e, 147d`. **So C12 is not "worth doing on a later budget" — it is the same
non-derivable ordinal wearing a fifth hat, and the `oracle_id` tail stays.**

## 23.5 `toughness<1` was never the fraction. It is `?`, and it cost nothing to fix

The brief for this work named `Little Girl` (printed `½`) as the row missing from `toughness<1`, and
put the fix at `ARCHIVE_FORMAT_VERSION` because an integer column cannot hold a half. Both halves of
that are wrong, and the second follows from the first.

**The missing row is `Shellephant` (ust/121), which prints `?` on both sides.** Diffing the two
answers row by row — 434 names from api.scryfall.com against 433 here — leaves exactly one name, and
it is not Little Girl. Scryfall holds exactly **0** for a `?`: `!"Shellephant" tou=0` is 1, `tou>=0`
is 1, `tou>0` is 0. This port read `?` as ABSENT, and an absent value satisfies no comparison against
its own column, so the row fell out of every power/toughness query rather than only the equality ones.

`?` is therefore zero on the same terms `*` already is, in the same two parsers, and it needs no
format change at all:

```text
toughness<1   433 -> 434   Scryfall 434   exact
power<1      1054 -> 1058   Scryfall 1058   exact
```

`∞` is deliberately NOT included: `Infinity Elemental` is `ulst`, which api.scryfall.com does not
answer for, so there is nothing measured to follow — the rule that already keeps loyalty's two starred
cards out of this parser.

**Little Girl is a real defect with the OPPOSITE SIGNATURE, which is why it was misdiagnosed.**
Truncation cannot LOSE a row from `tou<1`, because 0 satisfies it exactly as 0.5 does. It
OVER-CATCHES the integer it truncates to. Eleven Unhinged cards print a half, and every remaining
power/toughness divergence on the rebuild is one of them:

```text
tou=0   Scryfall  432   here  433   +1   Little Girl
pow=0   Scryfall 1054   here 1055   +1   Little Girl
tou=1   Scryfall 3758   here 3759   +1   Fraction Jackson
pow=2   Scryfall 5730   here 5733   +3   Smart Ass, Stone-Cold Basilisk, Vile Bile
```

(`is:commander` is 3,714 against 3,679 and is NOT this class — it is §21.3's shape residual.)

**FIXED, on a second rebuild at `ARCHIVE_FORMAT_VERSION` 2026081704**, and the encoding is
`Option<f32>` rather than the scaled integer the brief proposed. Both stat columns widen on
`OracleCard` (272 -> 288 archived bytes) and `OracleFace`, the two parsers stop truncating, the
spill codec goes 1 byte -> 4 per column, and `ArithTupleKey` holds `power_bits`/`toughness_bits`
because an f32 is neither `Hash` nor `Eq` — with `+ 0.0` on the way in so the corpus's printed `-0`
cannot intern as a second combination every comparison treats as equal to the first. Re-measured
serially the same day:

```text
query      Scryfall   before   after
tou=0           432      433     432    exact
pow=0          1054     1055    1054    exact
tou=1          3758     3759    3758    exact
pow=2          5730     5733    5730    exact
tou=0.5           1        0       1    the fraction becomes REACHABLE, not merely
pow=2.5           3        0       3    absent from the integers it is not
```

**Why f32 and not the scaled integer, since the guidance started the other way.** `cmc` took
exactly this shape for exactly this bug (`api/db/2026-08-12-01-fractional-mana-value.sql: integer ->
real`), and the whole downstream is f32 already — `sort_primary_f32`, `sort_col_card_value`,
`build_sort_permutations`, `NumericIndex = Vec<(f32, u32)>`, `planes.rs`'s `BucketBounds`, and
`filter.rs` widening to f64 to compare. **Byte-comparability is not the discriminator**, contrary to
the brief: `encode_sort_key` writes `f32_sort_bits` for every numeric column and that encoder is
total-order-preserving over all f32s, fractions included, so both designs keep the partitioned keys
sound. The discriminators that are real all point one way — a scaled integer cannot stay in `i8`
(B.F.M. is 99/99 and doubles past `i8::MAX`), it needs a x2 at every read site including
`sort_col_bound`, where a missed one is a silently mis-bounded permutation walk rather than a visible
wrong count, and doubling collides with the numeric planes' `NUM_INTERIOR_HI = 12`, which would cost
`pow=7`…`pow=12` their one-hot planes. **The card object never moves**: `power`/`toughness` JSON
comes from the text ids, so the printed `½` a reader sees was never what this column held.

**One test-design note worth keeping.** The fractional rows went into their OWN fixture rather than
into `numeric_plane_fixture_store`. Adding a single off-lattice value there made three plane tests
fail — `set_numeric_plane` routes it to the HI bucket, which widens that bucket's observed range for
the whole fixture and makes `compile_plane` decline thresholds those tests exist to prove it accepts.
That is exactly why `fractional_cmc_fixture_store` already stands apart, and it is a property of
bucketed planes rather than of this change: **a fixture that mixes lattice and off-lattice values
tests both cases more weakly than either alone.**

**One residual, pre-existing and orthogonal.** `pow=3`, `tou=3` and `tou>=3.5` are each short by
exactly one row. It is not a parse failure: over the whole 540,484-row corpus the only printed stat
this port still fails to read is `∞` (Infinity Elemental, 3 rows), whose set `ulst` api.scryfall.com
does not answer for. Before this change the same family read +2/+1 instead of -1 — the truncated
halves were masking it, which is the second time in this section that one defect hid inside another's
sign.

## 23.6 The differential, which is the gate that mattered

`memprobe compare-parts` over the whole 540,484-row corpus, twice — once after the name change and
once after the C12 revert:

```text
match: 162 envelope cases, 12103092 rows byte-for-byte, N=2 vs N=10
THE CUT DOES NOT CHANGE THE ANSWER
CONTROL: the same differential FAILS on 38 cases when the sort key's primary is made
         archive-local (orderings: set, name, artist)
```

The control still firing is the half that makes the pass mean something: the harness can still see a
broken key, so byte-comparability across partitions — the property that makes per-partition
`offset+limit` sound — is intact rather than untested. `bun run gate` is green end to end, including
the wasm build fit per partition and all five route ratios (highest: autocomplete at 1.0% of a full
scan, limit 3%).

## 23.7 Versions, and the rule that decides them

`ARCHIVE_FORMAT_VERSION` **2026081702 -> 2026081703 -> 2026081704**, `SORT_KEY_VERSION` **1 -> 2**,
`STORE_CONTENT_GENERATION` **37 -> 38**.

The format moved TWICE, once per layout change, because the two were measured and landed
separately — §23.2's name order and §23.5's stat widening (`Archived<OracleCard>` 272 -> 288). The
GENERATION did not move with the second, and that is deliberate: it is a rebuild trigger compared
against the PUBLISHED manifest, still generation 37, so 38 already forces the rebuild both format
versions need, and moving it again would name one rebuild twice.

The first bump was for §23.2 alone: `DivergentPrinting` gains a field, every `OracleCard::name_rank` in
the archive is a different number now that the two name sets share a number line, and
`SortPermutations` losing a pair moves the offset of every field after it inside `CardIndexes`. None
of those is a struct the header measures — it embeds `AOracleCard` and `APrinting` sizes only — so a
gen-2026081702 store read by this code would find the edhrec inverse where the name permutation used
to be. §23.1's rank keys are stored VALUES and needed no format change, and neither did §23.5's `?` rule,
which adds not one byte.

`SORT_KEY_VERSION` moved even though the key's LENGTH did not, which is the case worth naming. After
the C12 revert `Name`'s key gains no segment; its primary just means something different for 81 rows.
Two keys of the same shape that disagree about where 81 rows belong is precisely what a version byte
has to catch, because nothing about their shape reveals it and the gather compares them bytewise.

The generation carries all four of tonight's stored-value changes — `*` as zero, the `usd`/`eur`
coalesce, the two rank keys, and the name order — in ONE bump, because a generation is a rebuild
trigger and `store-age.ts` compares one number. **And it is the number `store-age.ts` compares: a
format bump shipped without it takes the site dark, since the header rejects the published store and
nothing schedules its replacement.**

## 23.8 Routing

`ranks.rs`, the sort-key encoding and `SortPermutations` are **Cloudflare-LOCAL**: upstream computes
its representative from `prefer_score` alone (where `+40` does decide the language), serves from
Postgres, and has no partition axis to encode a byte key for. Nothing in §23.1–§23.4 has an upstream
hunk.

**BOTH HALVES OF §23.5 ARE UPSTREAM-MATERIAL** and route to **#927** `multilingual-store`, beside the
`*` rule they extend — `card_processing.py`'s stat parse and `card_engine`'s `stat_str_to_int_star`,
which must move together for the same reason they did there (the numeric planes are built from FACE
values). The `?` rule is four characters in each tree plus its test row. The FRACTION is larger and
has a shape upstream already knows: an `integer -> real` migration on `magic.cards.creature_power`
and `creature_toughness`, mirroring #923's
`api/db/2026-08-12-01-fractional-mana-value.sql` for `cmc` exactly.

Not pushed from here. #927 had three writers during this session, the `?` hunk touches the exact
function one of them last edited, and the fraction needs a Postgres migration that cannot be
exercised from this repo at all — a schema change proposed blind is worse than one routed explicitly.

**Wanted, not added here** (`scripts/live-parity-cases.json` is another agent's): a `/cards/search`
case for `q=layout:reversible_card&order=name&unique=prints`. It is the only shape that exercises a
printing-space name order, and the parity reduction keeps row ORDER, which is the whole of what
§23.2 changes.

**Scryfall requests for this task: 118**, serial, one per 1.1 s.
