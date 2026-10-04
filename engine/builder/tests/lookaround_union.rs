//! `A OR B` holds every card `A` holds, whatever `B` is — through the whole native pipeline:
//! Scryfall JSON → transform → finalize → store → query.
//!
//! The query is the one mtg-seeker reported on 2026-10-03:
//!
//!   (otag:lands-matter OR (o:/(?<!any )(number of|for each)[^.,\n]*\b(lands|…|Plains)\b|…/
//!        OR o:"land creatures you" OR o:"lands you control have"))
//!
//! It answered 696 cards where the tag ALONE answers 584 and api.scryfall.com answers 765: the
//! union was missing 50 cards the tag matches (Burgeoning, Lumra, Omnath, Blanchwood Armor, Mystic
//! Sanctuary among them) and 19 more only the regex matches — every one of them in ONE of the
//! eleven partitions, the one that holds Baldur's Gate Wilderness.
//!
//! WHAT HAPPENED. A lookaround takes the whole pattern off the linear engine and onto
//! `fancy_regex`'s backtracking VM, whose unanchored search spent a backtrack per alternative at
//! EVERY character of the text — over five per character for this pattern — against a budget of
//! 8,192 per card. Baldur's Gate Wilderness is a dungeon: 1,489 characters of rules text, twice
//! the longest card upstream's corpus holds (it imports no tokens), and the only SERVED card that
//! long. The budget ran out on it. Running out sets a flag that makes every later regex match
//! answer `false` and every later printing fail its residual, on the understanding that the query
//! is about to be REFUSED — and the pyo3 entry points do refuse it. The pure-Rust core this port
//! calls never read the flag, so the partition answered a page that simply stopped at that card.
//!
//! Two halves, both asserted here: the budget is spent only where the pattern could match (so
//! this query, and every lookaround like it, is answered), and a pattern that still exhausts it
//! is an ERROR — never a short page.

use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, EngineErrorKind, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

/// The five cards the report named, all tagged `lands-matter` on Scryfall (oracle_tags dump of
/// 2026-10-03) and all in the partition that went dark.
const TAGGED: &[(&str, &str)] = &[
    ("burgeoning_c16_143", "Burgeoning"),
    ("lumra_bellow_of_the_woods_blb_183", "Lumra, Bellow of the Woods"),
    ("omnath_locus_of_rage_ecc_129", "Omnath, Locus of Rage"),
    ("blanchwood_armor_fdn_213", "Blanchwood Armor"),
    ("mystic_sanctuary_soc_388", "Mystic Sanctuary"),
];

/// Everything else in the store. Baldur's Gate Wilderness is the card the budget ran out on;
/// Day Vs. Night is a minigame card (1,940 characters, an `is:extra`) that does the same to
/// `include_extras=true`. Karma and Worm Harvest match the regex and carry no tag; Scapeshift's
/// "any number of lands" is what the lookbehind is there to refuse.
const UNTAGGED: &[&str] = &[
    "baldurs_gate_wilderness_tclb_0",
    "day_vs_night_mmid_2",
    "karma_8ed_28",
    "worm_harvest_c18_194",
    "scapeshift_m19_201",
    "tiller_engine_dmc_20",
    "amulet_of_vigor_wwk_121",
    "bone_miser_c19_15",
    "llanowar_elves",
    "lightning_bolt",
    "seat_of_the_synod_mrd_283",
    "tarmogoyf_fra_116",
    "ferris_wheel_unf_210",
];

/// The reported pattern, verbatim.
const REPORTED: &str = r"(?<!any )(number of|for each)[^.,\n]*\b(lands|land cards|Forests|Islands|Swamps|Mountains|Plains)\b|for each land card|whenever[^,\n]*\bland[^,\n]*graveyard|lands than";

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn store() -> BufferStore {
    // One directory per CALL, not per process: the tests below run on parallel threads of one
    // process, and a shared directory lets one test delete the store file another is reading.
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let mut tagged: HashMap<String, Vec<String>> = HashMap::new();
    let mut drafts = Vec::new();
    for (name, _) in TAGGED {
        let card = fixture(name);
        tagged.insert(card["oracle_id"].as_str().unwrap().to_owned(), vec!["lands-matter".to_owned()]);
        drafts.push(transform_row(&card, true).unwrap().unwrap());
    }
    for name in UNTAGGED {
        drafts.push(transform_row(&fixture(name), true).unwrap().unwrap());
    }
    let tags = TagData::from_slug_maps(tagged, HashMap::new());
    let rows: Vec<Value> = finalize(drafts, &tags).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-lookaround-union-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

// ─── The trees, as the parser emits them ─────────────────────────────────────

fn leaf(attribute: &str, alias: &str, op: &str, rhs: Value) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": attribute, "original_attribute": alias}},
            "op": op,
            "rhs": rhs,
        },
    })
}

fn regex(pattern: &str) -> Value {
    leaf("oracle_text", "o", ":", json!({"node_type": "RegexValueNode", "kwargs": {"value": pattern}}))
}

fn phrase(text: &str) -> Value {
    leaf("oracle_text", "o", ":", json!({"node_type": "StringValueNode", "kwargs": {"value": text}}))
}

fn otag(slug: &str) -> Value {
    leaf("card_oracle_tags", "otag", ":", json!([slug]))
}

fn is(tag: &str) -> Value {
    leaf("card_is_tags", "is", ":", json!([tag]))
}

fn or(operands: Vec<Value>) -> Value {
    json!({"node_type": "OrNode", "kwargs": {"operands": operands}})
}

fn and(operands: Vec<Value>) -> Value {
    json!({"node_type": "AndNode", "kwargs": {"operands": operands}})
}

fn not(operand: Value) -> Value {
    json!({"node_type": "NotNode", "kwargs": {"operand": operand}})
}

/// What `/cards/search` sends for a query: the tree under Scryfall's two default exclusions
/// (`src/routes/extras-gate.ts`). `extras` is `include_extras=true`, which drops the first.
///
/// NOT DECORATION. The `-is:extra` conjunct is printing-scoped, so it is evaluated in the
/// per-printing residual — the very walk that goes dark once the budget flag is set. Without the
/// gate the tag's cards are settled at card level and survive, and the bug does not reproduce.
fn served(tree: Value, extras: bool) -> Value {
    let mut operands = vec![tree];
    if !extras {
        operands.push(not(is("extra")));
    }
    operands.push(not(is("variation")));
    and(operands)
}

/// Every card a tree matches, by name — or the engine's refusal.
fn names(store: &BufferStore, tree: &Value, unique: &str) -> Result<BTreeSet<String>, EngineErrorKind> {
    let opts = QueryOptions {
        unique: unique.to_owned(),
        orderby: "name".to_owned(),
        limit: 1_000,
        fields: Some(["scryfall_id", "name"].map(str::to_owned).to_vec()),
        ..QueryOptions::default()
    };
    let out = store.query_value(tree, &opts).map_err(|e| e.kind)?;
    assert_eq!(out.total, out.rows.len(), "the total and the page disagree");
    Ok(out.rows.iter().map(|c| c["name"].as_str().unwrap().to_owned()).collect())
}

fn set(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|n| (*n).to_owned()).collect()
}

fn supplement(pattern: &str) -> Value {
    or(vec![regex(pattern), phrase("land creatures you"), phrase("lands you control have")])
}

#[test]
fn the_reported_union_holds_every_card_the_tag_holds() {
    let store = store();
    let tagged: BTreeSet<String> = TAGGED.iter().map(|(_, name)| (*name).to_owned()).collect();
    for unique in ["card", "printing"] {
        let tag = names(&store, &served(otag("lands-matter"), false), unique).unwrap();
        assert_eq!(tag, tagged, "{unique}");

        // Lumra counts "the number of lands you control", so it is in both halves. Scapeshift's
        // "any number of lands" is the lookbehind doing its job.
        let regex_only = names(&store, &served(supplement(REPORTED), false), unique).unwrap();
        assert_eq!(regex_only, set(&["Karma", "Lumra, Bellow of the Woods", "Worm Harvest"]), "{unique}");

        // The report. Before the fix this lost all five tagged cards.
        let union = names(&store, &served(or(vec![otag("lands-matter"), supplement(REPORTED)]), false), unique).unwrap();
        let expected: BTreeSet<String> = tag.union(&regex_only).cloned().collect();
        assert_eq!(union, expected, "{unique}");
        for (_, name) in TAGGED {
            assert!(union.contains(*name), "{unique}: the union lost {name}, which the tag alone matches");
        }

        // The control the report ran: without the lookbehind the pattern is linear, the union was
        // always right, and Scapeshift is in it.
        let linear = REPORTED.replace("(?<!any )", "");
        let control = names(&store, &served(or(vec![otag("lands-matter"), supplement(&linear)]), false), unique).unwrap();
        let mut with_scapeshift = expected.clone();
        with_scapeshift.insert("Scapeshift".to_owned());
        assert_eq!(control, with_scapeshift, "{unique}");
    }
}

/// The same query with `include_extras=true`, where the long card is a minigame one.
#[test]
fn the_union_holds_with_extras_included() {
    let store = store();
    let tag = names(&store, &served(otag("lands-matter"), true), "card").unwrap();
    let union = names(&store, &served(or(vec![otag("lands-matter"), supplement(REPORTED)]), true), "card").unwrap();
    assert!(union.is_superset(&tag), "lost {:?}", tag.difference(&union).collect::<Vec<_>>());
    assert_eq!(union.len(), 7, "{union:?}");
}

/// Patterns that need the backtracking engine, one per construct that sends a pattern there:
/// the four lookarounds, at the front, the back and the middle of a pattern and inside an
/// alternation; `\m`/`\M`, which `translate_query_escapes` rewrites to lookaround; a
/// backreference; an atomic group; and `~` beside a lookahead.
const BACKTRACKING: &[&str] = &[
    REPORTED,
    r"(?<!any )number of",
    r"(?<!a )zq|zx|zw|zv|zu",
    r"zq(?=a)|zx|zw|zv|zu",
    r"land(?! card)",
    r"(?<=number of )lands",
    r"(?=.*land)(?=.*graveyard)",
    r"^(?!whenever)[a-z]+ (?=target|each)",
    r"(?<!non)land(?!s)|(?<=basic )land",
    r"\mland\M",
    r"\mlands?\M[^.]*\mgraveyard\M",
    r"(\w+) \1",
    r"(?>lands?) you control",
    r"~(?! enters)",
    r"(?<!\d)[2-9](?!\d)",
];

/// The other leaf of each pair: a tag, a type, a phrase, a number, a linear regex, a negation,
/// and the two constants a rewrite can leave behind.
fn other_leaves() -> Vec<(&'static str, Value)> {
    vec![
        ("otag:lands-matter", otag("lands-matter")),
        ("t:land", leaf("card_types", "t", ":", json!(["Land"]))),
        ("o:\"land\"", phrase("land")),
        ("cmc>=3", leaf("cmc", "cmc", ">=", json!({"node_type": "NumericValueNode", "kwargs": {"value": 3}}))),
        ("o:/for each/", regex("for each")),
        ("-t:creature", not(leaf("card_types", "t", ":", json!(["Creature"])))),
        ("c:g", leaf("card_colors", "c", ":", json!(["G"]))),
    ]
}

/// The invariants themselves, for every pairing, under both gates and both `unique` modes:
///
///   A OR B  ⊇ A          A OR B  ⊇ B          A OR B = A ∪ B
///   NOT (A OR B) = NOT A AND NOT B = everything − (A ∪ B)
///   A AND B = A ∩ B      B OR A = A OR B
///
/// and no query is refused: none of these patterns is pathological, and the two longest texts in
/// the corpus class are in the store.
#[test]
fn a_lookaround_leaf_composes_like_any_other_leaf() {
    let store = store();
    let mut checked = 0usize;
    for extras in [false, true] {
        for unique in ["card", "printing"] {
            let run = |tree: Value, what: &str| {
                names(&store, &served(tree, extras), unique)
                    .unwrap_or_else(|kind| panic!("{what} (extras={extras}, {unique}) was refused: {kind:?}"))
            };
            let everything = run(json!({"node_type": "TrueNode", "kwargs": {}}), "everything");
            for pattern in BACKTRACKING {
                let b = run(regex(pattern), pattern);
                assert!(b.is_subset(&everything));
                for (label, leaf) in other_leaves() {
                    let what = format!("{label} with o:/{pattern}/");
                    let a = run(leaf.clone(), label);
                    let a_or_b = run(or(vec![leaf.clone(), regex(pattern)]), &what);
                    let b_or_a = run(or(vec![regex(pattern), leaf.clone()]), &what);
                    let union: BTreeSet<String> = a.union(&b).cloned().collect();
                    assert!(a_or_b.is_superset(&a), "{what}: OR lost {:?}", a.difference(&a_or_b).collect::<Vec<_>>());
                    assert!(a_or_b.is_superset(&b), "{what}: OR lost {:?}", b.difference(&a_or_b).collect::<Vec<_>>());
                    assert_eq!(a_or_b, union, "{what}: OR");
                    assert_eq!(b_or_a, union, "{what}: OR, regex first");

                    let neither: BTreeSet<String> = everything.difference(&union).cloned().collect();
                    assert_eq!(run(not(or(vec![leaf.clone(), regex(pattern)])), &what), neither, "{what}: NOT (A OR B)");
                    assert_eq!(
                        run(and(vec![not(leaf.clone()), not(regex(pattern))]), &what),
                        neither,
                        "{what}: NOT A AND NOT B"
                    );

                    let both: BTreeSet<String> = a.intersection(&b).cloned().collect();
                    assert_eq!(run(and(vec![leaf.clone(), regex(pattern)]), &what), both, "{what}: AND");
                    checked += 1;
                }
            }
        }
    }
    assert_eq!(checked, 2 * 2 * BACKTRACKING.len() * other_leaves().len());
}

/// What the lookarounds answer on these cards, read off the oracle text by hand — the invariants
/// above hold just as well for a matcher that matches nothing.
#[test]
fn lookarounds_answer_what_the_text_says() {
    let store = store();
    let run = |pattern: &str| names(&store, &served(regex(pattern), false), "card").unwrap();
    // "the number of lands you control" (Lumra), "the number of Swamps they control" (Karma);
    // Scapeshift's is "any number of lands".
    // (Tarmogoyf counts "the number of card types among cards in all graveyards".)
    assert_eq!(run(r"(?<!any )number of"), set(&["Karma", "Lumra, Bellow of the Woods", "Tarmogoyf"]));
    assert_eq!(run(r"number of"), set(&["Karma", "Lumra, Bellow of the Woods", "Scapeshift", "Tarmogoyf"]));
    assert_eq!(run(r"(?<=any )number of"), set(&["Scapeshift"]));
    // Lumra and Scapeshift say "lands"; only Lumra says it right after "number of ".
    assert_eq!(run(r"(?<=the number of )lands"), set(&["Lumra, Bellow of the Woods"]));
    // "for each land card in your graveyard" (Worm Harvest) against "for each Forest" (Blanchwood Armor).
    // (Baldur's Gate Wilderness has a room that says "For each opponent".)
    assert_eq!(run(r"for each (?!land)"), set(&["Baldur's Gate Wilderness", "Blanchwood Armor"]));
    assert_eq!(run(r"for each (?=land)"), set(&["Worm Harvest"]));
}

/// The other half: a pattern that DOES run out of budget is refused. It is not answered short.
///
/// Eight bare lookaheads leave the engine nothing to seek on, so the search walks every character
/// of Baldur's Gate Wilderness at a backtrack per alternative and exhausts the budget there.
/// Before the fix each of these was `Ok` with whatever the walk had found before that card.
#[test]
fn an_exhausted_budget_is_a_refusal_not_a_short_page() {
    let store = store();
    let exhausting = r"(?=zq)|(?=zx)|(?=zw)|(?=zv)|(?=zu)|(?=zt)|(?=zs)|(?=zr)";
    for unique in ["card", "printing"] {
        for extras in [false, true] {
            for tree in [
                regex(exhausting),
                or(vec![otag("lands-matter"), regex(exhausting)]),
                or(vec![regex(exhausting), otag("lands-matter")]),
                not(or(vec![otag("lands-matter"), regex(exhausting)])),
            ] {
                assert_eq!(
                    names(&store, &served(tree, extras), unique),
                    Err(EngineErrorKind::UnsupportedRegex),
                    "{unique}, extras={extras}"
                );
            }
        }
    }
    // And the refusal does not outlive its query: the next one is answered.
    assert_eq!(names(&store, &served(otag("lands-matter"), false), "card").unwrap().len(), TAGGED.len());
}
