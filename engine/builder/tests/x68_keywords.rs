//! The Scryfall search keywords x68 gave an answer to, through the whole native pipeline: Scryfall
//! JSON → transform → finalize → store → query. Real card objects (the fixtures are bulk objects
//! verbatim), each keyword asked the tree the parser emits for it.
//!
//! What is pinned here is the RULE each keyword follows, on the printings the fixtures hold — the
//! corpus-wide counts measured on api.scryfall.com (2026-10-03) are recorded beside each keyword
//! in src/parser/db-info.ts and card_engine's filter.rs, and compared live by
//! scripts/live-parity-cases.json.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A store of exactly these card objects. One directory per CALL: the tests run on parallel
/// threads of one process.
fn store_of(cards: &[Value]) -> BufferStore {
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let drafts = cards.iter().map(|c| transform_row(c, c["lang"] == "en").unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-x68-keywords-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

fn store_from(fixtures: &[&str]) -> BufferStore {
    store_of(&fixtures.iter().map(|n| fixture(n)).collect::<Vec<_>>())
}

fn attribute(column: &str, spelling: &str) -> Value {
    json!({"node_type": "CardAttributeNode", "kwargs": {"attribute_name": column, "original_attribute": spelling}})
}

/// `<spelling><op><number>` on a numeric column — the tree the parser emits.
fn num(column: &str, spelling: &str, op: &str, value: f64) -> Value {
    let value = if value.fract() == 0.0 { json!(value as i64) } else { json!(value) };
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {"lhs": attribute(column, spelling), "op": op, "rhs": {"node_type": "NumericValueNode", "kwargs": {"value": value}}},
    })
}

/// `<spelling><op><other column>` — a numeric column compared with another.
fn num_col(column: &str, spelling: &str, op: &str, other: &str, other_spelling: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {"lhs": attribute(column, spelling), "op": op, "rhs": attribute(other, other_spelling)},
    })
}

/// `<spelling><op><word>` on a text column.
fn text(column: &str, spelling: &str, op: &str, value: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {"lhs": attribute(column, spelling), "op": op, "rhs": {"node_type": "StringValueNode", "kwargs": {"value": value}}},
    })
}

fn not(operand: Value) -> Value {
    json!({"node_type": "NotNode", "kwargs": {"operand": operand}})
}

fn and(operands: &[Value]) -> Value {
    json!({"node_type": "AndNode", "kwargs": {"operands": operands}})
}

/// Every PRINTING the tree matches, as sorted `set/number` addresses.
fn printings(store: &BufferStore, tree: &Value) -> Vec<String> {
    let opts = QueryOptions {
        unique: "printing".to_owned(),
        orderby: "name".to_owned(),
        fields: Some(["scryfall_id", "set_code", "collector_number"].map(str::to_owned).to_vec()),
        ..QueryOptions::default()
    };
    let bytes = store.scryfall_search_bytes(tree, &opts, "https://sylvan.example").expect("query");
    let text = std::str::from_utf8(&bytes).unwrap();
    let (_, body) = text.split_once('\n').unwrap();
    let mut out: Vec<String> = serde_json::from_str::<Vec<Value>>(body)
        .unwrap()
        .iter()
        .map(|c| format!("{}/{}", c["set"].as_str().unwrap(), c["collector_number"].as_str().unwrap()))
        .collect();
    out.sort();
    out
}

const NONE: [&str; 0] = [];

// ── edition: ────────────────────────────────────────────────────────────────────────────────────

#[test]
fn edition_is_set_under_another_spelling() {
    // `edition:khm t:god` = `e:khm t:god` = 12 on api.scryfall.com.
    let store = store_from(&["valki_khm_114", "doubling_cube_10e_321", "doubling_cube_5dn_116", "lightning_bolt"]);
    assert_eq!(printings(&store, &text("card_set_code", "edition", ":", "khm")), ["khm/114"]);
    assert_eq!(printings(&store, &text("card_set_code", "edition", "=", "10e")), ["10e/321"]);
    assert_eq!(
        printings(&store, &text("card_set_code", "edition", ":", "khm")),
        printings(&store, &text("card_set_code", "e", ":", "khm")),
    );
    assert_eq!(printings(&store, &not(text("card_set_code", "edition", ":", "khm"))), ["10e/321", "5dn/116", "msc/806"]);
}

// ── collector: / collectornumber: ───────────────────────────────────────────────────────────────

#[test]
fn collector_is_the_numeric_collector_number() {
    // khm/114, 10e/321, 5dn/116, msc/806. `collector:1 e:khm` is khm/1 there and
    // `collector>=390 e:khm` its 17 = `cn>=390 e:khm`.
    let store = store_from(&["valki_khm_114", "doubling_cube_10e_321", "doubling_cube_5dn_116", "lightning_bolt"]);
    let collector = |op: &str, v: f64| printings(&store, &num("collector_number_int", "collector", op, v));
    assert_eq!(collector(":", 114.0), ["khm/114"]);
    assert_eq!(collector("=", 114.0), ["khm/114"]);
    assert_eq!(collector(">=", 321.0), ["10e/321", "msc/806"]);
    assert_eq!(collector(">", 321.0), ["msc/806"]);
    assert_eq!(collector("<", 116.0), ["khm/114"]);
    assert_eq!(collector("<=", 116.0), ["5dn/116", "khm/114"]);
    assert_eq!(collector("!=", 114.0), ["10e/321", "5dn/116", "msc/806"]);
    assert_eq!(collector(":", 0.0), NONE);
    // Both spellings, and `cn` under a comparison, are one tree but for the spelling.
    assert_eq!(printings(&store, &num("collector_number_int", "collectornumber", ">=", 321.0)), ["10e/321", "msc/806"]);
    assert_eq!(printings(&store, &num("collector_number_int", "cn", ">=", 321.0)), collector(">=", 321.0));
}

#[test]
fn collector_compares_against_another_column() {
    // `collector>=cmc e:khm` is 303 = `cn>=cmc e:khm`. Every fixture's number is far above its
    // mana value, so `>=` keeps them all and `<` none.
    let store = store_from(&["valki_khm_114", "doubling_cube_10e_321", "lightning_bolt"]);
    assert_eq!(
        printings(&store, &num_col("collector_number_int", "collector", ">=", "cmc", "cmc")),
        ["10e/321", "khm/114", "msc/806"]
    );
    assert_eq!(printings(&store, &num_col("collector_number_int", "collector", "<", "cmc", "cmc")), NONE);
}

// ── edhrec: ─────────────────────────────────────────────────────────────────────────────────────

#[test]
fn edhrec_is_the_cards_rank() {
    // Llanowar Elves 58, Clifftop Retreat 81, Lightning Bolt 160, Doubling Cube 3516 (both
    // printings: the rank is the card's), and a Dragon token with none.
    let store = store_from(&[
        "llanowar_elves",
        "clifftop_retreat_yeoe_31",
        "lightning_bolt",
        "doubling_cube_10e_321",
        "doubling_cube_5dn_116",
        "dragon_tund_4",
    ]);
    let edhrec = |spelling: &str, op: &str, v: f64| printings(&store, &num("edhrec_rank", spelling, op, v));
    assert_eq!(edhrec("edhrec", ":", 160.0), ["msc/806"]);
    assert_eq!(edhrec("edhrecrank", "=", 160.0), ["msc/806"]);
    assert_eq!(edhrec("edhrec_rank", ":", 58.0), ["fdn/227"]);
    assert_eq!(edhrec("edhrec", "<=", 100.0), ["fdn/227", "yeoe/31"]);
    assert_eq!(edhrec("edhrec", "<", 81.0), ["fdn/227"]);
    assert_eq!(edhrec("edhrec", ">=", 3516.0), ["10e/321", "5dn/116"]);
    assert_eq!(edhrec("edhrec", ">", 3516.0), NONE);
}

#[test]
fn a_card_with_no_rank_compares_as_null() {
    // `edhrec!=1 e:khm` and `edhrec>=0 e:khm` are both 295 of Kaldheim's 305 on api.scryfall.com:
    // the ten unranked cards satisfy neither a comparison nor its complement.
    let store = store_from(&["lightning_bolt", "dragon_tund_4"]);
    assert_eq!(printings(&store, &num("edhrec_rank", "edhrec", ">=", 0.0)), ["msc/806"]);
    assert_eq!(printings(&store, &num("edhrec_rank", "edhrec", "!=", 1.0)), ["msc/806"]);
    assert_eq!(printings(&store, &not(num("edhrec_rank", "edhrec", ">=", 0.0))), NONE);
    assert_eq!(
        printings(&store, &and(&[num("edhrec_rank", "edhrec", ">=", 0.0), text("card_set_code", "edition", ":", "tund")])),
        NONE
    );
}

// ── usdfoil: ────────────────────────────────────────────────────────────────────────────────────

#[test]
fn usdfoil_is_the_printings_own_foil_price() {
    // usd / usd_foil: chk/153 0.51 / 4.04, khm/114 3.84 / 4.21, msc/806 0.79 / 2.78,
    // sld/869 — / 208.85, sld/1969 4.52 / 4.34, c13/186 8.94 / —, tund/4 — / —.
    let store = store_from(&[
        "akki_lavarunner_chk_153",
        "valki_khm_114",
        "lightning_bolt",
        "blacker_lotus_sld_869",
        "mechtitan_sld_1969",
        "derevi_c13_186",
        "dragon_tund_4",
    ]);
    let usdfoil = |op: &str, v: f64| printings(&store, &num("price_usd_foil", "usdfoil", op, v));
    assert_eq!(usdfoil(">=", 4.21), ["khm/114", "sld/1969", "sld/869"]);
    assert_eq!(usdfoil(">", 4.21), ["sld/1969", "sld/869"]);
    assert_eq!(usdfoil("<", 4.0), ["msc/806"]);
    assert_eq!(usdfoil("=", 2.78), ["msc/806"]);
    assert_eq!(usdfoil(":", 4.04), ["chk/153"]);
    assert_eq!(usdfoil(">=", 100.0), ["sld/869"]);
    // `usdfoil>=0 e:khm` is 285 of 305 on api.scryfall.com: no foil price is NULL, on either side
    // of the comparison — and it is NOT `usd`'s coalesced key, which would give c13/186 its 8.94.
    assert_eq!(usdfoil(">=", 0.0), ["chk/153", "khm/114", "msc/806", "sld/1969", "sld/869"]);
    assert_eq!(printings(&store, &not(num("price_usd_foil", "usdfoil", ">=", 0.0))), NONE);
    assert_eq!(usdfoil("!=", 4.04), ["khm/114", "msc/806", "sld/1969", "sld/869"]);
}

#[test]
fn usdfoil_compares_against_the_other_prices() {
    // `usdfoil>usd e:khm` is 247 and `usd>usdfoil e:khm` 57 there. sld/869 has no nonfoil price
    // and `usd` reads its foil one, so the two sides are equal and neither strict comparison holds.
    let store = store_from(&["akki_lavarunner_chk_153", "valki_khm_114", "blacker_lotus_sld_869", "mechtitan_sld_1969"]);
    assert_eq!(
        printings(&store, &num_col("price_usd_foil", "usdfoil", ">", "price_usd", "usd")),
        ["chk/153", "khm/114"]
    );
    assert_eq!(printings(&store, &num_col("price_usd", "usd", ">", "price_usd_foil", "usdfoil")), ["sld/1969"]);
}

// ── stamp: ──────────────────────────────────────────────────────────────────────────────────────

#[test]
fn stamp_is_the_security_stamp() {
    // khm/114 oval, sld/869 triangle, ysnc/23 arena; chk/153 and msc/806 have none.
    let store = store_from(&[
        "valki_khm_114",
        "blacker_lotus_sld_869",
        "effluence_devourer_ysnc_23",
        "akki_lavarunner_chk_153",
        "lightning_bolt",
    ]);
    let stamp = |value: &str| printings(&store, &text("security_stamp", "stamp", ":", value));
    assert_eq!(stamp("oval"), ["khm/114"]);
    assert_eq!(stamp("OVAL"), ["khm/114"]);
    assert_eq!(stamp("triangle"), ["sld/869"]);
    assert_eq!(stamp("arena"), ["ysnc/23"]);
    assert_eq!(stamp("heart"), NONE);
    assert_eq!(printings(&store, &text("security_stamp", "stamp", "=", "oval")), ["khm/114"]);
    // `-stamp:oval e:khm` is 216 beside `stamp:oval e:khm`'s 94: a printing with NO stamp is a plain
    // False and survives the negation, where a NULL would have dropped it.
    assert_eq!(
        printings(&store, &not(text("security_stamp", "stamp", ":", "oval"))),
        ["chk/153", "msc/806", "sld/869", "ysnc/23"]
    );
}

// ── mtgoid: / arenaid: / tcgplayerid: / multiverseid: ───────────────────────────────────────────

/// chk/153 (mtgo 21237 + foil 21238, tcgplayer 11938, multiverse 78694), khm/114 (mtgo 87559,
/// arena 75155, tcgplayer 230113, multiverse 503724 + 503725), msc/806 (mtgo 152037, arena 105816,
/// tcgplayer 697344), ysnc/23 (arena 81960, multiverse 571326), tund/4 (none of them).
fn id_store() -> BufferStore {
    store_from(&[
        "akki_lavarunner_chk_153",
        "valki_khm_114",
        "lightning_bolt",
        "effluence_devourer_ysnc_23",
        "dragon_tund_4",
    ])
}

#[test]
fn mtgoid_names_a_printing_by_either_of_its_mtgo_ids() {
    let store = id_store();
    let mtgoid = |value: &str| printings(&store, &text("mtgo_id", "mtgoid", ":", value));
    assert_eq!(mtgoid("21237"), ["chk/153"]);
    // `mtgoid:12346` is Phyrexian Processor by its FOIL id on api.scryfall.com.
    assert_eq!(mtgoid("21238"), ["chk/153"]);
    assert_eq!(mtgoid("87559"), ["khm/114"]);
    assert_eq!(printings(&store, &text("mtgo_id", "mtgo", "=", "87559")), ["khm/114"]);
    assert_eq!(mtgoid("1"), NONE);
    assert_eq!(mtgoid("0"), NONE);
    assert_eq!(mtgoid("abc"), NONE);
    // The engine reads the leading digits itself, for `/search`, where no policy rewrites them.
    assert_eq!(mtgoid("87559a"), ["khm/114"]);
}

#[test]
fn a_negated_mtgoid_keeps_only_printings_holding_both_ids() {
    // `-mtgoid:87321 e:khm` is 404 on api.scryfall.com — no Kaldheim printing has an mtgo_foil_id,
    // so `NOT (id = x OR foil_id = x)` is NULL for all of them — while `-mtgoid:12346 e:usg` is
    // 331 of 335, Urza's Saga carrying both. Here chk/153 is the one printing with both.
    let store = id_store();
    let not_mtgoid = |value: &str| printings(&store, &not(text("mtgo_id", "mtgoid", ":", value)));
    assert_eq!(not_mtgoid("87559"), ["chk/153"]);
    assert_eq!(not_mtgoid("99999999"), ["chk/153"]);
    assert_eq!(not_mtgoid("0"), ["chk/153"]);
    assert_eq!(not_mtgoid("21238"), NONE);
}

#[test]
fn arenaid_is_one_column_and_its_negation_drops_printings_without_one() {
    // `-arenaid:75036 e:khm` is 304 (every Kaldheim printing has an arena id) and
    // `-arenaid:75036 e:usg` is 404 (none does); `-arenaid:abc e:khm` is all 305.
    let store = id_store();
    assert_eq!(printings(&store, &text("arena_id", "arenaid", ":", "75155")), ["khm/114"]);
    assert_eq!(printings(&store, &text("arena_id", "arena", "=", "81960")), ["ysnc/23"]);
    assert_eq!(printings(&store, &not(text("arena_id", "arenaid", ":", "75155"))), ["msc/806", "ysnc/23"]);
    assert_eq!(printings(&store, &not(text("arena_id", "arenaid", ":", "0"))), ["khm/114", "msc/806", "ysnc/23"]);
}

#[test]
fn tcgplayerid_reads_the_etched_id_too() {
    let store = id_store();
    assert_eq!(printings(&store, &text("tcgplayer_id", "tcgplayerid", ":", "11938")), ["chk/153"]);
    assert_eq!(printings(&store, &text("tcgplayer_id", "tcgplayer", "=", "697344")), ["msc/806"]);
    // `-tcgplayerid:230675 e:khm` is 404: no Kaldheim printing has a tcgplayer_etched_id, so the
    // disjunction is NULL wherever it is not True. None of these fixtures has one either.
    assert_eq!(printings(&store, &not(text("tcgplayer_id", "tcgplayerid", ":", "11938"))), NONE);
    // The same Valki given an etched id (no fixture carries one): it is found by it, and it is
    // the one printing a negation can keep.
    let mut etched = fixture("valki_khm_114");
    etched["tcgplayer_etched_id"] = json!(424242);
    let store = store_of(&[etched, fixture("akki_lavarunner_chk_153")]);
    assert_eq!(printings(&store, &text("tcgplayer_id", "tcgplayerid", ":", "424242")), ["khm/114"]);
    assert_eq!(printings(&store, &text("tcgplayer_id", "tcgplayerid", ":", "230113")), ["khm/114"]);
    assert_eq!(printings(&store, &not(text("tcgplayer_id", "tcgplayerid", ":", "11938"))), ["khm/114"]);
}

#[test]
fn multiverseid_is_membership_and_its_negation_is_a_plain_complement() {
    // `-multiverseid:503605 e:khm cn:1` is 404 and `-multiverseid:abc e:khm` is all 305: an array
    // is never NULL, so a printing with no multiverse id at all survives the negation.
    let store = id_store();
    let multiverseid = |value: &str| printings(&store, &text("multiverse_id", "multiverseid", ":", value));
    assert_eq!(multiverseid("78694"), ["chk/153"]);
    assert_eq!(multiverseid("503724"), ["khm/114"]);
    assert_eq!(multiverseid("503725"), ["khm/114"], "the back face's id names the printing too");
    assert_eq!(multiverseid("1"), NONE);
    assert_eq!(
        printings(&store, &not(text("multiverse_id", "multiverseid", ":", "78694"))),
        ["khm/114", "msc/806", "tund/4", "ysnc/23"]
    );
    assert_eq!(
        printings(&store, &not(text("multiverse_id", "multiverse", ":", "0"))),
        ["chk/153", "khm/114", "msc/806", "tund/4", "ysnc/23"]
    );
}

// ── prints: / sets: / paperprints: / papersets: / illustrations: ────────────────────────────────

/// The value a per-card count holds for the card behind `address`, read back by asking
/// `<keyword>=N` for every N: exactly one N answers, because the count is a value on every card.
fn count_of(store: &BufferStore, column: &str, keyword: &str, address: &str) -> u32 {
    let answers: Vec<u32> =
        (0..40).filter(|&n| printings(store, &num(column, keyword, "=", f64::from(n))).iter().any(|a| a == address)).collect();
    assert_eq!(answers.len(), 1, "{keyword} of {address} answered {answers:?}");
    answers[0]
}

/// `(prints, sets, paperprints, papersets, illustrations)` of the card behind `address`.
fn counts_of(store: &BufferStore, address: &str) -> (u32, u32, u32, u32, u32) {
    (
        count_of(store, "print_count", "prints", address),
        count_of(store, "set_count", "sets", address),
        count_of(store, "paper_print_count", "paperprints", address),
        count_of(store, "paper_set_count", "papersets", address),
        count_of(store, "illustration_count", "illustrations", address),
    )
}

#[test]
fn reset_counts_what_scryfall_counts() {
    // EVERY printing api.scryfall.com holds for Reset (2026-10-03): leg/73 in English and in
    // Italian, me3/48 (MTGO only, the Legends artwork) and mb2/170 (new artwork). Scryfall's own
    // values for the card that day, found by search: `!"Reset" prints=3`, `sets=3`,
    // `paperprints=2`, `papersets=2`, `illustrations=2` are each 1, and `paperprints=1`,
    // `papersets=1` and `illustrations=1` each 404.
    //
    // Four rows and three slots: the Italian leg/73 is a translation of a printing, not another
    // one. Three slots and two on paper: me3/48 is digital. Three printings and two artworks.
    let store = store_from(&["reset_leg_73", "reset_leg_73_it", "reset_me3_48", "reset_mb2_170", "lightning_bolt"]);
    assert_eq!(counts_of(&store, "leg/73"), (3, 3, 2, 2, 2));
    // The count is the CARD's: every printing of it answers, the digital one included.
    assert_eq!(printings(&store, &num("paper_print_count", "paperprints", "=", 2.0)), ["leg/73", "mb2/170", "me3/48"]);
    assert_eq!(printings(&store, &num("print_count", "prints", ">=", 2.0)), ["leg/73", "mb2/170", "me3/48"]);
    assert_eq!(printings(&store, &num("print_count", "prints", "=", 1.0)), ["msc/806"]);
    assert_eq!(printings(&store, &not(num("print_count", "prints", "=", 3.0))), ["msc/806"]);
}

#[test]
fn tithe_counts_its_gold_bordered_printing() {
    // Tithe is vis/23 and the World Championship deck's wc98/bh23a — memorabilia, an extra — and
    // Scryfall holds prints=2 sets=2 paperprints=2 papersets=2 illustrations=1 for it
    // (2026-10-03): extras printings count, and one artwork printed twice is one.
    let store = store_from(&["tithe_vis_23", "tithe_wc98_bh23a"]);
    assert_eq!(counts_of(&store, "vis/23"), (2, 2, 2, 2, 1));
}

#[test]
fn a_set_printed_twice_is_one_set_and_a_foreign_only_slot_is_a_printing() {
    // Flashback: psos/115p, sos/115 and sos/333 — three slots, two sets, one artwork.
    let store = store_from(&["flashback_psos_115p", "flashback_sos_115", "flashback_sos_333"]);
    assert_eq!(counts_of(&store, "sos/115"), (3, 2, 3, 2, 1));
    assert_eq!(printings(&store, &num_col("print_count", "prints", ">", "set_count", "sets")), ["psos/115p", "sos/115", "sos/333"]);
    // Delver of Secrets in English (inr/60) with a Spanish printing of ANOTHER slot (isd/51) and
    // no English row for it: the shape of Aether Shockwave, which has one English printing and a
    // Spanish-only Salvat one and is `prints=2 sets=2` on api.scryfall.com. The annex counts.
    // (The two rows carry different oracle ids in the fixtures — isd/51 predates the errata that
    // split them — so the Spanish row is given the English one's.)
    let english = fixture("delver_of_secrets");
    let mut spanish = fixture("delver_es");
    spanish["oracle_id"] = english["oracle_id"].clone();
    let store = store_of(&[english, spanish]);
    // Its artwork is on its FACES, and both rows print the same front: one illustration, though
    // the two backs differ (Delver's eight printings carry twelve face artworks and count 6).
    assert_eq!(counts_of(&store, "inr/60"), (2, 2, 2, 2, 1));
}

#[test]
fn a_digital_only_card_has_no_paper_printings() {
    // `paperprints=0` and `papersets=0` are each 654 cards on api.scryfall.com — the Alchemy cards
    // among them. ymkm/13 exists on Arena alone. A count of zero is a VALUE: it compares, and its
    // complement holds the paper card.
    let store = store_from(&["case_of_the_market_melee_ymkm_13", "lightning_bolt"]);
    assert_eq!(counts_of(&store, "ymkm/13"), (1, 1, 0, 0, 1));
    assert_eq!(printings(&store, &num("paper_print_count", "paperprints", "<", 1.0)), ["ymkm/13"]);
    assert_eq!(printings(&store, &not(num("paper_set_count", "papersets", "=", 0.0))), ["msc/806"]);
    assert_eq!(
        printings(&store, &num_col("print_count", "prints", ">", "paper_print_count", "paperprints")),
        ["ymkm/13"]
    );
}

#[test]
fn a_variation_is_not_a_print() {
    // Embermage Goblin is ons/200 and the foil-only ons/200★, which Scryfall marks
    // `variation: true`. `!"Embermage Goblin" prints=1` and `paperprints=1` are each 1 on
    // api.scryfall.com (2026-10-04) and `prints=2` is 404 — two slots, one print. Ten of ten
    // cards with a variation probed that day read the same way (Kuja, Genome Sorcerer 5 of its 9
    // slots, Vizzerdrix 6 of 8).
    let store = store_from(&["embermage_goblin_ons_200", "embermage_goblin_ons_200_star", "lightning_bolt"]);
    // Its ARTWORK still counts: the two carry different illustration ids, and
    // `!"Embermage Goblin" illustrations=2` is 1 there where `illustrations=1` is 404.
    assert_eq!(counts_of(&store, "ons/200"), (1, 1, 1, 1, 2));
    // The variation is still a printing of the card, and answers with the card's counts.
    assert_eq!(printings(&store, &num("print_count", "prints", "=", 1.0)), ["msc/806", "ons/200", "ons/200★"]);
    assert_eq!(printings(&store, &num("print_count", "prints", ">", 1.0)), NONE);
}

#[test]
fn a_digital_printing_in_a_paper_set_is_a_paper_print() {
    // "Name Sticker" Goblin's only printing is unf/107m: `games: [mtgo]`, `digital: true` — in
    // Unfinity, a paper set. Scryfall holds paperprints=1 and papersets=1 for it (2026-10-04):
    // the SET decides. Counting by the row's `games` answered `paperprints=0` 657 against
    // Scryfall's 654, this card being one of the three. ymkm/13 beside it is in a digital set.
    let store = store_from(&["name_sticker_goblin_unf_107m", "case_of_the_market_melee_ymkm_13"]);
    assert_eq!(counts_of(&store, "unf/107m"), (1, 1, 1, 1, 1));
    assert_eq!(counts_of(&store, "ymkm/13"), (1, 1, 0, 0, 1));
    assert_eq!(printings(&store, &num("paper_print_count", "paperprints", "=", 0.0)), ["ymkm/13"]);
}

#[test]
fn a_set_the_table_does_not_know_reads_the_printings_own_games() {
    // set_digital_gen.rs is refreshed by hand, so a set announced since is in neither list. Its
    // printings fall back to their own `games` — right for every set that is wholly paper or
    // wholly digital, which a new one is until Scryfall says otherwise.
    let mut mtgo_only = fixture("name_sticker_goblin_unf_107m");
    mtgo_only["set"] = json!("zz9");
    let mut on_paper = fixture("lightning_bolt");
    on_paper["set"] = json!("zz8");
    let store = store_of(&[mtgo_only, on_paper]);
    assert_eq!(counts_of(&store, "zz9/107m"), (1, 1, 0, 0, 1));
    assert_eq!(counts_of(&store, "zz8/806"), (1, 1, 1, 1, 1));
}

#[test]
fn doubling_cube_counts_slots_not_set_codes_in_the_number() {
    // 10e/321, 5dn/116, plst/10E-321 and sld/1080: four slots in four sets. The List's collector
    // number is the string `10E-321`, and it is its own slot. Three share the Fifth Dawn artwork;
    // the Secret Lair printing has its own, on its faces.
    let store =
        store_from(&["doubling_cube_10e_321", "doubling_cube_5dn_116", "doubling_cube_plst_10e_321", "doubling_cube_sld_1080"]);
    assert_eq!(counts_of(&store, "5dn/116"), (4, 4, 4, 4, 2));
}

// ── artists: ────────────────────────────────────────────────────────────────────────────────────

#[test]
fn artists_is_how_many_artists_the_printing_credits() {
    // dmr/215 Fire // Ice ("David Martin & Franz Vohwinkel") and sld/1969 Mechtitan ("Ivan Shavrin
    // & Rob Pavic") credit two; tclb/0 Baldur's Gate Wilderness and mmid/2 credit none — tclb/0 is
    // one of the 12 cards `artists=0` answers on api.scryfall.com; the rest credit one.
    let store = store_from(&[
        "fire_ice",
        "mechtitan_sld_1969",
        "mechtitan_tneo_14",
        "baldurs_gate_wilderness_tclb_0",
        "day_vs_night_mmid_2",
        "lightning_bolt",
    ]);
    let artists = |op: &str, v: f64| printings(&store, &num("artist_count", "artists", op, v));
    assert_eq!(artists("=", 2.0), ["dmr/215", "sld/1969"]);
    assert_eq!(artists(":", 2.0), ["dmr/215", "sld/1969"]);
    assert_eq!(artists(">=", 2.0), ["dmr/215", "sld/1969"]);
    assert_eq!(artists("=", 0.0), ["mmid/2", "tclb/0"]);
    assert_eq!(artists("<", 1.0), ["mmid/2", "tclb/0"]);
    assert_eq!(artists("=", 1.0), ["msc/806", "tneo/14"]);
    assert_eq!(artists("!=", 1.0), ["dmr/215", "mmid/2", "sld/1969", "tclb/0"]);
    assert_eq!(artists(">", 2.0), NONE);
    // Per PRINTING: Mechtitan's token printing credits one artist and its Secret Lair one two.
    // And a column on the right: Fire // Ice's two artists are fewer than its mana value of 4,
    // Lightning Bolt's one is its mana value exactly (`artists>=cmc e:khm` is 59 there).
    let at_least_cmc = printings(&store, &num_col("artist_count", "artists", ">=", "cmc", "cmc"));
    assert!(at_least_cmc.contains(&"msc/806".to_owned()) && !at_least_cmc.contains(&"dmr/215".to_owned()), "{at_least_cmc:?}");
}
