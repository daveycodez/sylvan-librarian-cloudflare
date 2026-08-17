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
