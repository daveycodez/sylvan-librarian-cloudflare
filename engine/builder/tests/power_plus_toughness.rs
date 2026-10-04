//! `pt` / `powtou`, Scryfall's combined power-and-toughness keyword — through the whole native
//! pipeline: Scryfall JSON → transform → finalize → store → query.
//!
//! Every card is a row of the 2026-10-03 measurement against api.scryfall.com, scoped by exact name
//! so the answer there is 1 or 404. The sum is the FRONT face's, in the values `pow` and `tou`
//! already compare:
//!
//!   Delver of Secrets // Insectile Aberration   1/1 // 3/2    pt=2    (pt=5, pt=3, pt=4 are 404)
//!   Akki Lavarunner // Tok-Tok, Volcano Born    1/1 // 2/2    pt=2    flip: the top half (pt=4 is 404)
//!   Bonecrusher Giant // Stomp                  4/3           pt=7    adventure: the creature
//!   Valki, God of Lies // Tibalt                2/1 // —      pt=3    a planeswalker back adds nothing
//!   Brisela, Voice of Nightmares                9/10          pt=19   a meld result is its own card
//!   Heart of Kiran                              4/4           pt=8    a Vehicle has both
//!   Tarmogoyf                                   */1+*         pt=1    `*` is 0 and `1+*` is 1
//!   Char-Rumbler                                -1/3          pt=2
//!   Little Girl                                 .5/.5         pt=1    a half is a half
//!   Westvale Abbey // Ormendahl                 — // 9/7      none    `pt>=0` is 404, `pow>=0` is 1
//!   Invasion of Zendikar // Awakened Skyclave   — // 4/4      none    a battle's front has no stats
//!   Lightning Bolt                              —             none

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const FIXTURES: &[&str] = &[
    "delver_of_secrets",
    "akki_lavarunner_chk_153",
    "bonecrusher_giant_clb_781",
    "valki_khm_114",
    "brisela_inr_14b",
    "heart_of_kiran_aer_153",
    "tarmogoyf_fra_116",
    "char_rumbler_tsr_158",
    "little_girl_unh_16",
    "westvale_abbey_inr_287",
    "invasion_of_zendikar_mom_194",
    "lightning_bolt",
];

const DELVER: &str = "Delver of Secrets // Insectile Aberration";
const AKKI: &str = "Akki Lavarunner // Tok-Tok, Volcano Born";
const BONECRUSHER: &str = "Bonecrusher Giant // Stomp";
const VALKI: &str = "Valki, God of Lies // Tibalt, Cosmic Impostor";
const BRISELA: &str = "Brisela, Voice of Nightmares";
const KIRAN: &str = "Heart of Kiran";
const GOYF: &str = "Tarmogoyf";
const RUMBLER: &str = "Char-Rumbler";
const GIRL: &str = "Little Girl";
const WESTVALE: &str = "Westvale Abbey // Ormendahl, Profane Prince";
const ZENDIKAR: &str = "Invasion of Zendikar // Awakened Skyclave";

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
    let out_dir = std::env::temp_dir().join(format!("sylvan-power-plus-toughness-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

fn num(value: f64) -> Value {
    json!({"node_type": "NumericValueNode", "kwargs": {"value": value}})
}

/// A numeric column, as the parser names it: `pt`/`powtou` resolve to `power_plus_toughness`.
fn column(alias: &str) -> Value {
    let attribute = match alias {
        "pt" | "powtou" => "power_plus_toughness",
        "pow" => "creature_power",
        "tou" => "creature_toughness",
        "mv" => "cmc",
        other => panic!("no column for {other}"),
    };
    json!({"node_type": "CardAttributeNode", "kwargs": {"attribute_name": attribute, "original_attribute": alias}})
}

fn binary(lhs: Value, op: &str, rhs: Value) -> Value {
    json!({"node_type": "CardBinaryOperatorNode", "kwargs": {"lhs": lhs, "op": op, "rhs": rhs}})
}

fn pt(op: &str, value: f64) -> Value {
    binary(column("pt"), op, num(value))
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

fn sorted(mut names: Vec<&str>) -> Vec<&str> {
    names.sort_unstable();
    names
}

#[test]
fn each_card_answers_its_front_faces_sum_and_no_other() {
    let store = store();
    let sums: [(&str, f64); 9] = [
        (DELVER, 2.0),
        (AKKI, 2.0),
        (BONECRUSHER, 7.0),
        (VALKI, 3.0),
        (BRISELA, 19.0),
        (KIRAN, 8.0),
        (GOYF, 1.0),
        (RUMBLER, 2.0),
        (GIRL, 1.0),
    ];
    for total in [1.0, 2.0, 3.0, 7.0, 8.0, 19.0] {
        let want = sorted(sums.iter().filter(|(_, s)| *s == total).map(|(n, _)| *n).collect());
        assert_eq!(names(&store, &pt("=", total)), want, "pt={total}");
        // `:` is `=` on a numeric column, and `powtou` is the same column.
        assert_eq!(names(&store, &pt(":", total)), want, "pt:{total}");
        assert_eq!(names(&store, &binary(column("powtou"), "=", num(total))), want, "powtou={total}");
    }
    // The sums no FRONT face has: Delver's back (5) and its two mixed pairs (3 is Valki's, so 4),
    // Akki's flipped half (4), Ormendahl's 16 and the Skyclave's 8 (which is Heart of Kiran's alone).
    let none: [&str; 0] = [];
    for absent in [4.0, 5.0, 16.0] {
        assert_eq!(names(&store, &pt("=", absent)), none, "pt={absent}");
    }
}

#[test]
fn every_comparator_reads_the_same_sum() {
    let store = store();
    // The nine cards with a front pair, by sum: 1 1 2 2 2 3 7 8 19.
    assert_eq!(names(&store, &pt("<", 2.0)), sorted(vec![GOYF, GIRL]));
    assert_eq!(names(&store, &pt("<=", 2.0)), sorted(vec![GOYF, GIRL, DELVER, AKKI, RUMBLER]));
    assert_eq!(names(&store, &pt(">", 7.0)), sorted(vec![KIRAN, BRISELA]));
    assert_eq!(names(&store, &pt(">=", 7.0)), sorted(vec![BONECRUSHER, KIRAN, BRISELA]));
    assert_eq!(names(&store, &pt("!=", 2.0)), sorted(vec![GOYF, GIRL, VALKI, BONECRUSHER, KIRAN, BRISELA]));
}

#[test]
fn a_card_whose_front_has_no_stats_has_no_pt_and_negation_does_not_find_it() {
    let store = store();
    let with_pt = sorted(vec![DELVER, AKKI, BONECRUSHER, VALKI, BRISELA, KIRAN, GOYF, RUMBLER, GIRL]);
    assert_eq!(names(&store, &pt(">=", 0.0)), with_pt);
    // `pow>=0` reaches the backs: Ormendahl's 9 and the Skyclave's 4.
    let mut with_power = with_pt.clone();
    with_power.extend([WESTVALE, ZENDIKAR]);
    with_power.retain(|n| *n != RUMBLER); // -1
    assert_eq!(names(&store, &binary(column("pow"), ">=", num(0.0))), sorted(with_power));
    // `!"Westvale Abbey" -(pt>=0)` and `!"Lightning Bolt" -(pt>=0)` are both 404: an absent value
    // is NULL, and NOT of NULL is not a match — the same three-valued NOT `-(pow>=0)` has.
    let none: [&str; 0] = [];
    assert_eq!(names(&store, &not(pt(">=", 0.0))), none);
    // ...and `-(pt<6)` is the cards whose sum is 6 or more, nothing else.
    assert_eq!(names(&store, &not(pt("<", 6.0))), sorted(vec![BONECRUSHER, KIRAN, BRISELA]));
}

#[test]
fn a_column_on_the_other_side_keeps_its_own_semantics() {
    let store = store();
    // `pow>pt`: Delver alone — its back's 3 against its front's 2. Akki's 2 does not exceed its
    // front's 2 (404), and Westvale has no pt to exceed (404).
    assert_eq!(names(&store, &binary(column("pow"), ">", column("pt"))), [DELVER]);
    assert_eq!(names(&store, &binary(column("pt"), "<", column("pow"))), [DELVER]);
    // `pt>mv`: Heart of Kiran's 8 against 2 is 1; `pt=mv` on Tarmogoyf (1 against 2) is 404.
    let pt_gt_mv = names(&store, &binary(column("pt"), ">", column("mv")));
    assert!(pt_gt_mv.iter().any(|n| n == KIRAN));
    assert!(!names(&store, &binary(column("pt"), "=", column("mv"))).iter().any(|n| n == GOYF));
    // Where it parts from `pow+tou`, the arithmetic api.scryfall.com does not have (it answers
    // 404 to it): that is the cross product over faces, so it finds Delver at 5, 3 and 4 too.
    let pow_plus_tou = |v: f64| binary(binary(column("pow"), "+", column("tou")), "=", num(v));
    assert_eq!(names(&store, &pow_plus_tou(5.0)), [DELVER]);
    assert_eq!(names(&store, &pow_plus_tou(16.0)), [WESTVALE]);
    assert_eq!(names(&store, &pt("=", 5.0)), [] as [&str; 0]);
}
