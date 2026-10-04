//! A REVERSIBLE PRINTING is read as the printing it is — `name:`, `o:`, autocomplete, the typo
//! stage and `unique=art` — through the whole native pipeline: Scryfall JSON → transform →
//! finalize → store → query.
//!
//! A reversible Secret Lair printing prints a doubled name ("Darksteel Colossus // Darksteel
//! Colossus") and the rules text of its own faces, and api.scryfall.com's `name:` and `o:` read
//! those, not the card's. Measured 2026-10-04, one request each:
//!
//!   usd-a                         13 printings — `usd-a` collates to `usda`, which the doubled
//!                                 name holds across its seam (`colossusdark`); the extra row is
//!                                 sld/1081
//!   colossusdark                  1 — sld/1081          name:"colossus // dark"   1 — sld/1081
//!   name:/colossus \/\/ dark/     1 — sld/1081
//!   name:/^tuvasa the sunlit$/    2 — c18/47, pz2/70691: NOT the reversible sld/1328, which
//!                                 prints the doubled name and so does not end there
//!   name:/^tuvasa the sunlit \/\/ tuvasa the sunlit$/   1 — sld/1328
//!   !"Tuvasa the Sunlit"          3 (the card's name is also one half of the doubled one)
//!   name:"//"                     5,205 against the 5,125 a card-only read gives: the 80
//!                                 reversible printings (83, less Bloomvine Regent's three, whose
//!                                 card already has the seam)
//!   o:shuffle !"Bloomvine Regent" 3 of the card's 4 printings — tdm/381 prints the front face's
//!                                 text on both sides, and the card's Omen is what shuffles
//!   /cards/autocomplete?q=tuvasa  "Tuvasa the Sunlit", "Tuvasa the Sunlit // Tuvasa the Sunlit"
//!   /cards/named?fuzzy=Tuvasa the Sunlit // Tuvasa the Sunlt   sld/1328
//!   is:reversible t:planeswalker unique=art   sld/1453..1457, where this port answered 745..749
//!
//! The printings here: Darksteel Colossus m10/208 and sld/1081 (reversible), Tuvasa the Sunlit
//! c18/47 and sld/1328, Bloomvine Regent tdm/136 (an adventure) and tdm/381 (reversible), Ajani
//! Goldmane m11/1, sld/745 (the foil-only `sldbonus` printing) and sld/1453, Lightning Bolt as the
//! control.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const FIXTURES: &[&str] = &[
    "darksteel_colossus_m10_208",
    "darksteel_colossus_sld_1081",
    "tuvasa_the_sunlit_c18_47",
    "tuvasa_the_sunlit_sld_1328",
    "bloomvine_regent_tdm_136",
    "bloomvine_regent_tdm_381",
    "ajani_goldmane_m11_1",
    "ajani_goldmane_sld_745",
    "ajani_goldmane_sld_1453",
    "lightning_bolt",
];

/// The ordinary printings Scryfall's `oracle_cards` file names as their cards' representatives.
/// PINNED here because the store builds a card from its group's highest-scoring printing, and a
/// reversible Secret Lair printing is newer than every ordinary one: unpinned, the fixture's card
/// would be the reversible printing and the divergent record the ordinary one — the opposite of
/// what the corpus builds (a pinned ordinary printing leads every one of the 71 groups).
const PINNED: &[&str] =
    &["darksteel_colossus_m10_208", "tuvasa_the_sunlit_c18_47", "bloomvine_regent_tdm_136", "ajani_goldmane_m11_1"];

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn store() -> BufferStore {
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let drafts = FIXTURES.iter().map(|n| transform_row(&fixture(n), true).unwrap().unwrap()).collect();
    let mut tags = TagData::default();
    tags.labels.extend(PINNED.iter().map(|n| fixture(n)["id"].as_str().unwrap().to_owned()));
    let rows: Vec<Value> = finalize(drafts, &tags).collect();
    let out_dir = std::env::temp_dir().join(format!("sylvan-reversible-printings-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

fn leaf(attribute: &str, alias: &str, kind: &str, value: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "lhs": {"node_type": "CardAttributeNode", "kwargs": {"attribute_name": attribute, "original_attribute": alias}},
            "op": ":",
            "rhs": {"node_type": kind, "kwargs": {"value": value}},
        },
    })
}

/// `name:word` — the collated bare-word form.
fn word(w: &str) -> Value {
    leaf("card_name", "name", "CollatedNameValueNode", w)
}

/// `name:"…"` — the literal form.
fn quoted(w: &str) -> Value {
    leaf("card_name", "name", "StringValueNode", w)
}

/// `name:/…/`.
fn name_regex(pattern: &str) -> Value {
    leaf("card_name", "name", "RegexValueNode", pattern)
}

fn not(operand: Value) -> Value {
    json!({"node_type": "NotNode", "kwargs": {"operand": operand}})
}

fn and(operands: &[Value]) -> Value {
    json!({"node_type": "AndNode", "kwargs": {"operands": operands}})
}

fn or(operands: &[Value]) -> Value {
    json!({"node_type": "OrNode", "kwargs": {"operands": operands}})
}

/// Every row the tree matches under `unique`, as sorted `set/number`.
fn rows(store: &BufferStore, tree: &Value, unique: &str) -> Vec<String> {
    let opts = QueryOptions {
        unique: unique.to_owned(),
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

/// Every PRINTING the tree matches, as sorted `set/number`.
fn printings(store: &BufferStore, tree: &Value) -> Vec<String> {
    rows(store, tree, "printing")
}

fn reversible() -> Value {
    leaf("card_layout", "layout", "StringValueNode", "reversible_card")
}

fn oracle(text: &str) -> Value {
    leaf("oracle_text", "o", "StringValueNode", text)
}

fn oracle_regex(pattern: &str) -> Value {
    leaf("oracle_text", "o", "RegexValueNode", pattern)
}

const NONE: [&str; 0] = [];

#[test]
fn a_needle_across_the_seam_of_the_doubled_name_finds_the_reversible_printing() {
    let store = store();
    // `usd-a` collates to `usda`, which only `colossus|dark` holds.
    assert_eq!(printings(&store, &word("usda")), ["sld/1081"]);
    assert_eq!(printings(&store, &word("colossusdark")), ["sld/1081"]);
    // The quoted form is the lowercase name, spaces and slashes as printed.
    assert_eq!(printings(&store, &quoted("colossus // dark")), ["sld/1081"]);
    assert_eq!(printings(&store, &name_regex(r"colossus \/\/ dark")), ["sld/1081"]);
    assert_eq!(printings(&store, &name_regex(r"^darksteel colossus \/\/ darksteel")), ["sld/1081"]);
    // The three-part name of the adventure printing, whose card already has the seam.
    assert_eq!(printings(&store, &quoted("claim territory // bloomvine")), ["tdm/381"]);
    assert_eq!(printings(&store, &quoted("regent // claim")), ["tdm/136", "tdm/381"]);
    // Under `unique=cards` the card is the row, and the printing that answers is the one that
    // prints the name — not the card's preferred one.
    assert_eq!(rows(&store, &word("colossusdark"), "card"), ["sld/1081"]);
    assert_eq!(rows(&store, &name_regex("^tuvasa the sunlit$"), "card"), ["c18/47"]);
    assert_eq!(rows(&store, &name_regex(r"^tuvasa the sunlit \/\/"), "card"), ["sld/1328"]);
}

#[test]
fn a_needle_inside_one_half_is_the_card_and_its_reversible_printing_alike() {
    let store = store();
    // Nothing is grafted: the two readings agree, so the answer is the ordinary one.
    assert_eq!(printings(&store, &word("colossus")), ["m10/208", "sld/1081"]);
    assert_eq!(printings(&store, &word("sunlit")), ["c18/47", "sld/1328"]);
    assert_eq!(printings(&store, &quoted("darksteel")), ["m10/208", "sld/1081"]);
    assert_eq!(printings(&store, &word("lightning")), ["msc/806"]);
    assert_eq!(printings(&store, &word("zzzz")), NONE);
}

#[test]
fn an_anchored_regex_is_asked_of_the_name_the_printing_prints() {
    let store = store();
    // The card's name ENDS at `sunlit`; the reversible printing's does not.
    assert_eq!(printings(&store, &name_regex("^tuvasa the sunlit$")), ["c18/47"]);
    assert_eq!(printings(&store, &name_regex(r"^tuvasa the sunlit \/\/ tuvasa the sunlit$")), ["sld/1328"]);
    assert_eq!(printings(&store, &name_regex("^darksteel colossus$")), ["m10/208"]);
    assert_eq!(printings(&store, &name_regex("sunlit$")), ["c18/47", "sld/1328"]);
    // Ajani Goldmane has three printings, two of them reversible.
    assert_eq!(printings(&store, &name_regex("^ajani goldmane$")), ["m11/1"]);
    assert_eq!(printings(&store, &name_regex("goldmane$")), ["m11/1", "sld/1453", "sld/745"]);
}

#[test]
fn a_negated_name_is_the_complement_over_printings() {
    let store = store();
    let all = printings(&store, &not(word("zzzz")));
    assert_eq!(all.len(), FIXTURES.len());
    assert_eq!(printings(&store, &word("colossusdark")), ["sld/1081"]);
    let without: Vec<String> = all.iter().filter(|p| **p != "sld/1081").cloned().collect();
    assert_eq!(printings(&store, &not(word("colossusdark"))), without);
    // `-name:/^tuvasa the sunlit$/ name:sunlit` is the printing that prints the doubled name.
    assert_eq!(printings(&store, &and(&[not(name_regex("^tuvasa the sunlit$")), word("sunlit")])), ["sld/1328"]);
    // Inside a group, with the card's other printings untouched.
    assert_eq!(
        printings(&store, &or(&[word("colossusdark"), name_regex("^tuvasa the sunlit$")])),
        ["c18/47", "sld/1081"]
    );
}

#[test]
fn autocomplete_offers_the_doubled_name_beside_the_card() {
    let store = store();
    // api.scryfall.com 2026-10-04: `q=tuvasa` and `q=sunlit` list both, the card's first.
    assert_eq!(store.autocomplete("tuvasa", 20), ["Tuvasa the Sunlit", "Tuvasa the Sunlit // Tuvasa the Sunlit"]);
    assert_eq!(
        store.autocomplete("tuvasa the sunlit //", 20),
        ["Tuvasa the Sunlit", "Tuvasa the Sunlit // Tuvasa the Sunlit"]
    );
    // The collated match reaches across the seam: `colossusdark`, `sunlit tuvasa` and
    // `tuvasa the sunlit // t` are the doubled name alone.
    assert_eq!(store.autocomplete("colossusdark", 20), ["Darksteel Colossus // Darksteel Colossus"]);
    assert_eq!(store.autocomplete("sunlit tuvasa", 20), ["Tuvasa the Sunlit // Tuvasa the Sunlit"]);
    assert_eq!(store.autocomplete("tuvasa the sunlit // t", 20), ["Tuvasa the Sunlit // Tuvasa the Sunlit"]);
    // An adventure's reversible printing prints three parts, and both names are offered.
    assert_eq!(
        store.autocomplete("bloomvine", 20),
        ["Bloomvine Regent // Claim Territory", "Bloomvine Regent // Claim Territory // Bloomvine Regent"]
    );
    // One name per distinct printed name, however many printings print it (Ajani Goldmane has two).
    assert_eq!(store.autocomplete("ajani goldmane", 20), ["Ajani Goldmane", "Ajani Goldmane // Ajani Goldmane"]);
    // The pairs the names blob is made of hold them too.
    let pairs = store.autocomplete_names();
    let doubled = ("darksteelcolossusdarksteelcolossus".to_owned(), "Darksteel Colossus // Darksteel Colossus".to_owned());
    assert!(pairs.contains(&doubled));
}

#[test]
fn the_typo_stage_holds_the_doubled_names_as_names_of_their_own() {
    let store = store();
    let ask = |needle: &str| -> String {
        let fields = Some(["name", "set_code", "collector_number"].map(str::to_owned).to_vec());
        let (status, card) = store.fuzzy_card_by_name(needle, 0.4, 0.0, fields).expect("fuzzy");
        let card = card.unwrap_or(Value::Null);
        format!(
            "{status} {} {}/{}",
            card["name"].as_str().unwrap_or(""),
            card["set_code"].as_str().unwrap_or(""),
            card["collector_number"].as_str().unwrap_or("")
        )
    };
    // api.scryfall.com 2026-10-04: the misspelt DOUBLED name is the reversible printing, where the
    // misspelt single name is the ordinary one.
    assert_eq!(ask("Tuvasa the Sunlit // Tuvasa the Sunlt"), "hit Tuvasa the Sunlit // Tuvasa the Sunlit sld/1328");
    assert_eq!(ask("Tuvasa the Sunlt"), "hit Tuvasa the Sunlit c18/47");
    assert_eq!(ask("Darksteel Colossus // Darksteel Colosus"), "hit Darksteel Colossus // Darksteel Colossus sld/1081");
    assert_eq!(
        ask("Bloomvine Regent // Claim Territory // Bloomvine Regnt"),
        "hit Bloomvine Regent // Claim Territory // Bloomvine Regent tdm/381"
    );
    // Of the card's two reversible printings the first stored answers. Scryfall's own pick is not a
    // rule it keeps: `Ajani Goldmane // Ajani Goldman` is sld/1453 and so is `// Ajani Goldmanee`,
    // while `Chandra Nalaar // Chandra Nalaer` is sld/1456 and `// Chandra Nalaa` sld/748 — one
    // card, two candidates, the typo moved. The card is the answer.
    assert!(ask("Ajani Goldmane // Ajani Goldman").starts_with("hit Ajani Goldmane // Ajani Goldmane sld/"));
    assert_eq!(ask("Ajani Goldman"), "hit Ajani Goldmane m11/1");
}

#[test]
fn unique_art_gives_a_bonus_printing_up_to_its_sibling_of_the_same_artwork() {
    let store = store();
    let art = |tree: &Value| rows(&store, tree, "artwork");
    // api.scryfall.com 2026-10-04, `is:reversible t:planeswalker unique=art`: sld/1453 for Ajani
    // Goldmane, where sld/745 — the foil-only `sldbonus` printing of the same two illustrations —
    // is the store's order and `prefer_score`'s pick.
    assert_eq!(printings(&store, &and(&[reversible(), word("ajani")])), ["sld/1453", "sld/745"]);
    assert_eq!(art(&and(&[reversible(), word("ajani")])), ["sld/1453"]);
    // Only a printing the filter MATCHES can stand for the group: with the plain one excluded the
    // bonus printing is all there is.
    let without_1453 = and(&[reversible(), word("ajani"), not(leaf("collector_number", "cn", "StringValueNode", "1453"))]);
    assert_eq!(art(&without_1453), ["sld/745"]);
    // No other group moves: Darksteel Colossus's two printings are different artworks.
    assert_eq!(art(&reversible()), ["sld/1081", "sld/1328", "sld/1453", "tdm/381"]);
    assert_eq!(art(&word("sunlit")), ["c18/47", "sld/1328"]);
}

#[test]
fn rules_text_is_the_text_the_reversible_printing_prints() {
    let store = store();
    let bloomvine = quoted("bloomvine regent");
    // The card's Omen shuffles; tdm/381 prints the front face's text, which does not.
    assert_eq!(printings(&store, &and(&[oracle("shuffle"), bloomvine.clone()])), ["tdm/136"]);
    assert_eq!(printings(&store, &and(&[oracle_regex("shuffles?"), bloomvine.clone()])), ["tdm/136"]);
    assert_eq!(printings(&store, &and(&[not(oracle("shuffle")), bloomvine.clone()])), ["tdm/381"]);
    // Text both sides print is found on both.
    assert_eq!(
        printings(&store, &and(&[oracle("whenever this creature or another dragon"), bloomvine.clone()])),
        ["tdm/136", "tdm/381"]
    );
    assert_eq!(printings(&store, &and(&[oracle("flying"), bloomvine])), ["tdm/136", "tdm/381"]);
    // Everywhere else the card's text is the text: Darksteel Colossus shuffles itself on both its
    // printings, and the one card whose reversible printing differs is the only one that moves.
    assert_eq!(printings(&store, &and(&[oracle("shuffle"), word("darksteel")])), ["m10/208", "sld/1081"]);
    assert_eq!(printings(&store, &oracle("shuffle")), ["m10/208", "sld/1081", "tdm/136"]);
}
