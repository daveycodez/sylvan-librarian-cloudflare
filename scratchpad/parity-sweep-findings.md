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
