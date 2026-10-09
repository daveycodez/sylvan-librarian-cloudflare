//! Scryfall's `new:` values through the whole native pipeline: Scryfall JSON → transform →
//! finalize → store → query. Real card objects (the fixtures are card objects verbatim), asked the
//! tree the parser emits for `is:new<value>`, the spelling the compat surface writes each term as.
//!
//! The rule is one shape for every value — per card and group, over the canonical rows that are
//! eligible, the first by (release date, release batch, the collector number's digits as one
//! integer, variation last, Scryfall id), flagged whether or not it is a variation — and was
//! measured on api.scryfall.com 2026-10-09 by reading each whole list, and again with
//! `include_variations=true`, which is what shows the variations a search hides by default;
//! card_engine's `assign_new_flags` carries the evidence for each clause. The engine is asked
//! directly here, with no route's `-is:variation` gate, so a flagged variation is in the answer. What is pinned here is that rule on the rows the
//! fixtures hold: each pair one clause, and each winner the printing Scryfall's own list holds.
//! `new:rarity` is older and has its own file, x72_new_rarity.rs.

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
    let out_dir = std::env::temp_dir().join(format!("sylvan-new-flags-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
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

/// Every PRINTING the tree matches, EVERY LANGUAGE, as sorted `set/number/lang` addresses.
fn rows(store: &BufferStore, tree: &Value) -> Vec<String> {
    let opts = QueryOptions {
        unique: "printing".to_owned(),
        orderby: "name".to_owned(),
        include_multilingual: true,
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

#[test]
fn new_card_is_the_first_paper_printing_outside_memorabilia_in_the_measured_order() {
    let store = store_of(&[
        // PAPER: Rusko, Clockmaker was an Arena card for two years before Mystery Booster 2
        // printed it — `ybro/24` is its first printing and `mb2/263` its `new:card`.
        ("rusko_clockmaker_ybro_24", true),
        ("rusko_clockmaker_mb2_263", true),
        // MEMORABILIA is outside: Mirror Mirror's 1998 oversized `olep/48` precedes Unglued.
        ("mirror_mirror_olep_48", true),
        ("mirror_mirror_ugl_77", true),
        // THE RELEASE BATCH before the number and the id: `4bb` is 1995-04-01's later batch, so
        // `4ed/49` leads though `4bb/49`'s id is lower.
        ("seeker_4ed_49", true),
        ("seeker_4bb_49_es", true),
        // THE SET CODE IS NOT A KEY: Revised and Foreign Black Border share a date and a batch,
        // and the id decides — `fbb/248` for Flying Carpet.
        ("flying_carpet_3ed_248", true),
        ("flying_carpet_fbb_248_fr", true),
        // A VARIATION sorts after its plain twin: `ons/200★` carries the lower id.
        ("embermage_goblin_ons_200", true),
        ("embermage_goblin_ons_200_star", true),
        // THE ANNEX never answers: the Russian `rav/186` carries the lower id.
        ("transluminant_rav_186", true),
        ("transluminant_rav_186_ru", false),
        // THE ONE MEASURED LEAD (`NEW_ORDER_LEADS`): of Orb of Dragonkind's three Japanese
        // promos Scryfall answers J2, where the number and the id both say J1.
        ("orb_of_dragonkind_plg21_j1_ja", true),
        ("orb_of_dragonkind_plg21_j2_ja", true),
        ("orb_of_dragonkind_plg21_j3_ja", true),
    ]);
    assert_eq!(
        rows(&store, &is("newcard")),
        ["4ed/49/en", "fbb/248/fr", "mb2/263/en", "ons/200/en", "plg21/J2/ja", "rav/186/en", "ugl/77/en"]
    );
    // Two-valued: the negation is every other row of every language.
    assert_eq!(
        rows(&store, &not(is("newcard"))),
        [
            "3ed/248/en",
            "4bb/49/es",
            "olep/48/en",
            "ons/200★/en",
            "plg21/J1/ja",
            "plg21/J3/ja",
            "rav/186/ru",
            "ybro/24/en",
        ]
    );
}

#[test]
fn new_frame_is_the_first_printing_in_each_frame_digital_printings_too() {
    let store = store_of(&[
        // ONE GROUP A FRAME: Soltari Priest is new in the 1997 frame in Tempest and in the 2003
        // frame as a 2007 promo; its Time Spiral reprint keeps the old frame and is not.
        ("soltari_priest_tmp_46", true),
        ("soltari_priest_tsb_14", true),
        // THE COLLECTOR NUMBER IS ITS DIGITS AS ONE INTEGER: `psus/14` and the Japanese
        // `pjjt/1N07` share 2007-01-01 and a batch, and 14 is before 107 — the number's first
        // integer, 1, and the id both say `pjjt`.
        ("soltari_priest_psus_14", true),
        ("soltari_priest_pjjt_1n07_ja", true),
        // A VARIATION THAT LEADS IS NEW: Zombify's Simplified Chinese `ody/171†` is the only row
        // its card has in the 2015 frame before 2018 — `new:frame` on api.scryfall.com with
        // `include_variations=true`, hidden without — and `a25/116` after it is not, either way.
        ("zombify_ody_171", true),
        ("zombify_ody_171_dagger_zhs", true),
        ("zombify_a25_116", true),
        // DIGITAL printings are eligible here: the Arena `ybro/24` is Rusko's first in its frame.
        ("rusko_clockmaker_ybro_24", true),
        ("rusko_clockmaker_mb2_263", true),
        // MEMORABILIA is outside.
        ("mirror_mirror_olep_48", true),
        ("mirror_mirror_ugl_77", true),
    ]);
    assert_eq!(
        rows(&store, &is("newframe")),
        ["ody/171/en", "ody/171†/zhs", "psus/14/en", "tmp/46/en", "ugl/77/en", "ybro/24/en"]
    );
    assert_eq!(rows(&store, &not(is("newframe"))), ["a25/116/en", "mb2/263/en", "olep/48/en", "pjjt/1N07/ja", "tsb/14/en"]);
}

#[test]
fn new_mtgo_is_the_first_printing_whose_games_hold_mtgo() {
    let store = store_of(&[
        // A DIGITAL printing: Thermokarst reached Magic Online in Masters Edition II.
        ("thermokarst_ice_268", true),
        ("thermokarst_me2_183", true),
        // ...OR A PAPER ONE that lists the game: Jasmine Boreal's Time Spiral timeshifted printing.
        ("jasmine_boreal_leg_233", true),
        ("jasmine_boreal_tsb_93", true),
        // One a card: Corpse Traders' first is `avr/90`, and `ddm/58` lists the game too.
        ("corpse_traders_avr_90", true),
        ("corpse_traders_ddm_58", true),
        ("corpse_traders_jmp_220", true),
        // An Arena-only card has none.
        ("rusko_clockmaker_ybro_24", true),
    ]);
    assert_eq!(rows(&store, &is("newmtgo")), ["avr/90/en", "me2/183/en", "tsb/93/en"]);
    assert_eq!(
        rows(&store, &not(is("newmtgo"))),
        ["ddm/58/en", "ice/268/en", "jmp/220/en", "leg/233/en", "ybro/24/en"]
    );
}

#[test]
fn new_arena_is_the_first_printing_whose_games_hold_arena() {
    let store = store_of(&[
        // A DIGITAL printing: Feeling of Dread reached Arena in Shadows of the Past.
        ("feeling_of_dread_isd_14", true),
        ("feeling_of_dread_sis_7", true),
        // ...OR A PAPER ONE that lists the game: Corpse Traders' Jumpstart printing.
        ("corpse_traders_avr_90", true),
        ("corpse_traders_ddm_58", true),
        ("corpse_traders_jmp_220", true),
        // A card that began there: the Arena `ybro/24` and not the paper `mb2/263`.
        ("rusko_clockmaker_ybro_24", true),
        ("rusko_clockmaker_mb2_263", true),
    ]);
    assert_eq!(rows(&store, &is("newarena")), ["jmp/220/en", "sis/7/en", "ybro/24/en"]);
    assert_eq!(rows(&store, &not(is("newarena"))), ["avr/90/en", "ddm/58/en", "isd/14/en", "mb2/263/en"]);
}

#[test]
fn new_astral_is_the_first_printing_whose_games_hold_astral() {
    // The game is not in the packed `games` byte: the importer's `game_astral` tag holds it.
    let store = store_of(&[
        ("astral_past_1", true),
        ("astral_past_2", true),
        ("sega_psdg_1_ja", true),
        ("rusko_clockmaker_ybro_24", true),
        ("thermokarst_ice_268", true),
    ]);
    assert_eq!(rows(&store, &is("newastral")), ["past/1/en", "past/2/en"]);
    assert_eq!(rows(&store, &not(is("newastral"))), ["ice/268/en", "psdg/1/ja", "ybro/24/en"]);
}

#[test]
fn new_sega_is_the_first_printing_whose_games_hold_sega() {
    // As `astral`: the importer's `game_sega` tag. The ten cards are Japanese, canonical rows.
    let store = store_of(&[
        ("sega_psdg_1_ja", true),
        ("sega_psdg_2_ja", true),
        ("astral_past_1", true),
        ("rusko_clockmaker_ybro_24", true),
        ("thermokarst_ice_268", true),
    ]);
    assert_eq!(rows(&store, &is("newsega")), ["psdg/1/ja", "psdg/2/ja"]);
    assert_eq!(rows(&store, &not(is("newsega"))), ["ice/268/en", "past/1/en", "ybro/24/en"]);
}

#[test]
fn new_game_is_the_first_printing_in_any_game() {
    let store = store_of(&[
        // First in paper and on Magic Online, first on Arena, and first nowhere.
        ("corpse_traders_avr_90", true),
        ("corpse_traders_ddm_58", true),
        ("corpse_traders_jmp_220", true),
        // A card that began on Arena: both its printings lead a game.
        ("rusko_clockmaker_ybro_24", true),
        ("rusko_clockmaker_mb2_263", true),
        // Paper in Ice Age, Magic Online in Masters Edition II.
        ("thermokarst_ice_268", true),
        ("thermokarst_me2_183", true),
        // The two games the packed byte does not hold.
        ("astral_past_1", true),
        ("sega_psdg_1_ja", true),
        // MEMORABILIA is outside in every game.
        ("mirror_mirror_olep_48", true),
        ("mirror_mirror_ugl_77", true),
    ]);
    assert_eq!(
        rows(&store, &is("newgame")),
        [
            "avr/90/en",
            "ice/268/en",
            "jmp/220/en",
            "mb2/263/en",
            "me2/183/en",
            "past/1/en",
            "psdg/1/ja",
            "ugl/77/en",
            "ybro/24/en"
        ]
    );
    assert_eq!(rows(&store, &not(is("newgame"))), ["ddm/58/en", "olep/48/en"]);
}

#[test]
fn new_foil_is_the_first_paper_printing_in_foil() {
    let store = store_of(&[
        // Tempest had no foils: Soltari Priest's first is the 2002 promo `f02/1`.
        ("soltari_priest_tmp_46", true),
        ("soltari_priest_f02_1", true),
        ("soltari_priest_tsb_14", true),
        // PAPER ONLY: Thermokarst's one foil is Magic Online's `me2/183`, and it has none.
        ("thermokarst_ice_268", true),
        ("thermokarst_me2_183", true),
        // Of one date, the printing that has the finish: the surge foil `40k/153★`.
        ("canoptek_wraith_40k_153", true),
        ("canoptek_wraith_40k_153_star", true),
        ("jasmine_boreal_leg_233", true),
        ("jasmine_boreal_tsb_93", true),
        // A VARIATION THAT LEADS IS NEW: Onslaught's foils of Embermage Goblin are the variation
        // `ons/200★` and Shadows over Innistrad's of Tamiyo's Journal the variation `soi/265†d`,
        // their plain twins nonfoil only — both `new:foil` on api.scryfall.com with
        // `include_variations=true`, and the two cards have none without.
        ("embermage_goblin_ons_200", true),
        ("embermage_goblin_ons_200_star", true),
        ("tamiyos_journal_soi_265", true),
        ("tamiyos_journal_soi_265_dagger_d", true),
    ]);
    assert_eq!(rows(&store, &is("newfoil")), ["40k/153★/en", "f02/1/en", "ons/200★/en", "soi/265†d/en", "tsb/93/en"]);
    assert_eq!(
        rows(&store, &not(is("newfoil"))),
        ["40k/153/en", "ice/268/en", "leg/233/en", "me2/183/en", "ons/200/en", "soi/265/en", "tmp/46/en", "tsb/14/en"]
    );
}

#[test]
fn new_nonfoil_is_the_first_paper_printing_in_nonfoil() {
    let store = store_of(&[
        // A card first printed in foil: the prerelease promo `pbng/31★` is foil only, and the
        // set's `bng/31` six days later is the first nonfoil.
        ("arbiter_of_the_ideal_pbng_31_star", true),
        ("arbiter_of_the_ideal_bng_31", true),
        // Of one date, the printing that has the finish: `40k/153`, not the surge foil.
        ("canoptek_wraith_40k_153", true),
        ("canoptek_wraith_40k_153_star", true),
        // PAPER ONLY: Rusko's Arena printing lists `nonfoil` and is not eligible, and its one
        // paper printing is foil — the card has no `new:nonfoil`.
        ("rusko_clockmaker_ybro_24", true),
        ("rusko_clockmaker_mb2_263", true),
        ("soltari_priest_tmp_46", true),
        ("soltari_priest_f02_1", true),
        // A VARIATION SORTS AFTER ITS PLAIN TWIN, and one row a group is new: Tamiyo's Journal's
        // `soi/265` and its variation `soi/265†a` are both nonfoil, of one day, and the plain one
        // is the answer with variations shown or hidden (`†d` is foil only).
        ("tamiyos_journal_soi_265", true),
        ("tamiyos_journal_soi_265_dagger_a", true),
        ("tamiyos_journal_soi_265_dagger_d", true),
    ]);
    assert_eq!(rows(&store, &is("newnonfoil")), ["40k/153/en", "bng/31/en", "soi/265/en", "tmp/46/en"]);
    assert_eq!(
        rows(&store, &not(is("newnonfoil"))),
        ["40k/153★/en", "f02/1/en", "mb2/263/en", "pbng/31★/en", "soi/265†a/en", "soi/265†d/en", "ybro/24/en"]
    );
}

#[test]
fn new_art_is_the_first_printing_of_each_artwork_across_cards() {
    let store = store_of(&[
        // A reprint of the same painting is not new.
        ("thermokarst_ice_268", true),
        ("thermokarst_me2_183", true),
        // THE GROUP CROSSES CARDS: Alchemy's Gate to Manorborn reuses Manor Gate's painting a
        // month later, and has no new art of its own.
        ("manor_gate_clb_356", true),
        ("gate_to_manorborn_hbg_78", true),
        // A VARIATION sorts after every plain row of its date and batch, whatever the numbers:
        // Mirage's Spanish misprint `mir/87†` carries Shaper Guildmage's artwork and a lower
        // number than `mir/91`, and `mir/91` is the new one.
        ("shaper_guildmage_mir_91", true),
        ("reality_ripple_mir_87_dagger_es", true),
        // A VARIATION THAT LEADS IS NEW: Embermage Goblin's foil `ons/200★` is a variation with
        // a painting of its own, and both it and `ons/200` are `new:art` on api.scryfall.com with
        // `include_variations=true` — one of the 17 variations that list holds.
        ("embermage_goblin_ons_200", true),
        ("embermage_goblin_ons_200_star", true),
        // NO ILLUSTRATION IS ONE GROUP, corpus-wide: the first such row is new — Scars of
        // Mirrodin's poison counter — and no other, of its card or of any.
        ("poison_counter_tsom_10", true),
        ("poison_counter_tmbs_6", true),
        ("innistrad_checklist_tisd_13", true),
        // MEMORABILIA is outside but for two sets: the Legacy Championship's oversized Plateau
        // is new, the Vintage Championship's Ancestral Recall is not.
        ("plateau_olgc_2018a", true),
        ("ovnt_2018", true),
        // A MEASURED TIE LEAD (`NEW_TIE_LEADS`): `ltr/401` over its prerelease twin, whose id is
        // the lower.
        ("gandalf_ltr_401", true),
        ("gandalf_pltr_401s", true),
        // SERIALIZED printings count here, where `new:flavor` leaves them out: the schematic
        // `brr/91z` carries the lower id and is the new one.
        ("liquimetal_coating_som_171", true),
        ("liquimetal_coating_brr_28", true),
        ("liquimetal_coating_brr_91", true),
        ("liquimetal_coating_brr_91z", true),
    ]);
    assert_eq!(
        rows(&store, &is("newart")),
        [
            "brr/91z/en",
            "clb/356/en",
            "ice/268/en",
            "ltr/401/en",
            "mir/91/en",
            "olgc/2018A/en",
            "ons/200/en",
            "ons/200★/en",
            "som/171/en",
            "tsom/10/en"
        ]
    );
    assert_eq!(
        rows(&store, &not(is("newart"))),
        [
            "brr/28/en",
            "brr/91/en",
            "hbg/78/en",
            "me2/183/en",
            "mir/87†/es",
            "ovnt/2018/en",
            "pltr/401s/en",
            "tisd/13/en",
            "tmbs/6/en"
        ]
    );
    // The builder's mark is not a stored tag: the engine's build turned it into the bit.
    assert_eq!(rows(&store, &is("new_art")), [] as [&str; 0]);
}

#[test]
fn new_language_is_the_first_printing_in_each_language_over_the_annex_too() {
    let store = store_of(&[
        // EVERY ROW OF THE CARD, the annex too: Transluminant's English `rav/186` is the canonical
        // row and its Russian edition an annex row, and each is the first in its language.
        ("transluminant_rav_186", true),
        ("transluminant_rav_186_ru", false),
        // One a language, by the order: Counterspell in Japanese is first `cmm/81` (2023), not
        // `cmm/630` of the same day nor `dsc/114` a year on — all three annex rows — and in
        // English `cmm/81` again.
        ("counterspell_cmm_81", true),
        ("counterspell_cmm_81_ja", false),
        ("counterspell_cmm_630_ja", false),
        ("counterspell_dsc_114", true),
        ("counterspell_dsc_114_ja", false),
        // THE RELEASE BATCH: Hour of Devastation and its promo set share 2017-07-14, `phou` is the
        // date's later batch, and `hou/83` leads though `phou/83` carries the lower id — one of
        // the eleven set pairs the 2026-10-04 measurement could not place.
        ("abrade_hou_83", true),
        ("abrade_phou_83", true),
        // MEMORABILIA is outside.
        ("mirror_mirror_olep_48", true),
        ("mirror_mirror_ugl_77", true),
        // SERIALIZED printings are outside: `brr/91z` carries the lower id.
        ("liquimetal_coating_brr_91", true),
        ("liquimetal_coating_brr_91z", true),
        // A VARIATION SORTS AFTER ITS PLAIN TWIN: Zombify's Simplified Chinese `ody/171` (an annex
        // row) leads its language, not the Simplified Chinese misprint `ody/171†` of the same day
        // (a canonical row, a variation). No variation leads a language anywhere:
        // `new:language is:variation lang:any` is 0 on api.scryfall.com.
        ("zombify_ody_171", true),
        ("zombify_ody_171_zhs", false),
        ("zombify_ody_171_dagger_zhs", true),
    ]);
    assert_eq!(
        rows(&store, &is("newlanguage")),
        [
            "brr/91/en",
            "cmm/81/en",
            "cmm/81/ja",
            "hou/83/en",
            "ody/171/en",
            "ody/171/zhs",
            "rav/186/en",
            "rav/186/ru",
            "ugl/77/en"
        ]
    );
    assert_eq!(
        rows(&store, &not(is("newlanguage"))),
        ["brr/91z/en", "cmm/630/ja", "dsc/114/en", "dsc/114/ja", "ody/171†/zhs", "olep/48/en", "phou/83/en"]
    );
}

#[test]
fn new_flavor_is_the_first_printing_with_each_flavor_text_as_scryfall_compares_them() {
    let store = store_of(&[
        // CASE: Visions capitalises "Sandstalkers" where the 1996 Multiverse Gift Box does not.
        ("viashino_sandstalker_mgb_8", true),
        ("viashino_sandstalker_vis_100", true),
        // ASCII PUNCTUATION, and the release batch: the prerelease promo adds a comma to "into
        // myself, I felt" and is the date's later batch.
        ("one_with_the_machine_m19_66", true),
        ("one_with_the_machine_pm19_66s", true),
        // ACCENTS AND LIGATURES: "Æther" in Magic 2013 and "aether" in the 2017 duel deck are one
        // text; Amonkhet's between them is another.
        ("essence_scatter_m13_50", true),
        ("essence_scatter_akh_52", true),
        ("essence_scatter_ddt_6", true),
        // NOT EVERY DASH: ddl/69 and c16/141 attribute with an em dash, cn2/174 with a horizontal
        // bar, and the bar makes a new text.
        ("beast_within_ddl_69", true),
        ("beast_within_cn2_174", true),
        ("beast_within_c16_141", true),
        // SERIALIZED printings are outside: `brr/91z` carries the lower id and `brr/91` is new.
        // `brr/28` reprints Scars of Mirrodin's text.
        ("liquimetal_coating_som_171", true),
        ("liquimetal_coating_brr_28", true),
        ("liquimetal_coating_brr_91", true),
        ("liquimetal_coating_brr_91z", true),
        // A FLAVOR ONLY THE BACK FACE HAS leads without being flagged: `fin/133` prints Clive's
        // line on the back, `fin/385` the same line on the front, and neither is new.
        ("clive_fin_133", true),
        ("clive_fin_385", true),
        // A VARIATION THAT LEADS IS NEW: Tamiyo's Journal was printed with six journal entries,
        // five of them variations, and each is the first printing of its own text — `soi/265†a`
        // through `†e` are `new:flavor` on api.scryfall.com with `include_variations=true`.
        ("tamiyos_journal_soi_265", true),
        ("tamiyos_journal_soi_265_dagger_a", true),
        ("tamiyos_journal_soi_265_dagger_d", true),
    ]);
    assert_eq!(
        rows(&store, &is("newflavor")),
        [
            "akh/52/en",
            "brr/91/en",
            "cn2/174/en",
            "ddl/69/en",
            "m13/50/en",
            "m19/66/en",
            "mgb/8/en",
            "soi/265/en",
            "soi/265†a/en",
            "soi/265†d/en",
            "som/171/en"
        ]
    );
    assert_eq!(
        rows(&store, &not(is("newflavor"))),
        [
            "brr/28/en",
            "brr/91z/en",
            "c16/141/en",
            "ddt/6/en",
            "fin/133/en",
            "fin/385/en",
            "pm19/66s/en",
            "vis/100/en"
        ]
    );
}
