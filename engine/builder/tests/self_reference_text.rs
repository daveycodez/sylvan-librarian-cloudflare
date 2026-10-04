//! A `~` pattern is matched against a text in which every self-reference IS a tilde — through the
//! whole native pipeline: Scryfall JSON → transform → finalize → store → query.
//!
//! api.scryfall.com keeps two texts per card. A pattern with no `~` reads the oracle text as
//! printed; a pattern with a `~` anywhere reads one where the card's own name, its short name and
//! every "this creature" / "this Vehicle" / "this card" phrase have been replaced by a literal
//! `~`, and the pattern's tilde is an ordinary character. Every assertion below is a probe
//! measured there on 2026-10-04, scoped to the one card; the five cards are the ones mtg-seeker's
//! reports R23, R27, R28, R34 and R36 named.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const FIXTURES: &[&str] = &[
    "risk_factor_grn_113",
    "case_of_the_market_melee_ymkm_13",
    "michelangelo_on_the_scene_tmc_124",
    "effluence_devourer_ysnc_23",
    "honeymoon_hearse_inr_159",
];

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn store() -> BufferStore {
    // One directory per CALL, not per process: the tests below run on parallel threads of one
    // process, and a shared directory lets one test delete the store file another is reading.
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let drafts = FIXTURES.iter().map(|n| transform_row(&fixture(n), true).unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-self-reference-text-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

fn term(node_type: &str, value: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": "oracle_text", "original_attribute": "o"}},
            "op": ":",
            "rhs": {"node_type": node_type, "kwargs": {"value": value}},
        },
    })
}

/// `o:/pattern/`, as the parser emits it.
fn regex(pattern: &str) -> Value {
    term("RegexValueNode", pattern)
}

/// `o:"phrase"`.
fn phrase(value: &str) -> Value {
    term("StringValueNode", value)
}

/// Every card a tree matches, by name.
fn names(store: &BufferStore, tree: &Value) -> Vec<String> {
    let opts = QueryOptions {
        unique: "card".to_owned(),
        orderby: "name".to_owned(),
        fields: Some(["scryfall_id", "name"].map(str::to_owned).to_vec()),
        ..QueryOptions::default()
    };
    let bytes = store.scryfall_search_bytes(tree, &opts, "https://sylvan.example").expect("query");
    let text = std::str::from_utf8(&bytes).unwrap();
    let (_, body) = text.split_once('\n').unwrap();
    let mut out: Vec<String> =
        serde_json::from_str::<Vec<Value>>(body).unwrap().iter().map(|c| c["name"].as_str().unwrap().to_owned()).collect();
    out.sort();
    out
}

const NONE: [&str; 0] = [];

#[test]
fn the_name_is_one_tilde_and_not_a_word() {
    let store = store();
    let risk = ["Risk Factor"];
    // "Target opponent may have Risk Factor deal 4 damage to them."
    assert_eq!(names(&store, &regex("have risk factor deal")), risk, "no tilde: the text as printed");
    assert_eq!(names(&store, &regex("have risk factor deal|~~~")), NONE, "a tilde anywhere: the name is gone");
    assert_eq!(names(&store, &regex("have . deal|~~~")), risk, "and ONE character stands there");
    assert_eq!(names(&store, &regex("have ~ deal")), risk);
    assert_eq!(names(&store, &regex("have [~] deal")), risk, "a class can name it");
    assert_eq!(names(&store, &regex(r"have \~ deal")), risk, "and so can an escape");
    assert_eq!(names(&store, &phrase("have ~ deal")), risk, "a quoted phrase is the same search");
    assert_eq!(names(&store, &regex(r"have [\w ]+ deal|~~~")), NONE, "it is not a word character");
    assert_eq!(names(&store, &regex(r"~\b deal")), NONE, "so no boundary stands between it and a space");
    assert_eq!(names(&store, &regex(r"have \b~")), NONE);
    assert_eq!(names(&store, &regex(r"have\b ~")), risk);
}

#[test]
fn the_this_phrases_are_tildes_in_the_text() {
    let store = store();
    // "Tap two untapped creatures you control: This Vehicle becomes an artifact creature…"
    assert_eq!(names(&store, &regex("this vehicle becomes")), ["Honeymoon Hearse"]);
    assert_eq!(names(&store, &regex("this vehicle becomes|~~~")), NONE);
    assert_eq!(names(&store, &regex(": . becomes|~~~")), ["Honeymoon Hearse"]);
    assert_eq!(names(&store, &regex(": ~ becomes an artifact creature")), ["Honeymoon Hearse"]);
    // "When Michelangelo dies, return this card to your hand." — a short name and a phrase.
    assert_eq!(names(&store, &regex("when . dies, return . to|~~~")), ["Michelangelo, On the Scene"]);
    assert_eq!(names(&store, &regex("return this card|~~~")), NONE);
    assert_eq!(names(&store, &regex("michelangelo|~~~")), NONE);
    // NAMES FIRST. "Case" is Case of the Market Melee's short name, so "When this Case enters"
    // reads "when this ~ enters" and is no longer a phrase.
    assert_eq!(names(&store, &regex("when this ~ enters")), ["Case of the Market Melee"]);
    assert_eq!(names(&store, &regex("when ~ enters")), NONE);
    assert_eq!(names(&store, &regex("this case|~~~")), NONE);
    // A bare `~` answers what it always did: all five mention themselves.
    assert_eq!(names(&store, &regex("~")).len(), 5);
    assert_eq!(names(&store, &phrase("~")).len(), 5);
}

#[test]
fn the_reported_arms_answer_what_scryfall_answers() {
    let store = store();
    // R23: Risk Factor through `target [\w ]+` across its own name, Case of the Market Melee
    // through `this \w+` over "this ~". Skullscorch is Risk Factor's shape.
    assert_eq!(names(&store, &regex(r"(^|[,:.—] )(~|this \w+|target [\w ]+) deals? ([1-9X]|that much|damage)")), NONE);
    // R28, both arms: Case of the Market Melee.
    assert_eq!(
        names(&store, &regex(r"(^|[,:.—] )(~|this \w+|target [\w ]+) deals? [^.\n]*damage [^.\n]*to any target")),
        NONE
    );
    assert_eq!(
        names(&store, &regex(r"When (~|this \w+) (enters|dies), it deals [^.\n]*damage to any target")),
        NONE
    );
    // R34: Michelangelo's "return this card" is "return ~".
    assert_eq!(
        names(&store, &regex(r"[Ww]hen ~ dies, return (it|this card)|dies, return it to the battlefield")),
        NONE
    );
    // R27: Effluence Devourer's "Exile this card from your graveyard:" is "exile ~ from…".
    assert_eq!(
        names(
            &store,
            &regex(r#"sacrifice (~|this creature) or another[^.\n]*it perpetually gains "[^:\n]*Exile this card from your graveyard:"#)
        ),
        NONE
    );
    assert_eq!(
        names(&store, &regex(r#"sacrifice ~ or another[^.\n]*it perpetually gains "[^:\n]*Exile ~ from your graveyard:"#)),
        ["Effluence Devourer"]
    );
    // R36 and its `(^|\n)` form: the three Vehicles' "This Vehicle becomes an artifact creature".
    for anchor in ["^", r"(^|\n)"] {
        let pattern = format!(r#"{anchor}[^"\n]*(~ becomes a copy of (target|that card)|This Vehicle becomes an artifact creature)"#);
        assert_eq!(names(&store, &regex(&pattern)), NONE, "{anchor}");
    }
}
