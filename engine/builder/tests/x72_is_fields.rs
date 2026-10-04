//! The `is:` values api.scryfall.com answers that this port held as unanswered until x72, through
//! the whole native pipeline: Scryfall JSON → transform → finalize → store → query. Real card
//! objects (the fixtures are card objects verbatim), each value asked the tree the parser emits.
//!
//! Three kinds, each measured 2026-10-04 by reading what Scryfall returns against the same day's
//! bulk file: a FIELD the printing carries (answered by the engine from what the store already
//! holds — card_engine's `FieldPresent` and `ImageStatusMatch`), a field the store did not hold
//! (a tag the builder writes), and a list of sets or names (a tag too). One test per rule.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{Value, json};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A store of exactly these card objects, each with whether its row is the CANONICAL one of its
/// printing (the row Scryfall's `default_cards` holds) or an annex row. One directory per CALL:
/// the tests run on parallel threads.
fn store_of(cards: &[(&str, bool)]) -> BufferStore {
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let drafts = cards.iter().map(|(name, canonical)| transform_row(&fixture(name), *canonical).unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-x72-is-fields-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

/// Every fixture as the canonical row of its printing.
fn store_from(fixtures: &[&str]) -> BufferStore {
    store_of(&fixtures.iter().map(|name| (*name, true)).collect::<Vec<_>>())
}

/// `is:<value>`, the tree the parser emits.
fn is(value: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": "card_is_tags", "original_attribute": "is"}},
            "op": ":",
            "rhs": [value],
        },
    })
}

fn not(operand: Value) -> Value {
    json!({"node_type": "NotNode", "kwargs": {"operand": operand}})
}

fn or(operands: Vec<Value>) -> Value {
    json!({"node_type": "OrNode", "kwargs": {"operands": operands}})
}

/// Every PRINTING the tree matches as sorted `set/number/lang` addresses — every language when
/// `every_language`, otherwise what a search with no `lang:` and no `include_multilingual` sees.
fn rows(store: &BufferStore, tree: &Value, every_language: bool) -> Vec<String> {
    let opts = QueryOptions {
        unique: "printing".to_owned(),
        orderby: "name".to_owned(),
        include_multilingual: every_language,
        fields: Some(["scryfall_id", "set_code", "collector_number", "lang"].map(str::to_owned).to_vec()),
        ..QueryOptions::default()
    };
    let bytes = store.scryfall_search_bytes(tree, &opts, "https://sylvan.example").expect("query");
    let text = std::str::from_utf8(&bytes).unwrap();
    let (_, body) = text.split_once('\n').unwrap();
    let mut out: Vec<String> = serde_json::from_str::<Vec<Value>>(body)
        .unwrap()
        .iter()
        .map(|c| {
            format!(
                "{}/{}/{}",
                c["set"].as_str().unwrap(),
                c["collector_number"].as_str().unwrap(),
                c["lang"].as_str().unwrap()
            )
        })
        .collect();
    out.sort();
    out
}

fn printings(store: &BufferStore, tree: &Value) -> Vec<String> {
    rows(store, tree, false)
}

const NONE: [&str; 0] = [];

#[test]
fn an_id_is_present_by_its_own_column() {
    // is:mtgoid 63,187 / is:arenaid 19,829 / is:tcgplayer 102,276 / is:cardmarket 100,368 /
    // is:multiverse 69,514 on api.scryfall.com, each the count of ONE field in the bulk file:
    //   m10/85   Black Knight      mtgo 32799 and foil 32800, tcgplayer, cardmarket, multiverse
    //   8ed/S5a  Vizzerdrix        the FOIL mtgo id alone, and nothing else
    //   cmr/566  Miara             the ETCHED tcgplayer id alone; cardmarket, multiverse
    //   hbg/911  Ruin Crab         an arena id alone
    //   inr/287  Westvale Abbey    mtgo, tcgplayer, cardmarket, multiverse
    // The foil id is not an MTGO id for this purpose (63,188 with it) and the etched id not a
    // TCGplayer one (103,168 with it) — where `mtgoid:19476` DOES name Vizzerdrix.
    let store = store_from(&[
        "black_knight_m10_85",
        "vizzerdrix_8ed_s5a",
        "miara_cmr_566",
        "ruin_crab_hbg_911",
        "westvale_abbey_inr_287",
    ]);
    assert_eq!(printings(&store, &is("mtgoid")), ["inr/287/en", "m10/85/en"]);
    assert_eq!(printings(&store, &is("arenaid")), ["hbg/911/en"]);
    assert_eq!(printings(&store, &is("tcgplayer")), ["inr/287/en", "m10/85/en"]);
    assert_eq!(printings(&store, &is("cardmarket")), ["cmr/566/en", "inr/287/en", "m10/85/en"]);
    assert_eq!(printings(&store, &is("multiverse")), ["cmr/566/en", "inr/287/en", "m10/85/en"]);
    // Each negation is the plain complement: `-is:mtgoid` 55,191 of 118,378.
    assert_eq!(printings(&store, &not(is("mtgoid"))), ["8ed/S5a/en", "cmr/566/en", "hbg/911/en"]);
    assert_eq!(printings(&store, &not(is("tcgplayer"))), ["8ed/S5a/en", "cmr/566/en", "hbg/911/en"]);
    assert_eq!(printings(&store, &not(is("arenaid"))), ["8ed/S5a/en", "cmr/566/en", "inr/287/en", "m10/85/en"]);
}

#[test]
fn an_illustration_is_the_printings_or_a_faces_and_an_image_is_any_status_but_missing() {
    // is:illustration 117,615 and its negation 763: an `illustration_id` on the printing or on
    // a face. Westvale Abbey carries one per face and none of its own; the art card astx/66s one
    // on its front alone; the playtest card unk/MZ05a none at all.
    //
    // is:image 118,216 and its negation 162 — `image_status: missing`, which astx/66s is.
    // is:placeholderimage 573 — `image_status: placeholder`, Vaevictis Asmadi's bchr/89.
    let store = store_from(&[
        "black_knight_m10_85",
        "westvale_abbey_inr_287",
        "memory_lapse_astx_66s",
        "the_convincing_general_unk_mz05a",
        "vaevictis_asmadi_bchr_89",
    ]);
    assert_eq!(printings(&store, &is("illustration")), ["astx/66s/en", "bchr/89/ja", "inr/287/en", "m10/85/en"]);
    assert_eq!(printings(&store, &not(is("illustration"))), ["unk/MZ05a/en"]);
    assert_eq!(printings(&store, &is("image")), ["bchr/89/ja", "inr/287/en", "m10/85/en", "unk/MZ05a/en"]);
    assert_eq!(printings(&store, &not(is("image"))), ["astx/66s/en"]);
    assert_eq!(printings(&store, &is("placeholderimage")), ["bchr/89/ja"]);
    assert_eq!(printings(&store, &not(is("placeholderimage"))).len(), 4);
}

#[test]
fn printed_text_is_the_printings_or_its_first_faces_and_widens_either_way() {
    // is:printedtext, 364,982 rows — a `printed_text` on the printing (Shock's Japanese m20/159,
    // Karma's German fbb/26) or on its FIRST face (Delver of Secrets' Spanish isd/51, which
    // carries it per face). ANY face is 82 rows too many: the Japanese Tuinvale Treefolk // Oaken
    // Boon prints rules text on its adventure alone, the creature half having none, and is not
    // counted. Karma's Italian 3ed/26 carries no printed text at all.
    //
    // No `lang:` is written and the annex rows answer (fbb/26 in German): the term switches
    // include_multilingual on, and so does its negation — 364,982 and 180,196, every row of
    // every language between them.
    let store = store_of(&[
        ("shock_ja", true),
        ("delver_es", true),
        ("karma_3ed_26", true),
        ("karma_3ed_26_it", false),
        ("karma_fbb_26_de", false),
        ("tuinvale_treefolk_eld_180", true),
        ("tuinvale_treefolk_eld_180_ja", false),
    ]);
    assert_eq!(printings(&store, &is("printedtext")), ["fbb/26/de", "isd/51/es", "m20/159/ja"]);
    assert_eq!(printings(&store, &not(is("printedtext"))), ["3ed/26/en", "3ed/26/it", "eld/180/en", "eld/180/ja"]);
}

#[test]
fn english_art_and_paper_art_are_true_of_every_row() {
    // `is:englishart lang:any` and `is:paperart lang:any` are each 545,173 — every row of every
    // language — and each negation 0; `is:paperart is:digital` is all 9,129 digital printings
    // (Ruin Crab's hbg/911 is one).
    let store = store_from(&["black_knight_m10_85", "ruin_crab_hbg_911", "vaevictis_asmadi_bchr_89"]);
    for value in ["englishart", "paperart"] {
        assert_eq!(printings(&store, &is(value)), ["bchr/89/ja", "hbg/911/en", "m10/85/en"]);
        assert_eq!(printings(&store, &not(is(value))), NONE);
    }
}

#[test]
fn a_back_is_a_card_back_that_is_not_the_ordinary_one() {
    // is:back, 3,330 printings: a `card_back_id` other than the shared Magic back. Tithe's World
    // Championship printing and the Attraction Ferris Wheel have their own; Westvale Abbey is
    // two-sided, carries no `card_back_id` at all, and is NOT one.
    //
    // is:indicator, 1,002: a colour indicator on the printing (Wheel of Fate, which has no mana
    // cost) or on a face (Ormendahl, Westvale Abbey's back). is:attractionlights, 135.
    let store = store_from(&[
        "tithe_wc98_bh23a",
        "ferris_wheel_unf_210",
        "westvale_abbey_inr_287",
        "wheel_of_fate_tsp_187",
        "black_knight_m10_85",
    ]);
    assert_eq!(printings(&store, &is("back")), ["unf/210/en", "wc98/bh23a/en"]);
    assert_eq!(printings(&store, &is("indicator")), ["inr/287/en", "tsp/187/en"]);
    assert_eq!(printings(&store, &is("attractionlights")), ["unf/210/en"]);
    assert_eq!(printings(&store, &not(is("back"))), ["inr/287/en", "m10/85/en", "tsp/187/en"]);
}

#[test]
fn foreign_black_border_is_a_set_and_a_language_and_foreign_white_border_widens() {
    // is:fbb — every row of fbb, bchr, ren and rin, and of 4bb all but the Korean and Chinese
    // ones (`is:fbb lang:ko e:4bb` is 0 of 370). With no `lang:` it is the canonical rows.
    //
    // is:fwb — Revised's German, French and Italian rows, 917, none of them canonical, and
    // answered with no `lang:` written: unnegated it WIDENS the search to every language for the
    // whole query (`is:fwb or (e:khm t:god)` is 1,062, every language of the gods). Negated it
    // does not: `-is:fwb` is the 118,378 canonical rows.
    let store = store_of(&[
        ("fortified_area_4bb_26_es", true),
        ("fortified_area_4bb_26_ko", false),
        ("karma_fbb_26_de", false),
        ("karma_3ed_26", true),
        ("karma_3ed_26_it", false),
        ("vaevictis_asmadi_bchr_89", true),
    ]);
    assert_eq!(printings(&store, &is("fbb")), ["4bb/26/es", "bchr/89/ja"]);
    assert_eq!(rows(&store, &is("fbb"), true), ["4bb/26/es", "bchr/89/ja", "fbb/26/de"]);
    assert_eq!(printings(&store, &is("fwb")), ["3ed/26/it"]);
    assert_eq!(printings(&store, &not(is("fwb"))), ["3ed/26/en", "4bb/26/es", "bchr/89/ja"]);
    assert_eq!(
        rows(&store, &not(is("fwb")), true),
        ["3ed/26/en", "4bb/26/es", "4bb/26/ko", "bchr/89/ja", "fbb/26/de"]
    );
    // The widening is the whole query's: every row of every language that is either.
    assert_eq!(
        printings(&store, &or(vec![is("fwb"), is("fbb")])),
        ["3ed/26/it", "4bb/26/es", "bchr/89/ja", "fbb/26/de"]
    );
    // A double negation is unnegated again.
    assert_eq!(printings(&store, &not(not(is("fwb")))), ["3ed/26/it"]);
}

#[test]
fn an_un_set_is_twelve_set_codes() {
    // is:unset, 1,411: every printing of ugl, unh, ust, und, unf and of sunf, tunf, tund, tust,
    // punh, pust and ulst. Unglued's own token set (tugl) hangs off an Un-set and is not one.
    let store = store_from(&["little_girl_unh_16", "dragon_tust_16", "ferris_wheel_unf_210", "sheep_tugl_93", "black_knight_m10_85"]);
    assert_eq!(printings(&store, &is("unset")), ["tust/16/en", "unf/210/en", "unh/16/en"]);
}

#[test]
fn tron_and_the_verges_are_lists_of_names() {
    // is:tron, 96 printings of three names. is:vergeland, 45 of ten: Krosan Verge is a land
    // named Verge and not of the cycle.
    let store = store_from(&["urzas_tower_me4_259a", "blazemire_verge_dsk_256", "krosan_verge_c18_263"]);
    assert_eq!(printings(&store, &is("tron")), ["me4/259a/en"]);
    assert_eq!(printings(&store, &is("vergeland")), ["dsk/256/en"]);
}

#[test]
fn timeshifted_is_the_old_frame_sheets_and_moonlit_is_a_promo_type() {
    // is:timeshifted, 247: every printing of tsb; tsr's 1997-frame printings — its `special`
    // sheet and the retro buy-a-box Lotus Bloom, which is `rare`; and The List's reprints that
    // keep the `special` rarity (Coalition Victory's plst/TSB-91 — Undead Warchief's plst/TSB-52
    // is `rare` and out). Char-Rumbler's tsr/158 is Time Spiral Remastered in the modern frame.
    let store = store_from(&[
        "jasmine_boreal_tsb_93",
        "lotus_bloom_tsr_411",
        "coalition_victory_plst_tsb_91",
        "undead_warchief_plst_tsb_52",
        "char_rumbler_tsr_158",
        "mountain_vow_411",
    ]);
    assert_eq!(printings(&store, &is("timeshifted")), ["plst/TSB-91/en", "tsb/93/en", "tsr/411/en"]);
    // is:moonlitland, 5: the `moonlitland` promo type.
    assert_eq!(printings(&store, &is("moonlitland")), ["vow/411/en"]);
}
