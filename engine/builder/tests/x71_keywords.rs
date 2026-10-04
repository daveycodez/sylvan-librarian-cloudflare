//! The Scryfall search keywords x71 gave an answer to, through the whole native pipeline: Scryfall
//! JSON → transform → finalize → store → query. Real card objects (the fixtures are card objects
//! verbatim), each keyword asked the tree the parser emits for it.
//!
//! What is pinned here is the RULE each keyword follows, on the printings the fixtures hold — the
//! corpus-wide measurements on api.scryfall.com (2026-10-04) are recorded beside each keyword in
//! card_engine's filter.rs and lib.rs, and compared live by scripts/live-parity-cases.json.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A store of exactly these card objects, English rows canonical and the rest in the annex — the
/// split the importer makes. One directory per CALL: the tests run on parallel threads.
fn store_of(cards: &[Value]) -> BufferStore {
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let drafts = cards.iter().map(|c| transform_row(c, c["lang"] == "en").unwrap().unwrap()).collect();
    let rows: Vec<Value> = finalize(drafts, &TagData::default()).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-x71-keywords-{}-{build}", std::process::id()));
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

/// `<spelling><op><word>` on a text column, the value as a plain string.
fn text(column: &str, spelling: &str, op: &str, value: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {"lhs": attribute(column, spelling), "op": op, "rhs": {"node_type": "StringValueNode", "kwargs": {"value": value}}},
    })
}

fn lore(value: &str) -> Value {
    text("lore", "lore", ":", value)
}

fn not(operand: Value) -> Value {
    json!({"node_type": "NotNode", "kwargs": {"operand": operand}})
}

/// Every PRINTING the tree matches, every language, as sorted `set/number/lang` addresses.
fn printings(store: &BufferStore, tree: &Value) -> Vec<String> {
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

const NONE: [&str; 0] = [];

// ── lore: ───────────────────────────────────────────────────────────────────────────────────────

#[test]
fn lore_reads_the_name_as_printed() {
    // `lore:ft e:khm` is 22 on api.scryfall.com where the collated `name:ft` reaches every
    // "… oF The …" (Jarl of the Forsaken) and makes the four-column union 41. Lumra, Bellow of
    // the Woods holds "ft" nowhere but across that space.
    let store = store_from(&["lumra_bellow_of_the_woods_blb_183", "valki_khm_114"]);
    assert_eq!(printings(&store, &lore("ft")), NONE);
    assert_eq!(printings(&store, &lore("of the")), ["blb/183/en"]);
    assert_eq!(printings(&store, &lore("LUMRA, bellow")), ["blb/183/en"]);
    // The collated name does reach it — the reading `lore:` does not take.
    let collated = json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {"lhs": attribute("card_name", "name"), "op": ":", "rhs": {"node_type": "CollatedNameValueNode", "kwargs": {"value": "ft"}}},
    });
    assert_eq!(printings(&store, &collated), ["blb/183/en"]);
    // The two faces' names are one name, joined: `lore:" // " e:khm` is its 16 two-faced cards.
    assert_eq!(printings(&store, &lore("lies // tibalt")), ["khm/114/en"]);
    assert_eq!(printings(&store, &lore(" // ")), ["khm/114/en"]);
}

#[test]
fn lore_reads_the_oracle_text_without_reminder_text_and_a_tilde_is_a_tilde() {
    // `lore:"after your draw step" e:khm` is 0 (the Sagas' reminder text) and `lore:~` is 2 — the
    // two Phyrexian flavor texts — where `o:~` is 20,181.
    let store = store_from(&["lightning_bolt", "heart_of_kiran_aer_153"]);
    assert_eq!(printings(&store, &lore("deals 3 damage")), ["msc/806/en"]);
    assert_eq!(printings(&store, &lore("crew 3")), ["aer/153/en"]);
    assert_eq!(printings(&store, &lore("tap any number of creatures")), NONE);
    assert_eq!(printings(&store, &lore("~")), NONE);
    assert_eq!(printings(&store, &lore("~ deals 3 damage")), NONE);
    assert_eq!(printings(&store, &text("oracle_text", "o", ":", "~ deals 3 damage")), ["msc/806/en"]);
}

#[test]
fn lore_reads_the_type_line_as_a_plain_substring() {
    // `lore:god` is 486 against the 468 of `(name:/god/ or ft:god or o:god or t:god)`: every
    // DemiGOD, which `t:god` anchors past. Callaphe holds "god" nowhere else.
    let store = store_from(&["callaphe_thb_45", "valki_khm_114", "jace_the_mind_sculptor"]);
    assert_eq!(printings(&store, &lore("god")), ["khm/114/en", "thb/45/en"]);
    let t_god = json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {"lhs": attribute("card_types", "t"), "op": ":", "rhs": ["god"]},
    });
    assert_eq!(printings(&store, &t_god), ["khm/114/en"]);
    // The faces' lines are one line: `lore:"god // legendary" e:khm` is its 12 Gods.
    assert_eq!(printings(&store, &lore("god // legendary")), ["khm/114/en"]);
    assert_eq!(printings(&store, &lore("creature — demi")), ["thb/45/en"]);
}

#[test]
fn lore_reads_the_printings_own_flavor_text_and_not_its_printed_name_or_text() {
    // Of the German printings holding "blitz", `lore:blitz lang:de` is the 143 that hold it in
    // the flavor text, the English name or the English oracle text — none of the 1,062 that hold
    // it only in `printed_text`, none of the 38 only in `printed_name`. Delver of Secrets isd/51
    // in Spanish prints "Ahondador de secretos", "Vuela." and "Transformado por la iluminación."
    // (The two Delver fixtures carry different oracle ids — isd/51 predates the errata that split
    // them — so the Spanish row is given the English one's.)
    let english = fixture("delver_of_secrets");
    let mut spanish = fixture("delver_es");
    spanish["oracle_id"] = english["oracle_id"].clone();
    let store = store_of(&[english, spanish, fixture("lightning_bolt")]);
    assert_eq!(printings(&store, &lore("iluminación")), ["isd/51/es"]);
    assert_eq!(printings(&store, &lore("iluminacion")), NONE);
    assert_eq!(printings(&store, &lore("ahondador")), NONE);
    assert_eq!(printings(&store, &lore("vuela")), NONE);
    assert_eq!(printings(&store, &lore("criatura")), NONE);
    // The English name and oracle text are every printing's.
    assert_eq!(printings(&store, &lore("delver of")), ["inr/60/en", "isd/51/es"]);
    assert_eq!(printings(&store, &lore("upkeep")), ["inr/60/en", "isd/51/es"]);
    // Flavor text is the printing's, per face: the English back face's is not the Spanish row's.
    assert_eq!(printings(&store, &lore("test animals")), ["inr/60/en"]);
    assert_eq!(printings(&store, &lore("god of thunder")), ["msc/806/en"]);
}

#[test]
fn lore_reads_the_flavor_name_literally_and_per_face() {
    // `lore:"théoden, strength restored"` is 1 and `lore:"theoden, strength restored"` 0;
    // `lore:"THÉODEN, strength restored"` is 1. Kenrith, the Returned King ltc/515 is sold under
    // that name; Doubling Cube sld/1080 prints "The AllSpark" on both faces, and
    // `lore:"lord of blood // dracula"` — two face names joined — is 0 where each alone is 1.
    let store = store_from(&["kenrith_ltc_515", "doubling_cube_sld_1080", "doubling_cube_10e_321", "doubling_cube_5dn_116"]);
    assert_eq!(printings(&store, &lore("théoden")), ["ltc/515/en"]);
    assert_eq!(printings(&store, &lore("THÉODEN, strength")), ["ltc/515/en"]);
    assert_eq!(printings(&store, &lore("theoden")), NONE);
    assert_eq!(printings(&store, &lore("allspark")), ["sld/1080/en"]);
    assert_eq!(printings(&store, &lore("allspark // the")), NONE);
    // The card's own name is every printing's.
    assert_eq!(printings(&store, &lore("doubling cube")), ["10e/321/en", "5dn/116/en", "sld/1080/en"]);
}

#[test]
fn lore_is_two_valued_and_folds_case_ae_and_runs_of_spaces() {
    // `-lore:zzzzqq e:khm` is all 305 — a printing with no flavor text is a plain False, where
    // `ft:` here answers Null for it. `lore:"god  of" e:khm` is `lore:"god of"`'s 17,
    // `lore:" of " e:khm` 174 against `lore:"of "`'s 176, and `lore:æther` is `lore:aether`.
    let store = store_from(&["lumra_bellow_of_the_woods_blb_183", "valki_khm_114", "lightning_bolt"]);
    assert_eq!(printings(&store, &not(lore("zzzzqq"))), ["blb/183/en", "khm/114/en", "msc/806/en"]);
    assert_eq!(printings(&store, &not(lore("god"))), ["blb/183/en"]);
    assert_eq!(printings(&store, &lore("god  of")), ["khm/114/en", "msc/806/en"]);
    assert_eq!(printings(&store, &lore("GOD OF")), ["khm/114/en", "msc/806/en"]);
    // "…the god of thunder…" has a space on both sides; "Valki, God of Lies" has too.
    assert_eq!(printings(&store, &lore(" god of ")), ["khm/114/en", "msc/806/en"]);
    assert_eq!(printings(&store, &lore("bellow  of   the")), ["blb/183/en"]);
    assert_eq!(printings(&store, &text("lore", "lore", "=", "bellow of")), ["blb/183/en"]);
    assert_eq!(printings(&store, &text("lore", "lore", "!=", "bellow of")), NONE);
}

#[test]
fn lore_reads_a_reversible_printing_by_the_faces_it_prints() {
    // `lore:shuffle !"Bloomvine Regent"` is 3 of the card's 4 English printings on
    // api.scryfall.com: the reversible tdm/381 prints the front face's rules text on BOTH sides,
    // so the Omen's "…then shuffle" is not on it. It answers by its own name and type line too:
    // `lore:"territory // bloomvine"` is that one printing (the three-part name), and
    // `lore:"omen // creature"` the 3 printings whose type line closes with the front face again.
    let store = store_from(&["bloomvine_regent_tdm_136", "bloomvine_regent_tdm_381"]);
    assert_eq!(printings(&store, &lore("shuffle")), ["tdm/136/en"]);
    assert_eq!(printings(&store, &lore("battlefield tapped")), ["tdm/136/en"]);
    assert_eq!(printings(&store, &lore("you gain 3 life")), ["tdm/136/en", "tdm/381/en"]);
    assert_eq!(printings(&store, &lore("territory // bloomvine")), ["tdm/381/en"]);
    assert_eq!(printings(&store, &lore("omen // creature")), ["tdm/381/en"]);
    assert_eq!(printings(&store, &lore("dragon // sorcery")), ["tdm/136/en", "tdm/381/en"]);
    assert_eq!(printings(&store, &not(lore("shuffle"))), ["tdm/381/en"]);
    // `lore:"garden // temple"` and `lore:"plains // land"` are each the one reversible Temple
    // Garden: a single-faced card printed on both sides. Doubling Cube sld/1080 is that shape.
    let store = store_from(&["doubling_cube_sld_1080", "doubling_cube_10e_321"]);
    assert_eq!(printings(&store, &lore("cube // doubling")), ["sld/1080/en"]);
    assert_eq!(printings(&store, &lore("artifact // artifact")), ["sld/1080/en"]);
}

// ── cheapest: ───────────────────────────────────────────────────────────────────────────────────

/// `cheapest:<currency>`; the compat surface writes the negated TERM as `not_<currency>`.
fn cheapest(value: &str) -> Value {
    text("cheapest", "cheapest", ":", value)
}

#[test]
fn cheapest_is_every_printing_at_the_cards_lowest_price() {
    // Doubling Cube, usd / usd_foil — eur / eur_foil — tix:
    //   10e/321       33.92 / 44.94    13.65 / 31.08    0.02
    //   5dn/116       33.65 / 76.68    12.89 / 26.14    0.02
    //   plst/10E-321  38.24 / —        18.49 / —        —
    //   sld/1080      33.37 / 27.57    17.44 / 20.10    —
    // The lowest PLAIN price decides where a printing has one: sld/1080's foil 27.57 is below
    // every plain price and does not lower the minimum — Reflections of Littjara's khm/73 is
    // 2.94 / 1.59 on api.scryfall.com and the cheapest is the foil-only khm/400 at 1.77.
    let store = store_from(&[
        "doubling_cube_10e_321",
        "doubling_cube_5dn_116",
        "doubling_cube_plst_10e_321",
        "doubling_cube_sld_1080",
    ]);
    assert_eq!(printings(&store, &cheapest("usd")), ["sld/1080/en"]);
    assert_eq!(printings(&store, &cheapest("eur")), ["5dn/116/en"]);
    // A tie is every printing at the price: `eld/1` is 0.38 / 0.38 and all cheapest.
    assert_eq!(printings(&store, &cheapest("tix")), ["10e/321/en", "5dn/116/en"]);
    // `$` and `dollar`, `euro` and `€`, `mtgo` — each measured against the plain word.
    assert_eq!(printings(&store, &cheapest("dollar")), ["sld/1080/en"]);
    assert_eq!(printings(&store, &cheapest("$")), ["sld/1080/en"]);
    assert_eq!(printings(&store, &cheapest("EURO")), ["5dn/116/en"]);
    assert_eq!(printings(&store, &cheapest("€")), ["5dn/116/en"]);
    assert_eq!(printings(&store, &cheapest("mtgo")), ["10e/321/en", "5dn/116/en"]);
    assert_eq!(printings(&store, &text("cheapest", "cheapest", "=", "usd")), ["sld/1080/en"]);
}

#[test]
fn the_negated_cheapest_term_is_not_the_complement() {
    // `-cheapest:usd e:khm` is 5 printings where `cheapest:usd e:khm` is 222 of 407: Scryfall's
    // expression is `(usd IS NULL OR usd <> M) AND (usd_foil IS NULL OR usd_foil = M)`, which
    // keeps a printing with NO foil price that is not cheapest and drops one that has both
    // prices. `-(cheapest:usd) e:khm`, the negated group, is the complement: 185.
    let store = store_from(&[
        "doubling_cube_10e_321",
        "doubling_cube_5dn_116",
        "doubling_cube_plst_10e_321",
        "doubling_cube_sld_1080",
    ]);
    assert_eq!(printings(&store, &cheapest("not_usd")), ["plst/10E-321/en"]);
    assert_eq!(printings(&store, &not(cheapest("usd"))), ["10e/321/en", "5dn/116/en", "plst/10E-321/en"]);
    assert_eq!(printings(&store, &cheapest("not_eur")), ["plst/10E-321/en"]);
    assert_eq!(printings(&store, &not(cheapest("eur"))), ["10e/321/en", "plst/10E-321/en", "sld/1080/en"]);
    // `-(-cheapest:usd) e:khm` is 402 = 407 - 5.
    assert_eq!(printings(&store, &not(cheapest("not_usd"))), ["10e/321/en", "5dn/116/en", "sld/1080/en"]);
    // tix has no foil price, and both negations are the complement: 290 + 117 = 407.
    assert_eq!(printings(&store, &cheapest("not_tix")), ["plst/10E-321/en", "sld/1080/en"]);
    assert_eq!(printings(&store, &not(cheapest("tix"))), ["plst/10E-321/en", "sld/1080/en"]);
}

#[test]
fn memorabilia_and_non_canonical_printings_are_outside_the_cheapest_minimum() {
    // Tithe: vis/23 is 36.62 and the gold-bordered wc98/bh23a 8.00 — Goblin Piledriver's
    // wc03/we205 at 2.60 beside ori/151's 2.65 on api.scryfall.com. All 334 rows priced below
    // their card's cheapest are memorabilia.
    let store = store_from(&["tithe_vis_23", "tithe_wc98_bh23a"]);
    assert_eq!(printings(&store, &cheapest("usd")), ["vis/23/en"]);
    assert_eq!(printings(&store, &cheapest("eur")), ["vis/23/en"]);
    assert_eq!(printings(&store, &cheapest("not_usd")), ["wc98/bh23a/en"]);
    // Reset: mb2/170 is 3.01, leg/73 27.90, me3/48 is priced in tix alone. The Italian leg/73
    // carries no price; given one BELOW the minimum it is Segovian Leviathan's German ren/40
    // (0.10, where the cheapest is 4ed/99 at 0.23): a row outside default_cards does not lower
    // the minimum, and answers the negated term like any other printing that is not cheapest.
    let mut italian = fixture("reset_leg_73_it");
    italian["prices"]["usd"] = json!("1.00");
    let store = store_of(&[fixture("reset_leg_73"), italian, fixture("reset_me3_48"), fixture("reset_mb2_170")]);
    assert_eq!(printings(&store, &cheapest("usd")), ["mb2/170/en"]);
    assert_eq!(printings(&store, &cheapest("not_usd")), ["leg/73/en", "leg/73/it", "me3/48/en"]);
    assert_eq!(printings(&store, &cheapest("tix")), ["me3/48/en"]);
    assert_eq!(printings(&store, &cheapest("not_tix")), ["leg/73/en", "leg/73/it", "mb2/170/en"]);
}

#[test]
fn a_foil_only_price_is_a_dollar_price_and_no_minimum_is_null() {
    // The Dragon token tust/16 is foil-only: usd — / 0.42, eur — / 0.24, and its only printing.
    // DOLLARS fall back to the foil price, so it is the card's cheapest — and, having no plain
    // price, it satisfies the negated term too: khm/400 is in both lists on api.scryfall.com.
    // EUROS do not fall back (ddu/35 at — / 17.54 is not cheapest beside c14/177's 18.53), so the
    // card has no cheapest euro price and this priced printing is SQL's NULL — in neither list
    // and neither complement, as `wc98/0` is for dollars (`cheapest:usd st:memorabilia` 4 and
    // `-(cheapest:usd) st:memorabilia` 5,662 of 5,847).
    let store = store_from(&["dragon_tust_16", "lightning_bolt"]);
    assert_eq!(printings(&store, &cheapest("usd")), ["msc/806/en", "tust/16/en"]);
    assert_eq!(printings(&store, &cheapest("not_usd")), ["tust/16/en"]);
    assert_eq!(printings(&store, &cheapest("eur")), ["msc/806/en"]);
    assert_eq!(printings(&store, &cheapest("not_eur")), NONE);
    assert_eq!(printings(&store, &not(cheapest("eur"))), NONE);
    assert_eq!(printings(&store, &not(cheapest("not_eur"))), ["msc/806/en"]);
    // An unpriced printing is a plain False / True: `-cheapest:usd e:ymkm` is all 30.
    assert_eq!(printings(&store, &cheapest("tix")), ["msc/806/en"]);
    assert_eq!(printings(&store, &cheapest("not_tix")), ["tust/16/en"]);
    // Blacker Lotus: ugl/70 is 30.02 / —, sld/869 — / 208.85. The foil-only printing is not
    // cheapest and, having a foil price that is not the minimum, not the negated term either.
    let store = store_from(&["blacker_lotus_ugl_70", "blacker_lotus_sld_869"]);
    assert_eq!(printings(&store, &cheapest("usd")), ["ugl/70/en"]);
    assert_eq!(printings(&store, &cheapest("not_usd")), NONE);
    assert_eq!(printings(&store, &not(cheapest("usd"))), ["sld/869/en"]);
}
