//! A cleave card answers `o:` under three readings of its text — through the whole native
//! pipeline: Scryfall JSON → transform → finalize → store → query.
//!
//! "Destroy target [attacking] creature." is found as printed, as "destroy target attacking
//! creature." and as "destroy target creature." on api.scryfall.com, whose searchable text for a
//! cleave card is the three joined by a line break. `fo:` reads the printed text alone. Every
//! assertion is a probe measured there on 2026-10-04; the cards are the ones mtg-seeker's reports
//! R14–R16, R18, R20 (row 4), R22, R24, R26, R30 and R31 named, plus Carth the Lion, whose
//! brackets are not cleave.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const FIXTURES: &[&str] = &[
    "fierce_retribution_vow_13",
    "alchemists_retrieval_vow_47",
    "dig_up_vow_197",
    "wash_away_vow_87",
    "alchemists_gambit_vow_140",
    "carth_the_lion_mh2_189",
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
    let out_dir = std::env::temp_dir().join(format!("sylvan-cleave-readings-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

fn term(alias: &str, node_type: &str, value: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": "oracle_text", "original_attribute": alias}},
            "op": ":",
            "rhs": {"node_type": node_type, "kwargs": {"value": value}},
        },
    })
}

/// `o:/pattern/` or `fo:/pattern/`, as the parser emits it.
fn regex(alias: &str, pattern: &str) -> Value {
    term(alias, "RegexValueNode", pattern)
}

/// `o:"phrase"` or `fo:"phrase"`.
fn phrase(alias: &str, value: &str) -> Value {
    term(alias, "StringValueNode", value)
}

fn not(tree: Value) -> Value {
    json!({"node_type": "NotNode", "kwargs": {"operand": tree}})
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
const FIERCE: [&str; 1] = ["Fierce Retribution"];

#[test]
fn all_three_readings_answer_a_phrase_and_a_regex() {
    let store = store();
    for reading in ["destroy target [attacking] creature", "destroy target attacking creature", "destroy target creature"] {
        assert_eq!(names(&store, &phrase("o", reading)), FIERCE, "{reading}");
    }
    assert_eq!(names(&store, &regex("o", r"\[attacking\]")), FIERCE);
    assert_eq!(names(&store, &regex("o", "destroy target attacking creature")), FIERCE, "R30");
    assert_eq!(names(&store, &regex("o", "destroy target creature")), FIERCE, "R20 row 4");
    assert_eq!(names(&store, &regex("o", r"^destroy target creature\.$")), FIERCE);
    assert_eq!(names(&store, &phrase("o", "Destroy target creature.")), FIERCE, "R22");
    // The whole text three times, the keyword line included, one line break between.
    assert_eq!(names(&store, &regex("o", r"\{w\}\ndestroy(.|\n)*\{w\}\ndestroy(.|\n)*\{w\}\ndestroy")), FIERCE);
    assert_eq!(names(&store, &regex("o", r"\[attacking\](.|\n)*target attacking(.|\n)*target creature\.")), FIERCE);
    assert_eq!(names(&store, &regex("o", r"target creature\.(.|\n)*\[attacking\]")), NONE, "printed first, cleaved last");
    assert_eq!(names(&store, &regex("o", r"creature\.\ncleave")), FIERCE);
    assert_eq!(names(&store, &regex("o", r"creature\.\n\n")), NONE);
    // `fo:` is the printed text and nothing else.
    assert_eq!(names(&store, &regex("fo", r"\[attacking\]")), FIERCE);
    assert_eq!(names(&store, &regex("fo", "target creature")), NONE);
    assert_eq!(names(&store, &phrase("fo", "target attacking creature")), NONE);
}

#[test]
fn the_words_go_with_the_space_before_them() {
    let store = store();
    assert_eq!(names(&store, &phrase("o", "target spell.")), ["Wash Away"]);
    assert_eq!(names(&store, &phrase("o", "target spell .")), NONE);
    assert_eq!(names(&store, &phrase("o", "your library for a card,")), ["Dig Up"], "R18");
    assert_eq!(names(&store, &phrase("o", "for a basic land card, reveal it, put")), ["Dig Up"]);
    assert_eq!(names(&store, &phrase("o", "for a card, reveal it, put")), NONE, "nothing is removed by halves");
    assert_eq!(names(&store, &regex("o", r"prevented\.$")), ["Alchemist's Gambit"]);
    // R26: "[At the beginning…" follows a full stop and a space only once the bracket is gone.
    assert_eq!(names(&store, &regex("o", r#"(^|[.:—] |")(When|Whenever|At the beginning)\b"#)), ["Alchemist's Gambit", "Carth the Lion"]);
    // R31, both forms.
    let retrieval = ["Alchemist's Retrieval"];
    assert_eq!(names(&store, &regex("o", "Return target (creature|nonland permanent|permanent) to its owner.s hand")), retrieval);
    assert_eq!(
        names(&store, &regex("o", r"Return target (\[[^\]]+\] )?\[?(creature|(nonland )?permanent)( you control)?\]? to its owner.s hand")),
        retrieval
    );
}

#[test]
fn a_negated_term_sees_the_readings_too() {
    let store = store();
    // R16: Scryfall EXCLUDES Alchemist's Retrieval, because "permanent [you control]" also reads
    // "permanent you control". This engine kept it.
    assert_eq!(names(&store, &regex("o", "permanents? you (own|control)")), ["Alchemist's Retrieval"]);
    // R24: three readings are three "target"s, so `-o:/\btargets?\b(.|\n)*\btargets?\b/` drops
    // every cleave spell with one target.
    let twice = not(regex("o", r"\btargets?\b(.|\n)*\btargets?\b"));
    let left = names(&store, &twice);
    for cleave in ["Alchemist's Retrieval", "Fierce Retribution", "Wash Away"] {
        assert!(!left.contains(&cleave.to_owned()), "{cleave} names its target three times over");
    }
}

#[test]
fn brackets_without_cleave_stay_as_printed() {
    let store = store();
    let carth = ["Carth the Lion"];
    assert_eq!(names(&store, &phrase("o", "additional [+1] to activate")), carth);
    assert_eq!(names(&store, &phrase("o", "additional +1 to activate")), NONE);
    assert_eq!(names(&store, &phrase("o", "additional to activate")), NONE);
}
