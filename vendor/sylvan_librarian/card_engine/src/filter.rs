use memchr::memmem;
use rkyv::Archived;
use serde_json::Value;
use super::regex_compat::{CompiledRegex, QUERY_REGEX_FLAGS, REGEX_COMPILE_ERR_PREFIX, SELF_REF_SENTINEL, SelfRefScope};
use super::{AOracleCard, APrinting, AStrings, ManaCost, str_at, mana_lane, lane_add, lane_get, lanes_ge, LANES8_HI, mana_pip_counts, mana_cmc, mana_bare_generic, color_list_to_mask, card_type_str_to_bit, trigram_candidates, trigram_min_posting, ARTIST_NONE, NONE_STR, FlavorIndex, NameBigramIndex, NO_TYPE_LINE_INDEX, PrintedNameIndex, OracleTextIndex, SortedTrigramIndex, TypeLineIndex, flavor_fingerprint, flavor_match_sets};
use super::legality::{LEGALITY_LEGAL, LEGALITY_BANNED, LEGALITY_RESTRICTED, format_shift};

/// Compile a query regex for public search.
///
/// The engine choice, the ARE-escape translation and the backtrack budget all live in
/// `regex_compat`; this adds the one thing only the query layer knows — that a pattern the
/// engine cannot compile is a FATAL query error rather than a decline, so the prefix routes
/// it away from the SQL retry that every other `build_filter` failure takes.
pub(crate) fn compile_search_regex(pattern: &str) -> Result<CompiledRegex, String> {
    CompiledRegex::new(pattern).map_err(|e| format!("{REGEX_COMPILE_ERR_PREFIX}{e}"))
}

/// The same, with `~` expanded to Scryfall's self-reference alias. Text columns only — see the
/// call site in `build_text_filter` for the four counts that decide which those are.
pub(crate) fn compile_search_regex_self_referential(pattern: &str, scope: SelfRefScope) -> Result<CompiledRegex, String> {
    CompiledRegex::new_self_referential(pattern, scope).map_err(|e| format!("{REGEX_COMPILE_ERR_PREFIX}{e}"))
}

#[cfg(test)]
pub(crate) fn compile_search_regex_for_test(pattern: &str) -> CompiledRegex {
    compile_search_regex(pattern).expect("test regex should compile")
}

// ─── Comparison / arithmetic operators ───────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum CmpOp {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}

#[derive(Clone, Copy)]
pub(crate) enum ArithOp {
    Add,
    Sub,
    Mul,
    Div,
}

// ─── Four-valued evaluation result ────────────────────────────────────────────

/// Evaluation result of a filter node. True/False/Null follow SQL ternary logic
/// (Null = a compared attribute is missing); PrintingDep is produced only during
/// the card-level pass (printing = None) when a predicate depends on
/// printing-level fields, and tells the query driver to re-evaluate per printing.
/// With a printing supplied, PrintingDep can never occur.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Tri {
    True,
    False,
    Null,
    PrintingDep,
}

fn tri_bool(b: bool) -> Tri {
    if b { Tri::True } else { Tri::False }
}

// ─── Numeric expressions ──────────────────────────────────────────────────────

// PartialEq so a caller can ask "is this leaf about the field I care about" — `sort_col_bound` matches
// the sort column against the field a NumericCmp constrains.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum NumField {
    Cmc,
    Power,
    Toughness,
    Loyalty,
    RarityInt,
    CollectorNumberInt,
    EdhrEc,
    PriceUsd,
    PriceEur,
    PriceTix,
    PreferScore,
}

fn attr_to_num_field(attr: &str) -> Option<NumField> {
    match attr {
        "cmc"                  => Some(NumField::Cmc),
        "creature_power"       => Some(NumField::Power),
        "creature_toughness"   => Some(NumField::Toughness),
        "planeswalker_loyalty" => Some(NumField::Loyalty),
        "card_rarity_int"      => Some(NumField::RarityInt),
        "collector_number_int" => Some(NumField::CollectorNumberInt),
        "edhrec_rank"          => Some(NumField::EdhrEc),
        "price_usd"            => Some(NumField::PriceUsd),
        "price_eur"            => Some(NumField::PriceEur),
        "price_tix"            => Some(NumField::PriceTix),
        "prefer_score"         => Some(NumField::PreferScore),
        _ => None,
    }
}

/// Numeric operand during evaluation. PDep occurs only in the card-level pass
/// (printing = None) for printing-level fields.
#[derive(Clone, Copy)]
pub(crate) enum NumVal {
    Known(f64),
    Null,
    PDep,
}

fn field_num(card: &AOracleCard, printing: Option<&APrinting>, f: NumField) -> NumVal {
    fn known(v: Option<f32>) -> NumVal {
        v.map_or(NumVal::Null, |x| NumVal::Known(x as f64))
    }
    // Cents -> dollars via exact f64 division, not through f32 -- 722.0 / 100.0 and a
    // directly-parsed query constant "7.22" round to the identical nearest f64 (both are
    // single, non-lossy roundings of the same rational number), so this and NumExpr::Const
    // (untouched) always agree exactly. Unconditional, regardless of comparison shape
    // (Arith, Field-vs-Field, bare Field-vs-Const, ...): a bind-time fast path that
    // special-cased only the bare shape shipped two silent correctness bugs
    // (`usd+1<power`, `usd<cmc` -- see docs/issues/local-engine-broad-range-fastpath.md)
    // for a ~2-3% win on the one shape it covered, not worth the ongoing risk of a
    // representation that's easy to bypass by rephrasing a logically identical query.
    fn known_cents(v: Option<u32>) -> NumVal {
        v.map_or(NumVal::Null, |cents| NumVal::Known(f64::from(cents) / 100.0))
    }
    match f {
        NumField::Cmc                => known(card.cmc.as_ref().map(|v| f32::from(*v))),
        NumField::Power              => known(card.creature_power.as_ref().map(|v| f32::from(*v))),
        NumField::Toughness          => known(card.creature_toughness.as_ref().map(|v| f32::from(*v))),
        NumField::Loyalty            => known(card.planeswalker_loyalty.as_ref().map(|v| f32::from(*v))),
        NumField::EdhrEc             => known(card.edhrec_rank.as_ref().map(|v| u32::from(*v) as f32)),
        NumField::RarityInt          => printing.map_or(NumVal::PDep, |p| known(p.card_rarity_int.as_ref().map(|v| f32::from(*v)))),
        NumField::CollectorNumberInt => printing.map_or(NumVal::PDep, |p| known(p.collector_number_int.as_ref().map(|v| u16::from(*v) as f32))),
        // The COALESCED search key, not the raw column: `usd` falls back to the foil and then the
        // etched price on api.scryfall.com, which is 121 cards on `usd>=500` alone. See
        // `crate::search_price_usd_cents` — the range index the planner narrows with is built from
        // the same function, and they have to agree or a correct row is narrowed away.
        NumField::PriceUsd           => printing.map_or(NumVal::PDep, |p| known_cents(super::search_price_usd_cents(p))),
        NumField::PriceEur           => printing.map_or(NumVal::PDep, |p| known_cents(super::search_price_eur_cents(p))),
        NumField::PriceTix           => printing.map_or(NumVal::PDep, |p| known_cents(p.price_tix.as_ref().map(|v| u32::from(*v)))),
        NumField::PreferScore        => printing.map_or(NumVal::PDep, |p| known(p.prefer_score.as_ref().map(|v| f32::from(*v)))),
    }
}

#[derive(Clone)]
pub(crate) enum NumExpr {
    Const(f64),
    Field(NumField),
    Arith(Box<NumExpr>, ArithOp, Box<NumExpr>),
}

impl NumExpr {
    // #[inline(always)] alone doesn't reach the goal here: LLVM's
    // always-inliner refuses to inline ANY self-recursive function at ANY
    // call site, not just the recursive edge -- confirmed in the release
    // disassembly, where a first attempt at just adding the attribute to a
    // still-self-recursive eval() left both `bl NumExpr::eval` calls in
    // FilterExpr::tri's NumericCmp arm untouched. Splitting the Arith case
    // into its own (separately named, not force-inlined) function makes
    // eval_with() itself non-recursive, so the attribute now actually applies:
    // for the common Const/Field leaf case (e.g. `usd<50`, no arithmetic),
    // eval_with()'s whole body -- including the fetch closure (field_num,
    // already small enough to inline on its own) -- folds directly into tri(),
    // eliminating both calls' prologue/epilogue/jump-table tax. Arith
    // (`cmc+1<power`) is colder and still recurses through eval_arith_with,
    // unaffected either way.
    //
    // Generic over the field-fetch (#743) so the real per-card path (fetch =
    // field_num) and the tuple-scan path (fetch = one tuple key's four fields)
    // share this one evaluator — no second copy of the recursion /
    // NULL-propagation / div-by-zero logic to drift (the
    // and_child_rank/narrow_rec single-source-of-truth lesson from #741). The
    // per-card call site (tri's NumericCmp arm) passes a concrete closure, so
    // monomorphization + #[inline(always)] reproduce the pre-#743 hand-written
    // match exactly.
    #[inline(always)]
    fn eval_with<F: Fn(NumField) -> NumVal>(&self, fetch: &F) -> NumVal {
        match self {
            NumExpr::Const(v) => NumVal::Known(*v),
            NumExpr::Field(f) => fetch(*f),
            NumExpr::Arith(lhs, op, rhs) => Self::eval_arith_with(lhs, *op, rhs, fetch),
        }
    }

    fn eval_arith_with<F: Fn(NumField) -> NumVal>(lhs: &NumExpr, op: ArithOp, rhs: &NumExpr, fetch: &F) -> NumVal {
        // Null dominates PDep: Null op anything is Null for every
        // printing, so the card-level result is already exact.
        match (lhs.eval_with(fetch), rhs.eval_with(fetch)) {
            (NumVal::Null, _) | (_, NumVal::Null) => NumVal::Null,
            (NumVal::PDep, _) | (_, NumVal::PDep) => NumVal::PDep,
            (NumVal::Known(l), NumVal::Known(r)) => match op {
                ArithOp::Add => NumVal::Known(l + r),
                ArithOp::Sub => NumVal::Known(l - r),
                ArithOp::Mul => NumVal::Known(l * r),
                ArithOp::Div => {
                    if r == 0.0 { NumVal::Null } else { NumVal::Known(l / r) }
                }
            },
        }
    }
}

/// The trivalent result of a `lhs op rhs` numeric comparison, over any field-fetch.
/// Shared by `FilterExpr::tri`'s `NumericCmp` arm (fetch = `field_num`) and the #743
/// arith-tuple scan (fetch = the four card-level fields of one tuple key) so both go
/// through the exact same Null/PDep handling. `#[inline(always)]` + monomorphization
/// keeps the hot `tri` arm byte-for-byte with its former inline match.
#[inline(always)]
pub(crate) fn numeric_cmp_tri<F: Fn(NumField) -> NumVal>(lhs: &NumExpr, op: CmpOp, rhs: &NumExpr, fetch: &F) -> Tri {
    match (lhs.eval_with(fetch), rhs.eval_with(fetch)) {
        (NumVal::Null, _) | (_, NumVal::Null) => Tri::Null, // missing field: SQL NULL
        (NumVal::PDep, _) | (_, NumVal::PDep) => Tri::PrintingDep,
        (NumVal::Known(a), NumVal::Known(b)) => tri_bool(num_cmp(op, a, b)),
    }
}

// ─── per-face numeric values (gen 28) ────────────────────────────────────────
//
// Scryfall matches a `//` card if ANY FACE satisfies the predicate, and the three stat columns
// are INDEPENDENT of one another when it does. Both halves are measured against
// api.scryfall.com, 2026-08-16, with `!"Full // Name"` scoping so the answer is 1 or 404:
//
//   pow>=3                on Delver of Secrets (1/1 // 3/2)          -> 1   (back only)
//   pow=1 tou=2           on Delver                                   -> 1   (no face is 1/2)
//   pow>=3 pow<=1         on Delver                                   -> 1   (one column, two faces)
//   pow>tou               on Huntmaster of the Fells (2/2 // 4/4)     -> 1   (no face has p>t)
//   pow=tou               on Thing in the Ice (0/4 // 7/8)            -> 404 (no pair is equal)
//
// The last two are the pair that settles the shape: a per-face ROW model answers 404 to
// `pow>tou` on Huntmaster, and a "max power vs max toughness" model answers 1 to `pow=tou` on
// Thing in the Ice. A card carrying a SET of values per column, with the comparison existential
// over the cross product, is the only one of the three that answers both as measured — so that
// is what `face_num_values` builds and what `build_arith_tuple_index` interns.
//
// NEGATION is deliberately not part of this: Scryfall IGNORES a negated numeric term outright
// (`-pow=1` answers with `Invalid expression "-pow=1" was ignored`, and `is:dfc -pow>=3` is 2,895
// = the unfiltered `is:dfc`), so it offers no oracle for what NOT should mean over a value set.
// This port keeps its existing NOT-of-the-existential, which is the deviation already ledgered.

/// How many distinct values one card can hold for one face-scoped column. Two faces is the whole
/// corpus (`reversible_card` and `meld` are single-faced rows), and the front's own value is one
/// of them; 4 leaves room for a future three-face layout without a heap allocation in `tri`.
const MAX_FACE_VALUES: usize = 4;

/// A fixed-capacity, allocation-free value set. Local rather than a new crate dependency: the
/// whole need is "up to four f64s on the stack, deduped", and the wasm engine pays for every
/// dependency it links.
#[derive(Default)]
struct FaceValues {
    vals: [f64; MAX_FACE_VALUES],
    len: usize,
}

impl FaceValues {
    fn push(&mut self, v: f64) {
        if self.vals[..self.len].contains(&v) || self.len == MAX_FACE_VALUES {
            return;
        }
        self.vals[self.len] = v;
        self.len += 1;
    }
    fn get(&self, i: usize) -> Option<f64> {
        if i < self.len { Some(self.vals[i]) } else { None }
    }
    /// One "don't care" slot when the card has 0 or 1 value, so a column the card has nothing
    /// for still evaluates once and reaches `field_num`'s NULL exactly as before.
    fn slots(&self) -> usize {
        self.len.max(1)
    }
}

/// True for the columns whose values a face can differ on. `Cmc` is deliberately NOT here:
/// measured, mana value stays card-level on every layout — `mv=0` on Delver (back has no cost),
/// `mv=2` on Fire // Ice (each half) and `mv=2` on Bonecrusher Giant // Stomp (the adventure's
/// cost) are all 404, while the front's 1 / the joined 4 / the creature's 3 all answer 1.
fn num_field_is_face_scoped(f: NumField) -> bool {
    matches!(f, NumField::Power | NumField::Toughness | NumField::Loyalty)
}

fn num_expr_touches_face_field(e: &NumExpr) -> bool {
    match e {
        NumExpr::Const(_) => false,
        NumExpr::Field(f) => num_field_is_face_scoped(*f),
        NumExpr::Arith(l, _, r) => num_expr_touches_face_field(l) || num_expr_touches_face_field(r),
    }
}

/// The distinct values this card holds for one face-scoped column, card value first.
///
/// The card value is always one of the faces' (the merge copies a whole `_FACE_STAT_GROUPS`
/// group from one face), so listing it first costs nothing and makes the single-face path —
/// `faces` empty, one value, identical to the pre-gen-28 behaviour — fall out rather than be
/// special-cased. A face with no value for the column contributes nothing, which is why
/// `pow=4` matches Bonecrusher Giant // Stomp and the costless adventure half adds no NULL.
fn face_num_values(card: &AOracleCard, f: NumField) -> FaceValues {
    let mut out = FaceValues::default();
    let mut push = |v: f64| out.push(v);
    match f {
        NumField::Power => {
            if let Some(v) = card.creature_power.as_ref() {
                push(f64::from(f32::from(*v)));
            }
            for face in card.faces.iter() {
                if let Some(v) = face.creature_power.as_ref() {
                    push(f64::from(f32::from(*v)));
                }
            }
        }
        NumField::Toughness => {
            if let Some(v) = card.creature_toughness.as_ref() {
                push(f64::from(f32::from(*v)));
            }
            for face in card.faces.iter() {
                if let Some(v) = face.creature_toughness.as_ref() {
                    push(f64::from(f32::from(*v)));
                }
            }
        }
        NumField::Loyalty => {
            if let Some(v) = card.planeswalker_loyalty.as_ref() {
                push(f64::from(*v));
            }
            for face in card.faces.iter() {
                if let Some(v) = face.planeswalker_loyalty.as_ref() {
                    push(f64::from(*v));
                }
            }
        }
        _ => {}
    }
    out
}

/// Existential re-evaluation of a `NumericCmp` over a multi-face card's value sets.
///
/// Only reached from `tri` when the card HAS faces and the card-level answer was not already
/// `True`, so the 82% single-face majority and every already-matching row pay one branch. The
/// three columns are enumerated independently (the cross product, per the measurements above);
/// `Cmc` and every printing-level field keep coming from `field_num`, unchanged.
///
/// Three-valued aggregation matches `tri`'s own: any `True` wins, else any `False`, else `Null`.
fn face_numeric_cmp_tri(
    card: &AOracleCard,
    printing: Option<&APrinting>,
    lhs: &NumExpr,
    op: CmpOp,
    rhs: &NumExpr,
    base: Tri,
) -> Tri {
    if !num_expr_touches_face_field(lhs) && !num_expr_touches_face_field(rhs) {
        return base;
    }
    let powers = face_num_values(card, NumField::Power);
    let toughnesses = face_num_values(card, NumField::Toughness);
    let loyalties = face_num_values(card, NumField::Loyalty);
    let mut acc = base;
    for pi in 0..powers.slots() {
        for ti in 0..toughnesses.slots() {
            for li in 0..loyalties.slots() {
                let fetch = |f: NumField| -> NumVal {
                    let pick = |vs: &FaceValues, i: usize| vs.get(i).map_or(NumVal::Null, NumVal::Known);
                    match f {
                        NumField::Power => pick(&powers, pi),
                        NumField::Toughness => pick(&toughnesses, ti),
                        NumField::Loyalty => pick(&loyalties, li),
                        other => field_num(card, printing, other),
                    }
                };
                match numeric_cmp_tri(lhs, op, rhs, &fetch) {
                    Tri::True => return Tri::True,
                    Tri::PrintingDep => return Tri::PrintingDep,
                    Tri::False => acc = Tri::False,
                    Tri::Null => {}
                }
            }
        }
    }
    acc
}

/// Card-level numeric fields the #743 joint-tuple index covers: all card-scoped (not
/// printing-dependent), all small bounded integer domains, confirmed low joint
/// cardinality (531-564 distinct combinations — see docs/issues/00743). A numeric
/// expression is tuple-evaluable iff every `NumField` it references (recursively
/// through `Arith`) is one of these; any other field (edhrec, price*, rarity, cn,
/// prefer) disqualifies the whole expression.
pub(crate) fn num_field_in_arith_tuple_scope(f: NumField) -> bool {
    matches!(f, NumField::Cmc | NumField::Power | NumField::Toughness | NumField::Loyalty)
}

fn num_expr_all_in_tuple_scope(e: &NumExpr) -> bool {
    match e {
        NumExpr::Const(_) => true,
        NumExpr::Field(f) => num_field_in_arith_tuple_scope(*f),
        NumExpr::Arith(l, _, r) => num_expr_all_in_tuple_scope(l) && num_expr_all_in_tuple_scope(r),
    }
}

/// A bare single-field `{cmc,power,toughness} op const` comparison — already handled
/// exactly by `narrow_rec`'s dedicated single-field numeric-index arms. The tuple route
/// must decline these (the direct index is at least as good, and re-routing their
/// negation would desync `and_child_rank`'s ranking from `narrow_rec`'s dispatch — the
/// exact mismatch class #741 fought). Loyalty is intentionally excluded: it has no
/// dedicated numeric index, so the tuple route is its only narrowing.
fn is_bare_dedicated_numeric(f: &FilterExpr) -> bool {
    matches!(
        f,
        FilterExpr::NumericCmp { lhs: NumExpr::Field(NumField::Cmc | NumField::Power | NumField::Toughness), rhs: NumExpr::Const(_), .. }
            | FilterExpr::NumericCmp { lhs: NumExpr::Const(_), rhs: NumExpr::Field(NumField::Cmc | NumField::Power | NumField::Toughness), .. }
    )
}

/// Single source of truth (#741 precedent) for "does this filter take the #743 arith-tuple
/// route": a `NumericCmp` whose every referenced field is in `num_field_in_arith_tuple_scope`,
/// and which is *not* one of the bare single-field shapes the dedicated numeric-index arms
/// already own. Both `narrow_rec` (positive fallback and the negated arm) and `and_child_rank`
/// gate on this one function, so the narrowing dispatch and its cost ranking cannot drift.
/// A mixed expression (e.g. `usd+1<power`, an in-scope field with a printing-level one) fails
/// the scope check and declines here entirely — it is never partially narrowed.
pub(crate) fn is_arith_tuple_route(f: &FilterExpr) -> bool {
    match f {
        FilterExpr::NumericCmp { lhs, rhs, .. } => {
            num_expr_all_in_tuple_scope(lhs) && num_expr_all_in_tuple_scope(rhs) && !is_bare_dedicated_numeric(f)
        }
        _ => false,
    }
}

/// Evaluate a tuple-routed `NumericCmp` against one joint tuple key's four field values
/// (each `None` = the card has no value for that field, i.e. SQL NULL). Reuses
/// `numeric_cmp_tri`/`NumExpr::eval_with` — the identical evaluator the per-card path
/// uses — so the differential test's exact-agreement claim holds by construction, not by
/// a parallel reimplementation. Returns `Tri::True`/`Tri::False`/`Tri::Null`; `PrintingDep`
/// cannot occur (all four fields are card-level), and any out-of-scope field would be an
/// `is_arith_tuple_route` bug, caught by the debug_assert (CI runs debug).
pub(crate) fn eval_arith_tuple_tri(
    lhs: &NumExpr,
    op: CmpOp,
    rhs: &NumExpr,
    cmc: Option<f64>,
    power: Option<f64>,
    toughness: Option<f64>,
    loyalty: Option<f64>,
) -> Tri {
    let fetch = |f: NumField| -> NumVal {
        let v = match f {
            NumField::Cmc => cmc,
            NumField::Power => power,
            NumField::Toughness => toughness,
            NumField::Loyalty => loyalty,
            _ => {
                debug_assert!(false, "out-of-scope field reached arith-tuple eval; is_arith_tuple_route is wrong");
                None
            }
        };
        v.map_or(NumVal::Null, NumVal::Known)
    };
    numeric_cmp_tri(lhs, op, rhs, &fetch)
}

/// The one numeric comparator dispatch. `pub(crate)` because the rarity candidate
/// builders in `lib.rs` need exactly this and used to each carry their own copy.
pub(crate) fn num_cmp(op: CmpOp, a: f64, b: f64) -> bool {
    match op {
        CmpOp::Eq => a == b,
        CmpOp::Ne => a != b,
        CmpOp::Lt => a < b,
        CmpOp::Le => a <= b,
        CmpOp::Gt => a > b,
        CmpOp::Ge => a >= b,
    }
}

// ─── Color / collection / text field enums ───────────────────────────────────

#[derive(Clone, Copy)]
pub(crate) enum ColorField {
    Colors,
    ColorIdentity,
    ProducedMana,
}

fn card_colors(card: &AOracleCard, f: ColorField) -> u8 {
    match f {
        ColorField::Colors        => card.card_colors,
        ColorField::ColorIdentity => card.card_color_identity,
        ColorField::ProducedMana  => card.produced_mana,
    }
}

// ─── per-face colours ────────────────────────────────────────────────────────
//
// `colors` is the one colour column a face has of its own, and Scryfall compares the query against
// EVERY face's mask, existentially — the same shape the stat columns take, and for the same
// measured reason. Each row below is a live probe against api.scryfall.com on 2026-08-16, scoped
// with `!"Full // Name"` so the answer is 1 or 404:
//
//   c=b     on Valki, God of Lies // Tibalt (B // BR)             -> 1    the FRONT's mask alone
//   c:c     on Kabira Takedown // Kabira Plateau (W // [])        -> 1    the land back is colourless
//   c=wb    on Extus // Awaken the Blood Avatar (WB // BR)        -> 1    one face exactly
//   c=br    on Extus                                              -> 1    the other face exactly
//   c:brw   on Extus                                              -> 404  NO face is {W,B,R}
//   c=3     on Extus                                              -> 404  no face has three
//   c=2     on Extus                                              -> 1    both faces have two
//   c<=b    on Valki // Tibalt                                    -> 1    B ⊆ B
//   c:c     on Fire // Ice (split, faces declare NO colours)      -> 404  the faces are the card's
//
// The last row is the one that constrains the SHAPE rather than the semantics: a split or flip
// face carries no `colors` key at all, so reading its absence as the mask 0 would answer 1 there.
// The middle rows are why the card's own union is NOT a member of the set — `c:brw` and `c=3` are
// satisfied by {W,B,R} and by nothing else, and {W,B,R} is a value no face of Extus has.
//
// `color_identity` and `produced_mana` are card-level and stay that way, measured the same way and
// agreeing on both sides already: `id=wbr` on Extus is 1 while `id=wb` and `id=2` are 404 (the
// identity really is the card's three colours, not either face's two), and Scryfall's face objects
// carry neither key. Mana VALUE is card-level for the identical reason — see
// `num_field_is_face_scoped`.

/// One card's colour comparison against one mask. The single definition the THREE structures that
/// decide a colour leaf share: `tri`'s ColorCmp arm below; `planes::compile_plane`, which evaluates
/// it at COMPILE time against every possible mask to pick the planes to OR; and
/// `exact_result_total`'s color arm, which runs it over every stored combination in the totals
/// table. Stating the operator once is what makes the plane expression, the totals lookup and `tri`
/// unable to disagree about it — a query bare enough to reach the totals table still has to agree
/// with the residual path a compound query would fall back to.
pub(crate) fn color_cmp(bits: u8, op: CmpOp, mask: u8, field: ColorField) -> bool {
    match op {
        // mask == 0 means the query was literally "c"/"colorless" (see
        // get_colors_comparison_object on the Python side), not "at
        // least zero colors" -- bits & 0 == 0 is vacuously true for
        // every card, so Ge must fall back to exact equality here.
        //
        // That is right for `:` and WRONG for `>=`, which Scryfall answers as the tautology every
        // card is a superset of nothing (`c>=colorless` = 33,599 = the corpus, 2026-08-28). The two
        // spellings share CmpOp::Ge by the time they reach here and cannot be told apart, so the
        // `>=` case is separated in the PARSER instead, as the count comparison `>= 0` -- see
        // card_query_nodes' _COLORLESS_BY_OPERATOR. This line keeps answering for `:`.
        CmpOp::Ge => if mask == 0 { bits == 0 } else { bits & mask == mask },
        CmpOp::Eq => bits == mask,
        // A CARD THAT PRODUCES NOTHING IS NOT A PRODUCER OF ANYTHING, and the two subset operators
        // are where that bites: `bits & !mask == 0` is vacuously true of the empty set, so without
        // the extra conjunct `produces<w` and `produces<=w` sweep in every card that produces no
        // mana at all. Scryfall excludes them, measured against api.scryfall.com 2026-08-28,
        // corpus-wide (33,599 cards) and against the `e:khm t:creature` base (151):
        //
        //   produces<w  = produces<white  = 0      (base 0)   -- the empty set is the only proper
        //                                                        subset of {W}, and it is excluded
        //   produces<=w = produces<=white = 72     (base 0)   = `produces=w`, exactly {W}
        //   produces<wu                   = 163               = {W} 72 + {U} 91, no empty set
        //   produces<=wu                  = 211               = those plus {W,U}'s 48
        //   produces<c                    = 0                 -- C is a real produced value, and
        //   produces<=c                   = 481                  it behaves like any other lane
        //
        // This port answered 139 on `e:khm t:creature produces<white` -- the 139 creatures in the
        // set that produce nothing -- for `<` and `<=` alike.
        //
        // ONLY these two operators, and only on this column. `produces!=w` is 33,527 = 33,599 - 72,
        // so `!=` DOES admit the non-producers; `=`, `>` and `>=` exclude them on their own for any
        // non-empty mask, which produced_mana's always is (`produces:c` is the C lane, not the
        // empty set). The two colour columns keep the plain subset test: `c<w` = 4,300 = `c:c` and
        // `id<w` = 2,959 = `id:c` -- colourless cards ARE in a colour column's `<` and `<=`, which
        // is the whole of what makes `id<=wu` the commander query it is.
        //
        // planes::cmp_expr carries the identical conjunct for the plane path; the two must agree
        // because the estimator reports the plane compilation as exact.
        CmpOp::Le => bits & !mask == 0 && produces_something(bits, field),
        CmpOp::Lt => bits & !mask == 0 && bits != mask && produces_something(bits, field),
        CmpOp::Gt => bits & mask == mask && bits != mask,
        CmpOp::Ne => bits != mask,
    }
}

/// The "at least one produced value" conjunct `color_cmp`'s two subset operators carry on
/// produced_mana, and nothing at all on the two colour columns.
fn produces_something(bits: u8, field: ColorField) -> bool {
    !matches!(field, ColorField::ProducedMana) || bits != 0
}

/// How many colours one mask counts as, for `c=2` / `id>=3` / `produces=6`.
///
/// WIDTH DEPENDS ON THE COLUMN, and the asymmetry is measured. For the two colour columns the C
/// bit (32) is masked OFF before counting: colorless is ZERO colors on Scryfall (`c:all` =
/// `c:wubrg` = `c=5` = 60, and `c=6` is not even a valid query there), matching the SQL path's
/// magic.color_identity_mask. produced_mana keeps it: that array can literally contain "C" — Sol
/// Ring produces ["C"] while its colors and color_identity are both [] — so `produces=6` = 106 =
/// `produces:all` and the 481 cards producing colorless and nothing else answer `produces=1`.
/// magic.produced_mana_mask is the six-bit twin of this line.
pub(crate) fn color_count(bits: u8, f: ColorField) -> u8 {
    let mask = if matches!(f, ColorField::ProducedMana) { 0b11_1111 } else { 0b1_1111 };
    (bits & mask).count_ones() as u8
}

/// The distinct colour masks this card holds — the query-time twin of `lib::face_color_masks`,
/// which enumerates the identical set at build time for the planes. Read that one's doc for why
/// the card's union is excluded and why an absent face `colors` inherits it.
///
/// Returns `None` for the two card-level columns and for the ~82% of cards with no faces, which is
/// the caller's signal to keep using the single card-level mask it already read.
fn face_color_masks(card: &AOracleCard, f: ColorField) -> Option<impl Iterator<Item = u8> + '_> {
    if card.faces.is_empty() || !matches!(f, ColorField::Colors) {
        return None;
    }
    let card_mask = card.card_colors;
    Some(card.faces.iter().map(move |face| face.card_colors.as_ref().map_or(card_mask, |v| *v)))
}

// ─── the front face, and `is:vanilla` ────────────────────────────────────────
//
// `is:vanilla` — and `has:vanilla`, its total alias — is the third face-scoped shape after the
// numeric columns above and the colour masks beside them, and the only one that is not existential.
// It is a predicate rather than the `t:creature -o:/./` expansion it replaces because that rewrite
// reads the MERGED row, whose text is every face's joined: a card whose FRONT face prints nothing
// loses to the half that does. 352 on both sides against Scryfall's own 363.
//
// THREE RULES, each measured against api.scryfall.com on 2026-08-17, and only the first is the
// question the diagnosis started from:
//
//   1. THE FRONT FACE ANSWERS — not the merged row, and NOT any face. `is:vanilla o:/./` is 12
//      there and all 12 are adventures whose creature front is blank behind an Instant/Sorcery half
//      that prints (`Beluna's Gatekeeper // Entry Denied`). The back is NOT enough: all four of
//      `Kaslem's Stonetree`, `Ecstatic Awakener`, `Chosen of Markov` and `Skin Invasion` have a
//      blank creature BACK behind a front that prints, and `is:vanilla` on the four is 0. The token
//      rows settle it in the other direction — `is:vanilla is:dfc` is 18 there, and it holds
//      `Servo // Thopter` and `Goblin // Blood` (blank front, printing back) while leaving out
//      `Elemental // Centaur` and `Fish // Kraken` (printing front, blank back).
//
//   2. THE CREATURE TEST IS THE CARD'S, not the front face's. `City's Blessing // Elemental` and
//      `Copy // Horror` are both in that 18, and neither FRONT is a creature — the back is. So the
//      card must be a creature somewhere and its front must be silent, which is exactly the pair
//      `card_types` and `faces[0]` already hold.
//
//   3. A LAND IS NEVER VANILLA. `t:creature -o:/./ -is:vanilla` is exactly 1 there and it is
//      `Dryad Arbor`, whose land types grant `{T}: Add {G}` with nothing printed to say so.
//      `is:vanilla t:land` is 0 there with and without `include_extras`, while
//      `t:creature t:land -o:/./` is 2 — Dryad Arbor and the `Forest Dryad` token. Both candidates,
//      neither vanilla, and over the whole 540,484-row import those 2 are the only rows the clause
//      removes: a creature with no printed text produces mana only through a land type.
//
// And the text read is the SEARCHABLE form, reminder stripped, the same text `o:` searches:
// `Icehide Golem` ("({S} can be paid with one mana from a snow source.)") and `Infinity Elemental`
// ("(This creature has INFINITE POWER.)") are both vanilla there and neither prints an empty string.
//
// 352 + 12 − 1 = 363, which is Scryfall's own count. Every field this reads is already in the
// archive — `card_types`, `oracle_text_lower_id`, and `OracleFace::oracle_text_id` since gen 28 —
// so nothing is stored for it and no generation moves.

/// Whether a face's PRINTED text leaves nothing behind once its reminder text is removed.
///
/// `strip_reminder_text` rather than a second parenthesis walk, so "what `o:` searches" keeps one
/// definition: a face whose text is entirely parenthetical is blank here for the same reason it is
/// invisible to `o:/./`. The empty case — all 12 adventures — never reaches the strip.
fn text_blank_after_reminders(text: &str) -> bool {
    text.is_empty() || crate::strip_reminder_text(text).trim().is_empty()
}

/// `is:vanilla` / `has:vanilla`: a creature whose FRONT face prints no rules text.
///
/// The type half is two mask bits the build already parsed off the whole type line, so it needs no
/// face walk and no lowercasing; the text half is one face read, or the card's own stripped column
/// for the ~82% with no faces — where the card IS its one face.
fn card_is_vanilla(card: &AOracleCard, strings: &AStrings) -> bool {
    let bits = u16::from(card.card_types);
    if bits & super::TYPE_CREATURE == 0 || bits & super::TYPE_LAND != 0 {
        return false;
    }
    match card.faces.first() {
        // `oracle_text_lower_id` is ALREADY the reminder-stripped form, and a textless card interns
        // "" rather than NONE_STR — so absence and emptiness agree and the strip is not repeated.
        None => str_at(strings, u32::from(card.oracle_text_lower_id)).is_none_or(str::is_empty),
        // A FACE carries the printed string (nothing strips a face's text at build), so the strip
        // happens here — for the one face, never the whole list.
        Some(front) => str_at(strings, u32::from(front.oracle_text_id)).is_none_or(text_blank_after_reminders),
    }
}

#[derive(Clone, Copy)]
pub(crate) enum CollField {
    Subtypes,
    Keywords,
    OracleTags,
    ArtTags,
    IsTags,
    FrameData,
}

/// Collections are interned vocab ids (see VocabInterner). Card-level
/// collections come from the OracleCard; printing-level ones (art/is tags,
/// frame data) come from the printing — None during the card pass.
fn collection<'a>(
    card: &'a AOracleCard,
    printing: Option<&'a APrinting>,
    f: CollField,
) -> Option<&'a rkyv::vec::ArchivedVec<rkyv::rend::u16_le>> {
    match f {
        CollField::Subtypes   => Some(&card.card_subtypes),
        CollField::Keywords   => Some(&card.card_keywords),
        CollField::OracleTags => Some(&card.card_oracle_tags),
        CollField::ArtTags    => printing.map(|p| &p.card_art_tags),
        CollField::IsTags     => printing.map(|p| &p.card_is_tags),
        CollField::FrameData  => printing.map(|p| &p.card_frame_data),
    }
}

// enum_variant_names: the `Lower` suffix is load-bearing, not noise — these name the
// case/accent-folded store columns (`card_name_lower`, `oracle_text_lower`, …) that search
// actually reads, as distinct from the display columns of the same fields.
#[allow(clippy::enum_variant_names)]
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum TextSearchField {
    /// `name:"…"` — the LITERAL name match, `card_name_lower` and nothing folded past its case.
    /// Measured on api.scryfall.com 2026-08-16: `name:"eowyn"` answers 0 while `name:"éowyn"`
    /// answers 3, and `name:"lim-dul"` answers 0 while `name:"lim-dûl"` answers 8 — a quoted
    /// value reaches only the spelling the searcher typed.
    NameLower,
    /// `name:word` — the BARE-word match, against `card_name_collated`: diacritics folded and
    /// every non-alphanumeric character removed. The overwhelmingly common form (a bare word in
    /// a query IS this predicate), and the one that makes `ft` answer 1,628 rather than 362 by
    /// reaching "Sword **of the** Ages" through the vanished space.
    NameCollated,
    OracleTextLower,
    /// `fo:`/`fulloracle:` — oracle text WITH reminder text, the form Scryfall's
    /// full-oracle operator searches and the one `OracleTextLower` stopped being.
    /// Deliberately index-free: `o:` carries the trigram index because it is the
    /// common operator, and `fo:` is rare enough that a card-level scan over the
    /// distinct texts is the right trade against a second ~5 MB index.
    FullOracleTextLower,
    FlavorTextLower,
    /// `a:"quoted"` — the value as written, still UNfolded by the parser.
    ///
    /// Kept as its own variant only because the parser distinguishes the two node shapes; both
    /// arms bind through `artist_contains_ids`, because Scryfall draws no quoted/bare line for
    /// artists the way it does for `name:` — `a:"rebeccaguay"` answers `a:rebecca-guay`'s 399.
    ArtistLower,
    /// `a:word` — the COLLATED artist (diacritics folded, every non-alphanumeric character gone),
    /// which is what Scryfall compares EVERY artist value against, bare or quoted, `:` or `=`.
    ArtistCollated,
}

/// Text operand during evaluation; PDep only in the card-level pass.
enum StrVal<'a> {
    Known(&'a str),
    Null,
    PDep,
}

fn opt_sv(v: Option<&str>) -> StrVal<'_> {
    v.map_or(StrVal::Null, StrVal::Known)
}

/// The SECOND value a text field compares against, for the one field that has two.
///
/// `layout:` is a multi-VALUE column and not a scalar one: a `reversible_card` printing answers
/// both `layout:reversible_card` and its faces' `layout:normal` (measured on api.scryfall.com —
/// `is:reversible layout:reversible_card` 81, `is:reversible layout:normal` 77, and the whole
/// 77-row gap between `layout:normal`'s 106,635 there and the 106,558 printings whose own layout
/// is `normal`). See `DivergentPrinting::face_layout_id`.
///
/// `watermark:` is one too, and per FACE rather than per printing: `Research // Development`
/// (dis/155) prints simic on its front and izzet on its back, and api.scryfall.com answers it for
/// both `wm:simic` and `wm:izzet`. 19 printings in the 2026-08-16 default_cards bulk carry a
/// watermark only a non-front face has. See `PrintingFace::card_watermark_id`.
///
/// UNBOUNDED, not "one more". A cap here would be a cap on what `tri` can see while
/// `indexes.watermarks` indexes every value a printing has, and the two disagreeing is precisely
/// the shape `compile_plane`'s exactness contract cannot survive — the postings leaf is claimed
/// EXACT and nothing downstream re-checks it, so a third face watermark would have to either
/// silently drop out of the filter or panic the build. It does neither: this yields all of them.
/// Allocation-free (an enum, not a `Box<dyn Iterator>`) because it runs per candidate printing.
///
/// Exhaustive over `TextField`, not a `matches!` with a hidden `_ => Empty`: a field that gains a
/// second value must get a considered answer here rather than silently keeping one. `Empty` means
/// "this field has exactly one value", which is every field but `Layout` and `Watermark`.
fn extra_text_field_values<'a>(
    card: &'a AOracleCard,
    printing: Option<&'a APrinting>,
    strings: &'a AStrings,
    field: TextField,
) -> ExtraStrs<'a> {
    match field {
        TextField::Layout => printing
            .and_then(|p| crate::divergent_of(card, p))
            .and_then(|d| str_at(strings, u32::from(d.face_layout_id)))
            .map_or(ExtraStrs::Empty, ExtraStrs::One),
        // The FACES' watermarks. `text_field_value` already answered with `Printing`'s own, which
        // is the front face's copy for a faced printing, so the front repeating here is harmless:
        // every use of this is an existential OR against that same value.
        TextField::Watermark => match printing {
            Some(p) => ExtraStrs::Faces { faces: p.faces.iter(), strings },
            None => ExtraStrs::Empty,
        },
        TextField::NameLower
        | TextField::OracleTextLower
        | TextField::FullOracleTextLower
        | TextField::FlavorTextLower
        | TextField::ArtistLower
        | TextField::SetCode
        | TextField::Border
        | TextField::CollectorNumber
        | TextField::TypeLine
        | TextField::ManaCostText => ExtraStrs::Empty,
    }
}

/// Three-valued existential over every value a `TextField` carries on this printing — the one
/// shape `TextExact` and `TextRegex` both evaluate, so they cannot drift apart on which values
/// they see.
///
/// `Tri::Null` is reserved for "this printing answers NOTHING here", which on a nullable
/// multi-valued field means the scalar is absent AND no face supplies one. A faced printing whose
/// back alone carries the watermark is therefore False-or-True, never Null — the front's absence
/// is not the printing's.
/// The separator `merge_face_drafts` joins a card's face texts with — the builder's own
/// `FACE_TEXT_SEPARATOR`, kept in step with `_FACE_TEXT_SEPARATOR` in
/// api/card_processing.py. THIS STORE INVENTED IT. Scryfall never joins: it matches each face
/// separately, so any pattern that can see a character of this separator sees something that is
/// not in Scryfall's haystack at all.
pub(crate) const FACE_TEXT_SEPARATOR: &str = "\n//\n";

/// Whether a field's stored value is a face JOIN rather than one face's text.
///
/// Three of them, and exactly the three `_FACE_JOINED_TEXTS` names — but only two SEPARATORS.
/// `type_line` joins with " // " and is NOT here, because that string is Scryfall's own: its
/// top-level `type_line` for a split card is "Instant // Instant", and `t:/\/\//` answers 930
/// there (2026-08-28) where `o:/^\/\/$/` answers nothing at all. The newline form is the invented
/// one, and it is the only one worth undoing.
fn field_joins_faces(field: TextField) -> bool {
    matches!(
        field,
        TextField::OracleTextLower | TextField::FullOracleTextLower | TextField::FlavorTextLower
    )
}

/// A card's own name, truncated where Magic's legendary short name is.
///
/// MEASURED, and the separator set is the whole rule. `!"Rankle, Master of Pranks" o:/~/` is 1 on
/// api.scryfall.com 2026-08-28 and Rankle's text never spells the full name — it says "Whenever
/// Rankle deals combat damage" — so the pre-comma form is an alias. So are the two other
/// conventional cuts: Eron the Relentless ("Regenerate Eron"), Svyelun of Sea and Sky ("Svyelun
/// has indestructible"), Braulios of Pheres Band, Storm of Memories (whose stripped text opens on
/// the bare line "Storm", which is what makes `o:/^~$/` answer exactly 1 corpus-wide).
///
/// It is NOT "the first word": Hurska Sweet-Tooth's text says "Whenever Hurska attacks" and the
/// card does NOT match, because its name carries none of the three separators. Nor is it
/// legendary-only — For the Common Good, From the Catacombs, Turn the Tide, Choice of Damnations
/// and Start the TARDIS all match on their prefixes, and not one of them is legendary.
///
/// The EARLIEST separator wins, which is what keeps "Rankle, Master of Pranks" cutting at the
/// comma rather than at the " of ". What the separators CANNOT reach is
/// [`SELF_REF_CURATED_SHORT_NAMES`], which is data and not a rule.
fn legendary_short_name(name: &str) -> &str {
    let mut cut = name.len();
    for sep in [",", " the ", " of "] {
        match name.find(sep) {
            Some(at) if at > 0 && at < cut => cut = at,
            _ => {}
        }
    }
    &name[..cut]
}

/// Write [`SELF_REF_SENTINEL`] over every occurrence of the card's own names in one face's text.
///
/// The inverse of what a reader expects, and deliberately: the ALTERNATIVE is to interpolate the
/// name into the pattern, which makes the pattern card-dependent and costs one regex compile per
/// candidate — and a `~` query is unnarrowable, so "per candidate" is the whole corpus. Compiling
/// once with a sentinel and rewriting the haystack instead is one compile and one scan.
///
/// THE WORD BOUNDARY IS CHECKED HERE, against the NAME's own edges, because that is where
/// Scryfall checks it. `\b(?:name|…)\b` is what its alias compiles to, and `\b` is a boundary
/// between a word character and a non-word one — so for a name that ENDS in punctuation it
/// demands a word character AFTER the punctuation, which almost never follows. That is not a
/// curiosity: `!"Kaboom!" o:/~/` is 404 on api.scryfall.com (2026-08-28) even though the card's
/// text opens "Kaboom! deals damage equal to…", and a sentinel wearing its own `\b` would have
/// called it a match. Checking the name's edges and then writing a BARE sentinel reproduces
/// Scryfall's answer for both shapes.
///
/// The ordinary half is measured the same way: `!"On the Job"`, `!"Get the Point"` and `!"In the
/// Presence of Ages"` are all 404, each short form ("On", "Get", "In") appearing in its text only
/// inside "control", "target" and "into" — while every card whose short name stands as its own
/// word matches.
///
/// Longest name first, so "Rankle, Master of Pranks" is consumed before the "Rankle" inside it.
///
/// Borrows when no name occurs, which is the common case by a wide margin: 3,046 of the 19,228
/// cards `o:/~/` matches do so through a NAME (`o:/~/ -o:/this/`), so roughly nine candidates in
/// ten never allocate at all.
fn with_self_reference<'a>(text: &'a str, names: &[&str]) -> std::borrow::Cow<'a, str> {
    if !names.iter().any(|n| !n.is_empty() && text.contains(n)) {
        return std::borrow::Cow::Borrowed(text);
    }
    let mut out = std::borrow::Cow::Borrowed(text);
    for name in names {
        if name.is_empty() || !out.contains(name) {
            continue;
        }
        out = std::borrow::Cow::Owned(replace_bounded(&out, name));
    }
    out
}

/// `\w` as the compiled patterns mean it: the regex crate's Unicode `\w` is
/// `[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}]`, of which this covers everything a card
/// name or an oracle text has ever carried.
fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Whether `\b` holds between two adjacent characters, a string edge counting as non-word.
fn is_boundary(before: Option<char>, after: Option<char>) -> bool {
    before.is_some_and(is_word_char) != after.is_some_and(is_word_char)
}

/// Write the sentinel over every `\b<needle>\b` occurrence, leaving unbounded ones alone.
fn replace_bounded(text: &str, needle: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut consumed = 0usize;
    while let Some(at) = rest.find(needle) {
        let start = consumed + at;
        let end = start + needle.len();
        let before = text[..start].chars().next_back();
        let first = needle.chars().next();
        let last = needle.chars().next_back();
        let after = text[end..].chars().next();
        if is_boundary(before, first) && is_boundary(last, after) {
            out.push_str(&rest[..at]);
            out.push(SELF_REF_SENTINEL);
        } else {
            out.push_str(&rest[..at + needle.len()]);
        }
        rest = &rest[at + needle.len()..];
        consumed = end;
    }
    out.push_str(rest);
    out
}

/// `regex.is_match`, run PER FACE on the fields whose stored value is a join.
///
/// `o:/\ndraw/` is 381 on api.scryfall.com and was 389 here (2026-08-28). The eight extras are
/// every one a two-face card whose BACK face opens with "Draw": the separator ends in a newline,
/// so "\n//\nDraw…" contains "\ndraw" and the joined string answers a pattern no face answers.
///
/// Splitting is the WHOLE difference, and a small one by construction, because `QUERY_REGEX_FLAGS`
/// already carries `m` without `s`: `^` and `$` bind at every line boundary and `.` never crosses
/// one, so the only positions a pattern can reach across a face boundary are the ones the
/// separator's own characters create. Undoing the join removes exactly those and nothing else.
/// A single-face card has no separator, so `split` yields the one segment and the cost is one scan
/// for the needle that is not there.
/// The face-join rule for `TextSearchField`, the substring side's enum. Same three columns, and
/// the same reason — see `field_joins_faces`.
fn search_field_joins_faces(field: TextSearchField) -> bool {
    matches!(
        field,
        TextSearchField::OracleTextLower | TextSearchField::FullOracleTextLower | TextSearchField::FlavorTextLower
    )
}

/// `str::contains`, PER FACE on the joined columns.
///
/// A substring can only span a face boundary by containing the separator's own characters, which
/// is rare enough to look ignorable and is not: `o:/\/\//` is a PLAIN LITERAL, so
/// `lowerLiteralRegexes` turns it into this predicate before the engine sees a pattern at all —
/// and it answered 849 here against 1 on api.scryfall.com (2026-08-28), the one real card being
/// SP//dr. The regex arm's fix does not reach it, because by then it is not a regex.
fn contains_per_face(needle: &str, field: TextSearchField, s: &str) -> bool {
    if search_field_joins_faces(field) {
        s.split(FACE_TEXT_SEPARATOR).any(|face| face.contains(needle))
    } else {
        s.contains(needle)
    }
}

/// The face split alone, for the two callers that have no card in hand.
fn regex_matches_face_split(regex: &CompiledRegex, field: TextField, s: &str) -> bool {
    if field_joins_faces(field) {
        s.split(FACE_TEXT_SEPARATOR).any(|face| regex.is_match(face))
    } else {
        regex.is_match(s)
    }
}

fn regex_matches_faces(
    regex: &CompiledRegex,
    field: TextField,
    s: &str,
    card: &AOracleCard,
    strings: &AStrings,
) -> bool {
    if !regex.has_self_reference() {
        return regex_matches_face_split(regex, field, s);
    }
    // `~` BINDS PER FACE, which is a second reason the split above is not merely a tidy-up:
    // the alias is the face's OWN name, not the card's. Measured on api.scryfall.com 2026-08-28
    // over the three cards in the corpus whose only self-reference-shaped text is the OTHER
    // face's name — none of them matches `o:/~/`.
    let segments: Vec<&str> =
        if field_joins_faces(field) { s.split(FACE_TEXT_SEPARATOR).collect() } else { vec![s] };
    let per_face = face_self_names(card, strings, segments.len());
    for (segment, names) in segments.iter().zip(per_face.iter()) {
        let needles: Vec<&str> = names.iter().map(String::as_str).collect();
        if regex.is_match(&with_self_reference(segment, &needles)) {
            return true;
        }
    }
    false
}

/// Short names Wizards uses that no separator can find. CURATED DATA, and a SNAPSHOT.
///
/// [`legendary_short_name`] cuts at `,` / ` the ` / ` of `, and after that cut and the phrase
/// family in `SELF_REF_THIS_PHRASES` the corpus-wide diff against api.scryfall.com (2026-08-28,
/// full `o:/~/` id sets both sides, 19,228 there) came to 53 names missing here. Forty-seven were
/// the two absent phrases. These six are the whole rest, each measured `!"<card>" o:/~/` = 1 with
/// the oracle text that earns it:
///
/// | card | text says | why no rule finds it |
/// |---|---|---|
/// | Drizzt Do'Urden | "When Drizzt enters" | no separator in the name |
/// | Hazezon Tamar | "When Hazezon enters" | no separator |
/// | King Darien XLVIII | "on King Darien" | no separator, and the alias is TWO words |
/// | Rasputin Dreamweaver | "Rasputin enters with seven dream counters" | no separator |
/// | Ryan Sinclair | "Whenever Ryan attacks" | no separator |
/// | Zurgo Bellstriker | "Zurgo can't block" | no separator |
///
/// KING DARIEN REFUTES "the first word", and Hurska Sweet-Tooth refutes it again from the other
/// side: its text says "Whenever Hurska attacks" and `!"Hurska Sweet-Tooth" o:/~/` is 0. One
/// two-word alias and one first-word non-alias, so what remains is a table Wizards keeps and
/// Scryfall reads — the CARDNAME templating each card is written against — not a derivation.
///
/// THEREFORE THIS DRIFTS. Every new legendary whose printed text uses a short name the separators
/// cannot cut is a new row, and nothing in the build will notice. To refresh: fetch both full
/// `o:/~/` id sets (Scryfall paginates 175/page, so does `/cards/search` here), diff them, and
/// sort each missing card into "the phrase family should have caught it" or "another row here".
const SELF_REF_CURATED_SHORT_NAMES: &[(&str, &str)] = &[
    ("drizzt do'urden", "drizzt"),
    ("hazezon tamar", "hazezon"),
    ("king darien xlviii", "king darien"),
    ("rasputin dreamweaver", "rasputin"),
    ("ryan sinclair", "ryan"),
    ("zurgo bellstriker", "zurgo"),
];

/// Names whose own text uses them as a GAME TERM, which Scryfall does not count as a self
/// reference. CURATED DATA, and a SNAPSHOT, for the same reason as above.
///
/// The other half of the 2026-08-28 diff: 16 names matched here and not there, and these seven are
/// the ones no rule explains. Each is a card named after a keyword ability, a keyword action or a
/// creature type, whose text spells that term because the term is what the card DOES:
///
/// | card | the occurrence | `!"<card>" o:/~/` |
/// |---|---|---|
/// | Assembly-Worker | "Target Assembly-Worker creature" (a creature TYPE) | 0 |
/// | Fear | "Enchanted creature has fear" | 0 |
/// | Lifelink | "Enchanted creature has lifelink" | 0 |
/// | Manifest Dread | "Manifest dread." | 0 |
/// | Regenerate | "Regenerate target creature." | 0 |
/// | Suspend | "it gains suspend" | 0 |
/// | Vigilance | "Enchanted creature has vigilance" | 0 |
///
/// CASE IS NOT THE RULE, tested both ways so the cheaper fix stays refuted. Regenerate and
/// Assembly-Worker spell the name in EXACT case and still do not match, so a case-sensitive alias
/// would not exclude them; and Sorry's text says `may say "sorry."` in lowercase against a name
/// spelled "Sorry", yet `o:/Say "~"/` returns it — so the alias is case-INSENSITIVE and a
/// case-sensitive alias would wrongly drop a card that matches. Neither direction survives.
///
/// Nor is it "the card is not legendary": For the Common Good and Turn the Tide are not legendary
/// and DO alias (see `legendary_short_name`). It is a judgement about what the sentence means,
/// which is data. The refresh procedure is the one above, read from the other side of the diff.
const SELF_REF_NON_ALIASING_NAMES: &[&str] =
    &["assembly-worker", "fear", "lifelink", "manifest dread", "regenerate", "suspend", "vigilance"];

/// One card name plus its legendary short form and its Alchemy-unprefixed form, longest first.
///
/// A PERIOD IN AN ALIAS KILLS IT, and that one IS a rule rather than a table. Nine of the sixteen
/// 2026-08-28 over-matches were cards whose only self-reference-shaped text is a name form
/// carrying a `.`: Black Waltz No. 3, Devil K. Nevil, Dr. Julius Jumblemorph, J. Jonah Jameson,
/// Mr. Foxglove, Ms. Marvel (both printings, aliasing at "Ms. Marvel"), U.S.Agent and
/// U.S.S. Enterprise-D. Checked over ALL 69 cards whose name contains a period, not just those
/// nine: ten reach a period-bearing form and nothing else, and not one of the ten is in Scryfall's
/// set; every period-named card that IS in the set gets there by a `this <noun>` phrase or by a
/// short name with no period in it — Nick Fury (from "Nick Fury, Agent of S.H.I.E.L.D.") and
/// Phoebe (from "Phoebe, Head of S.N.E.A.K.") are both 1. Zero counterexamples in either
/// direction. Goblin S.W.A.T. Team looks like one and is not: it matches, but `o:/Say "~"/` is 3
/// and it is not among them, so its `Say "Goblin S.W.A.T. Team"` is not where the match lands.
///
/// THE `A-` PREFIX IS NOT PART OF THE SELF-REFERENCE. An Alchemy rebalance is named "A-Blood
/// Artist" and its oracle text says "Whenever Blood Artist or another creature dies", so the name
/// as printed never appears in the text at all — and `!"A-Blood Artist" o:/~/` is 1 on
/// api.scryfall.com (2026-08-28). It is not a rounding error either: `name:/^a-/ o:/~/` is 138
/// there, against a corpus-wide `o:/~/` gap of 144 before this line existed.
fn self_names_of(name_lower: &str) -> Vec<String> {
    if SELF_REF_NON_ALIASING_NAMES.contains(&name_lower) {
        return Vec::new();
    }
    let mut out = vec![name_lower.to_string()];
    let short = legendary_short_name(name_lower);
    if short.len() != name_lower.len() {
        out.push(short.to_string());
    }
    if let Some((_, curated)) = SELF_REF_CURATED_SHORT_NAMES.iter().find(|(n, _)| *n == name_lower) {
        out.push((*curated).to_string());
    }
    if let Some(rebalanced) = name_lower.strip_prefix("a-") {
        out.push(rebalanced.to_string());
        let short = legendary_short_name(rebalanced);
        if short.len() != rebalanced.len() {
            out.push(short.to_string());
        }
        if let Some((_, curated)) = SELF_REF_CURATED_SHORT_NAMES.iter().find(|(n, _)| *n == rebalanced) {
            out.push((*curated).to_string());
        }
    }
    // A period anywhere in the form and the form is not an alias — see the doc comment.
    out.retain(|n| !n.contains('.'));
    // Longest first, so "rankle, master of pranks" is consumed before the "rankle" inside it.
    out.sort_by_key(|n| std::cmp::Reverse(n.len()));
    out.dedup();
    out
}

/// The names `~` may stand for, ONE LIST PER JOINED SEGMENT and in the same order.
///
/// The segments come from splitting the stored text on the separator, and the join dropped every
/// face whose text was empty — so the faces that line up with them are exactly the faces that
/// contributed. When that count matches, each segment gets its own face's names and nothing else,
/// which is the per-face binding Scryfall has.
///
/// When it does NOT match — a single-face card, a printing-level column like flavor text whose
/// faces live on the printing rather than here, or any future join this reasoning has not seen —
/// every name the card carries is offered to every segment. That is a SUPERSET, so it can only
/// over-match, and the only shape it over-matches on is a face whose text names its TWIN: 4 such
/// cards in the whole 2026-05-31 corpus, and `ft:/~/` — the column that always takes this path —
/// is 2 on api.scryfall.com.
fn face_self_names(card: &AOracleCard, strings: &AStrings, segments: usize) -> Vec<Vec<String>> {
    if !card.faces.is_empty() {
        let contributing: Vec<String> = card
            .faces
            .iter()
            .filter(|f| str_at(strings, u32::from(f.oracle_text_id)).is_some_and(|t| !t.is_empty()))
            .filter_map(|f| str_at(strings, u32::from(f.card_name_id)))
            .map(str::to_lowercase)
            .collect();
        if contributing.len() == segments {
            return contributing.iter().map(|n| self_names_of(n)).collect();
        }
    }
    let mut all = self_names_of(crate::lower_name(card, strings));
    for face in card.faces.iter() {
        if let Some(name) = str_at(strings, u32::from(face.card_name_id)) {
            for n in self_names_of(&name.to_lowercase()) {
                if !all.contains(&n) {
                    all.push(n);
                }
            }
        }
    }
    // Longest first across the whole set, so a face name inside another is consumed second.
    all.sort_by_key(|n| std::cmp::Reverse(n.len()));
    vec![all; segments]
}

fn tri_over_values(
    card: &AOracleCard,
    printing: Option<&APrinting>,
    strings: &AStrings,
    field: TextField,
    holds: impl Fn(&str) -> bool,
) -> Tri {
    match text_field_value(card, printing, strings, field) {
        StrVal::Known(s) => {
            tri_bool(holds(s) || extra_text_field_values(card, printing, strings, field).any(&holds))
        }
        StrVal::Null => {
            // `fold` and not `any`: whether ANY value existed is as load-bearing as whether one
            // held, and `any` short-circuits away the evidence for the first half.
            let (seen, hit) = extra_text_field_values(card, printing, strings, field)
                .fold((false, false), |(_, hit), s| (true, hit || holds(s)));
            if seen { tri_bool(hit) } else { Tri::Null }
        }
        StrVal::PDep => Tri::PrintingDep,
    }
}

/// The additional values a multi-valued `TextField` carries — see `extra_text_field_values`.
enum ExtraStrs<'a> {
    Empty,
    One(&'a str),
    Faces { faces: std::slice::Iter<'a, Archived<crate::PrintingFace>>, strings: &'a AStrings },
}

impl<'a> Iterator for ExtraStrs<'a> {
    type Item = &'a str;

    fn next(&mut self) -> Option<&'a str> {
        match self {
            ExtraStrs::Empty => None,
            ExtraStrs::One(_) => match std::mem::replace(self, ExtraStrs::Empty) {
                ExtraStrs::One(s) => Some(s),
                _ => unreachable!(),
            },
            // A face WITHOUT a watermark is not a value — skipping rather than yielding "" is what
            // keeps `Tri::Null` meaning "this printing answers nothing" on a faced printing whose
            // faces are all bare.
            ExtraStrs::Faces { faces, strings } => {
                faces.find_map(|f| str_at(strings, u32::from(f.card_watermark_id)))
            }
        }
    }
}

fn text_search_field_value<'a>(
    card: &'a AOracleCard,
    printing: Option<&'a APrinting>,
    strings: &'a AStrings,
    field: TextSearchField,
) -> StrVal<'a> {
    match field {
        // LITERAL (`name:"…"`, and a plain-literal regex lowered to one): the stored lowercase
        // name, WHOLE (`lower_name`, not the 61-byte inline — see its note), with neither fold.
        // The query value keeps its diacritics in Python for the same reason.
        TextSearchField::NameLower       => StrVal::Known(crate::lower_name(card, strings)),
        // COLLATED (`name:word`): accent-folded (#649) AND separator-folded, the query word
        // through `collate_name(fold_accents(...))` in Python, so this must match.
        TextSearchField::NameCollated    => StrVal::Known(crate::collated_name(card, strings)),
        TextSearchField::OracleTextLower => opt_sv(str_at(strings, u32::from(card.oracle_text_lower_id))),
        // `fo:` -- the text WITH its reminder text, which `OracleTextLower` no longer has.
        TextSearchField::FullOracleTextLower => opt_sv(str_at(strings, u32::from(card.oracle_full_lower_id))),
        TextSearchField::FlavorTextLower => printing.map_or(StrVal::PDep, |p| opt_sv(str_at(strings, u32::from(p.flavor_text_lower_id)))),
        // Rewritten to ArtistMatch by bind(); printings carry no artist strings.
        TextSearchField::ArtistLower | TextSearchField::ArtistCollated => StrVal::Null,
    }
}

/// Enum that replaces fn-pointer fields in TextExact / TextRegex.
/// Function pointers cannot be parameterized over &Card vs &ACard, so enum
/// dispatch is used instead.
#[derive(Clone, Copy)]
pub(crate) enum TextField {
    NameLower,
    OracleTextLower,
    FullOracleTextLower,
    FlavorTextLower,
    ArtistLower,
    SetCode,
    Layout,
    Border,
    Watermark,
    CollectorNumber,
    TypeLine,
    /// The printed mana cost STRING, e.g. `{1}{R}`. Stored as printed (mixed case, braces
    /// intact); every query regex carries `(?i)`, so the case-folding Scryfall applies is already
    /// the compile's.
    ///
    /// MATCHED WHOLE, NOT PER FACE, and it is the only joined column here that is. `o:` and `ft:`
    /// are split back at `FACE_TEXT_SEPARATOR` before matching because the separator between their
    /// faces is a string this store invented and Scryfall has no counterpart to. This column's
    /// separator is `" // "`, and Scryfall's own `mana:` haystack contains it — so splitting here
    /// would invent a divergence rather than close one.
    ///
    /// The builder writes the faces' NON-EMPTY costs joined with `" // "` — see
    /// `transform::joined_face_cost`, which carries the per-card probes. The shape, on
    /// api.scryfall.com 2026-08-28: `!"Extus, Oriq Overlord // Awaken the Blood Avatar"` (a modal
    /// DFC, whose card object has NO top-level `mana_cost`) answers `mana:/\/\//` 1 and
    /// `mana:/{b}{b} \/\/ /` 1, so the seam is in the haystack and a pattern spans it; `!"Fire //
    /// Ice" mana:/^{u}$/` answers 0, so the back half alone is not a value of its own. Corpus-wide,
    /// `mana:/\/\// is:mdfc` is 40 of 100.
    ///
    /// The residual this replaced was the FRONT face's cost, written by the import's face overlay.
    /// Scryfall against what the front-only column answered, same date: `mana:/ /` 435 against 0,
    /// `mana:/{r}/` 6,853 against 6,811, `mana:/}{/` 26,815 against 26,775, `mana:/2/` 8,315
    /// against 8,248, `mana:/^$/` 1,350 against 1,355.
    ///
    /// EMPTY IS A VALUE, and dropping empty faces from the join is what keeps it one. `!"Westvale
    /// Abbey // Ormendahl, Profane Prince"`, both faces costless, answers `mana:/^$/` 1 and
    /// `mana:/\/\//` 0 — `" // "` would have failed both. `!"Delver of Secrets // Insectile
    /// Aberration"` answers `mana:/^{u}$/` 1 and `mana:/^{u} /` 0 for the same reason.
    ManaCostText,
}

fn text_field_value<'a>(
    card: &'a AOracleCard,
    printing: Option<&'a APrinting>,
    strings: &'a AStrings,
    field: TextField,
) -> StrVal<'a> {
    match field {
        TextField::NameLower       => StrVal::Known(crate::lower_name(card, strings)),
        TextField::OracleTextLower => opt_sv(str_at(strings, u32::from(card.oracle_text_lower_id))),
        TextField::FullOracleTextLower => opt_sv(str_at(strings, u32::from(card.oracle_full_lower_id))),
        // PRINTING-level since gen 30 (see Printing::card_layout_id): a reversible printing and an
        // ordinary printing of the same card give different answers, so no card-level value can
        // stand in for either.
        TextField::Layout          => printing.map_or(StrVal::PDep, |p| opt_sv(str_at(strings, u32::from(p.card_layout_id)))),
        TextField::FlavorTextLower => printing.map_or(StrVal::PDep, |p| opt_sv(str_at(strings, u32::from(p.flavor_text_lower_id)))),
        // Rewritten to ArtistMatch by bind(); printings carry no artist strings.
        TextField::ArtistLower     => StrVal::Null,
        TextField::SetCode         => printing.map_or(StrVal::PDep, |p| StrVal::Known(p.card_set_code.as_str())),
        TextField::Border          => printing.map_or(StrVal::PDep, |p| opt_sv(str_at(strings, u32::from(p.card_border_id)))),
        TextField::Watermark       => printing.map_or(StrVal::PDep, |p| opt_sv(str_at(strings, u32::from(p.card_watermark_id)))),
        TextField::CollectorNumber => printing.map_or(StrVal::PDep, |p| opt_sv(str_at(strings, u32::from(p.collector_number_id)))),
        // Card-level, like Layout above: printings carry their own copy, but
        // Scryfall's type line is oracle data, so the group's value answers for
        // all of them — and reading it here keeps `t:/…/` card-invariant
        // instead of forcing a printing walk.
        TextField::TypeLine        => opt_sv(str_at(strings, u32::from(card.type_line_id))),
        // Card-level, like TypeLine, and on a faced card ALREADY the faces' costs joined " // " —
        // `transform::joined_face_cost` writes it that way because that is Scryfall's own `mana:`
        // haystack. No face walk here for the same reason there is no split: the join is the value.
        TextField::ManaCostText    => opt_sv(str_at(strings, u32::from(card.mana_cost_text_id))),
    }
}

// ─── FilterExpr ───────────────────────────────────────────────────────────────

/// verify_cost_tier() and printing_dependent() match on this enum
/// exhaustively (no `_` arm), so adding a variant is a compile error until
/// it's classified in both — deliberately, since a silent default there
/// would misorder the verifier walk without failing any test.
///
/// `Clone` (#745): `explain_analyze` needs a fresh, unmutated tree for every
/// `run_query_with_plan` call — its own `prepare_candidates` mutates via
/// `memoize_text_predicates` — so it clones from a pristine snapshot per call
/// rather than reusing one filter across plans/rounds. Every field here is
/// cheaply `Clone` already (small `Vec`s, `String`, `regex::Regex` is
/// internally `Arc`-based); this is a plain derive, not a deep-copy concern.
#[derive(Clone)]
pub(crate) enum FilterExpr {
    True,
    And(Vec<FilterExpr>),
    Or(Vec<FilterExpr>),
    Not(Box<FilterExpr>),
    ExactName(String),

    NumericCmp {
        lhs: NumExpr,
        op: CmpOp,
        rhs: NumExpr,
    },

    TextContains {
        field: TextSearchField,
        word: String,
    },
    /// An artist predicate (contains/exact/regex) after bind() resolved it
    /// against the ~2.2k-entry artist vocab: sorted vocab ids whose artist
    /// string satisfies the original predicate. Matching is an integer binary
    /// search per printing instead of a string comparison.
    ArtistMatch {
        ids: Vec<u16>,
    },
    /// A flavor-text predicate (contains/exact/regex) after bind() resolved it
    /// against the ~26.3k distinct flavor texts (fingerprint-prefiltered scan):
    /// sorted global string ids whose text satisfies the predicate — matching
    /// is an integer binary search per printing — plus the dense text ids for
    /// CSR narrowing in printing space.
    FlavorMatch {
        gids: Vec<u32>,
        dense_ids: Vec<u32>,
    },
    /// A name contains-predicate after memoize_text_predicates() resolved it
    /// through the name trigram index in a full-scan query: sorted
    /// card_name_id values of the cards whose lowercase name contains the
    /// needle. Names are always Known (missing names intern as ""), so
    /// matching is a plain two-valued binary search. The ids are specific to
    /// the store the rewrite ran against — a memoized filter must not outlive
    /// that store or that query.
    NameMatch {
        ids: Vec<u32>,
    },
    /// An oracle-text contains-predicate after memoize_text_predicates()
    /// resolved it through the oracle trigram index in a full-scan query:
    /// sorted oracle_text_lower_id values whose text contains the needle.
    /// Textless cards intern "" at load (never NONE_STR), so like TextContains
    /// they evaluate False, not Null; the Null arm in tri() only mirrors the
    /// str_at() contract defensively. Store-bound, same as NameMatch.
    OracleMatch {
        gids: Vec<u32>,
    },
    /// Every `t:` predicate after `bind()` resolved it against the distinct type
    /// lines: `t:creature`, `t:"artifact creature"` and `t:/^drag/` all arrive
    /// here. The corpus has ~1.5k distinct type lines, so the predicate is
    /// evaluated once per line at bind time and the answer is a set of ids —
    /// there is nothing left to verify per card, and `narrow_rec` can expand the
    /// line ids to the exact card set through the CSR in `TypeLineIndex`.
    ///
    /// Two parallel views of the same answer, both ascending: `gids` are global
    /// `CardData.strings` ids, compared against `card.type_line_id` when a card
    /// has to be tested one at a time; `line_ids` are the dense ids the CSR is
    /// keyed by. Store-bound, like NameMatch/OracleMatch.
    /// A literal `t:` needle, already lowercased and whitespace-collapsed, before
    /// `bind_type_lines` resolves it. Separate from `TextRegex { TypeLine }` for
    /// speed alone — the semantics are identical (`regex::escape` of this needle
    /// under `(?i)` matches the same lines) — but a case-insensitive regex over
    /// ~3k mixed-case type lines costs ~160 us per query where `memmem` over the
    /// index's pre-lowercased copies costs ~5 us, and `t:` is the most common
    /// filter there is.
    ///
    /// `whole_word` is set when the needle NAMES A TYPE — see `CANONICAL_TYPE_NAMES`
    /// — and the match is then anchored to type-word boundaries instead of being a
    /// bare substring.
    TypeLineContains {
        needle: String,
        whole_word: bool,
    },
    TypeLineMatch {
        gids: Vec<u32>,
        line_ids: Vec<u32>,
    },
    TextExact {
        field: TextField,
        op: CmpOp,
        value: String,
    },
    TextRegex {
        field: TextField,
        regex: CompiledRegex,
    },

    ColorCmp {
        field: ColorField,
        op: CmpOp,
        mask: u8,
    },

    /// Scryfall numeric color syntax (`id>=3`, `c=2`, `produces>=2`): compares
    /// the NUMBER of values in the field against `count`. Five bits for the two
    /// colour columns, SIX for produced_mana — whose array can hold "C" — see
    /// the eval arm for the measurements behind that split.
    ColorCountCmp {
        field: ColorField,
        op: CmpOp,
        count: u8,
    },

    TypeCmp {
        mask: u16,
        op: CmpOp,
    },

    CollectionCmp {
        field: CollField,
        op: CmpOp,
        value: String,
        /// `value` resolved to its vocab id by bind_collection_ids(), which the
        /// query entry points call once per query before matching; None means
        /// absent from the vocab (matches no element). Matching compares ids
        /// only — never strings — so an unbound filter behaves as if the value
        /// were unknown.
        value_id: Option<u16>,
    },

    /// `lang:xx` — a printing's language equals `value` (`card_lang`, stored as
    /// `CompatFields.lang_id`). `lang:any` matches every printing: its whole effect is the one
    /// every LangMatch leaf has, widening the query to the foreign annex (the presence of this
    /// variant in a bound filter is one of the two widening triggers; `include_multilingual` is
    /// the other). Detected here, in the engine, so the flag and the operator cannot drift.
    LangMatch {
        value: String,
        /// `value` resolved to its coll_vocab id by bind(), the CollectionCmp shape exactly:
        /// None means no loaded printing carries the language, which matches nothing.
        vid: Option<u16>,
        any: bool,
    },

    /// `st:<type>` — a printing's SET TYPE equals `value` (Scryfall's `set_type`, stored as
    /// `CompatFields.set_type_id`). `LangMatch`'s shape exactly, minus the widening: both live in
    /// the compat blob rather than in a column of their own, both intern into `coll_vocab`, and
    /// both resolve to an id in `bind()` so `tri()` is one integer equality.
    ///
    /// It is the predicate five `is:` values turn out to BE — `is:masterpiece` is `st:masterpiece`
    /// exactly (measured against api.scryfall.com, both set differences empty), and `is:alchemy`
    /// and `is:funny` are their set types — so it retires a family of stored tags rather than
    /// adding one.
    SetTypeMatch {
        value: String,
        /// `value` resolved to its coll_vocab id by bind(), the LangMatch shape exactly: None
        /// means no loaded printing carries the set type, which matches nothing.
        vid: Option<u16>,
    },

    /// `is:localizedname`, and `has:printedname`, its other spelling — this printing carries a
    /// PRINTED name. One field compare (`printed_name_folded_id != NONE_STR`), because the importer
    /// already folds the printed FULL name of every face into that id and leaves it NONE_STR when
    /// no face has one; nothing is stored for this predicate and nothing is bound for it.
    ///
    /// Presence, not difference, and not "non-English" — measured against api.scryfall.com on
    /// 2026-08-16 over the whole 540,484-row bulk. 182 of the printings it matches are ENGLISH
    /// (om1/66 prints "Rhilex the Accursed" over Agent Venom); 4,468 of the foreign ones print a
    /// name IDENTICAL to the English one and still count; and it reads per-FACE, so every Japanese
    /// transform printing matches on face names with no top-level `printed_name` at all.
    /// `is:localizedname e:dsk` is 1,917 printings there against the same 1,917 in the bulk.
    ///
    /// Its presence WIDENS the query — see `widens_to_annex`, and the count that proves it.
    PrintedNamePresent,

    /// `is:flavorname` — and `has:flavorname` — a PRINTING that carries a flavor name, Scryfall's
    /// alternate SOLD-AS name (the Godzilla series, the Secret Lair crossovers). The presence twin
    /// of `FlavorNameIn`: that leaf asks whether the flavor name satisfies a `name:` needle, this
    /// one only whether there is one. Nothing is stored for it and nothing is bound.
    ///
    /// EITHER PLACE Scryfall puts the key counts. Measured against api.scryfall.com on
    /// 2026-09-01: `is:flavorname` is 476 cards / 661 printings, 646 of them carrying the
    /// top-level key and the other 15 carrying it on their FACES alone (`transform` and
    /// `reversible_card` — vow/341 is "Dracula the Voyager" // "Casket of Native Earth", sld/1807
    /// "Chucky" on the front face only), and none carrying neither. A printing-level read alone
    /// would have answered 646 and called it the whole set.
    ///
    /// Its presence WIDENS the query, exactly as `PrintedNamePresent`'s does: 6 of the 661 are
    /// Japanese rows (iko/387 ja prints "Mechagodzilla, the Weapon" over 結晶の巨人) and
    /// api.scryfall.com returns them with no `lang:` term written.
    FlavorNamePresent,

    /// A PRINTING whose `flavor_name` satisfies the `name:` predicate that produced this leaf.
    ///
    /// `name:` reaches a printing's alternate SOLD-AS name, not just its oracle name. Measured on
    /// api.scryfall.com 2026-08-16: `name:croft` answers 2 — Lara Croft, and **Command Tower**,
    /// which is 2 of 112 printings there because two of them are sold as "Croft Manor";
    /// `name:godzilla` is 8 cards / 14 printings; `!"croft manor"` is 1. It is printing-scoped in
    /// both directions: `unique=prints` returns only the printings that carry the name.
    ///
    /// `ids` are interned `CardData.strings` ids of `Printing.flavor_name_folded_id`, sorted — a
    /// printing matches iff its own id is in the set. Compiled by `bind_flavor_names` from the
    /// ~546-record `flavor_names` index, and ONLY when the needle actually hits one of those
    /// records: a `name:` query that matches no flavor name never grows this arm at all, so the
    /// hottest predicate in the language pays a bounded scan of a table two orders of magnitude
    /// smaller than the corpus and nothing else.
    FlavorNameIn {
        ids: Vec<u32>,
    },

    /// `is:unique` — the owning CARD has been printed in exactly one SET. Card-level and total, off
    /// `OracleCard.single_set`, which the build computes over the canonical printings AND the annex
    /// (`assign_single_set_flags`); nothing here to bind and nothing per printing to consult.
    ///
    /// A SET count, not a printing count: Scryfall's syntax page defines it as "cards that have
    /// only been in a single set", and the two differ on 2,847 of its own 16,318 — `!"Forest"`
    /// alone is two printings of one set. Spanning the annex is not optional either: 130 cards have
    /// exactly one English set and a second set that exists only in another language (Salvat,
    /// ps11, pmei), and api.scryfall.com calls none of the 130 unique. Reading canonical printings
    /// alone would have called all 130 unique and been wrong 130 times.
    SingleSet,

    /// `is:vanilla` — and `has:vanilla` — a CREATURE FACE that prints no rules text. Card-level and
    /// total, off fields the archive already holds; nothing to bind and nothing per printing.
    ///
    /// A PREDICATE rather than the `t:creature -o:/./` expansion it replaces, because the merged
    /// row cannot answer it: the join hides a blank creature face behind the half that does print.
    /// See `card_is_vanilla` for the two measured rules — the searchable (reminder-stripped) text,
    /// and the land face that is never vanilla.
    VanillaFace,

    /// `oracleid:<uuid>` — the oracle card whose `oracle_id` equals `id` (`parse_uuid_or_hash`'s
    /// u128, 0 for an unparseable value, which no stored id ever equals). Card-level and total,
    /// with nothing for `bind()` to resolve — bind() sees the vocab tables, not `CardIndexes` —
    /// so `tri()` compares the raw u128 and `narrow_rec` seeds the same id through
    /// `oracle_by_oracle_id` for the O(log n) answer.
    OracleIdMatch {
        id: u128,
    },

    Legality {
        shift: Option<u8>, // None: format absent from all loaded data — matches nothing
        expected: u64,
    },

    ManaCostCmp {
        op: CmpOp,
        /// Single-symbol pip counts of the query cost, packed into the same
        /// 8-bit lanes as ManaCost.core (see the packed-pip-lanes section).
        core: u64,
        /// The query's hybrid '/' symbols as (symbol, count), sorted; kept as
        /// strings so bind() can resolve them against the store's mana vocab.
        hybrids: Vec<(String, u8)>,
        /// `hybrids` resolved to sorted (mana_vocab id, count) by bind().
        /// Symbols absent from the vocab — which no card can carry — merge
        /// into the reserved MANA_SYM_UNKNOWN id, preserving exact match
        /// semantics. Built all-unknown, so an unbound filter behaves as if
        /// every hybrid symbol were unknown (mirroring CollectionCmp).
        hybrid_ids: Vec<(u8, u8)>,
        /// Each mana-vocab id's CMC CONTRIBUTION, indexed by id, resolved by bind() — 2 for a
        /// TWOBRID (`{2/W}`), 1 for every other hybrid.
        ///
        /// Generic is `cmc - (what the pips account for)`, and a twobrid accounts for TWO. Without
        /// this the subtraction credits it with one, and the shortfall becomes generic the card
        /// does not have. Measured on api.scryfall.com 2026-08-17 — Beseech the Queen,
        /// `{2/B}{2/B}{2/B}`, cmc 6, three pips: the true generic is 0, this read 6 - 3 = 3, and
        /// `!"Beseech the Queen" m>={3}` answered the card where Scryfall answers nothing.
        /// Corpus-wide, `m:{2/w} m:{2}` was 16 against Scryfall's 0.
        ///
        /// Empty until bind(), which is the same all-unknown posture `hybrid_ids` takes; a missing
        /// id falls back to 1, the weight of every non-twobrid symbol.
        hybrid_cmc: Vec<u8>,
        cmc: f32,
    },

    Devotion {
        op: CmpOp,
        /// Queried WUBRGC devotion counts in the low six 8-bit lanes,
        /// hybrid query pips expanded at build — same layout as
        /// ManaCost.devotion, so every comparison is lane arithmetic.
        pips: u64,
        /// Each mana-vocab id's DEVOTION COLOUR MASK, indexed by id, resolved by bind(): the
        /// lanes a pip of that symbol counts toward. `R/G` sets red and green; `2/W` and `W/P`
        /// set white alone, since neither `2` nor `P` is a colour.
        ///
        /// Devotion is a count of PIPS, and `ManaCost.devotion` stores per-colour lanes with
        /// hybrids expanded — so summing the queried lanes counts a `{R/G}` pip once for red and
        /// again for green when both are queried. This table is what lets the sum be corrected
        /// back to distinct pips. Empty until bind(); a missing id contributes no colours, which
        /// costs a correction rather than inventing one.
        hybrid_colors: Vec<u8>,
    },

    DateCmp {
        op: CmpOp,
        value: u32, // yyyymmdd, partial dates zero-padded (e.g. "2026-07" → 20260700)
    },

    YearCmp {
        op: CmpOp,
        year: i32,
    },
}

/// Verifier per-candidate cost estimates, in hundredths of a nanosecond
/// (ns * 100 — e.g. 1.83 ns -> 183) so sub-nanosecond gaps between measured
/// ops stay representable as plain integers, and adding or recalibrating one
/// op is a one-line constant edit instead of a renumbering of its neighbors
/// (#651 forced exactly that churn on the previous 0..4 ordinal scheme).
///
/// Measured on the real corpus (`bench_verify_cost.rs`, `cargo test --release
/// bench_verify_cost -- --ignored --nocapture`, 31,508 oracle cards, min-of-50
/// per kernel, 3 repeated runs — see that file for the per-op numbers):
///
/// - field loads and integer/float/mask compares (TypeCmp, ColorCmp,
///   NumericCmp, ExactName, TextExact, Legality, DateCmp, YearCmp): 2.0-3.8 ns
///   measured (2026-07 re-run: Legality 2.05, YearCmp/DateCmp 2.3-2.6,
///   ColorCmp 2.20, ExactName/TextExact 2.57, NumericCmp 3.16-3.83). NumericCmp
///   is the priciest member (NumExpr::eval() indirection on both sides costs
///   more than a direct field load), so the constant sits just above it.
///   Was 600 — pinned to a stale 5.6 ns NumericCmp measurement; the recalibrated
///   ceiling (~3.8) fixes StreamedSelect over-pricing a mask-compare residual
///   ~1.6x (e.g. `f:legacy or year:2020` mis-routing to compose, #731).
pub(crate) const MASK_COMPARE_NS100: u32 = 400;
/// - bounded lookups: a binary search over a bind/memoize-resolved id set
///   (ArtistMatch/FlavorMatch/NameMatch/OracleMatch), a card collection
///   (CollectionCmp), and anchored-literal regexes (a memcmp at a known
///   position — see regex_tier): 1.8-8.1 ns measured. Devotion/ManaCostCmp
///   (#651, bench_mana.rs) measure below this range (0.65-2 ns) but share the
///   constant deliberately — see their arm below.
pub(crate) const SET_LOOKUP_NS100: u32 = 900;
/// - per-candidate text scans: unmemoized TextContains: 21.6-22.7 ns measured.
pub(crate) const TEXT_SCAN_NS100: u32 = 2_300;
/// - regex without a usable anchor: bare literal and general machinery
///   measured statistically identical (~44-49 ns) once compared on equal
///   footing (both carrying the (?i) every query regex has) — the regex
///   crate's literal-prefix optimization doesn't meaningfully beat a full
///   scan for an *unanchored* pattern. This corrects the previous assumption
///   that bare-literal costs the same as TextContains (it measures ~2x more).
///   An anchored non-literal pattern (e.g. `^[aeiou]`) measured far cheaper
///   (~17.7 ns, anchoring bounds the scan regardless of what's being tested)
///   but regex_tier() doesn't distinguish that case from general machinery —
///   left as a known conservative overestimate, not fixed here (would need a
///   regex_tier() classification change, not just a constant recalibration).
pub(crate) const REGEX_MACHINERY_NS100: u32 = 5_000;
/// A pattern that needed the backtracking engine — lookaround or a
/// backreference (`CompiledRegex::Backtrack`).
///
/// Measured at **77x** the linear engine's per-candidate cost on the same
/// corpus (6,535 vs 85 ns/card, mean over negative lookahead / positive
/// lookahead / lookbehind; `bench_backtrack_engine`). The engines themselves
/// are the same speed — fancy_regex delegates to the `regex` crate whenever a
/// pattern needs nothing extra, measured at 1.00x — so this prices lookaround,
/// not the dispatch.
///
/// It dwarfs every other tier deliberately. These patterns are the one node
/// kind the #734 trigram narrow cannot read a literal factor out of, so they
/// scan the whole corpus; ordering them last in an And is the only lever the
/// model has, and any candidate that a cheaper sibling can reject first is a
/// candidate this never has to see.
pub(crate) const REGEX_BACKTRACK_NS100: u32 = 380_000;

/// Per-candidate verification cost of a node in the tri walk. Composites take
/// the max of their children: their short-circuit may have to evaluate every
/// child, so the most expensive child bounds the cost.
/// `verify_cost_tier` over an `And` whose `proven` children are skipped, matching what `card_pass` will
/// actually evaluate (see `Narrowed::proven`).
///
/// Without this the model keeps charging the tier of a conjunct nobody verifies: `o:this border:black`
/// read `TEXT_SCAN` (23 ns/card) when the surviving residual is a `TextExact` at `MASK_COMPARE` (4 ns),
/// and both plans under-predicted by 2.0-2.6x. A cost model that does not see a change cannot route on it.
pub(crate) fn verify_cost_tier_unproven(f: &FilterExpr, proven: u64) -> u32 {
    match f {
        FilterExpr::And(children) if proven != 0 => children
            .iter()
            .enumerate()
            .filter(|(i, _)| *i >= 64 || proven & (1 << i) == 0)
            .map(|(_, c)| verify_cost_tier(c))
            .max()
            .unwrap_or(0),
        _ => verify_cost_tier(f),
    }
}

pub(crate) fn verify_cost_tier(f: &FilterExpr) -> u32 {
    match f {
        FilterExpr::TextRegex { regex, .. } if regex.is_backtracking() => REGEX_BACKTRACK_NS100,
        FilterExpr::TextRegex { regex, .. } => regex_tier(regex.as_str()),
        // Unbound only (see tri()): a lowercasing scan of the type line, the same tier as any
        // other per-card text scan.
        FilterExpr::TypeLineContains { .. } | FilterExpr::TextContains { .. } => TEXT_SCAN_NS100,
        // Two mask bits reject all but the creatures, and the survivors read one string: the card's
        // already-stripped column, or the FRONT face's printed text through `strip_reminder_text`.
        // That last case is a scan, so it is ranked as one — the model must not under-charge a
        // predicate on the strength of the branch it usually takes.
        FilterExpr::VanillaFace => TEXT_SCAN_NS100,
        FilterExpr::Devotion { .. } | FilterExpr::ManaCostCmp { .. } => SET_LOOKUP_NS100,
        FilterExpr::ArtistMatch { .. }
        | FilterExpr::FlavorMatch { .. }
        | FilterExpr::NameMatch { .. }
        | FilterExpr::OracleMatch { .. }
        // A binary search over the distinct type-line ids, the same shape as
        // OracleMatch's — and the whole point of the rewrite is that this
        // replaces regex_tier's REGEX_MACHINERY_NS100 for every `t:` predicate.
        | FilterExpr::TypeLineMatch { .. }
        // A binary search over the compiled flavor-name ids, against a u32 already on the printing.
        | FilterExpr::FlavorNameIn { .. }
        | FilterExpr::CollectionCmp { .. } => SET_LOOKUP_NS100,
        FilterExpr::And(children) | FilterExpr::Or(children) => {
            children.iter().map(verify_cost_tier).max().unwrap_or(0)
        }
        FilterExpr::Not(inner) => verify_cost_tier(inner),
        // Exhaustive, not `_ => MASK_COMPARE_NS100`: a new variant must get a
        // considered cost here rather than silently inheriting the cheapest.
        FilterExpr::True
        | FilterExpr::ExactName(_)
        | FilterExpr::NumericCmp { .. }
        | FilterExpr::TextExact { .. }
        | FilterExpr::ColorCmp { .. }
        | FilterExpr::ColorCountCmp { .. }
        | FilterExpr::TypeCmp { .. }
        | FilterExpr::Legality { .. }
        // A LangMatch is one integer equality against a resolved vocab id.
        | FilterExpr::LangMatch { .. }
        // ...and a SetTypeMatch is the same equality against a different id in the same vocab.
        | FilterExpr::SetTypeMatch { .. }
        // A PrintedNamePresent is one u32 compare against a field already on the printing, a
        // FlavorNamePresent the same compare plus a walk of the printing's few faces, and a
        // SingleSet one bool read off a field already on the card.
        | FilterExpr::PrintedNamePresent
        | FilterExpr::FlavorNamePresent
        | FilterExpr::SingleSet
        // An OracleIdMatch is one 128-bit integer equality against a field already in the card.
        | FilterExpr::OracleIdMatch { .. }
        | FilterExpr::DateCmp { .. }
        | FilterExpr::YearCmp { .. } => MASK_COMPARE_NS100,
    }
}

/// Classify a regex pattern's per-candidate cost by shape. The regex crate
/// compiles literal-only patterns to memcmp-style matchers (with case
/// folding for the QUERY_REGEX_FLAGS every query regex carries), and anchors bound the
/// scan to one position — measured on the real corpus, `^flying$` costs
/// ~half a substring scan while an unanchored literal costs about the same
/// as one. Ranking them as general regexes inverted real costs and made
/// `o:/^flying$/ oracle:sacrifice` 2.4× slower, so:
///
///   SET_LOOKUP_NS100    — literal with a ^ or $ anchor (starts_with/
///                         ends_with/equality; memcmp at a known position)
///   REGEX_MACHINERY_NS100 — everything else: bare literal (measured the
///                         same cost as live metacharacters, not the same as
///                         TextContains — see REGEX_MACHINERY_NS100's doc)
///   REGEX_BACKTRACK_NS100 — lookarounds and other fancy-regex backtracking
///                         features (see bench_regex_backtrack_tier)
pub(crate) fn regex_tier(pattern: &str) -> u32 {
    // Both spellings: this tree compiles under `QUERY_REGEX_FLAGS`, upstream under a bare `(?i)`,
    // and the shared tier tests pass patterns in either form.
    let p = pattern
        .strip_prefix(QUERY_REGEX_FLAGS)
        .or_else(|| pattern.strip_prefix("(?i)"))
        .unwrap_or(pattern);
    // `verify_cost_tier` answers this from the compiled `CompiledRegex::is_backtracking()`, which
    // is authoritative — it knows which engine actually took the pattern. This arm is for the
    // callers that hold only the pattern string, and must agree with it.
    if pattern_requires_backtrack(p) {
        return REGEX_BACKTRACK_NS100;
    }
    let mut p = p;
    let anchored_start = p.starts_with('^');
    if anchored_start {
        p = &p[1..];
    }
    let bytes = p.as_bytes();
    let mut anchored_end = false;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            // An escape of punctuation (\{ \. \$) is a literal character; an
            // alphanumeric escape (\d \w \b \p…) is a class — real machinery.
            b'\\' => match bytes.get(i + 1) {
                Some(c) if !c.is_ascii_alphanumeric() => i += 2,
                _ => return REGEX_MACHINERY_NS100,
            },
            b'$' if i == bytes.len() - 1 => {
                anchored_end = true;
                i += 1;
            }
            b'.' | b'*' | b'+' | b'?' | b'(' | b')' | b'[' | b']' | b'{' | b'}' | b'|' | b'^' | b'$' => return REGEX_MACHINERY_NS100,
            _ => i += 1,
        }
    }
    if anchored_start || anchored_end { SET_LOOKUP_NS100 } else { REGEX_MACHINERY_NS100 }
}

/// True when *pattern* needs fancy-regex's backtracking VM (lookarounds, etc.).
///
/// THIS WALKS BYTES, SO IT MUST NEVER SLICE THE `&str`. Every token it looks for begins with an
/// ASCII byte, so the whole scan is expressible on `bytes` — and it has to be: a `pattern[i..]`
/// reached with `i` inside a multi-byte character panics, which in the wasm engine is not a
/// declined query but an aborted isolate. That is exactly what shipped: a `(?P=` probe sitting on
/// the catch-all arm ran `pattern[i..]` at EVERY byte position, so any pattern combining a
/// metacharacter with a non-ASCII literal (`o:/.—/`, `o:/[a-z]—/`, `o:/\w—/`, `o:/[a-z]é/`) took
/// down /cards/search with a 500. Measured against production 2026-08-28, before the fix:
/// `sylvan-engine-wasm panic: byte index 2 is not a char boundary; it is inside '—' (bytes 1..4)
/// of `.—``. A pattern of a bare non-ASCII literal never reached here — `lowerLiteralRegexes`
/// turns `o:/x—/` into a plain substring leaf — which is why only the mixed shapes crashed.
///
/// `(?P=` is checked where the other group prefixes are, not on a catch-all arm. On the catch-all
/// it could not fire at all: a `(?P=name)` is reached with `bytes[i] == b'('` and `bytes[i+1] ==
/// b'?'`, so the `b'('` arm always matched first and the probe was dead code for the one input it
/// was written for.
pub(crate) fn pattern_requires_backtrack(pattern: &str) -> bool {
    /// Group prefixes fancy-regex must take: lookaround, atomic group, conditional, and a named
    /// backreference.
    const BACKTRACK_GROUPS: &[&[u8]] = &[b"(?=", b"(?!", b"(?<=", b"(?<!", b"(?>", b"(?(", b"(?P="];
    let bytes = pattern.as_bytes();
    let mut in_class = false;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'[' => in_class = true,
            b']' if in_class => in_class = false,
            b'(' if !in_class && i + 1 < bytes.len() && bytes[i + 1] == b'?' => {
                let rest = &bytes[i..];
                if BACKTRACK_GROUPS.iter().any(|tok| rest.starts_with(tok)) {
                    return true;
                }
            }
            b'\\' if !in_class && i + 1 < bytes.len() => {
                let nxt = bytes[i + 1];
                if (b'1'..=b'9').contains(&nxt) || matches!(nxt, b'g' | b'G' | b'k' | b'K') {
                    return true;
                }
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }
    false
}

/// Whether a node can NEVER settle the card-level pass — it compares only
/// printing-level fields, so at card level it always returns PrintingDep and
/// its evaluation there is pure deferral. Ordering such children after the
/// card-level ones is a free win in both And and Or: they cannot reject an
/// And or accept an Or at card level, so a card-level sibling that settles
/// first skips their eval entirely, and nothing is lost when it doesn't.
///
/// Composites settle at card level when ANY child can (a card-level False
/// settles an And, a card-level True settles an Or), so a composite is
/// printing-dependent only when ALL its children are.
fn printing_dependent(f: &FilterExpr) -> bool {
    match f {
        FilterExpr::And(children) | FilterExpr::Or(children) => children.iter().all(printing_dependent),
        FilterExpr::Not(inner) => printing_dependent(inner),
        leaf => leaf_compares_printing_field(leaf),
    }
}

/// Whether `f` compares a printing-level field **anywhere** — the `any` composition of the same leaf
/// table `printing_dependent` reads with `all`. The two questions are different and both are wanted:
///
/// - `printing_dependent` asks "can this node never settle at card level", for verify ORDERING. A
///   composite settles when ANY child can, so it is printing-dependent only when ALL children are.
/// - this asks "could any part of this need a per-printing answer", for the result-total ESTIMATE. A
///   card-invariant residual returns `True`/`False` per card and never `PrintingDep`, so each candidate
///   contributes either its whole printing span or none of it — a different estimator shape from one where
///   printings under a single card disagree.
///
/// `name:s AND usd>10` separates them: not `printing_dependent` (the name settles it), but it does touch a
/// printing field, so the span of a matching card is not all-or-nothing.
pub(crate) fn touches_printing_field(f: &FilterExpr) -> bool {
    match f {
        FilterExpr::And(children) | FilterExpr::Or(children) => children.iter().any(touches_printing_field),
        FilterExpr::Not(inner) => touches_printing_field(inner),
        leaf => leaf_compares_printing_field(leaf),
    }
}

/// The per-leaf half of both questions above: does this NON-composite node compare a printing-level
/// field. Composition is the callers' business, which is the whole reason this is factored out — the two
/// callers disagree on it and must not disagree on the table.
fn leaf_compares_printing_field(f: &FilterExpr) -> bool {
    fn num_pdep(e: &NumExpr) -> bool {
        match e {
            NumExpr::Const(_) => false,
            // Exhaustive over NumField, not `matches!` with a hidden `_ =>
            // false`: a new field must get a considered answer here rather
            // than silently inheriting "card-level".
            NumExpr::Field(field) => match field {
                NumField::RarityInt
                | NumField::CollectorNumberInt
                | NumField::PriceUsd
                | NumField::PriceEur
                | NumField::PriceTix
                | NumField::PreferScore => true,
                NumField::Cmc | NumField::Power | NumField::Toughness | NumField::Loyalty | NumField::EdhrEc => false,
            },
            NumExpr::Arith(lhs, _, rhs) => num_pdep(lhs) || num_pdep(rhs),
        }
    }
    match f {
        FilterExpr::NumericCmp { lhs, rhs, .. } => num_pdep(lhs) || num_pdep(rhs),
        FilterExpr::DateCmp { .. } | FilterExpr::YearCmp { .. } => true,
        FilterExpr::ArtistMatch { .. } | FilterExpr::FlavorMatch { .. } => true,
        // Exhaustive over TextSearchField (no `matches!`), same reason as num_pdep.
        FilterExpr::TextContains { field, .. } => match field {
            TextSearchField::FlavorTextLower => true,
            TextSearchField::NameLower
            | TextSearchField::NameCollated
            | TextSearchField::OracleTextLower
            | TextSearchField::FullOracleTextLower
            | TextSearchField::ArtistLower
            | TextSearchField::ArtistCollated => false,
        },
        // Exhaustive over TextField (no `matches!`), same reason as num_pdep.
        FilterExpr::TextExact { field, .. } | FilterExpr::TextRegex { field, .. } => match field {
            // `Layout` joined this list in gen 30 and is the reason the list is worth reading
            // twice: it sat in the card-level arm below while `card_layout_id` lived on the
            // OracleCard, and leaving it there would have let the verifier settle `layout:` at
            // card level and never look at the printing whose value now decides it.
            TextField::FlavorTextLower
            | TextField::SetCode
            | TextField::Layout
            | TextField::Border
            | TextField::Watermark
            | TextField::CollectorNumber => true,
            TextField::NameLower
            | TextField::OracleTextLower
            | TextField::FullOracleTextLower
            | TextField::ArtistLower
            | TextField::TypeLine
            | TextField::ManaCostText => false,
        },
        // Exhaustive over CollField (no `matches!`), same reason as num_pdep.
        FilterExpr::CollectionCmp { field, .. } => match field {
            CollField::ArtTags | CollField::IsTags | CollField::FrameData => true,
            CollField::Subtypes | CollField::Keywords | CollField::OracleTags => false,
        },
        // Divergent-legality cards defer to the printing, but they are a rare
        // exception (non-tournament reprints); rank by the common card-level case.
        FilterExpr::Legality { .. } => false,
        // The language is a per-printing fact (CompatFields.lang_id).
        FilterExpr::LangMatch { .. } => true,
        // The set type is the PRINTING's set, so it can only settle once one is in hand.
        FilterExpr::SetTypeMatch { .. } => true,
        // The printed name is a per-printing fact (Printing.printed_name_folded_id) — an English
        // row and its Japanese sibling answer differently.
        FilterExpr::PrintedNamePresent => true,
        // A flavor name is printed on the PRINTING; two printings of one card differ on it, which
        // is the whole reason `name:croft` returns 2 of Command Tower's 112 — and the same reason
        // `is:flavorname` matches Command Tower's sld/1864 row and none of its other 111.
        FilterExpr::FlavorNameIn { .. } | FilterExpr::FlavorNamePresent => true,
        // Composites are composed by the two callers, which differ on `all` vs `any`; reaching here with
        // one is a bug in whichever caller forgot to handle it, not a case to answer silently.
        FilterExpr::And(_) | FilterExpr::Or(_) | FilterExpr::Not(_) => {
            unreachable!("composites are composed by printing_dependent / touches_printing_field")
        }
        // A REVERSIBLE PRINTING PRINTS ITS OWN JOINED NAME ("Temple Garden // Temple Garden"
        // against the card's "Temple Garden"), so an exact-name match can settle differently for
        // two printings of one card — 81 printings over 71 cards in the 2026-08-16 corpus.
        FilterExpr::ExactName(_) => true,
        // Exhaustive, not `_ => false`: a new variant must get a considered
        // answer here rather than silently inheriting "can settle at card level".
        FilterExpr::True
        | FilterExpr::NameMatch { .. }
        | FilterExpr::OracleMatch { .. }
        // The type line is oracle data (TextField::TypeLine reads the card, not
        // the printing), so both the needle and the resolved id set are
        // card-invariant.
        | FilterExpr::TypeLineContains { .. }
        | FilterExpr::TypeLineMatch { .. }
        // The oracle id is the card's own identity — every printing of it shares one.
        | FilterExpr::OracleIdMatch { .. }
        // How many SETS the card has been printed in is the card's fact too, decided at build over
        // every printing of it; no printing can change the answer.
        | FilterExpr::SingleSet
        // Faces and their texts are oracle data — every printing of the card prints the same ones.
        | FilterExpr::VanillaFace
        | FilterExpr::ColorCmp { .. }
        | FilterExpr::ColorCountCmp { .. }
        | FilterExpr::TypeCmp { .. }
        | FilterExpr::ManaCostCmp { .. }
        | FilterExpr::Devotion { .. } => false,
    }
}

/// Or-child sort key. An Or short-circuits on acceptance, and acceptance
/// rates — unlike costs — are unknowable statically, so ordering an Or by
/// fine-grained cost backfires when a cheap child rarely accepts (measured
/// twice: `oracle:vigilance or devotion:bbb` lost 1.2× to devotion-first,
/// and a memoized name set jumping a contains lost 1.1×). The key therefore
/// only separates classes with a decisive gap:
///
///   bucket 0 — card-level tier-0 checks: cheap enough (a few ns) that
///              leading with them is near-free even when they rarely accept
///   bucket 1 — everything else below regex machinery (set lookups, pip
///              maps, text scans) in written order: costs within ~3× of
///              each other, where acceptance dominates
///   bucket 2 — regex machinery, always last
///
/// Within a bucket, printing-dependent children order last: they can never
/// settle the Or at card level (see printing_dependent), so leading with
/// them is pure deferral cost.
fn or_child_key(f: &FilterExpr) -> (u8, bool) {
    let tier = verify_cost_tier(f);
    let pdep = printing_dependent(f);
    let bucket = if tier >= REGEX_MACHINERY_NS100 {
        2
    } else if tier == MASK_COMPARE_NS100 && !pdep {
        0
    } else {
        1
    };
    (bucket, pdep)
}

/// Within-tier refinement for And children: memoized sets know their own
/// size, and under an And a smaller set is more selective — it rejects more
/// candidates per (identical) binary-search cost, so it should run first.
/// Nodes without a known set size sort after sized ones in their tier and
/// keep written order among themselves (the sort is stable).
fn and_child_set_len(f: &FilterExpr) -> usize {
    match f {
        FilterExpr::ArtistMatch { ids } => ids.len(),
        FilterExpr::NameMatch { ids } => ids.len(),
        FilterExpr::FlavorMatch { gids, .. } | FilterExpr::OracleMatch { gids } => gids.len(),
        // Distinct type lines, not cards — a strictly smaller number than the
        // card set it expands to, so a `t:` leaf sorts ahead of set-sized
        // siblings it is in fact broader than. That is the same approximation
        // the four above make (ids are values, not rows) and it only orders
        // verification, never correctness.
        FilterExpr::TypeLineMatch { gids, .. } => gids.len(),
        _ => usize::MAX,
    }
}

/// Reserved ManaCost hybrid id for query symbols absent from the store's
/// mana vocab: no card carries it, so containment fails and exactness fails
/// against any card, exactly like a HashMap key nothing else holds. Distinct
/// unknown symbols merge into one entry — safe for the same reason.
pub(crate) const MANA_SYM_UNKNOWN: u8 = u8::MAX;

type AHybrids = rkyv::Archived<Vec<(u8, u8)>>;

/// Resolve the query's hybrid symbols to sorted (mana_vocab id, count).
fn bind_mana_hybrids(hybrids: &[(String, u8)], mana_vocab: &AStrings) -> Vec<(u8, u8)> {
    let mut out = Vec::with_capacity(hybrids.len());
    let mut unknown = 0u8;
    for (sym, n) in hybrids {
        // Linear scan: the vocab is ~29 entries and queries carry 0-2 hybrids.
        match mana_vocab.iter().position(|v| v.as_str() == sym.as_str()) {
            Some(i) => out.push((i as u8, *n)),
            None => unknown = unknown.saturating_add(*n),
        }
    }
    out.sort_unstable();
    if unknown > 0 {
        out.push((MANA_SYM_UNKNOWN, unknown)); // sorts last: real ids are < 255
    }
    out
}

fn hybrid_count(card: &AHybrids, id: u8) -> u8 {
    card.iter().find(|e| e.0 == id).map_or(0, |e| e.1)
}

/// Every query hybrid is contained in the card's (query ⊆ card).
fn hybrids_ge(card: &AHybrids, query: &[(u8, u8)]) -> bool {
    query.iter().all(|&(id, n)| hybrid_count(card, id) >= n)
}

/// Every card hybrid is contained in the query's (card ⊆ query).
fn hybrids_le(card: &AHybrids, query: &[(u8, u8)]) -> bool {
    card.iter().all(|e| query.iter().find(|q| q.0 == e.0).map_or(0, |q| q.1) >= e.1)
}

/// Same hybrid multiset — both sides sorted, so pairwise equality suffices.
fn hybrids_eq(card: &AHybrids, query: &[(u8, u8)]) -> bool {
    card.len() == query.len() && card.iter().zip(query).all(|(c, q)| c.0 == q.0 && c.1 == q.1)
}

/// GENERIC mana — the `{2}` in `{2}{R}` — as a COUNTED quantity, recovered from a cost's cmc and
/// its pips rather than stored.
///
/// It is not in `core`: `mana_pip_counts` drops numeric symbols on purpose (they are not pips and
/// have no lane), so a cost's generic used to survive only inside `cmc`, and comparing THAT is a
/// measurably different question. Every non-X pip contributes exactly 1 to cmc and X contributes
/// 0, so `cmc - (non-X pips)` is the generic exactly, for a query cost and a card cost alike —
/// which is why the query side needs no new field and the store needs no new column.
///
/// Lane 7 is X (see `MANA_LANE_SYMS`) and is excluded; every other lane, and every hybrid, counts
/// 1 each. Saturating and clamped at 0 so a cost this arithmetic cannot describe — a `{2/R}`, whose
/// true cmc contribution is 2 rather than 1 — degrades to 0 instead of wrapping. Scryfall answers
/// nothing to `m>={2/r}` and so does this, so that cost never reaches a comparison anyway.
fn generic_of(core: u64, hybrids: impl Iterator<Item = (u8, u8)>, cmc: f32, hybrid_cmc: &[u8]) -> u8 {
    // Lanes 0..6 only: lane 7 is X, which is a real pip and contributes 0 to cmc, so subtracting
    // it would invent generic. Every other single symbol contributes exactly 1.
    let core_pips: u32 = (0..7).map(|l| u32::from(lane_get(core, l))).sum();
    // A hybrid contributes its OWN weight, which is 2 for a twobrid and 1 for the rest — see
    // `hybrid_cmc`. Unknown ids weigh 1, the common case and the safe one.
    let hybrid_pips: u32 = hybrids
        .map(|(id, n)| u32::from(hybrid_cmc.get(id as usize).copied().unwrap_or(1)) * u32::from(n))
        .sum();
    let cmc = if cmc > 0.0 { cmc as u32 } else { 0 };
    u8::try_from(cmc.saturating_sub(core_pips + hybrid_pips)).unwrap_or(u8::MAX)
}

/// The devotion lanes a pip of `sym` counts toward, as a bitmask over WUBRGC.
///
/// `R/G` sets red and green — a hybrid pip is devotion to BOTH its colours. `2/W` and `W/P` set
/// white alone: neither `2` nor `P` is a colour, and Phyrexian mana is devotion to its one colour.
fn devotion_color_mask(sym: &str) -> u8 {
    sym.split('/')
        .filter_map(mana_lane)
        .filter(|&lane| lane < 6)
        .fold(0u8, |mask, lane| mask | (1u8 << lane))
}

/// A mana symbol's contribution to converted mana cost: 2 for a TWOBRID (`2/W`), 1 otherwise.
///
/// Scryfall's cmc counts a twobrid as two — `{2/B}{2/B}{2/B}` is cmc 6, not 3 — while every other
/// hybrid (`W/U`, `W/P`, `B/G/P`) counts one. The vocab interns the symbol without its braces, so
/// the leading component is what decides it.
fn hybrid_cmc_weight(sym: &str) -> u8 {
    sym.split('/').next().and_then(|head| head.parse::<u8>().ok()).unwrap_or(1)
}

/// Interned name ids (ascending, deduplicated) of the `flavor_names` records satisfying `pred`.
///
/// `pred` sees the record's COLLATED name, which is the form both `name:` predicates compare in.
fn flavor_name_ids(
    idx: &rkyv::Archived<PrintedNameIndex>,
    collated: &AStrings,
    pred: impl Fn(&str) -> bool,
) -> Vec<u32> {
    let mut ids: Vec<u32> = collated
        .iter()
        .enumerate()
        .filter(|(_, s)| pred(s.as_str()))
        .map(|(rec, _)| u32::from(idx.name_ids[rec]))
        .collect();
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// Vocab ids (ascending) whose artist string satisfies `pred`.
fn artist_match_ids(artist_vocab: &AStrings, pred: impl Fn(&str) -> bool) -> Vec<u16> {
    artist_vocab
        .iter()
        .enumerate()
        .filter(|(_, s)| pred(s.as_str()))
        .map(|(i, _)| i as u16)
        .collect()
}

/// Vocab ids (ascending) whose artist CONTAINS `needle`, collated on both sides.
///
/// THE ONE COMPARISON EVERY ARTIST PREDICATE MAKES. On api.scryfall.com there is no `a:` / `a=`
/// distinction and no quoted / bare distinction — measured 2026-08-16, every pair answers the same
/// number:
///
///   a:"rebecca guay" 399   a="rebecca guay" 399   a:rebecca-guay 399   a=rebecca-guay 399
///   a:gaweł           23   a=gaweł           23   a:gawel         23   a="gawel"       23
///
/// and it is a CONTAINS rather than an equality: `a="rebecca"` answers 405 exactly as `a:rebecca`
/// does, and `a="guay"` answers 462 exactly as `a:guay` does. This port had `a=` as a full-string
/// compare against the unfolded vocab, so `a="greg hildebrandt"` answered 0 where Scryfall answers
/// 6, and a quoted `a:"…"` stayed literal, so `a:"rebeccaguay"` answered 0 against Scryfall's 399.
///
/// The needle arrives accent-folded ONLY when the parser built a CollatedNameValueNode (a bare
/// `a:` word); the quoted and `=` forms keep their spelling. Rather than teach the engine a second
/// copy of `fold_accents`, a NON-ASCII needle is compared against the unfolded vocab collated on
/// the fly as well as the stored folded one — the union is exactly Scryfall's behaviour, which
/// answers 23 for `gaweł` and `gawel` alike. An ASCII needle skips that pass entirely and cannot
/// need it: folding only ever maps non-ASCII to ASCII, so the stored folded vocab is already the
/// more permissive target. That keeps the common path allocation-free, as it was.
///
/// AND IT IS AN ARTIST-ENTITY MATCH, not only a string one. A needle matching any ONE of an
/// artist's credited spellings answers for ALL of that artist's printings — `a:"don't mess"`
/// answers `a:"rebecca guay"`'s 399 (measured 2026-08-17, `&unique=prints`), because
/// `Persecute Artist` is credited `Rebecca "Don't Mess with Me" Guay`. The scan above cannot see
/// that: `Kev Walker` and `Evkay Alkerway` are one artist sharing no substring at all.
///
/// SO A MATCHED ENTITY BECOMES MORE NEEDLES, and the same one scan answers all of them. An entity
/// whose spelling contains the needle contributes its OTHER spellings, and a vocab entry matching
/// any of them is a match — which is right because a joined credit collates to its components
/// concatenated (`davidmartin` and `franzvohwinkel` both sit inside `davidmartinfranzvohwinkel`),
/// so "the credits naming this artist" IS "the credits containing this spelling".
///
/// That is also why the entity table stores no ids and nothing per printing: the relation between
/// a spelling and a credit is the operator's own `contains`, already computed here. The table is
/// 28 entities and ~61 spellings over the live corpus, so the expansion adds at most 61 needles to
/// a scan that already runs 2,543 comparisons.
///
/// `artist_match_ids` — the ordering comparisons and `a:/…/` — is deliberately NOT given this
/// expansion. Scryfall has no artist behaviour there to reproduce: `a>"rebecca guay"` answers 0
/// (2026-08-16), and `a:/don.t.mess/` is a 400 with "All of your terms were ignored" (2026-08-17,
/// this port supports it as an extension). Extending the entity relation to either would be
/// inventing semantics.
fn artist_contains_ids(
    artist_vocab: &AStrings,
    artist_vocab_collated: &AStrings,
    artist_entities: &Archived<crate::ArtistEntityIndex>,
    needle: &str,
) -> Vec<u16> {
    let collated = crate::collate_name(needle);
    // memmem::Finder built once, reused across the vocab scan — its SIMD prefilter beats
    // rebuilding str::contains's searcher per entry (~1.3x, bench_substring_finders). #734.
    let finder = memmem::Finder::new(collated.as_bytes());
    let also_unfolded = !collated.is_ascii();

    // The entity pass, BEFORE the vocab scan: whichever spellings it adds are tested in the same
    // single walk below rather than in a walk of their own.
    let mut extra: Vec<&str> = Vec::new();
    for e in 0..artist_entities.form_offsets.len().saturating_sub(1) {
        let forms = u32::from(artist_entities.form_offsets[e]) as usize
            ..u32::from(artist_entities.form_offsets[e + 1]) as usize;
        let hit = forms.clone().any(|i| {
            finder.find(artist_entities.forms_collated[i].as_bytes()).is_some()
                || (also_unfolded
                    && finder
                        .find(crate::collate_name(artist_entities.forms_lower[i].as_str()).as_bytes())
                        .is_some())
        });
        if hit {
            extra.extend(forms.map(|i| artist_entities.forms_collated[i].as_str()));
        }
    }
    let extra_finders: Vec<memmem::Finder<'_>> =
        extra.iter().filter(|f| **f != collated).map(|f| memmem::Finder::new(f.as_bytes())).collect();

    artist_vocab_collated
        .iter()
        .enumerate()
        .filter(|(vid, folded)| {
            let bytes = folded.as_str().as_bytes();
            finder.find(bytes).is_some()
                || extra_finders.iter().any(|f| f.find(bytes).is_some())
                || (also_unfolded
                    && finder.find(crate::collate_name(artist_vocab[*vid].as_str()).as_bytes()).is_some())
        })
        .map(|(vid, _)| vid as u16)
        .collect()
}

impl FilterExpr {
    /// Per-query binding against the store's vocab tables, called once before
    /// matching. Two rewrites happen here:
    ///
    /// - CollectionCmp values resolve to their vocab id (binary search over the
    ///   string-sorted permutation — ~14 string compares per term); a value
    ///   absent from the vocab resolves to None and can match no element.
    /// - Artist predicates (contains/exact/regex on ArtistLower) evaluate once
    ///   against the ~2.2k distinct artist strings and become ArtistMatch nodes
    ///   holding the sorted ids that satisfied them — per-printing matching is
    ///   then an integer membership test, and narrow_candidates can expand the
    ///   ids through the artist CSR index.
    /// - Flavor predicates get the same treatment against the ~26.3k distinct
    ///   flavor texts (FlavorMatch), with a fingerprint prefilter skipping
    ///   texts that cannot contain the needle (see FLAVOR_FP_FEATURES).
    ///
    /// Name/oracle-text contains predicates are deliberately NOT rewritten
    /// here: their rewrite is only profitable when the query full-scans, which
    /// isn't known until run_query computes candidates — see
    /// memoize_text_predicates().
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn bind(
        &mut self,
        vocab: &AStrings,
        sorted_ids: &rkyv::Archived<Vec<u16>>,
        artist_vocab: &AStrings,
        // artist_vocab_collated: the same artists, `collate_name(fold_accents(...))` — the string
        // `a:word` matches against (see TextSearchField::ArtistCollated).
        artist_vocab_collated: &AStrings,
        // artist_entities: the 28 multi-spelling artist entities the two vocabs above cannot
        // relate to each other — see `artist_contains_ids` and `ArtistEntityIndex`.
        artist_entities: &Archived<crate::ArtistEntityIndex>,
        mana_vocab: &AStrings,
        flavor: &rkyv::Archived<FlavorIndex>,
        strings: &AStrings,
    ) {
        match self {
            FilterExpr::And(children) | FilterExpr::Or(children) => {
                for c in children {
                    c.bind(vocab, sorted_ids, artist_vocab, artist_vocab_collated, artist_entities, mana_vocab, flavor, strings);
                }
            }
            FilterExpr::Not(inner) => inner.bind(vocab, sorted_ids, artist_vocab, artist_vocab_collated, artist_entities, mana_vocab, flavor, strings),
            // UNCONDITIONAL, unlike the other bind arms: the weights are read off the CARD's
            // hybrids, not the query's, so `m:{2}` against a twobrid card needs them even though
            // the query carries no hybrid symbol at all. Gating this on `!hybrids.is_empty()` —
            // which is right for `hybrid_ids` — would have left the commonest twobrid query
            // unweighted.
            FilterExpr::ManaCostCmp { hybrids, hybrid_ids, hybrid_cmc, .. } => {
                if !hybrids.is_empty() {
                    *hybrid_ids = bind_mana_hybrids(hybrids, mana_vocab);
                }
                *hybrid_cmc = mana_vocab.iter().map(|s| hybrid_cmc_weight(s.as_str())).collect();
            }
            // Like ManaCostCmp's, UNCONDITIONAL: the masks are read off the CARD's hybrids, so a
            // query naming no hybrid at all still needs them to correct its own sum.
            FilterExpr::Devotion { hybrid_colors, .. } => {
                *hybrid_colors = mana_vocab.iter().map(|s| devotion_color_mask(s.as_str())).collect();
            }
            FilterExpr::CollectionCmp { value, value_id, .. } => {
                let i = sorted_ids.partition_point(|id| vocab[u16::from(*id) as usize].as_str() < value.as_str());
                *value_id = sorted_ids
                    .get(i)
                    .map(|id| u16::from(*id))
                    .filter(|&id| vocab[id as usize].as_str() == value.as_str());
            }
            // The language lives in the same vocab the collection values do (CompatFields.lang_id
            // interns into coll_vocab), so this is CollectionCmp's resolution verbatim.
            FilterExpr::LangMatch { value, vid, any: false } => {
                let i = sorted_ids.partition_point(|id| vocab[u16::from(*id) as usize].as_str() < value.as_str());
                *vid = sorted_ids
                    .get(i)
                    .map(|id| u16::from(*id))
                    .filter(|&id| vocab[id as usize].as_str() == value.as_str());
            }
            // The set type interns into that same vocab (CompatFields.set_type_id), so this is
            // the resolution above verbatim.
            FilterExpr::SetTypeMatch { value, vid } => {
                let i = sorted_ids.partition_point(|id| vocab[u16::from(*id) as usize].as_str() < value.as_str());
                *vid = sorted_ids
                    .get(i)
                    .map(|id| u16::from(*id))
                    .filter(|&id| vocab[id as usize].as_str() == value.as_str());
            }
            FilterExpr::TextContains { field: TextSearchField::ArtistLower, word } => {
                // A QUOTED `a:"…"` reaches this arm, and it is collated too — Scryfall draws no
                // quoted/bare line for artists, unlike `name:`. See `artist_contains_ids`.
                let ids = artist_contains_ids(artist_vocab, artist_vocab_collated, artist_entities, word.as_str());
                *self = FilterExpr::ArtistMatch { ids };
            }
            FilterExpr::TextContains { field: TextSearchField::ArtistCollated, word } => {
                // A BARE `a:word`, already folded and collated by the parser. Collating an
                // already-collated needle is idempotent, so it shares the one comparison.
                let ids = artist_contains_ids(artist_vocab, artist_vocab_collated, artist_entities, word.as_str());
                *self = FilterExpr::ArtistMatch { ids };
            }
            FilterExpr::TextExact { field: TextField::ArtistLower, op, value } => {
                let (op, value) = (*op, std::mem::take(value));
                // `a=` IS `a:` on Scryfall — a contains, not an equality (see
                // `artist_contains_ids` for the measurements). The ordering comparisons keep the
                // full-string compare against the unfolded vocab: Scryfall answers 0 for every one
                // of them (`a>"rebecca guay"` measured 2026-08-16), so there is no behaviour there
                // to match, and `a!=` already agrees with it at 0 — changing either would be
                // inventing semantics rather than reproducing them.
                let ids = if matches!(op, CmpOp::Eq) {
                    artist_contains_ids(artist_vocab, artist_vocab_collated, artist_entities, &value)
                } else {
                    artist_match_ids(artist_vocab, |s| match op {
                        CmpOp::Eq => s == value,
                        CmpOp::Ne => s != value,
                        CmpOp::Lt => s < value.as_str(),
                        CmpOp::Le => s <= value.as_str(),
                        CmpOp::Gt => s > value.as_str(),
                        CmpOp::Ge => s >= value.as_str(),
                    })
                };
                *self = FilterExpr::ArtistMatch { ids };
            }
            FilterExpr::TextRegex { field: TextField::ArtistLower, regex } => {
                let ids = artist_match_ids(artist_vocab, |s| regex.is_match(s));
                *self = FilterExpr::ArtistMatch { ids };
            }
            FilterExpr::TextContains { field: TextSearchField::FlavorTextLower, word } => {
                let mask = flavor_fingerprint(word.as_str());
                let finder = memmem::Finder::new(word.as_bytes()); // built once, reused (see ArtistLower)
                // PER FACE, like every other verify on a joined column: `ft:"//"` is 404 on
                // api.scryfall.com and was 262 here, every one of them the separator this store
                // wrote between two faces' flavor texts.
                let (gids, dense_ids) = flavor_match_sets(flavor, strings, mask, |s| {
                    s.split(FACE_TEXT_SEPARATOR).any(|face| finder.find(face.as_bytes()).is_some())
                });
                *self = FilterExpr::FlavorMatch { gids, dense_ids };
            }
            FilterExpr::TextExact { field: TextField::FlavorTextLower, op, value } => {
                let (op, value) = (*op, std::mem::take(value));
                // Equality implies containment, so Eq can use the fingerprint;
                // the other comparisons carry no containment implication.
                let mask = if op == CmpOp::Eq { flavor_fingerprint(value.as_str()) } else { 0 };
                let (gids, dense_ids) = flavor_match_sets(flavor, strings, mask, |s| match op {
                    CmpOp::Eq => s == value,
                    CmpOp::Ne => s != value,
                    CmpOp::Lt => s < value.as_str(),
                    CmpOp::Le => s <= value.as_str(),
                    CmpOp::Gt => s > value.as_str(),
                    CmpOp::Ge => s >= value.as_str(),
                });
                *self = FilterExpr::FlavorMatch { gids, dense_ids };
            }
            // NOT a `~` pattern: this rewrite answers from the flavor INDEX, which is keyed by
            // string id and never sees a card, so a predicate that depends on the card's own name
            // cannot be resolved here. `ft:/~/` (2 on api.scryfall.com) therefore stays a
            // TextRegex and is evaluated per candidate, which is the only place the name is in
            // scope. Everything else keeps the memoization.
            FilterExpr::TextRegex { field: TextField::FlavorTextLower, regex } if !regex.has_self_reference() => {
                // PER FACE, exactly as the unmemoized arm is: flavor text is joined with the same
                // invented separator oracle text is (`_FACE_JOINED_TEXTS`), and this rewrite is
                // the path a bare `ft:/…/` actually takes, so leaving it whole would have kept
                // the bug alive everywhere it matters.
                let (gids, dense_ids) = flavor_match_sets(flavor, strings, 0, |s| {
                    regex_matches_face_split(regex, TextField::FlavorTextLower, s)
                });
                *self = FilterExpr::FlavorMatch { gids, dense_ids };
            }
            _ => {}
        }
    }

    /// Memoize indexable text predicates in a query the driver is about to
    /// evaluate against every card (#624) — the third instance of the
    /// ArtistMatch/FlavorMatch pattern. Name/oracle contains-nodes resolve
    /// through their trigram indexes: gather candidates (bounded by the
    /// needle's rarest trigram), verify each with the real contains() once,
    /// and rewrite to a sorted match-id set whose per-card evaluation is an
    /// integer binary search instead of a substring search.
    ///
    /// Only called when the query has no candidates (no postings narrowing
    /// and no plane bitmap): with candidates, the driver evaluates only those
    /// cards and the bind-time verify would mostly be wasted work. Needles
    /// under 3 bytes have no trigrams and keep the scan; needles whose
    /// candidates exceed half the corpus stay unrewritten too — at that
    /// density a binary search costs about what contains() does, so the
    /// verify pass couldn't earn its keep.
    /// Cost-based memoization gate, measured (bench_memo_crossover.py, six
    /// needles spanning 493-11,933 candidate texts × eight candidate-domain
    /// sizes, memoize-always vs memoize-never builds): the bind cost breaks
    /// even when the evaluation domain reaches ~1.25× the needle's shortest
    /// trigram posting list. The factor here is 2 — declining early forgoes a
    /// small win, declining late pays on every query — with a floor below
    /// which the whole effect sits inside measurement noise (scaled down for
    /// tiny stores so tests and partial imports still exercise the rewrite).
    fn memoize_pays(bind_bound: usize, eval_domain: usize, n_rows: usize) -> bool {
        const MEMO_DOMAIN_FACTOR: usize = 2;
        const MEMO_DOMAIN_FLOOR: usize = 2_048;
        eval_domain >= (bind_bound * MEMO_DOMAIN_FACTOR).max(MEMO_DOMAIN_FLOOR.min(n_rows / 4))
    }

    /// Resolve every type-line predicate against the distinct type lines, the
    /// second half of `bind()` — split out only because `bind()` predates the
    /// index and is called from a dozen benches and tests that have no use for
    /// it. `bind_and_split_filter` calls the two together and nothing else
    /// should call one without the other.
    ///
    /// UNCONDITIONAL, unlike `memoize_text_predicates`. That rewrite is gated on
    /// a cost model because it scans ~30k distinct oracle texts; this one walks
    /// **3,965** distinct type lines totalling 127 KB (measured on the 2026-08-16
    /// corpus, 526,865 rows) — fewer in any one partition — so there is no query
    /// for which paying it is worse
    /// than the per-card regex it replaces — and it is what turns a type
    /// predicate from "no narrowing arm exists" into an exact card set.
    ///
    /// The answer is EXACT, not a prefilter: a card's whole type-line identity
    /// is its interned id, so "the predicate held for these lines" is precisely
    /// "these cards match". `narrow_rec` returns it `tight` for that reason.
    /// Grow the FLAVOR-NAME arm of a `name:` predicate — but only when a flavor name answers it.
    ///
    /// Scryfall's `name:` reads a printing's alternate SOLD-AS name as well as its oracle name:
    /// `name:croft` answers 2 there, because Command Tower is sold as "Croft Manor" on 2 of its 112
    /// printings; `name:godzilla` is 8 cards / 14 printings; `!"croft manor"` is 1.
    ///
    /// THE COST ARGUMENT IS THE DESIGN. Answering that unconditionally would make `name:` — the
    /// most common predicate in the language and the one the perf gate holds to <3% of a full scan
    /// — printing-dependent for every query, which costs the card-level settle on all of them. So
    /// the needle is put to the ~546-record `flavor_names` table FIRST, against the pre-collated
    /// strings beside it, and the arm is added only on a hit. A needle that matches nothing there
    /// leaves the tree byte-identical to what it was, which is the overwhelmingly common case; the
    /// scan itself is one `memmem::Finder` over ~9 KB of short strings, built once per predicate.
    ///
    /// Both name predicates that Scryfall reaches flavor names through are handled — the bare
    /// `name:word` (collated on both sides) and `!"…"` (collated, and matching either half of a
    /// `A // B` name, exactly as the oracle-name arm does).
    pub(crate) fn bind_flavor_names(&mut self, idx: &rkyv::Archived<PrintedNameIndex>, collated: &AStrings) {
        match self {
            FilterExpr::And(children) | FilterExpr::Or(children) => {
                for c in children {
                    c.bind_flavor_names(idx, collated);
                }
            }
            FilterExpr::Not(inner) => inner.bind_flavor_names(idx, collated),
            FilterExpr::TextContains { field: TextSearchField::NameCollated, word } => {
                let finder = memmem::Finder::new(word.as_bytes());
                let ids = flavor_name_ids(idx, collated, |s| finder.find(s.as_bytes()).is_some());
                if !ids.is_empty() {
                    let original = std::mem::replace(self, FilterExpr::True);
                    *self = FilterExpr::Or(vec![original, FilterExpr::FlavorNameIn { ids }]);
                }
            }
            FilterExpr::ExactName(needle) => {
                let needle = needle.clone();
                let ids = flavor_name_ids(idx, collated, |s| exact_name_matches(s, &needle));
                if !ids.is_empty() {
                    let original = std::mem::replace(self, FilterExpr::True);
                    *self = FilterExpr::Or(vec![original, FilterExpr::FlavorNameIn { ids }]);
                }
            }
            _ => {}
        }
    }

    pub(crate) fn bind_type_lines(&mut self, idx: &rkyv::Archived<TypeLineIndex>, strings: &AStrings) {
        // MEASUREMENT ESCAPE HATCH, the same shape as CARD_ENGINE_MAX_NARROW_FRACTION and there
        // for the same reason: the gate's ratios only mean something if the unnarrowed state can
        // be measured too. With this set, `t:` keeps its (correct) substring semantics and falls
        // back to running the regex against every card's type line — the naive shape this index
        // exists to avoid. Never set in production; `guard_env` defaults it off.
        if *NO_TYPE_LINE_INDEX {
            return;
        }
        match self {
            FilterExpr::And(children) | FilterExpr::Or(children) => {
                for c in children.iter_mut() {
                    c.bind_type_lines(idx, strings);
                }
            }
            FilterExpr::Not(inner) => inner.bind_type_lines(idx, strings),
            FilterExpr::TypeLineContains { .. } | FilterExpr::TextRegex { field: TextField::TypeLine, .. } => {
                // The literal scans the index's lowercased copies with a SIMD `memmem`; a user's
                // own `t:/…/` runs against the original line, where its pattern's own case
                // expectations still mean what they say.
                fn scan(idx: &rkyv::Archived<TypeLineIndex>, hit: impl Fn(usize, u32) -> bool) -> (Vec<u32>, Vec<u32>) {
                    let mut gids: Vec<u32> = Vec::new();
                    let mut line_ids: Vec<u32> = Vec::new();
                    for (d, gid) in idx.gids.iter().enumerate() {
                        let gid = u32::from(*gid);
                        if hit(d, gid) {
                            gids.push(gid);
                            line_ids.push(d as u32);
                        }
                    }
                    // `line_ids` comes out ascending (dense order); `gids` follows first-seen order
                    // and has to be sorted for the binary search in tri(). Distinct dense ids intern
                    // to distinct strings, so there are no duplicates to dedup.
                    gids.sort_unstable();
                    (gids, line_ids)
                }
                // The literal scans the index's lowercased copies with a SIMD `memmem`; a user's
                // own `t:/…/` runs against the original line, where its pattern's own case
                // expectations still mean what they say.
                let (gids, line_ids) = match self {
                    FilterExpr::TypeLineContains { needle, whole_word: false } => {
                        let finder = memmem::Finder::new(needle.as_bytes());
                        scan(idx, |d, _| idx.lower.get(d).is_some_and(|l| finder.find(l.as_bytes()).is_some()))
                    }
                    // The canonical-name arm. Same scan, same pre-lowercased copies; the finder is
                    // asked for EVERY occurrence rather than the first, because the anchored one
                    // need not be the leftmost ("Demigod Warrior" against `t:warrior`).
                    FilterExpr::TypeLineContains { needle, whole_word: true } => {
                        let finder = memmem::Finder::new(needle.as_bytes());
                        scan(idx, |d, _| {
                            idx.lower.get(d).is_some_and(|l| type_word_match(l.as_bytes(), &finder, needle.len()))
                        })
                    }
                    FilterExpr::TextRegex { regex, .. } => {
                        scan(idx, |_, gid| str_at(strings, gid).is_some_and(|s| regex.is_match(s)))
                    }
                    _ => unreachable!("guarded by the match arm above"),
                };
                *self = FilterExpr::TypeLineMatch { gids, line_ids };
            }
            _ => {}
        }
    }

    pub(crate) fn memoize_text_predicates(
        &mut self,
        cards: &[AOracleCard],
        strings: &AStrings,
        name_trigram: &rkyv::Archived<SortedTrigramIndex>,
        name_bigrams: &rkyv::Archived<NameBigramIndex>,
        oracle: &rkyv::Archived<OracleTextIndex>,
        eval_domain: usize,
    ) {
        match self {
            FilterExpr::And(children) | FilterExpr::Or(children) => {
                for c in children.iter_mut() {
                    c.memoize_text_predicates(cards, strings, name_trigram, name_bigrams, oracle, eval_domain);
                }
            }
            FilterExpr::Not(inner) => inner.memoize_text_predicates(cards, strings, name_trigram, name_bigrams, oracle, eval_domain),
            FilterExpr::TextContains { field: field @ (TextSearchField::NameLower | TextSearchField::NameCollated), word } => {
                // BOTH name predicates narrow through the SAME collated tiers, because both
                // indexes are built over `card_name_collated`. The COLLATED predicate is answered
                // by them; the LITERAL one only gets its candidates there and re-verifies against
                // the name as written.
                //
                // Narrowing the literal predicate through a collated index is sound in the one
                // direction it is used: deleting the same character class from both sides
                // preserves containment, so a name containing `word` literally contains
                // `collate_name(word)` collated, and the collated tier can only ever be a
                // SUPERSET. `name:"of the"` narrows through `ofthe` and is then checked against
                // the space. An all-punctuation needle collates to nothing and has no tier at
                // all, so it declines to the walk rather than narrowing to everything.
                // A NON-ASCII literal needle declines to narrow at all. The index is built over
                // the ACCENT-FOLDED collated name, and folding is not a deletion — "éowyn" has no
                // window in common with the stored "eowynladyofrohan", so narrowing would drop
                // the very card `name:"éowyn"` names (measured: 3 on api.scryfall.com). The
                // separator argument below survives folding only for ASCII, which is why the two
                // guards are separate.
                let literal = *field == TextSearchField::NameLower;
                let collated = if literal { crate::collate_name(word) } else { word.clone() };
                if collated.is_empty() || (literal && !word.is_ascii()) {
                    return;
                }
                // Verifies against the string THIS predicate compares, not the one the index is
                // built from — the whole point of the split.
                let finder = memmem::Finder::new(word.as_bytes()); // built once, reused across the verify scan
                let verify = |cid: u32| -> bool {
                    let card = &cards[cid as usize];
                    let hay = if literal { crate::lower_name(card, strings) } else { crate::collated_name(card, strings) };
                    finder.find(hay.as_bytes()).is_some()
                };

                let cand: Vec<u32> = if collated.len() == 2 {
                    // 2-byte needles resolve exactly through the bigram index: containment IS
                    // bigram membership over the indexed string, so the collated predicate skips
                    // verification entirely and the ids just re-key to card_name_id for eval.
                    if u32::from(name_bigrams.n_cards) as usize != cards.len() {
                        return;
                    }
                    let bg = [collated.as_bytes()[0], collated.as_bytes()[1]];
                    let bind_bound = name_bigrams.postings.get(&bg).map_or_else(
                        || name_bigrams.plane_of.get(&bg).map_or(0, |_| cards.len() / 8),
                        |v| v.len(),
                    );
                    if !Self::memoize_pays(bind_bound, eval_domain, cards.len()) {
                        return;
                    }
                    if let Some(p) = name_bigrams.plane_of.get(&bg) {
                        let wpp = cards.len().div_ceil(64);
                        let start = u32::from(*p) as usize * wpp;
                        let mut out = Vec::new();
                        for (i, w) in name_bigrams.plane_words[start..start + wpp].iter().enumerate() {
                            let mut w = u64::from(*w);
                            while w != 0 {
                                out.push(((i as u32) << 6) | w.trailing_zeros());
                                w &= w - 1;
                            }
                        }
                        out
                    } else {
                        name_bigrams.postings.get(&bg).map_or_else(Vec::new, |v| v.iter().map(|x| u32::from(u16::from(*x))).collect())
                    }
                } else {
                    // The intersection is bounded by the shortest posting list, so
                    // checking that bound first makes the decline path free — no
                    // gather, no intersection. Declining when only the *bound*
                    // (not the exact count) exceeds half the corpus is deliberate:
                    // it can only happen when every trigram of the needle is
                    // ultra-common, where the match set is broad anyway.
                    match trigram_min_posting(name_trigram, &collated) {
                        Some(min) if min <= cards.len() / 2 && Self::memoize_pays(min, eval_domain, cards.len()) => {}
                        _ => return,
                    }
                    let Some(cand) = trigram_candidates(name_trigram, &collated) else { return };
                    cand
                };

                let exact_tier = !literal && collated.len() == 2;
                let mut ids: Vec<u32> = cand
                    .into_iter()
                    .filter(|&cid| exact_tier || verify(cid))
                    .map(|cid| u32::from(cards[cid as usize].card_name_id))
                    .collect();
                ids.sort_unstable();
                ids.dedup();
                *self = FilterExpr::NameMatch { ids };
            }
            FilterExpr::TextContains { field: TextSearchField::OracleTextLower, word } => {
                match trigram_min_posting(&oracle.trigrams, word) {
                    Some(min) if min <= oracle.gids.len() / 2 && Self::memoize_pays(min, eval_domain, cards.len()) => {}
                    _ => return,
                }
                let Some(dense) = trigram_candidates(&oracle.trigrams, word) else { return };
                let finder = memmem::Finder::new(word.as_bytes()); // built once, reused across the verify scan
                let mut gids: Vec<u32> = Vec::with_capacity(dense.len());
                for d in dense {
                    let gid = u32::from(oracle.gids[d as usize]);
                    // PER FACE, like the unmemoized arm: the trigram narrow above reads the joined
                    // text and is a superset either way, but this verify is the answer, and a
                    // needle straddling the invented separator must not survive it.
                    let hit = |s: &str| {
                        s.split(FACE_TEXT_SEPARATOR).any(|face| finder.find(face.as_bytes()).is_some())
                    };
                    if str_at(strings, gid).is_some_and(hit) {
                        gids.push(gid);
                    }
                }
                gids.sort_unstable();
                *self = FilterExpr::OracleMatch { gids };
            }
            _ => {}
        }
    }

    /// Reorder And/Or children cheapest-verification-first so the tri walk's
    /// short-circuit (first False settles an And, first True settles an Or)
    /// runs the expensive text predicates on as few cards as possible. The tri
    /// accumulation is commutative — False/True dominate and the Null /
    /// PrintingDep flags just OR together — so any child order is
    /// semantics-preserving; only the cost changes. Without this, whether a
    /// broad scan pays a regex before or after the cheap mask checks depends
    /// on how the user typed the query.
    ///
    /// And children sort card-level-first (a printing-dependent child cannot
    /// reject at card level, so any card-level sibling that rejects first
    /// skips its eval — free, never negative), then on the full cost tiers,
    /// refined within the memoized-set tier to ascending set size: a smaller
    /// match set rejects more candidates per unit cost, and the size is
    /// already known (ids.len()). Or children sort on the coarser
    /// or_child_key — their short-circuit is acceptance, which no static
    /// cost model can see, so only decisive cost gaps reorder them.
    ///
    /// The sorts are stable, so equal-cost children keep written order and
    /// the result is deterministic. Must run after memoize_text_predicates():
    /// memoization flips TextContains nodes from the scan tier to the set
    /// tier. The per-printing residual pass inherits the order too, since
    /// card_pass() pushes residual children in child order.
    /// `proven` is a bitmask over THIS node's `And` children (see `Narrowed::proven`) and is permuted in
    /// step with them. Carrying it through rather than invalidating it matters: this reorder runs on every
    /// query with a residual, so a mask dropped here would never survive to its consumer. Nested nodes get
    /// no mask — only the outermost `And`'s is ever read.
    pub(crate) fn order_children_by_verify_cost(&mut self, proven: &mut u64) {
        match self {
            FilterExpr::And(children) => {
                for c in children.iter_mut() {
                    c.order_children_by_verify_cost(&mut 0);
                }
                let key = |c: &FilterExpr| (printing_dependent(c), verify_cost_tier(c), and_child_set_len(c));
                if *proven == 0 {
                    children.sort_by_key(key);
                    return;
                }
                // Sort an index permutation instead of the children, so the mask can be rebuilt against
                // the new positions. `sort_by_key` is stable, so this produces the same order as the
                // unmasked path above.
                let mut order: Vec<usize> = (0..children.len()).collect();
                order.sort_by_key(|&i| key(&children[i]));
                let mut moved: Vec<Option<FilterExpr>> = std::mem::take(children).into_iter().map(Some).collect();
                let mut remapped = 0u64;
                for (new_i, &old_i) in order.iter().enumerate() {
                    if new_i < 64 && old_i < 64 && *proven & (1 << old_i) != 0 {
                        remapped |= 1 << new_i;
                    }
                    children.push(moved[old_i].take().expect("each index appears once in a permutation"));
                }
                *proven = remapped;
            }
            FilterExpr::Or(children) => {
                for c in children.iter_mut() {
                    c.order_children_by_verify_cost(&mut 0);
                }
                children.sort_by_key(or_child_key);
            }
            FilterExpr::Not(inner) => inner.order_children_by_verify_cost(&mut 0),
            _ => {}
        }
    }

    /// True iff the filter matches this (card, printing) pair. With a printing
    /// supplied, evaluation is exact — PrintingDep cannot occur. The query
    /// driver goes through card_pass()/residual_matches() instead; this is the
    /// unfactored single-pair form, kept for tests.
    #[cfg(test)]
    pub(crate) fn matches(&self, card: &AOracleCard, printing: &APrinting, strings: &AStrings) -> bool {
        self.tri(card, Some(printing), strings) == Tri::True
    }

    /// Card-level pass: evaluate with no printing. True means every printing of
    /// the card matches; False/Null mean none can; PrintingDep means the result
    /// depends on printing-level fields. The query driver uses card_pass()
    /// (which adds residual extraction); this is the plain form, kept for tests.
    #[cfg(test)]
    pub(crate) fn eval_card(&self, card: &AOracleCard, strings: &AStrings) -> Tri {
        self.tri(card, None, strings)
    }

    /// Printing-level pass, the plain form, kept for tests: the same evaluation the residual walk
    /// performs, with a printing in hand. `eval_card`'s twin — the one-printing question a
    /// printing-scoped leaf (set code, watermark, set type) is the only way to ask directly.
    #[cfg(test)]
    pub(crate) fn eval_printing(&self, card: &AOracleCard, printing: &APrinting, strings: &AStrings) -> Tri {
        self.tri(card, Some(printing), strings)
    }

    /// Card pass with one-level residual extraction. For a top-level And/Or,
    /// children are classified individually: decided children are dropped (a
    /// False/Null child settles an And, a True child settles an Or — and at the
    /// top level only True counts as a match, so an And with a Null child can
    /// never match and collapses to False), and only the PrintingDep children
    /// go into `residual` for the per-printing walk. This is what makes
    /// broad-card × narrow-printing conjunctions cheap: `t:creature set:lea`
    /// proves the type check once per card and walks printings evaluating only
    /// the set check. `residual` is a caller-owned buffer reused across cards;
    /// `residual_is_or` says how residual_matches() must combine it.
    ///
    /// Returns True (every printing matches), False (none can), or PrintingDep
    /// (evaluate the residual per printing). Never returns Null: at the top
    /// level Null cannot become a match, so it collapses to False.
    pub(crate) fn card_pass<'f>(
        &'f self,
        card: &AOracleCard,
        strings: &AStrings,
        residual: &mut Vec<&'f FilterExpr>,
        residual_is_or: &mut bool,
        proven: u64,
    ) -> Tri {
        residual.clear();
        *residual_is_or = false;
        match self {
            FilterExpr::And(children) => {
                for (i, c) in children.iter().enumerate() {
                    // Membership in the candidate set already settles this conjunct for this card, so
                    // evaluating it can only return `True` — see `Narrowed::proven` for why that is sound
                    // and for what it costs when it is not done. Skipping it is exactly the `all_match`
                    // shortcut at conjunct granularity: not in the residual either, since the printings
                    // of a card cannot disagree about a card-space fact.
                    if i < 64 && proven & (1 << i) != 0 {
                        continue;
                    }
                    match c.tri(card, None, strings) {
                        // And(Null, x) is Null or False for every printing —
                        // never True — so the card cannot match.
                        Tri::False | Tri::Null => return Tri::False,
                        Tri::True => {}
                        Tri::PrintingDep => residual.push(c),
                    }
                }
                if residual.is_empty() { Tri::True } else { Tri::PrintingDep }
            }
            FilterExpr::Or(children) => {
                *residual_is_or = true;
                for c in children {
                    match c.tri(card, None, strings) {
                        Tri::True => {
                            residual.clear();
                            return Tri::True;
                        }
                        // Or(Null, x) is True iff x is True: Null children
                        // cannot contribute a match and drop out.
                        Tri::False | Tri::Null => {}
                        Tri::PrintingDep => residual.push(c),
                    }
                }
                if residual.is_empty() { Tri::False } else { Tri::PrintingDep }
            }
            other => match other.tri(card, None, strings) {
                Tri::PrintingDep => {
                    residual.push(self);
                    Tri::PrintingDep
                }
                Tri::True => Tri::True,
                Tri::False | Tri::Null => Tri::False,
            },
        }
    }

    /// Evaluate a card_pass() residual against one printing. Only True counts
    /// as a match at the top level, so And-residuals need every child True and
    /// Or-residuals need any child True.
    pub(crate) fn residual_matches(
        card: &AOracleCard,
        printing: &APrinting,
        strings: &AStrings,
        residual: &[&FilterExpr],
        residual_is_or: bool,
    ) -> bool {
        // A query whose regex already blew its backtrack budget has a wrong answer either way;
        // stop paying for the rest of the walk (`CompiledRegex::is_match` short-circuits per leaf,
        // this short-circuits the whole residual).
        if super::regex_compat::regex_match_failed() {
            return false;
        }
        if residual_is_or {
            residual.iter().any(|c| c.tri(card, Some(printing), strings) == Tri::True)
        } else {
            residual.iter().all(|c| c.tri(card, Some(printing), strings) == Tri::True)
        }
    }

    /// True iff any leaf of this (bound) filter can only be answered over the ANNEX — one of the
    /// two triggers that send a query to the widened (multilingual) driver instead of
    /// `run_query_routed`. Detected here, on the compiled tree, so the operators and the
    /// `include_multilingual` flag cannot widen differently.
    ///
    /// Three leaves qualify. `LangMatch` is the obvious one. `PrintedNamePresent` is the second,
    /// and it is not a design choice — it is Scryfall's measured behaviour: `is:localizedname`
    /// with no `lang:` term in sight answers 31,294 cards there, and `&unique=prints` shows the
    /// rows it returns are German, French, Japanese… A canonical-only reading would answer 182
    /// (the English printings that carry a printed name) and call it the whole set.
    /// `FlavorNamePresent` is the third, on the same measurement: `is:flavorname&unique=prints`
    /// is 661 rows there and 6 of them are Japanese (2026-09-01).
    pub(crate) fn widens_to_annex(&self) -> bool {
        match self {
            FilterExpr::LangMatch { .. } | FilterExpr::PrintedNamePresent | FilterExpr::FlavorNamePresent => true,
            FilterExpr::And(children) | FilterExpr::Or(children) => children.iter().any(Self::widens_to_annex),
            FilterExpr::Not(inner) => inner.widens_to_annex(),
            _ => false,
        }
    }

    /// A language every match MUST carry, when the filter pins one: a `LangMatch` that is the
    /// whole filter or a direct conjunct of a top-level `And`. Conjuncts only — under `Or` or
    /// `Not` a language constrains nothing on its own, and several conjuncts can only tighten,
    /// so answering with the FIRST is a sound (superset) narrowing either way. `lang:any`
    /// requires nothing.
    pub(crate) fn required_lang_value(&self) -> Option<&str> {
        fn leaf(f: &FilterExpr) -> Option<&str> {
            match f {
                FilterExpr::LangMatch { value, any: false, .. } => Some(value.as_str()),
                _ => None,
            }
        }
        match self {
            FilterExpr::And(children) => children.iter().find_map(leaf),
            other => leaf(other),
        }
    }

    /// This filter with every `LangMatch` leaf replaced by `True`: the query's scope, minus the
    /// language it asks for.
    ///
    /// `run_query_widened` needs it to answer "which CANONICAL rows would this query have
    /// matched?" for a card whose only matching rows are foreign — the question that decides which
    /// foreign row represents the card (see `annex_representative`). Relaxing to `True` rather
    /// than deleting the leaf keeps the tree's shape, so a `LangMatch` under `Not` or `Or`
    /// contributes exactly what a satisfied conjunct would and no arm changes arity.
    ///
    /// Not a narrowing helper and never used as one: this loosens the filter, so it may only be
    /// asked about rows already known to be in scope.
    pub(crate) fn with_lang_relaxed(&self) -> FilterExpr {
        match self {
            FilterExpr::LangMatch { .. } => FilterExpr::True,
            FilterExpr::And(children) => FilterExpr::And(children.iter().map(Self::with_lang_relaxed).collect()),
            FilterExpr::Or(children) => FilterExpr::Or(children.iter().map(Self::with_lang_relaxed).collect()),
            FilterExpr::Not(inner) => FilterExpr::Not(Box::new(inner.with_lang_relaxed())),
            other => other.clone(),
        }
    }

    /// Four-valued evaluation. True/False/Null mirror SQL ternary logic: Null is
    /// SQL's NULL ("unknown"), produced when a compared field is missing from the
    /// card, and NOT/AND/OR propagate it exactly like SQL — so -power>2 excludes
    /// powerless cards (NOT NULL = NULL) while -(power>2 and t:creature) still
    /// matches instants (NULL AND false = false, NOT false = true). Only True
    /// counts as a match.
    ///
    /// PrintingDep is the card-pass "depends on the printing" value: it behaves
    /// like an unknown that per-printing evaluation can still resolve either way,
    /// so it survives NOT and is only absorbed by a dominant exact value (AND
    /// with a False, OR with a True). Null stays senior to PrintingDep in AND/OR
    /// only via those dominance rules — when both occur the result is
    /// conservatively PrintingDep and the per-printing pass settles it.
    fn tri(&self, card: &AOracleCard, printing: Option<&APrinting>, strings: &AStrings) -> Tri {
        match self {
            FilterExpr::True => Tri::True,

            FilterExpr::And(children) => {
                let mut null = false;
                let mut pdep = false;
                for c in children {
                    match c.tri(card, printing, strings) {
                        Tri::False => return Tri::False,
                        Tri::Null => null = true,
                        Tri::PrintingDep => pdep = true,
                        Tri::True => {}
                    }
                }
                if pdep { Tri::PrintingDep } else if null { Tri::Null } else { Tri::True }
            }
            FilterExpr::Or(children) => {
                let mut null = false;
                let mut pdep = false;
                for c in children {
                    match c.tri(card, printing, strings) {
                        Tri::True => return Tri::True,
                        Tri::Null => null = true,
                        Tri::PrintingDep => pdep = true,
                        Tri::False => {}
                    }
                }
                if pdep { Tri::PrintingDep } else if null { Tri::Null } else { Tri::False }
            }
            FilterExpr::Not(inner) => match inner.tri(card, printing, strings) {
                Tri::True => Tri::False,
                Tri::False => Tri::True,
                Tri::Null => Tri::Null,
                Tri::PrintingDep => Tri::PrintingDep,
            },

            FilterExpr::ExactName(lower) => {
                if exact_name_matches(crate::folded_name(card, strings), lower) {
                    return Tri::True;
                }
                // The joined name a REVERSIBLE printing prints, which is not its card's — see
                // `name_divergent`, the index that makes this reachable at all. Printing-dependent
                // by construction: only the printings whose layout is the divergent one print it,
                // which is exactly what `divergent_of` decides, so a card-space evaluation answers
                // PrintingDep and the driver re-asks per printing — the same contract TextExact
                // takes for the second layout value.
                let Some(rec) = card.divergent.first() else { return Tri::False };
                if !str_at(strings, u32::from(rec.card_name_folded_id)).is_some_and(|joined| exact_name_matches(joined, lower)) {
                    return Tri::False;
                }
                match printing {
                    None => Tri::PrintingDep,
                    Some(p) => tri_bool(crate::divergent_of(card, p).is_some()),
                }
            }

            FilterExpr::NumericCmp { lhs, op, rhs } => {
                let base = numeric_cmp_tri(lhs, *op, rhs, &|f| field_num(card, printing, f));
                // The merged row answers for 82% of cards (no faces) and for every row that
                // already matched, so the per-face cross product is reached only by a multi-face
                // card the card-level values did not satisfy — see face_numeric_cmp_tri.
                if base == Tri::True || card.faces.is_empty() {
                    base
                } else {
                    face_numeric_cmp_tri(card, printing, lhs, *op, rhs, base)
                }
            }

            FilterExpr::TextContains { field, word } => {
                match text_search_field_value(card, printing, strings, *field) {
                    StrVal::Known(s) => tri_bool(contains_per_face(word.as_str(), *field, s)),
                    StrVal::Null => Tri::Null,
                    StrVal::PDep => Tri::PrintingDep,
                }
            }

            FilterExpr::ArtistMatch { ids } => {
                let Some(p) = printing else { return Tri::PrintingDep };
                let vid = u16::from(p.card_artist_vid);
                if vid == ARTIST_NONE {
                    Tri::Null // no artist: SQL NULL, like the missing-string case before
                } else {
                    tri_bool(ids.binary_search(&vid).is_ok())
                }
            }

            // NONE_STR is Scryfall having omitted `printed_name` on every face, which is a real
            // False (this printing has no printed name) and not an SQL NULL — unlike the interned
            // scalars above, absence here IS the answer the predicate asks about.
            FilterExpr::PrintedNamePresent => {
                let Some(p) = printing else { return Tri::PrintingDep };
                tri_bool(p.printed_name_folded_id != super::NONE_STR)
            }

            FilterExpr::FlavorNameIn { ids } => {
                let Some(p) = printing else { return Tri::PrintingDep };
                let id = u32::from(p.flavor_name_folded_id);
                tri_bool(id != super::NONE_STR && ids.binary_search(&id).is_ok())
            }

            // Presence in EITHER place Scryfall puts the key: the printing's own top-level
            // `flavor_name`, or a face's (`PrintingFace.flavor_name_id`, which the 15 transform /
            // reversible printings carry INSTEAD of the top-level one — never both). NONE_STR on
            // both is a real False, not an SQL NULL, for the same reason as PrintedNamePresent.
            FilterExpr::FlavorNamePresent => {
                let Some(p) = printing else { return Tri::PrintingDep };
                tri_bool(
                    u32::from(p.flavor_name_id) != super::NONE_STR
                        || p.faces.iter().any(|f| u32::from(f.flavor_name_id) != super::NONE_STR),
                )
            }

            FilterExpr::SingleSet => tri_bool(card.single_set),

            // Two-valued: a card either has a blank creature face or it does not, and a card with
            // no text at all interns "" rather than NONE_STR, so absence is never an SQL NULL here.
            FilterExpr::VanillaFace => tri_bool(card_is_vanilla(card, strings)),

            FilterExpr::SetTypeMatch { vid, .. } => {
                let Some(p) = printing else { return Tri::PrintingDep };
                if u16::from(p.compat.set_type_id) == super::VOCAB_NONE {
                    Tri::Null // no set type recorded: SQL NULL, like the missing-string cases above
                } else {
                    // `vid` None = the set type exists on no loaded printing; matches nothing.
                    tri_bool(vid.is_some_and(|v| u16::from(p.compat.set_type_id) == v))
                }
            }

            FilterExpr::LangMatch { vid, any, .. } => {
                // `lang:any` is True for every printing — its whole effect is the widening its
                // presence triggers, so as a predicate it must reject nothing.
                if *any {
                    return Tri::True;
                }
                let Some(p) = printing else { return Tri::PrintingDep };
                if u16::from(p.compat.lang_id) == super::VOCAB_NONE {
                    Tri::Null // no lang recorded: SQL NULL, like the missing-string cases above
                } else {
                    // `vid` None = the language exists on no loaded printing; matches nothing.
                    tri_bool(vid.is_some_and(|v| u16::from(p.compat.lang_id) == v))
                }
            }

            // Two-valued, never Null: a stored oracle_id is never 0 (build enforces it), and
            // parse_uuid_or_hash's 0 for an unparseable value therefore rejects every card —
            // the same answer the oracle_by_oracle_id path gives, which refuses id 0 outright.
            FilterExpr::OracleIdMatch { id } => tri_bool(u128::from(card.oracle_id) == *id),

            FilterExpr::FlavorMatch { gids, .. } => {
                let Some(p) = printing else { return Tri::PrintingDep };
                let gid = u32::from(p.flavor_text_lower_id);
                if gid == NONE_STR {
                    Tri::Null // no flavor text: SQL NULL, matching the pre-bind semantics
                } else {
                    tri_bool(gids.binary_search(&gid).is_ok())
                }
            }

            // Names are always present (TextContains on NameLower is always
            // Known), so membership is two-valued: an id absent from `ids`
            // means the name didn't contain the needle, exactly like
            // contains() on the inline string.
            FilterExpr::NameMatch { ids } => tri_bool(ids.binary_search(&u32::from(card.card_name_id)).is_ok()),

            FilterExpr::OracleMatch { gids } => {
                let gid = u32::from(card.oracle_text_lower_id);
                if gid == NONE_STR {
                    // Unreachable for loaded cards (missing text interns "" —
                    // contains() on it is False, and so is a binary-search
                    // miss); kept to mirror str_at()'s NONE_STR → None
                    // contract, which TextContains maps to Null via opt_sv.
                    Tri::Null
                } else {
                    tri_bool(gids.binary_search(&gid).is_ok())
                }
            }

            // The type line is interned per distinct string, so a card's line id
            // IS its type-line identity: `bind_type_lines` already decided which
            // ids satisfy the predicate, and there is nothing left to re-derive
            // here. Missing type lines intern "" (never NONE_STR — see
            // `type_line_id`'s `unwrap_or_default` at load), so this is
            // two-valued like NameMatch rather than three-valued like
            // OracleMatch.
            FilterExpr::TypeLineMatch { gids, .. } => {
                tri_bool(gids.binary_search(&u32::from(card.type_line_id)).is_ok())
            }

            // Only reachable when `bind_type_lines` did not run — a bench or a test that calls
            // `bind` alone, or the CARD_ENGINE_NO_TYPE_LINE_INDEX measurement mode. Correct, and
            // deliberately the slow way round: one allocation per card is what the index exists to
            // remove, so a path that starts paying it is easy to spot in a profile.
            FilterExpr::TypeLineContains { needle, whole_word } => {
                match text_field_value(card, printing, strings, TextField::TypeLine) {
                    StrVal::Known(s) => tri_bool(type_line_hit(&s.to_lowercase(), needle, *whole_word)),
                    StrVal::Null => Tri::Null,
                    StrVal::PDep => Tri::PrintingDep,
                }
            }

            FilterExpr::TextExact { field, op, value } => {
                let holds = |s: &str| match op {
                    CmpOp::Eq => s == value,
                    CmpOp::Ne => s != value,
                    CmpOp::Lt => s < value.as_str(),
                    CmpOp::Le => s <= value.as_str(),
                    CmpOp::Gt => s > value.as_str(),
                    CmpOp::Ge => s >= value.as_str(),
                };
                // EXISTENTIAL over the field's values, which is one value on every field but
                // `layout:` and `watermark:` — see `extra_text_field_values`. Negation composes
                // correctly through it: the `Not` arm complements this, so `-layout:normal` is
                // "no value of this printing is normal", which is Scryfall's own 4 for
                // `is:reversible -layout:normal`.
                tri_over_values(card, printing, strings, *field, holds)
            }

            FilterExpr::TextRegex { field, regex } => {
                // Existential over the same values the exact arm tests, for the same reason —
                // and PER FACE within each of them, on the fields whose stored value is a join
                // this store invented. See `regex_matches_faces`.
                tri_over_values(card, printing, strings, *field, |s| {
                    regex_matches_faces(regex, *field, s, card, strings)
                })
            }

            FilterExpr::ColorCmp { field, op, mask } => {
                // Existential over the faces' own masks — see `face_color_masks`. The card-level
                // mask answers for the 82% of cards with no faces and for every card-level column,
                // where `face_color_masks` declines and this is exactly the pre-gen-28 line.
                tri_bool(match face_color_masks(card, *field) {
                    Some(masks) => masks.into_iter().any(|bits| color_cmp(bits, *op, *mask, *field)),
                    None => color_cmp(card_colors(card, *field), *op, *mask, *field),
                })
            }

            FilterExpr::ColorCountCmp { field, op, count } => {
                // Colors are always present (colorless = 0 bits, not Null), so this is
                // total and two-valued. Existential over the faces for the same measured reason
                // ColorCmp is: `c=1` matches Valki // Tibalt on the front's single B, and `c=3`
                // does NOT match Extus // Awaken the Blood Avatar, whose union has three colours
                // and whose faces have two each.
                let hit = |bits: u8| num_cmp(*op, f64::from(color_count(bits, *field)), f64::from(*count));
                tri_bool(match face_color_masks(card, *field) {
                    Some(masks) => masks.into_iter().any(hit),
                    None => hit(card_colors(card, *field)),
                })
            }

            FilterExpr::TypeCmp { mask, op } => {
                let bits = u16::from(card.card_types);
                tri_bool(match op {
                    CmpOp::Ge => bits & mask != 0,
                    CmpOp::Eq => bits == *mask,
                    CmpOp::Le => bits & !mask == 0,
                    CmpOp::Lt => bits & !mask == 0 && bits != *mask,
                    CmpOp::Gt => bits & mask != 0 && bits != *mask,
                    CmpOp::Ne => bits != *mask,
                })
            }

            FilterExpr::CollectionCmp { field, op, value_id, .. } => {
                // Set-containment semantics against the single-value query {value},
                // mirroring the SQL path's jsonb operators (@>, <@, =, <> and the
                // strict variants). Lt (proper subset of a one-element set) can only
                // be the empty collection; Ne is not-exactly-equal, NOT "lacks value"
                // (that's what negation is for).
                //
                // Ids only: bind_collection_ids() resolved the value up front, and
                // vocab ids are unique per string, so id equality is string equality.
                let Some(coll) = collection(card, printing, *field) else {
                    return Tri::PrintingDep; // printing-level collection during the card pass
                };
                let contains = || match (*value_id, *field) {
                    (None, _) => false,
                    // card_subtypes keeps the printed order, so it is not id-sorted.
                    (Some(id), CollField::Subtypes) => coll.iter().any(|x| u16::from(*x) == id),
                    // The set-like collections are sorted by id at load.
                    (Some(id), _) => coll.binary_search(&id.into()).is_ok(),
                };
                let all_equal = || match *value_id {
                    None => coll.is_empty(),
                    Some(id) => coll.iter().all(|x| u16::from(*x) == id),
                };
                tri_bool(match op {
                    CmpOp::Ge => contains(),
                    CmpOp::Eq => coll.len() == 1 && contains(),
                    CmpOp::Gt => contains() && coll.len() > 1,
                    CmpOp::Le => all_equal(),
                    CmpOp::Lt => coll.is_empty(),
                    CmpOp::Ne => !(coll.len() == 1 && contains()),
                })
            }

            FilterExpr::Legality { shift, expected } => {
                let Some(shift) = shift else { return Tri::False }; // format absent from all data
                // The card-level word is exact unless this card's printings carry
                // divergent legalities (non-tournament printings: 30A, Collectors'
                // Edition, gold border) — then defer to each printing's own word.
                let word = if card.legality_divergent {
                    match printing {
                        Some(p) => u64::from(p.card_legalities),
                        None => return Tri::PrintingDep,
                    }
                } else {
                    u64::from(card.card_legalities)
                };
                tri_bool((word >> shift) & 0b11 == *expected)
            }

            FilterExpr::ManaCostCmp { op, core, hybrid_ids, hybrid_cmc, cmc, .. } => {
                // Containment/equality over the pip multiset = the same test
                // per lane (SWAR, all eight at once) and per hybrid entry
                // (sorted-slice walks; both sides empty on ~97% of cards).
                //
                // Existential over the faces on top of that, for the same measured reason the
                // numeric columns are (gen 28): `m:{R}` matches Valki // Tibalt on the BACK's
                // {5}{B}{R}, and `m={1}{R}` matches Fire // Ice on one half's cost rather than
                // the card's joined "{1}{R} // {1}{U}" (whose cmc is 4, so `eq` could never
                // hold). The card-level cost is tried first and is the whole answer for the 82%
                // of cards with no faces; a face that printed NO cost has no `mana_cost` and is
                // skipped, which is why `m=0` still does not match Delver's costless back.
                // GENERIC MANA IS A COUNTED PIP, NOT A CMC. `{2}` in a query cost means "at least
                // two GENERIC", not "cmc at least 2" — comparing cmc let every colored pip pay
                // for it, so `m:{2}` matched a card costing {R}{R}.
                //
                // Measured on api.scryfall.com 2026-08-16, `e:khm t:creature` (151) unless noted:
                //
                //   m:{2}          102   this answered 142 (= cmc >= 2)
                //   m:{1}          140   this answered 151
                //   m:{3}           60   this answered 113
                //   m:{1}{1}       102   generic SUMS across symbols — the same query as m:{2}
                //   m:{2}{r}        17   this answered 20
                //   m:{1}{1}{r}     17   again the same query
                //   m:{2} -m:{1}     0   >= and not ==, so {2} implies {1}
                //
                // and the decisive one, on the whole corpus rather than on KHM, because KHM has no
                // creature costing exactly {R}{R}: `m={r}{r} t:creature` is 24 there, and
                // `m={r}{r} m:{2} t:creature` is **0** where this answered all 24. A cost of
                // {R}{R} has cmc 2 and generic 0; only one of those two readings can be right, and
                // Scryfall's is the pip.
                //
                // The cmc comparisons are GONE rather than kept alongside: once generic and every
                // pip lane compare in the same direction, cmc's does too (cmc is their sum), so
                // keeping it would be redundant on the Ge/Le/Eq paths and would re-admit exactly
                // the cards this excludes.
                let q_generic = generic_of(*core, hybrid_ids.iter().copied(), *cmc, hybrid_cmc);
                let matches = |mc: &Archived<ManaCost>| {
                    let card_core = u64::from(mc.core);
                    let c_generic = generic_of(card_core, mc.hybrids.iter().map(|e| (e.0, e.1)), f32::from(mc.cmc), hybrid_cmc);
                    let ge = || lanes_ge(card_core, *core, LANES8_HI) && hybrids_ge(&mc.hybrids, hybrid_ids) && c_generic >= q_generic;
                    let le = || lanes_ge(*core, card_core, LANES8_HI) && hybrids_le(&mc.hybrids, hybrid_ids) && c_generic <= q_generic;
                    let eq = || c_generic == q_generic && card_core == *core && hybrids_eq(&mc.hybrids, hybrid_ids);
                    match op {
                        CmpOp::Ge => ge(),
                        CmpOp::Le => le(),
                        CmpOp::Eq => eq(),
                        CmpOp::Gt => ge() && !eq(),
                        CmpOp::Lt => le() && !eq(),
                        CmpOp::Ne => !eq(),
                    }
                };
                // THE CARD-LEVEL COST IS NOT A COST WHEN THE CARD HAS FACES — it is one face's pip
                // multiset paired with the WHOLE CARD's cmc, and `generic_of` reads that pair as a
                // generic the card does not have.
                //
                // `merge_face_drafts` keeps the FRONT face's `mana_cost_jsonb` while `cmc` is the
                // card column the face overlay never touches, so a split card stores
                // {core: front's pips, cmc: both halves}. `generic_of` = cmc - pips then counts the
                // BACK half's cmc as front-half generic. Measured on api.scryfall.com 2026-08-17:
                //
                //   Research // Development  {G}{U} // {3}{U}{R}, card cmc 7, front pips 2
                //     m:{3}  1  the true face generic ({3} on Development)
                //     m:{4}  0  m:{5}  0      this answered 1 to both, on 7 - 2 = 5
                //   Cut // Ribbons           {1}{R} // {X}{B}{B}, card cmc 4, front pips 1
                //     m:{1}  1               m:{2}  0   this answered 1, on 4 - 1 = 3
                //
                // and at corpus scale `m:{2}` is 19,692 against this file's 19,746, `m:{6}` 749
                // against 809. The inflation can even go NEGATIVE-then-clamped: sld/1556's
                // {R/G}{G}{G/W} has 3 hybrid+core pips against a card cmc of 3, so a back half
                // would have had to pay for it.
                //
                // The faces are the faithful record and already carry their OWN cmc
                // (`face_mana_cost` computes it from the face's own string), so where a face
                // carries a cost the card-level pair is not consulted at all. It is redundant as
                // well as wrong: the core it holds IS the front face's, so nothing that matched
                // through it truthfully stops matching through `faces[0]`.
                //
                // GATED ON A FACE ACTUALLY CARRYING A COST rather than on `faces` being non-empty.
                // A face that printed none has no `mana_cost` (`jv_faces` skips the absent key), and
                // for a card whose faces all print none — an art series, a reversible poster — the
                // card-level cost is still the only cost there is, and still the 82%-of-cards path
                // for the faceless majority, where core and cmc do describe the same cost.
                let any_face_cost = card.faces.iter().any(|f| f.mana_cost.is_some());
                // NO PRINTED COST IS NOT A COST OF ZERO, and the packed form cannot tell them
                // apart: a land and Ornithopter both arrive as {core: 0, hybrids: [], cmc: 0},
                // because `{0}` parses as a number and so contributes no pip and no cmc. The
                // INTERNED STRING is where the difference survives, and it survives as EMPTY
                // rather than absent — Scryfall prints `"mana_cost": ""` on a land and `"{0}"` on
                // Ornithopter, and the card object has to keep emitting both, so the id is real
                // either way and only its contents separate them.
                //
                // Measured on api.scryfall.com 2026-08-17, unique=prints:
                //
                //   m:{0} t:land   195     this answered 12,254 — every land in the corpus
                //   m={0}          293     this answered 12,713
                //   m:{0}       93,355     this answered 105,839
                //   -m:{0}      12,442     this answered 0, because m:{0} had matched everything
                //
                // A costless card fails the containment and exactness comparisons rather than
                // matching the zero ones, which is what makes `-m:{0}` return the lands: the
                // negation is of the leaf, and the leaf is false for them.
                //
                // `!=` IS THE EXCEPTION, and measurement is the only reason this is not a blanket
                // false: `m!={w} t:land` is 12,249 on Scryfall, so a card with no cost DOES
                // satisfy "not exactly {W}". That is consistent rather than special — `!=` asks
                // whether the costs differ, and an absent cost differs from every queried one,
                // while `:` `=` `>` `<` all ask about a cost the card does not have.
                let has_cost = any_face_cost
                    || str_at(strings, u32::from(card.mana_cost_text_id)).is_some_and(|s| !s.is_empty());
                tri_bool(if has_cost {
                    (!any_face_cost && matches(&card.mana_cost))
                        || card.faces.iter().any(|f| f.mana_cost.as_ref().is_some_and(matches))
                } else {
                    matches!(op, CmpOp::Ne)
                })
            }

            FilterExpr::Devotion { op, pips, hybrid_colors } => {
                // DEVOTION IS A QUESTION ABOUT THE QUERIED COLORS TAKEN TOGETHER, AND A HYBRID
                // QUERIES **BOTH** OF ITS COLORS AS ONE QUANTITY.
                //
                // This read the whole six-lane vector at once — one SWAR containment, plus an
                // integer equality that demanded every UNQUERIED color be zero too. Both are
                // wrong, and the hybrid case was wrong by two orders of magnitude:
                // `devotion:{r/g}` expands to lanes r=1,g=1, and a per-lane containment then
                // means "at least one red pip AND at least one green pip" — one card in KHM,
                // where Scryfall answers 62.
                //
                // MEASURED on api.scryfall.com 2026-08-16 over `e:khm t:creature` (151). `d[c]` is
                // this card's devotion to color c; the measure is the SUM over the queried lanes.
                //
                //   devotion:{r}       27 = d[r] >= 1        devotion:{g}        36
                //   devotion:{r}{r}     7 = d[r] >= 2        devotion:{g}{g}      8
                //   devotion={r}       20 = d[r] == 1        (27 - 7, and NOT 15, which is what
                //                                             whole-vector equality answered)
                //   devotion>{r}        7 = d[r] >  1        devotion<={r}      144
                //   devotion<{r}{r}   144   devotion!={r}    131 = 151 - 20
                //   devotion:{r/g}     62 = d[r]+d[g] >= 1   (27 + 36 - 1 card carrying both)
                //   devotion:{r/g}{r/g} 16 = d[r]+d[g] >= 2
                //   devotion={r/g}     46 = d[r]+d[g] == 1   (62 - 16)
                //   devotion>{r/g}     16   devotion<={r/g}  135   devotion!={r/g} 105
                //
                // THE SUM, NOT A PER-LANE OR — that 16 is what decides it. `devotion:{r}{r}` is 7
                // and `devotion:{g}{g}` is 8, so "d[r] >= 2 OR d[g] >= 2" can be at most 15; the
                // sixteenth card is the one KHM creature carrying one red pip AND one green pip,
                // which has neither lane at 2 and a combined devotion of exactly 2. An OR answers
                // 15 to all five hybrid rows above and 62 to the first, which is why the first one
                // alone is not enough evidence to pick a model.
                //
                // The queried lanes only — a lane the query left at zero is not part of the sum
                // and not a constraint. That is the half that made `devotion={r}` 15 here:
                // pinning the unqueried colors to zero excluded every red card that is also green.
                //
                // THE MEASURE IS DISTINCT PIPS, NOT A SUM OF LANES — the sum was the last
                // approximation here and it is gone. `ManaCost.devotion` stores per-color lanes
                // with hybrids EXPANDED, so a `{R/G}` symbol sits in red and in green; summing
                // both queried lanes counts one pip twice. Two cards falsify the two obvious
                // readings in opposite directions, and only the pip count answers both:
                //
                //                                       Svella {1}{R}{G}   Burning-Tree {R/G}{R/G}
                //   Scryfall's combined devotion               2                    2
                //   sum of the queried lanes                   2  OK                4  WRONG
                //   max of the queried lanes                   1  WRONG             2  OK
                //   DISTINCT PIPS matching either              2  OK                2  OK
                //
                // Burning-Tree answers `devotion:{r/g}{r/g}` on api.scryfall.com and NOT
                // `devotion:{r/g}{r/g}{r/g}`; Svella is the sixteenth card of KHM's 16, carrying
                // one red pip and one green one. The correction below is inclusion-exclusion over
                // the card's own hybrid symbols, and it is provably ZERO for a single-color query
                // (one bit in the mask cannot match twice), so every single-color comparison —
                // and the exact devotion PLANE, which declines multi-lane queries anyway — is
                // bit-identical to before.
                //
                // Verified set-scoped, where corpus vintage cannot reach: `e:rna
                // devotion:{r/g}{r/g}` 24, `e:gtc devotion:{w/u}{w/u}` 16, `e:sok
                // devotion:{b/g}{b/g}` 21, `e:rna devotion:{r/g}{r/g}{r/g}` 3, `e:khm
                // devotion!={r/g}` 252, `e:khm devotion<={r/g}` 301 — all exact.
                //
                // A SECOND, SEPARATE RESIDUAL on Scryfall's side: `=` and `!=` with a hybrid value
                // never match a card whose cost carries that hybrid pip. `devotion={r/g} m:{r/g}`
                // is 0 there across all 61, while `devotion={r/g} m:{w/u} -m:{r/g}` is 1 — that
                // pair specifically, not hybrids in general. It is not self-consistent (the same
                // cards answer `devotion={r}` and `devotion:{r/g}`, and `!=` follows the model
                // above exactly, so `=` and `!=` are not complements there), so no model fits it
                // and none is guessed here.
                let d = u64::from(card.mana_cost.devotion);
                // The card's devotion to the queried colors TOGETHER, against the number of
                // symbols the query asked for. A lane the query leaves at zero contributes
                // nothing — including the vacuous all-zero query, which the parser cannot produce
                // (a devotion value that is not a single color or a hybrid is ignored-and-warned
                // before the engine sees it) and which lands here as measure 0 against want 0.
                let mut measure: u32 = 0;
                let mut want: u8 = 0;
                let mut query_mask: u8 = 0;
                for c in 0..6 {
                    let k = lane_get(*pips, c);
                    if k > 0 {
                        measure += u32::from(lane_get(d, c));
                        want = want.max(k);
                        query_mask |= 1u8 << c;
                    }
                }
                // BACK OUT THE DOUBLE COUNT. The lanes hold hybrids expanded, so a `{R/G}` pip
                // sits in red AND green; summing both queried lanes counts one pip twice. Each
                // hybrid symbol in the card's own cost gives back (matched queried colours - 1)
                // per pip, which is inclusion-exclusion for the only overlap a mana symbol can
                // have — a pip cannot be three of the queried colours unless the symbol says so,
                // and the mask handles that case too.
                //
                // This is what makes the measure a count of DISTINCT PIPS rather than a sum of
                // lanes. Both readings agree on every single-colour pip and differ only where a
                // card carries a hybrid of the queried pair — 61 cards for {R/G}, 58 for {W/U},
                // 64 for {B/G}.
                let overcount: u32 = card
                    .mana_cost
                    .hybrids
                    .iter()
                    .map(|e| {
                        let mask = hybrid_colors.get(usize::from(e.0)).copied().unwrap_or(0);
                        let matched = (mask & query_mask).count_ones();
                        u32::from(e.1) * matched.saturating_sub(1)
                    })
                    .sum();
                let measure = measure.saturating_sub(overcount);
                let want = u32::from(want);
                tri_bool(match op {
                    CmpOp::Ge => measure >= want,
                    CmpOp::Gt => measure > want,
                    CmpOp::Eq => measure == want,
                    CmpOp::Lt => measure < want,
                    CmpOp::Le => measure <= want,
                    CmpOp::Ne => measure != want,
                })
            }

            FilterExpr::DateCmp { op, value } => {
                // value is a zero-padded yyyymmdd (see build_binary); zero-padding a
                // partial date reproduces the old lexicographic-prefix semantics exactly,
                // since any real day/month (>= 01) compares greater than 00.
                let Some(p) = printing else { return Tri::PrintingDep };
                let Some(date) = p.released_at_int.as_ref().map(|v| u32::from(*v)) else {
                    return Tri::Null; // missing date: SQL NULL
                };
                tri_bool(match op {
                    CmpOp::Eq => date == *value,
                    CmpOp::Ne => date != *value,
                    CmpOp::Lt => date < *value,
                    CmpOp::Le => date <= *value,
                    CmpOp::Gt => date > *value,
                    CmpOp::Ge => date >= *value,
                })
            }

            FilterExpr::YearCmp { op, year } => {
                let Some(p) = printing else { return Tri::PrintingDep };
                let Some(date) = p.released_at_int.as_ref().map(|v| u32::from(*v)) else {
                    return Tri::Null; // missing date: SQL NULL
                };
                let card_year = (date / 10_000) as i32;
                tri_bool(match op {
                    CmpOp::Eq => card_year == *year,
                    CmpOp::Ne => card_year != *year,
                    CmpOp::Gt => card_year > *year,
                    CmpOp::Lt => card_year < *year,
                    CmpOp::Ge => card_year >= *year,
                    CmpOp::Le => card_year <= *year,
                })
            }
        }
    }
}

// ─── Building FilterExpr from JSON ───────────────────────────────────────────

fn str_op_to_cmp(s: &str) -> Result<CmpOp, String> {
    match s {
        "=" | ":" => Ok(CmpOp::Eq),
        "!="      => Ok(CmpOp::Ne),
        "<"       => Ok(CmpOp::Lt),
        "<="      => Ok(CmpOp::Le),
        ">"       => Ok(CmpOp::Gt),
        ">="      => Ok(CmpOp::Ge),
        _ => Err(format!("unknown operator: {s}")),
    }
}

/// `=` IS `:` ON A COLLECTION COLUMN — set EQUALITY is not a meaning Scryfall gives it.
///
/// Measured on api.scryfall.com 2026-08-16, every collection column this feeds, `X=v` against
/// `X:v` on the same corpus — identical on every row:
///
///   kw=flying e:khm      28 = kw:flying 28        (this answered 9: cards whose ONLY keyword is
///                                                  Flying — set equality, which nothing asks for)
///   otag=ramp e:khm      35 = otag:ramp 35        (this answered 0)
///   atag=forest e:khm    17 = atag:forest 17      (this answered 0)
///   is=foil e:khm t:cre  129 = is:foil 129        (this answered 0)
///   frame=2015 …         151 = frame:2015 151     (this answered 99)
///
/// The boundary is real and lies elsewhere, not on this function: the columns where `=` DOES
/// differ from `:` are the set-valued COLOR ones, and they go through `op_to_color_cmp`, which
/// keeps `Eq` — `c=rg e:khm t:creature` is 1 against `c:rg`'s 2, `id=rg` is 1 against `id:rg`'s
/// 52, `produces=rg` is 0 against `produces:rg`'s 5. Mana keeps it too (`m={2}` 0 against
/// `m:{2}`'s 102). Probed in both directions before this changed.
///
/// The other operators are unaffected and already agree: `kw>=flying`, `kw>flying`, `kw<flying`
/// and `kw!=flying` are each 404 on Scryfall and 404 here.
///
/// TypeCmp also reads this, but cannot observe the change: `card_types` with `=` is claimed by
/// the TypeLineContains branch above for every non-empty needle, so the only `=` that reaches
/// TypeCmp carries an empty value, which no query produces.
fn op_to_collection_cmp(op: &str) -> CmpOp {
    match op {
        ":" | ">=" | "=" => CmpOp::Ge,
        ">"        => CmpOp::Gt,
        "<="       => CmpOp::Le,
        "<"        => CmpOp::Lt,
        "!="       => CmpOp::Ne,
        _          => CmpOp::Ge,
    }
}

fn op_to_color_cmp(op: &str) -> CmpOp {
    match op {
        ":" | ">=" => CmpOp::Ge,
        "="        => CmpOp::Eq,
        "<="       => CmpOp::Le,
        "<"        => CmpOp::Lt,
        ">"        => CmpOp::Gt,
        "!="       => CmpOp::Ne,
        _          => CmpOp::Ge,
    }
}

fn build_num_expr(v: &Value) -> Result<NumExpr, String> {
    let node_type = v["node_type"].as_str().unwrap_or("");
    let kw = &v["kwargs"];
    match node_type {
        "NumericValueNode" => {
            let val = kw["value"].as_f64().ok_or("NumericValueNode missing value")?;
            Ok(NumExpr::Const(val))
        }
        "CardAttributeNode" => {
            let attr = kw["attribute_name"].as_str().unwrap_or("");
            attr_to_num_field(attr)
                .map(NumExpr::Field)
                .ok_or_else(|| format!("unknown numeric field: {attr}"))
        }
        "CardBinaryOperatorNode" => {
            let op_str = kw["op"].as_str().unwrap_or("");
            let arith_op = match op_str {
                "+" => ArithOp::Add,
                "-" => ArithOp::Sub,
                "*" => ArithOp::Mul,
                "/" => ArithOp::Div,
                _ => return Err(format!("expected arithmetic op, got: {op_str}")),
            };
            let lhs = build_num_expr(&kw["lhs"])?;
            let rhs = build_num_expr(&kw["rhs"])?;
            Ok(NumExpr::Arith(Box::new(lhs), arith_op, Box::new(rhs)))
        }
        _ => Err(format!("unexpected node in numeric expr: {node_type}")),
    }
}

pub(crate) fn build_filter(v: &Value) -> Result<FilterExpr, String> {
    let node_type = v["node_type"].as_str().unwrap_or("");
    let kw = &v["kwargs"];

    match node_type {
        "TrueNode" => Ok(FilterExpr::True),

        "AndNode" => {
            let operands = kw["operands"]
                .as_array()
                .ok_or("AndNode missing operands")?
                .iter()
                .map(build_filter)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(FilterExpr::And(operands))
        }

        "OrNode" => {
            let operands = kw["operands"]
                .as_array()
                .ok_or("OrNode missing operands")?
                .iter()
                .map(build_filter)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(FilterExpr::Or(operands))
        }

        "NotNode" => {
            let inner = build_filter(&kw["operand"])?;
            Ok(FilterExpr::Not(Box::new(inner)))
        }

        "ExactNameNode" => {
            let value = kw["value"].as_str().unwrap_or("").to_string();
            Ok(FilterExpr::ExactName(value))
        }

        "CardBinaryOperatorNode" => build_binary(kw),

        _ => Err(format!("unexpected top-level node type: {node_type}")),
    }
}

fn build_binary(kw: &Value) -> Result<FilterExpr, String> {
    let op = kw["op"].as_str().unwrap_or(":");
    let lhs = &kw["lhs"];
    let rhs = &kw["rhs"];

    let lhs_type = lhs["node_type"].as_str().unwrap_or("");
    let lhs_kw   = &lhs["kwargs"];

    if lhs_type != "CardAttributeNode" {
        let lhs_expr = build_num_expr(lhs)?;
        let rhs_expr = build_num_expr(rhs)?;
        let cmp_op   = str_op_to_cmp(op)?;
        return Ok(FilterExpr::NumericCmp { lhs: lhs_expr, op: cmp_op, rhs: rhs_expr });
    }

    let attr = lhs_kw["attribute_name"].as_str().unwrap_or("");
    let orig = lhs_kw["original_attribute"].as_str().unwrap_or("");

    if let Some(num_field) = attr_to_num_field(attr) {
        let cmp_op   = str_op_to_cmp(op)?;
        let rhs_expr = build_num_expr(rhs)?;
        return Ok(FilterExpr::NumericCmp { lhs: NumExpr::Field(num_field), op: cmp_op, rhs: rhs_expr });
    }

    // A regex rhs is a text predicate whatever attribute it names, so it routes
    // here rather than falling into the attribute branches below. Those all
    // read their value with `rhs.as_array()`, which is `None` for a
    // RegexValueNode: `t:/dragon/` used to fold an empty array into
    // `TypeCmp { mask: 0, op: Ge }`, and `bits & 0 != 0` is false for every
    // card — a silent empty result, not a decline, so the SQL fallback never
    // saw it either. The SQL path answers the same query with
    // `type_line ~* 'dragon'`.
    if rhs["node_type"].as_str() == Some("RegexValueNode") {
        return build_text_filter(attr, op, rhs, orig);
    }

    if attr == "released_at" {
        let val_str = rhs_value_str(rhs);
        if orig == "year" {
            let year: i32 = val_str.parse().map_err(|_| format!("bad year: {val_str}"))?;
            let cmp_op = str_op_to_cmp(op)?;
            return Ok(FilterExpr::YearCmp { op: cmp_op, year });
        }
        let cmp_op = str_op_to_cmp(op)?;
        // A PARTIAL DATE IS A RANGE, NOT A POINT. `date:2021` means "released in 2021", and every
        // operator reads off the ends of that window rather than off one padded value.
        //
        // The zero-padding this replaced (`"2021"` → 20210000) is the START of the window, which
        // is the right bound for exactly two of the six operators and wrong for the other four.
        // Measured on api.scryfall.com 2026-08-16 over the whole default corpus, `date:<year>`
        // against `year:<year>` — the same column under its other spelling — agreeing on all seven
        // spellings, where the padded reading agreed on three:
        //
        //             Scryfall  padded reading answered
        //   date:2021     3,834  0        (= released_at == 2021-01-01)
        //   date=2021     3,834  0
        //   date<2021    20,966  20,966   ✓ start of window is correct for <
        //   date<=2021   22,888  20,966   (answered date<2021)
        //   date>2021    18,639  20,086   (answered date>=2021)
        //   date>=2021   20,086  20,086   ✓ start of window is correct for >=
        //   date!=2021   32,774  33,599   (the whole corpus — nothing was ever equal)
        //
        // `year:` was right all along because YearCmp compares the extracted year; only the `date`
        // spelling took the padded path. Month precision is the same rule one level down:
        // `date:2021-02` is 504 and equals `date>=2021-02 date<2021-03`, and `date>=2021-02` is
        // 20,085 — one fewer than `date>=2021`, the card released in January.
        //
        // Composed from the existing leaf rather than given a new node shape: `And`/`Not` already
        // narrow, estimate and complement correctly for DateCmp (see date_range_bounds), and a
        // {lo,hi} DateCmp would have had to be threaded through the narrower, the estimator, the
        // cost model, the fuzz corpus and three benches to say the same thing.
        let digits: String = val_str.chars().filter(|c| c.is_ascii_digit()).collect();
        let n: u32 = digits.parse().map_err(|_| format!("bad date: {val_str}"))?;
        // yyyy, yyyymm, yyyymmdd — the three precisions the parser emits. 12-31 and day 31 are
        // upper bounds rather than real calendar ends: no stored date exceeds them, and using the
        // true month length would buy nothing but a leap-year table.
        let (lo, hi) = match digits.len() {
            4 => (n * 10_000 + 101, n * 10_000 + 1231),
            6 => (n * 100 + 1, n * 100 + 31),
            8 => (n, n),
            _ => return Err(format!("bad date: {val_str}")),
        };
        let within = || FilterExpr::And(vec![
            FilterExpr::DateCmp { op: CmpOp::Ge, value: lo },
            FilterExpr::DateCmp { op: CmpOp::Le, value: hi },
        ]);
        return Ok(match cmp_op {
            CmpOp::Lt => FilterExpr::DateCmp { op: CmpOp::Lt, value: lo },
            CmpOp::Ge => FilterExpr::DateCmp { op: CmpOp::Ge, value: lo },
            CmpOp::Le => FilterExpr::DateCmp { op: CmpOp::Le, value: hi },
            CmpOp::Gt => FilterExpr::DateCmp { op: CmpOp::Gt, value: hi },
            // A full date is its own window, and the single leaf keeps SQL's three-valued answer
            // for a printing with no release date: `Not(Null)` is `Null`, so the composed form
            // agrees, but the leaf is what the narrower and the fuzz corpus already exercise.
            CmpOp::Eq if lo == hi => FilterExpr::DateCmp { op: CmpOp::Eq, value: lo },
            CmpOp::Ne if lo == hi => FilterExpr::DateCmp { op: CmpOp::Ne, value: lo },
            CmpOp::Eq => within(),
            CmpOp::Ne => FilterExpr::Not(Box::new(within())),
        });
    }

    if attr == "mana_cost_jsonb" {
        let mana_str = rhs_value_str(rhs);
        let mut core = 0u64;
        let mut hybrids: Vec<(String, u8)> = Vec::new();
        for (sym, n) in mana_pip_counts(mana_str) {
            match mana_lane(&sym) {
                Some(lane) => core = lane_add(core, lane, n),
                None => hybrids.push((sym, n)),
            }
        }
        hybrids.sort_unstable();
        // Until bind() resolves them against the store's vocab, hybrid
        // symbols count as unknown — one merged entry no card can match.
        let hybrid_ids = if hybrids.is_empty() { Vec::new() } else { vec![(MANA_SYM_UNKNOWN, 1)] };
        // The TRUE cmc of the query cost, which is what `generic_of` subtracts the pips from.
        // `mana_cmc` reads braces and bare letters but skips loose digits, so the shorthand forms
        // the parser passes through verbatim — `m:2` as "2", `m>=2WW` as "2WW", `m:1{r}1` as
        // "1{R}1" — arrived carrying none of their generic. `m:2` is the case that shows it: an
        // empty cost with cmc 0 is a tautology, and this answered all 151 of `e:khm t:creature`
        // where Scryfall answers 102, the same 102 as `m:{2}`.
        let cmc = mana_cmc(mana_str) + mana_bare_generic(mana_str) as f32;
        let cmp_op = match op { ":" => CmpOp::Ge, _ => str_op_to_cmp(op)? };
        return Ok(FilterExpr::ManaCostCmp { op: cmp_op, core, hybrids, hybrid_ids, hybrid_cmc: Vec::new(), cmc });
    }

    if attr == "devotion" {
        let mana_str = rhs_value_str(rhs);
        // Split hybrid symbols ({R/G} -> R:1, G:1) and keep only the WUBRGC
        // lanes, matching calculate_devotion() in SQL (which counts only
        // color characters). mana_pip_counts is NOT used lane-directly
        // because it keeps hybrids as single keys.
        let mut pips = 0u64;
        for (sym, n) in mana_pip_counts(mana_str) {
            if sym.contains('/') {
                for part in sym.split('/') {
                    if let Some(lane) = mana_lane(part).filter(|&l| l < 6) {
                        pips = lane_add(pips, lane, n);
                    }
                }
            } else if let Some(lane) = mana_lane(&sym).filter(|&l| l < 6) {
                pips = lane_add(pips, lane, n);
            }
        }
        let cmp_op = match op { ":" => CmpOp::Ge, _ => str_op_to_cmp(op)? };
        return Ok(FilterExpr::Devotion { op: cmp_op, pips, hybrid_colors: Vec::new() });
    }

    if matches!(attr, "card_colors" | "card_color_identity" | "produced_mana") {
        let color_field = match attr {
            "card_colors"          => ColorField::Colors,
            "card_color_identity"  => ColorField::ColorIdentity,
            _                      => ColorField::ProducedMana,
        };
        // Scryfall numeric color syntax (id>=3, c=2): the rhs arrives as a raw
        // NumericValueNode instead of a color-letter list, and compares the
        // NUMBER of colors in the field. ":" behaves like "=" here (verified
        // against the live Scryfall API: id:2 and id=2 return identical sets),
        // which is exactly what str_op_to_cmp yields.
        // produced_mana counts here too, over SIX values rather than five — see
        // the ColorCountCmp eval arm.
        if rhs["node_type"].as_str() == Some("NumericValueNode") {
            let count = rhs["kwargs"]["value"].as_f64().ok_or("NumericValueNode missing value")? as u8;
            return Ok(FilterExpr::ColorCountCmp { field: color_field, op: str_op_to_cmp(op)?, count });
        }
        let color_strs: Vec<&str> = rhs
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();
        let mask = color_list_to_mask(&color_strs);
        // id:/identity: means "card's identity is a subset of query colors" (Le), not superset (Ge)
        let cmp_op = if attr == "card_color_identity" && op == ":" {
            CmpOp::Le
        } else {
            op_to_color_cmp(op)
        };
        return Ok(FilterExpr::ColorCmp { field: color_field, op: cmp_op, mask });
    }

    if attr == "card_legalities" {
        let format = rhs
            .as_array()
            .and_then(|a| a.first())
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let expected = match orig {
            "format" | "f" | "legal" => LEGALITY_LEGAL,
            "banned"                 => LEGALITY_BANNED,
            "restricted"             => LEGALITY_RESTRICTED,
            _                        => LEGALITY_LEGAL,
        };
        return Ok(FilterExpr::Legality { shift: format_shift(format), expected });
    }

    // A `t:` VALUE IS A SUBSTRING OF THE PRINTED TYPE LINE — *unless* it NAMES A TYPE, and then it
    // is anchored to the type word. Both halves are measured; see `CANONICAL_TYPE_NAMES` for the
    // anchored half and its catalog.
    //
    // The substring half, MEASURED against api.scryfall.com on 2026-08-16 over `e:khm` (323 prints)
    // and not guessed:
    //
    //   t:creature 151   t:creat 151   t:reature 151   t:eatur 151   -> unanchored on both sides
    //   t:snow 47        t:no 47                                     -> "no" inside "Snow"
    //   t:elf 22         t:lf 25                                     -> "lf" also inside "Wolf"
    //   t:CREAT 39 = t:Creat 39 = t:creat 39 (with cmc<=2)           -> case-insensitive
    //   t:legend 42 = t:legendary 42                                 -> supertypes are in the line
    //   t:— 227 = t:"—" 227                                          -> the em dash is ordinary text
    //   t:"// creature" 182, t:"creature //" 0                       -> the " // " face join is too
    //   -t:creat 172, and 151 + 172 = 323                            -> negation is a plain complement
    //   t=creature 151 = t:creature, t="legendary creature" 32       -> `=` is the same substring
    //   t:artifactcreature 0, t:"artifact creature" 360              -> not a token-set test
    //
    // and for a phrase, whitespace runs collapse (`t:"artifact  creature"` is the same query),
    // order matters (`t:"creature artifact"` is empty) and it is not word-anchored either
    // (`t:"tifact creat"` returns the same 360).
    //
    // Everything above is one rule — case-insensitive substring of the whole type line — so this
    // compiles single tokens and phrases identically, as a regex over the escaped literal. The
    // regex is not for its own sake: `bind()` rewrites EVERY TypeLine regex (this one and the
    // user's own `t:/…/`) into a `TypeLineMatch` by running it over the ~1,519 distinct type lines
    // in the corpus, which is both the case folding and the narrowing. See `TypeLineIndex`.
    //
    // WHAT THE SUBSTRING RULE ALONE GETS WRONG, and it is not an edge: `t:god` answers 96 on
    // api.scryfall.com and answered 104 here, the 8 extra being every **Demigod** in the corpus.
    // The needle that names a type is matched against the type WORD.
    //
    // WHICH OPERATORS. `:` and `>=` are containment and `=` is measurably the same substring test
    // on Scryfall (`t=creature` 151, `t="legendary creature"` 32 — set equality would answer 0
    // there, since no card's type array is exactly ["Creature"] once subtypes exist). `<`, `<=`
    // and `>` keep upstream's set-comparison meaning: Scryfall has no answer to compare against
    // (`t>=creature` returns zero rows there), so there is nothing to follow.
    //
    // `!=` DOES have an answer, and it is the empty set: `t!=creature` is 404 on Scryfall, exactly
    // as `name!=bolt`, `o!="draw a card"`, `a!="rebecca guay"` and `set!=khm` are — the same rule
    // build_text_filter applies to every other string column, and the same reason (a superset is
    // the one wrong answer a client cannot see past). Measured 2026-08-16.
    if matches!(attr, "card_types" | "card_subtypes") && op == "!=" {
        return Ok(FilterExpr::Not(Box::new(FilterExpr::True)));
    }
    if matches!(attr, "card_types" | "card_subtypes") && matches!(op, ":" | ">=" | "=") {
        let raw = rhs.as_array().and_then(|a| a.first()).and_then(|v| v.as_str()).unwrap_or("");
        let needle = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        if !needle.is_empty() {
            // `æ` expands here too: `t:"æ"` and `t:"ae"` both answer 213 on Scryfall. See
            // `crate::fold_ae` — the type line is one of the columns that folds THAT letter and
            // no other (`t:œ`, `t:ø`, `t:ß`, `t:þ`, `t:đ` and `t:ł` are each 404 there).
            let needle = crate::fold_ae(&needle.to_lowercase());
            let whole_word = is_canonical_type_name(&needle);
            return Ok(FilterExpr::TypeLineContains { needle, whole_word });
        }
    }

    if attr == "card_types" {
        let mask: u16 = rhs
            .as_array()
            .map(|a| a.iter().fold(0u16, |acc, v| acc | card_type_str_to_bit(v.as_str().unwrap_or(""))))
            .unwrap_or(0);
        return Ok(FilterExpr::TypeCmp { mask, op: op_to_collection_cmp(op) });
    }

    if attr == "card_lang" {
        // Equality only, plus the `any` widener — the same surface upstream's parser grants
        // `lang:` (string-order comparisons error there like on the other string columns, so a
        // non-equality op reaching here is defense in depth, not a reachable path).
        if !matches!(op, ":" | "=") {
            return Err(format!("operator {op:?} is not supported on lang"));
        }
        let value = rhs_value_str(rhs).to_lowercase();
        let any = value == "any";
        return Ok(FilterExpr::LangMatch { value, vid: None, any });
    }

    if attr == "card_set_type" {
        // Equality only, the surface upstream's parser grants `st:` — same as `lang:`, and for the
        // same reason: it is a string column, and ordered comparisons on those error in the parser.
        if !matches!(op, ":" | "=") {
            return Err(format!("operator {op:?} is not supported on set_type"));
        }
        // Scryfall spells the set types with underscores (`draft_innovation`, `duel_deck`) and
        // accepts the hyphenated form too; the stored value is Scryfall's own, lowercased.
        let value = rhs_value_str(rhs).to_lowercase().replace('-', "_");
        return Ok(FilterExpr::SetTypeMatch { value, vid: None });
    }

    if attr == "oracle_id" {
        // Equality only, the surface upstream's parser grants `oracleid:` (string-order
        // comparisons parse there like on the other string columns, so a non-equality op reaching
        // here is defense in depth, not a reachable path). parse_uuid_or_hash folds hex case, so
        // an uppercase uuid — the parser hands the value on unchanged — resolves the same id.
        if !matches!(op, ":" | "=") {
            return Err(format!("operator {op:?} is not supported on oracle_id"));
        }
        return Ok(FilterExpr::OracleIdMatch { id: super::parse_uuid_or_hash(rhs_value_str(rhs)) });
    }

    if attr == "card_subtypes" {
        let value = rhs.as_array().and_then(|a| a.first()).and_then(|v| v.as_str()).unwrap_or("").to_string();
        return Ok(FilterExpr::CollectionCmp { field: CollField::Subtypes, op: op_to_collection_cmp(op), value, value_id: None });
    }

    if attr == "card_keywords" {
        let value  = rhs.as_array().and_then(|a| a.first()).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let cmp_op = op_to_collection_cmp(op);
        return Ok(FilterExpr::CollectionCmp { field: CollField::Keywords, op: cmp_op, value, value_id: None });
    }

    if matches!(attr, "card_oracle_tags" | "card_art_tags" | "card_is_tags" | "card_frame_data") {
        let coll_field = match attr {
            "card_oracle_tags" => CollField::OracleTags,
            "card_art_tags"    => CollField::ArtTags,
            "card_is_tags"     => CollField::IsTags,
            _                  => CollField::FrameData,
        };
        let value  = rhs.as_array().and_then(|a| a.first()).and_then(|v| v.as_str()).unwrap_or("").to_string();
        // Four `is:` values the importer stores no tag for, because fields already on the row
        // answer them (see `rewrite.ENGINE_IS_VALUES`, which is what keeps the parser from
        // reporting them unsupported). They arrive as `card_is_tags` membership like every other
        // `is:` value and turn into their own leaf HERE rather than in the parser, so the tag
        // vocabulary stays what the importer writes and nothing has to be stored twice.
        if matches!(coll_field, CollField::IsTags) {
            match value.as_str() {
                "localizedname" => return Ok(FilterExpr::PrintedNamePresent),
                "flavorname" => return Ok(FilterExpr::FlavorNamePresent),
                "unique" => return Ok(FilterExpr::SingleSet),
                "vanilla" => return Ok(FilterExpr::VanillaFace),
                _ => {}
            }
        }
        let cmp_op = op_to_collection_cmp(op);
        return Ok(FilterExpr::CollectionCmp { field: coll_field, op: cmp_op, value, value_id: None });
    }

    build_text_filter(attr, op, rhs, orig)
}

/// Does `!"needle"` name this card? `stored` is the card's FOLDED name, `needle` the query's own
/// collated spelling (`collate_name(fold_accents(value.lower()))`, done in Python).
///
/// COLLATED on both sides — diacritics folded, every non-alphanumeric character removed — which
/// is how Scryfall compares it. Measured on api.scryfall.com 2026-08-16, all four of
/// `!"Lim-Dûl's Vault"`, `!"lim-dul's vault"`, `!"limduls vault"` and `!"Lim-Dul's Vault"` answer
/// the same one card, and `!"eowyn, lady of rohan"` answers "Éowyn, Lady of Rohan". Comparing
/// `card_name_lower` — what this did before — answered only the accented, fully punctuated
/// spelling, so a searcher who typed the name off the card and skipped the circumflex got
/// nothing.
///
/// The faces are split BEFORE collating, because the `" // "` join is itself non-alphanumeric:
/// collapsing first would make every face boundary vanish and let a needle straddle it.
///
/// The whole name, or — when the name has EXACTLY TWO halves — either side of the `" // "` join.
/// A two-faced card answers to each of its face names on its own. Measured against
/// api.scryfall.com on 2026-08-16: `!"Lightning Bolt"` returns two cards, `Lightning Bolt` and
/// `Emeritus of Conflict // Lightning Bolt` (sos/113), whose *second* face carries the name;
/// `!"Fire"` returns `Fire // Ice`, `!"Stomp"` returns `Bonecrusher Giant // Stomp`,
/// `!"Insectile Aberration"` returns `Delver of Secrets // Insectile Aberration`. Comparing only
/// the joined name found the first of those and missed all the rest.
///
/// TWO, and not "any part". `split(" // ")` yields every part, so a longer name answered to each
/// of its own — measured on api.scryfall.com 2026-08-31, `include_extras=true` throughout because
/// und/75 is extras-gated: `!"Who"` answers 0 there and answered 1 here, `!"What"` answers 0 there
/// and answered 1 here, both of them `Who // What // When // Where // Why`, the one printed name
/// with more than two parts. Its whole name stays a key —
/// `!"Who // What // When // Where // Why"` answers 1 on both sides. Nothing two-halved moves:
/// `!"Stomp"` answers 1 on both, `!"Fire"` answers 2 on both (`Fire // Ice` and `Start // Fire`),
/// and the joined name of a two-half card is a key as well
/// (`!"Curse of the Fire Penguin // Curse of the Fire Penguin Creature"`, 1 on both). The
/// collation is untouched: `!"limduls vault"` still answers `Lim-Dûl's Vault`, 1 on both.
///
/// This is the `!` SEARCH operator and nothing else. `/cards/named?exact=` deliberately answers on
/// ORACLE names alone (see `core_api::name_key_tier` and the route's own note) — the two
/// surfaces share a rule shape, not a scope, and conflating them would widen a route Scryfall keeps
/// narrow.
pub(crate) fn exact_name_matches(stored: &str, needle: &str) -> bool {
    if crate::collate_name(stored) == needle {
        return true;
    }
    // `split_once` and then a reject, rather than `split(...).any(...)`: the face keys exist only
    // for a name that is exactly two halves, and a third part means there are none.
    let Some((front, back)) = stored.split_once(" // ") else { return false };
    if back.contains(" // ") {
        return false;
    }
    crate::collate_name(front) == needle || crate::collate_name(back) == needle
}

fn rhs_value_str(rhs: &Value) -> &str {
    rhs["kwargs"]["value"].as_str().unwrap_or("")
}

/// Whether a byte can be part of a type WORD, for `type_word_match`.
///
/// The type line's own punctuation is what separates one type from the next: a space, the em dash
/// before the subtypes, the ` // ` face join, and the comma and question mark two joke type lines
/// print. Everything else BINDS — and the three that bind are exactly the three the catalog spells
/// inside a name: the hyphen (`Assembly-Worker`, `Power-Plant`), the apostrophe (`Urza's`,
/// `C'tan`, `Shi'ar`) and the period (`B.O.B.`). Binding them is not cosmetic: it is what keeps
/// `t:worker` off `Assembly-Worker` and `t:bolas` off the plane `Bolas's Meditation Realm`, which
/// is what Scryfall answers, because neither type ARRAY holds the shorter name.
fn type_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'\'' || b == b'-' || b == b'.'
}

/// Whether `needle` occurs in `line` bounded by type-word boundaries on both sides.
///
/// Every occurrence is tried, not just the leftmost: `t:warrior` has to match `Demigod Warrior`,
/// whose first `warrior`-bearing position is the anchored one only because the earlier candidate
/// does not exist — reverse the pair (`Warrior Demigod` against `t:god`) and the leftmost hit is
/// the one that must be rejected.
fn type_word_match(line: &[u8], finder: &memmem::Finder<'_>, needle_len: usize) -> bool {
    let mut base = 0usize;
    while let Some(rel) = finder.find(&line[base..]) {
        let start = base + rel;
        let end = start + needle_len;
        let before_ok = start == 0 || !type_word_byte(line[start - 1]);
        let after_ok = end >= line.len() || !type_word_byte(line[end]);
        if before_ok && after_ok {
            return true;
        }
        base = start + 1;
        if base >= line.len() {
            break;
        }
    }
    false
}

/// One `t:` needle against one ALREADY-LOWERCASED type line, for the callers that have no
/// prebuilt `Finder` to reuse — the per-card fallback in `tri` and the tests. `bind_type_lines`
/// deliberately does not come through here: it builds the finder once for the whole vocab scan.
pub(crate) fn type_line_hit(lower: &str, needle: &str, whole_word: bool) -> bool {
    if whole_word {
        type_word_match(lower.as_bytes(), &memmem::Finder::new(needle.as_bytes()), needle.len())
    } else {
        lower.contains(needle)
    }
}

/// Whether a `t:` needle NAMES A TYPE, in which case it matches the type word rather than any
/// substring of the printed line.
///
/// `CANONICAL_TYPE_NAMES` is the union of the nine type catalogs api.scryfall.com publishes —
/// `/catalog/supertypes`, `card-types`, `artifact-types`, `battle-types`, `creature-types`,
/// `enchantment-types`, `land-types`, `planeswalker-types` and `spell-types` — fetched 2026-08-17,
/// lowercased and sorted. 531 names.
///
/// THE CATALOGS ARE THE RULE, not "any word on a type line", and that distinction is measured
/// rather than assumed. Every probe below is api.scryfall.com against this store on the same day:
///
/// ```text
///   t:god     96 vs 104   ANCHORED   the 8 extra were every Demigod
///   t:ape     45 vs 273   ANCHORED   "ape" also sits inside Shapeshifter and Spellshaper
///   t:bat     54 vs  92   ANCHORED   and inside Wombat and Incubator
///   t:ir    1906 = 1906   SUBSTRING  `Plane — Ir` is a real type line, and "Ir" is in no catalog
///   t:las     43 =   43   SUBSTRING  `Plane — Las Vegas` likewise; Scryfall still matches Bolas
///   t:art   4171 = 4171   SUBSTRING  `Creature — Art Lizard` likewise; Artifact still matches
/// ```
///
/// The three SUBSTRING rows are the reason this is a fixed catalog and not a vocabulary derived
/// from the corpus's own type lines: plane types are printed, are not published in any catalog,
/// and Scryfall does NOT anchor on them. A corpus-derived vocabulary would have anchored `t:ir`
/// and answered 0 where Scryfall answers 1,906.
///
/// WHAT IT STILL CANNOT DO. Scryfall matches the type ARRAY, which holds subtypes it never prints:
/// `t:warrior` is 1,298 there against the printed line's 1,294, because `Burakos, Party Leader`
/// answers to all four party classes while its `type_line` reads `Legendary Creature — Orc` on
/// both sides. That residual is not derivable from any published field and is one card per party
/// class.
///
/// A catalog is a SNAPSHOT: a creature type printed after the date above matches as a substring
/// until this list is refreshed, which is the safe direction — the pre-fix behaviour, not a miss.
fn is_canonical_type_name(needle: &str) -> bool {
    CANONICAL_TYPE_NAMES.binary_search(&needle).is_ok()
}

/// The catalog itself, for the test that asserts its shape.
#[cfg(test)]
pub(crate) fn canonical_type_names() -> &'static [&'static str] {
    &CANONICAL_TYPE_NAMES
}

const CANONICAL_TYPE_NAMES: [&str; 531] = [
    "abian", "adventure", "advisor", "aetherborn", "ajani", "alien", "ally", "aminatou", "andorian", "angel",
    "angrath", "antelope", "ape", "arcane", "archer", "archon", "arlinn", "armadillo", "army", "artifact",
    "artificer", "arzakon", "ashiok", "assassin", "assembly-worker", "astartes", "atog", "attraction", "aura",
    "aurochs", "automaton", "avatar", "azra", "b.o.b.", "background", "badger", "bahamut", "balloon", "barbarian",
    "bard", "basic", "basilisk", "basri", "bat", "battle", "bear", "beast", "beaver", "beeble", "beholder",
    "berserker", "bird", "bison", "blinkmoth", "blood", "boar", "bobblehead", "bolas", "book", "borg", "boss",
    "brainiac", "bringer", "brushwagg", "c'tan", "caitian", "calix", "camarid", "camel", "capybara", "caribou",
    "carrier", "cartouche", "case", "cat", "cave", "centaur", "chandra", "chicken", "child", "chimera", "chorus",
    "citizen", "class", "cleric", "cloud", "clown", "clue", "cockatrice", "comet", "conspiracy", "construct",
    "contraption", "coward", "coyote", "crab", "creature", "crocodile", "curse", "custodes", "cyberman", "cyclops",
    "dack", "dakkon", "dalek", "daretti", "dauthi", "davriel", "deb", "dellian", "demigod", "demon", "desert",
    "deserter", "detective", "devil", "dihada", "dinosaur", "djinn", "doctor", "dog", "domri", "dovin", "dragon",
    "drake", "dreadnought", "drix", "drone", "druid", "dryad", "duck", "dungeon", "dwarf", "dyfed", "echidna",
    "efreet", "egg", "elder", "eldrazi", "elemental", "elephant", "elf", "elite", "elk", "ellywick", "elminster",
    "elspeth", "emblem", "employee", "enchantment", "equipment", "ersta", "estrid", "eternal", "event", "eye",
    "faerie", "feroz", "ferret", "fish", "flagbearer", "food", "forest", "fortification", "fox", "fractal",
    "freyalise", "frog", "fungus", "gamer", "gamma", "gargoyle", "garruk", "gate", "germ", "giant", "gideon",
    "giraffe", "gith", "glimmer", "gnoll", "gnome", "goat", "goblin", "god", "gold", "golem", "gorgon", "gorn",
    "graveborn", "greensleeves", "gremlin", "griffin", "grist", "guest", "guff", "hag", "halfling", "hamster",
    "harpy", "head", "hedgehog", "hellion", "hero", "hippo", "hippogriff", "homarid", "homunculus", "horror",
    "horse", "huatli", "human", "hydra", "hyena", "illusion", "imp", "incarnation", "incubator", "infinity",
    "inhuman", "inkling", "inquisitor", "insect", "instant", "inzerva", "island", "jace", "jackal", "jared", "jaya",
    "jellyfish", "jeska", "juggernaut", "junk", "kaito", "kangaroo", "karn", "kasmina", "kavu", "kaya", "kelpien",
    "kindred", "kiora", "kirin", "kithkin", "klingon", "knight", "kobold", "kor", "koth", "kraken", "kree", "lair",
    "lamia", "lammasu", "land", "lanthanite", "leech", "legendary", "lemur", "lesson", "leviathan", "lhurgoyf",
    "licid", "liliana", "lizard", "llama", "lobster", "locus", "lolth", "lukka", "luxior", "manticore", "map",
    "master", "masticore", "mercenary", "merfolk", "metathran", "mine", "minion", "minotaur", "minsc", "mite",
    "mole", "monger", "mongoose", "monk", "monkey", "monopoly", "moogle", "moonfolk", "mordenkainen", "mount",
    "mountain", "mouse", "mutant", "myr", "mystic", "naga", "nahiri", "narset", "nautilus", "necron", "nephilim",
    "nightmare", "nightstalker", "niko", "ninja", "nissa", "nixilis", "noble", "noggle", "nomad", "nymph",
    "octopus", "officer", "ogre", "oko", "omen", "ongoing", "ooze", "orb", "orc", "orgg", "orion", "otter", "ouphe",
    "ox", "oyster", "pangolin", "peasant", "pegasus", "pentavite", "performer", "pest", "phelddagrif", "phenomenon",
    "phoenix", "phyrexian", "pilot", "pincher", "pirate", "plains", "plan", "plane", "planeswalker", "planet",
    "plant", "platypus", "porcupine", "possum", "power-plant", "powerstone", "praetor", "primarch", "prism",
    "processor", "q", "qu", "quintorius", "rabbit", "raccoon", "ral", "ranger", "rat", "rebel", "reflection",
    "reveler", "rhino", "rigger", "robot", "rogue", "role", "room", "rowan", "rukh", "rune", "sable", "saga",
    "saheeli", "salamander", "samurai", "samut", "sand", "saproling", "sarkhan", "satyr", "scarecrow", "scheme",
    "scientist", "scion", "scorpion", "scout", "sculpture", "seal", "serf", "serpent", "serra", "servo", "shade",
    "shaman", "shapeshifter", "shard", "shark", "sheep", "shi'ar", "shrine", "siege", "sifa", "siren", "sivitri",
    "skeleton", "skrull", "skunk", "slith", "sliver", "sloth", "slug", "snail", "snake", "snow", "soldier",
    "soltari", "sorcerer", "sorcery", "sorin", "spacecraft", "spawn", "specter", "spellshaper", "sphere", "sphinx",
    "spider", "spike", "spirit", "splinter", "sponge", "spy", "squid", "squirrel", "starfish", "stone", "surrakar",
    "survivor", "svega", "swamp", "symbiote", "synth", "szat", "talosian", "tamiyo", "tasha", "teddy", "teferi",
    "tellarite", "tentacle", "terminus", "tetravite", "teyo", "tezzeret", "thalakos", "tholian", "thomil",
    "thopter", "thrull", "tibalt", "tiefling", "time lord", "token", "tosk", "tower", "town", "toy", "trap",
    "treasure", "treefolk", "trilobite", "triskelavite", "troll", "turtle", "tyranid", "tyvar", "ugin", "unicorn",
    "urza", "urza's", "urzan", "utrom", "vampire", "vanguard", "varmint", "vedalken", "vehicle", "venser",
    "villain", "vivien", "volver", "vorta", "vraska", "vronos", "vulcan", "wall", "walrus", "wanderer", "warlock",
    "warrior", "weasel", "weird", "werewolf", "whale", "will", "windgrace", "wizard", "wolf", "wolverine", "wombat",
    "world", "worm", "worzel", "wraith", "wrenn", "wurm", "xenagos", "xindi", "yanggu", "yanling", "yeti", "zariel",
    "zombie", "zubera",
];

fn build_text_filter(attr: &str, op: &str, rhs: &Value, orig: &str) -> Result<FilterExpr, String> {
    let rhs_node_type = rhs["node_type"].as_str().unwrap_or("");
    // `fo:`/`fulloracle:` share `oracle_text`'s COLUMN — upstream's Postgres copy is the full
    // text, so the SQL path answers both from it and needs no second column — and are told
    // apart here by the spelling the user typed. Measured on api.scryfall.com 2026-08-16:
    // `fo:lifelink` 713 against `o:lifelink`'s stripped answer, `fo:draw e:khm` 57 against
    // `o:draw e:khm` 39, and `fo:` takes a regex like `o:` does (`fo:/\(this creature/` 1,098 —
    // a pattern that cannot match the stripped form at all).
    let full_oracle = attr == "oracle_text" && matches!(orig, "fo" | "fulloracle");

    if rhs_node_type == "RegexValueNode" {
        let pattern  = rhs["kwargs"]["value"].as_str().unwrap_or("");
        // Every field the store holds as a string can carry a regex: `~*`
        // applies to all of them on the SQL path, and restricting the engine to
        // the first four only sent the rest to that path as a decline. The
        // printing-scoped ones (set code, collector number, watermark) resolve
        // through the same StrVal::PDep path their exact-match twins use.
        let field = match attr {
            "card_name"        => TextField::NameLower,
            "oracle_text" if full_oracle => TextField::FullOracleTextLower,
            "oracle_text"      => TextField::OracleTextLower,
            "flavor_text"      => TextField::FlavorTextLower,
            "card_artist"      => TextField::ArtistLower,
            "card_set_code"    => TextField::SetCode,
            "card_layout"      => TextField::Layout,
            "card_border"      => TextField::Border,
            "card_watermark"   => TextField::Watermark,
            "collector_number" => TextField::CollectorNumber,
            // `t:/…/` matches against the printed type line, the same string
            // the SQL path's `type_line ~* …` reads — not the type/subtype
            // bitmasks `t:goblin` compiles to, which cannot answer a regex.
            "card_types" | "card_subtypes" => TextField::TypeLine,
            // `mana:/…/` IS A REGEX, and it runs against the printed cost STRING rather than
            // against the pip multiset every other spelling of this column compiles to. Measured
            // on api.scryfall.com 2026-08-28, with the rows a pip reading cannot produce:
            //
            //   mana:/^{2}/   400 "Invalid regular expression: quantifier operand invalid."
            //   mana:/}{/     26,815   every multi-symbol cost — a pure string artefact
            //   mana:/rr/        404   because "{R}{R}" has no "rr" in it
            //   mana:/2/       8,315   the CHARACTER, against mana:2's 19,692 generic reading
            //   mana:/^$/      1,350   the cards with no mana cost at all
            //   mana:/ /         435   = mana:/\/\// — a split cost is "{1}{R} // {1}{U}"
            //   mana:/^{r}$/     526   anchored, against mana:{r}'s 6,852
            //
            // NOT split per face, deliberately and unlike the oracle/flavor columns: the " // "
            // in this store's `mana_cost_text` is in SCRYFALL's haystack too, so splitting it
            // would invent a divergence — which is exactly what the 435 above measures, and it
            // covers the two-image layouts as well (`mana:/\/\// is:mdfc` is 40 of 100 there,
            // even though an MDFC's card object carries no top-level `mana_cost` at all). See
            // TextField::ManaCostText. `devotion` shares this parser class and is
            // absent on purpose: `devotion:/r/` is `Unknown regular expression keyword
            // “devotion”` there, and the parser never emits a pattern for it.
            "mana_cost_jsonb" => TextField::ManaCostText,
            _ => return Err(format!("regex not supported on {attr}")),
        };
        // `~` IS EXPANDED ON THE TEXT COLUMNS AND NOWHERE ELSE, which is why the field has to be
        // chosen before the pattern is compiled. `name:/~/` is 404 on api.scryfall.com
        // (2026-08-28) — if `~` were the card's name there it would be the whole corpus — and
        // `t:/~/` and `mana:/~/` are 404 too. On the three text columns it IS the alias:
        // `o:/~/` 19,228, `fo:/~/` 22,037, `ft:/~/` 2.
        let re = match field {
            TextField::OracleTextLower | TextField::FullOracleTextLower => {
                compile_search_regex_self_referential(pattern, SelfRefScope::Oracle)?
            }
            // FLAVOR IS NOT AN ORACLE COLUMN for this purpose, which took two measurements to
            // establish. `ft:/~/` is 2 on api.scryfall.com — a number small enough to read as an
            // alias answering thinly — and the two cards are Blighted Agent and Urabrask the
            // Hidden, whose Phyrexian-script flavor text carries a literal `~`; the plain
            // substring `ft:"~"` returns the same two. Expanding names here answered 680, and
            // expanding the phrase family answered 715.
            _ => compile_search_regex(pattern)?,
        };
        return Ok(FilterExpr::TextRegex { field, regex: re });
    }

    let raw_value = rhs["kwargs"]["value"].as_str().unwrap_or("");

    // `name!=x`, `o!=x`, `a!=x`, `set!=x` — Scryfall answers NOTHING, for every value and every
    // string column, and that is a statement about the OPERATOR rather than about the value.
    // Measured 2026-08-16: `name!="lightning bolt"` 404 where `name="lightning bolt"` answers 2,
    // `name!=bolt` 404 where `name=bolt` answers 41; `o!="draw a card"`, `a!="rebecca guay"`,
    // `t!=creature` and `set!=khm` all 404 — while the NUMERIC `cmc!=3` answers 25,522, so this is
    // not "`!=` is unsupported". It is the empty set, and it composes as one: `name!=ft or
    // t:creature` answers exactly `t:creature`'s 18,753 and `-name!=ft` answers the whole corpus.
    // This port answered a not-equal SUPERSET (33,751 for `name!=ft`), which is the one shape a
    // client cannot recover from — a filter that silently widens rather than narrows.
    if op == "!=" {
        return Ok(FilterExpr::Not(Box::new(FilterExpr::True)));
    }

    if matches!(attr, "card_set_code" | "card_layout" | "card_border" | "card_watermark" | "collector_number") {
        // collector_number_id is stored raw and mixed-case (e.g. "10E-105"); compare exactly,
        // matching the SQL path. The other four are lowercased at import, so lowercasing
        // the query value gives case-insensitive matching with a plain equality.
        let value = if attr == "collector_number" { raw_value.to_string() } else { raw_value.to_lowercase() };
        let cmp_op = str_op_to_cmp(op)?;
        let field = match attr {
            "card_set_code"    => TextField::SetCode,
            "card_layout"      => TextField::Layout,
            "card_border"      => TextField::Border,
            "card_watermark"   => TextField::Watermark,
            "collector_number" => TextField::CollectorNumber,
            _                  => unreachable!(),
        };
        return Ok(FilterExpr::TextExact { field, op: cmp_op, value });
    }

    let lower_word = raw_value.to_lowercase();
    // `=` IS `:` ON A TEXT COLUMN — a SUBSTRING test, not an equality, and not a member of the
    // comparison family the branch above answers with the empty set.
    //
    // This is the one operator on these columns that carries no information at all. Measured on
    // api.scryfall.com 2026-08-16, `X=v` against `X:v` over the whole default corpus:
    //
    //   o=flying    4,574 = o:flying 4,574      (this answered 99 — the cards whose ORACLE TEXT
    //                                            IS the word "flying", i.e. a real equality)
    //   ft=aether      80 = ft:aether 80        (this answered 0)
    //   name=ft     1,628 = name:ft 1,628       (this answered 0)
    //   fo=lifelink   713 = fo:lifelink 713
    //   a=rebecca     170 = a:rebecca 170       (already agreed — `bind` collapses every artist
    //                                            form onto one collated contains regardless)
    //
    // and the BARE/QUOTED split survives `=` intact rather than being flattened to one side of
    // it: `name="ft"` is 362 on Scryfall, exactly `name:"ft"`, against `name=ft`'s 1,628. That
    // distinction is carried by the node shape (`CollatedNameValueNode` vs `StringValueNode`), so
    // routing `=` here preserves it for free — the parser now builds the collated node for `=`
    // as well, which is the other half of this fix.
    //
    // WHAT IS NOT IN THIS CLASS, probed in both directions rather than assumed. `!=` is the empty
    // set (the branch above, unchanged). `<`, `<=`, `>`, `>=` keep the string-order comparison
    // they had; Scryfall answers 404 to all of them on every string column, which is what the
    // query-validation layer already reproduces. And `=` stays a genuine EQUALITY on the columns
    // that are stored exact rather than searched — set code, layout, border, watermark, collector
    // number — which is why those five are claimed by the branch above this one and never reach
    // here: `e=khm` is 151 and `layout=normal` is 284, agreeing with `:` because equality IS the
    // meaning there, not because the operator was rewritten.
    if matches!(op, ":" | "=") {
        let tsf = match attr {
            // `CollatedNameValueNode` is the parser's spelling of "the user typed a BARE word
            // here"; a `StringValueNode` under `name:` means they quoted it (or wrote a
            // plain-literal regex, which lowers to the same). The two are different searches —
            // see `TextSearchField::NameLower` / `NameCollated` for the live measurements.
            "card_name" if rhs_node_type == "CollatedNameValueNode" => TextSearchField::NameCollated,
            "card_name"   => TextSearchField::NameLower,
            "oracle_text" if full_oracle => TextSearchField::FullOracleTextLower,
            "oracle_text" => TextSearchField::OracleTextLower,
            "flavor_text" => TextSearchField::FlavorTextLower,
            // Same split as `card_name`: a bare word arrives as a CollatedNameValueNode and is
            // matched against the collated artist vocab, a quoted one stays literal.
            "card_artist" if rhs_node_type == "CollatedNameValueNode" => TextSearchField::ArtistCollated,
            "card_artist" => TextSearchField::ArtistLower,
            _ => return Err(format!("text substring not supported on {attr}")),
        };
        // `æ` expands, and ONLY in the text columns — see `crate::fold_ae` for the per-character
        // probe. The name and artist needles are already fully transliterated by the parser's
        // `fold_accents`, and a literal `name:"…"` deliberately keeps its spelling.
        let word = match tsf {
            TextSearchField::OracleTextLower
            | TextSearchField::FullOracleTextLower
            | TextSearchField::FlavorTextLower => crate::fold_ae(&lower_word),
            _ => lower_word,
        };
        return Ok(FilterExpr::TextContains { field: tsf, word });
    }

    let field = match attr {
        "card_name"   => TextField::NameLower,
        "oracle_text" if full_oracle => TextField::FullOracleTextLower,
        "oracle_text" => TextField::OracleTextLower,
        "flavor_text" => TextField::FlavorTextLower,
        "card_artist" => TextField::ArtistLower,
        _ => return Err(format!("unknown text field: {attr}")),
    };
    let cmp_op = str_op_to_cmp(op)?;
    let value = match field {
        TextField::OracleTextLower | TextField::FullOracleTextLower | TextField::FlavorTextLower => {
            crate::fold_ae(&raw_value.to_lowercase())
        }
        _ => raw_value.to_lowercase(),
    };
    Ok(FilterExpr::TextExact { field, op: cmp_op, value })
}
