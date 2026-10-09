//! `unique=art` ANSWERS EVERY PRINTING WITHOUT AN ILLUSTRATION ID AS ONE ROW, ACROSS CARDS — through
//! the whole native pipeline (Scryfall JSON → transform → finalize → store → query), in one archive
//! and cut into partitions, where the group's printings land in different archives and the gather
//! has to pick its row, place it and count it once.
//!
//! Real card objects, api.scryfall.com 2026-10-09 (`baldurs_gate_wilderness_tclb_0` 2026-10-08).
//! Fifteen art-less printings of twelve cards — seven World Championship and Pro Tour deck fillers,
//! two checklists, three playtest cards, a two-faced minigame, a promo dungeon, and the German
//! printing of a card whose English one has art — beside eight printings of four real artworks.
//!
//! The answers are api.scryfall.com's, asked with `include_extras=true`. A scope's representative
//! is the first of its printings under a fixed order, so the answer for a subset that still holds
//! the measured winner is the measured answer:
//!
//! ```text
//! -is:illustration                 764 prints  1 artwork   '______' unk/RL01c
//! (e:wc97 or e:ptc or e:tsoi)      13 of 459   1 of 235    wc97/0; order=usd tsoi/CH1; order=tix tsoi/CH2
//! !"Blank Card"                    10          1           wc04/00; order=usd wc99/00a
//! e:unk                            527         1           unk/RL01c; order=usd unk/UU04c; order=tix unk/MG05
//! e:wc97                           10 of 131   1 of 90     wc97/0; order=usd|eur|tix wc97/sg0a
//! ```
//!
//! The rules, one test each, are in card_engine beside `artless_rank_key`.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{merge_artless, ArtlessKey, BufferStore, QueryOptions};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const ARTLESS: [&str; 15] = [
    "1997_world_championships_ad_wc97_0",
    "blank_card_wc97_00",
    "svend_geertsen_bio_wc97_sg0a",
    "svend_geertsen_decklist_wc97_sg0b",
    "blank_card_ptc_0",
    "blank_card_wc04_00",
    "blank_card_wc99_00a",
    "shadows_over_innistrad_checklist_1_tsoi_ch1",
    "shadows_over_innistrad_checklist_2_tsoi_ch2",
    "six_underscores_unk_rl01c",
    "fear_of_forgetting_names_unk_uu04c",
    "the_generational_historian_unk_mg05",
    "base_race_mkhm_1",
    "baldurs_gate_wilderness_tclb_0",
    // The annex: German, no illustration id, where its English printing (below) has one.
    "behold_the_power_of_destruction_dsc_328_de",
];

/// Four artworks with an id, eight printings: Angel of the Dawn's one (m19, 2xm, cmr), Ajani, the
/// Greathearted's two (war/184; the Japanese war/184★ and its prerelease twin) and the English
/// Behold the Power of Destruction.
const ARTWORKS: [&str; 8] = [
    "behold_the_power_of_destruction_dsc_328",
    "angel_of_the_dawn_cmr_6",
    "angel_of_the_dawn_2xm_4",
    "angel_of_the_dawn_m19_7",
    "ajani_the_greathearted_war_184",
    "ajani_the_greathearted_pwar_184s",
    "ajani_the_greathearted_pwar_184sstar_ja",
    "ajani_the_greathearted_war_184star_ja",
];

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn rows() -> Vec<Value> {
    let cards: Vec<Value> = ARTLESS.iter().chain(ARTWORKS.iter()).map(|n| fixture(n)).collect();
    // Canonical as `default_cards` has them: every English printing, and the two Japanese Ajanis,
    // which have no English twin. The German Behold the Power of Destruction is an annex row.
    let drafts = cards.iter().map(|c| transform_row(c, c["lang"] != "de").unwrap().unwrap()).collect();
    finalize(drafts, &TagData::default()).collect()
}

/// The fixtures as ONE store. One directory per CALL: the tests run on parallel threads.
fn store() -> BufferStore {
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let out_dir = std::env::temp_dir().join(format!("sylvan-artless-group-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows().into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

/// The same rows cut into `n` partitions the way the publisher cuts them: by the row's partition
/// hash, each bucket built on its own through the standalone-blob path.
fn partitions(n: u32) -> Vec<BufferStore> {
    let mut buckets: Vec<Vec<Vec<u8>>> = vec![Vec::new(); n as usize];
    for row in rows() {
        let (meta, blob) = card_engine::SpillingStoreBuilder::encode_standalone(&row).expect("standalone");
        buckets[(meta.part_hash % u64::from(n)) as usize].push(blob);
    }
    buckets
        .into_iter()
        .map(|blobs| {
            let mut bytes = Vec::new();
            card_engine::build_partition_from_standalone(blobs.into_iter(), Value::Null, &mut bytes).expect("partition build");
            BufferStore::from_bytes(&bytes).expect("partition loads")
        })
        .collect()
}

fn attribute(column: &str, spelling: &str) -> Value {
    json!({"node_type": "CardAttributeNode", "kwargs": {"attribute_name": column, "original_attribute": spelling}})
}

fn leaf(column: &str, spelling: &str, rhs: Value) -> Value {
    json!({"node_type": "CardBinaryOperatorNode", "kwargs": {"lhs": attribute(column, spelling), "op": ":", "rhs": rhs}})
}

fn set(code: &str) -> Value {
    leaf("card_set_code", "e", json!({"node_type": "StringValueNode", "kwargs": {"value": code}}))
}

fn name(word: &str) -> Value {
    leaf("card_name", "name", json!({"node_type": "CollatedNameValueNode", "kwargs": {"value": word}}))
}

fn lang(code: &str) -> Value {
    leaf("card_lang", "lang", json!({"node_type": "StringValueNode", "kwargs": {"value": code}}))
}

fn or(operands: &[Value]) -> Value {
    json!({"node_type": "OrNode", "kwargs": {"operands": operands}})
}

fn everything() -> Value {
    json!({"node_type": "TrueNode"})
}

/// `(e:wc97 or e:ptc or e:tsoi)` — the scope measured whole on api.scryfall.com.
fn decks_and_checklists() -> Value {
    or(&[set("wc97"), set("ptc"), set("tsoi")])
}

fn opts(unique: &str, orderby: &str, direction: &str, prefer: &str) -> QueryOptions {
    QueryOptions {
        unique: unique.to_owned(),
        prefer: prefer.to_owned(),
        orderby: orderby.to_owned(),
        direction: direction.to_owned(),
        fields: Some(["scryfall_id", "set_code", "collector_number", "lang"].map(str::to_owned).to_vec()),
        ..QueryOptions::default()
    }
}

fn label(row: &Value) -> String {
    let lang = row["lang"].as_str().unwrap_or("en");
    let base = format!("{}/{}", row["set_code"].as_str().unwrap(), row["collector_number"].as_str().unwrap());
    if lang == "en" || lang == "ja" { base } else { format!("{base} {lang}") }
}

/// One archive's answer: the total and the page as `set/number`.
fn whole(store: &BufferStore, tree: &Value, opts: &QueryOptions) -> (usize, Vec<String>) {
    let out = store.query_value(tree, opts).expect("query");
    (out.total, out.rows.iter().map(label).collect())
}

/// The gather a serving Durable Object runs (src/engine/gather.ts): every partition's best
/// `offset + limit` keys from zero, merged bytewise; the art-less group's candidates reduced to the
/// one `merge_artless` names, merged in by its own key and counted once; the page's rows fetched
/// from the partitions that own them.
fn gathered(parts: &[BufferStore], tree: &Value, opts: &QueryOptions) -> (usize, Vec<String>) {
    let mut phase1 = opts.clone();
    phase1.limit = opts.offset + opts.limit;
    phase1.offset = 0;
    let mut total = 0;
    let mut merged: Vec<(Vec<u8>, usize, u32)> = Vec::new();
    let mut artless: Vec<Option<ArtlessKey>> = Vec::new();
    for (part, store) in parts.iter().enumerate() {
        let out = store.query_keys(tree, &phase1, 0).expect("phase 1");
        total += out.total;
        merged.extend(out.keys.into_iter().map(|(key, vpid)| (key, part, vpid)));
        artless.push(out.artless);
    }
    if let Some(part) = merge_artless(&artless) {
        let rep = artless[part].take().unwrap();
        total += 1;
        merged.push((rep.key, part, rep.vpid));
    }
    merged.sort_unstable();
    let page = merged.iter().skip(opts.offset).take(opts.limit);
    let rows = page.map(|(_, part, vpid)| label(&parts[*part].fetch_rows(&[*vpid], opts.fields.clone()).expect("phase 2")[0]));
    (total, rows.collect())
}

/// The page under `unique=art` in one archive.
fn art(store: &BufferStore, tree: &Value, orderby: &str, direction: &str, prefer: &str) -> Vec<String> {
    whole(store, tree, &opts("artwork", orderby, direction, prefer)).1
}

/// The art-less rows of a `unique=art` page — there is never more than one.
fn artless_rows(store: &BufferStore, tree: &Value, orderby: &str, direction: &str, prefer: &str) -> Vec<String> {
    let with_art = ["m19/7", "cmr/6", "2xm/4", "war/184", "war/184★", "pwar/184s", "pwar/184s★", "dsc/328"];
    art(store, tree, orderby, direction, prefer).into_iter().filter(|r| !with_art.contains(&r.as_str())).collect()
}

#[test]
fn every_printing_without_an_illustration_is_one_row_across_cards() {
    let store = store();
    // 14 canonical art-less printings of 11 cards, one row; the four artworks with an id beside it.
    let (total, page) = whole(&store, &everything(), &opts("artwork", "name", "asc", "default"));
    assert_eq!(page, ["unk/RL01c", "war/184", "war/184★", "m19/7", "dsc/328"]);
    assert_eq!(total, 5);
    // The other two modes are what they were: every printing, and every card.
    assert_eq!(whole(&store, &everything(), &opts("printing", "name", "asc", "default")).0, 22);
    assert_eq!(whole(&store, &everything(), &opts("card", "name", "asc", "default")).0, 14);
    // One group whatever the face count: the two-faced minigame alone is still the group's row.
    assert_eq!(art(&store, &set("mkhm"), "name", "asc", "default"), ["mkhm/1"]);
}

#[test]
fn the_row_is_the_first_art_less_printing_in_name_order_whatever_the_order() {
    let store = store();
    for (orderby, direction) in [("name", "asc"), ("name", "desc"), ("released", "asc"), ("released", "desc"), ("set", "asc"), ("set", "desc"), ("cmc", "desc"), ("rarity", "asc"), ("edhrec", "desc")] {
        assert_eq!(artless_rows(&store, &everything(), orderby, direction, "default"), ["unk/RL01c"], "{orderby} {direction}");
        assert_eq!(artless_rows(&store, &decks_and_checklists(), orderby, direction, "default"), ["wc97/0"], "{orderby} {direction}");
        // Inside one name, the card's own order: Blank Card's newest, not the 1996 ptc/0 an
        // artwork WITH an id would answer (`artwork_first_printing.rs`).
        assert_eq!(artless_rows(&store, &name("blank"), orderby, direction, "default"), ["wc04/00"], "{orderby} {direction}");
    }
}

#[test]
fn a_price_order_answers_the_cheapest_and_breaks_a_tie_by_the_newest() {
    let store = store();
    for direction in ["asc", "desc"] {
        assert_eq!(artless_rows(&store, &everything(), "usd", direction, "default"), ["tsoi/CH1"]);
        assert_eq!(artless_rows(&store, &name("blank"), "usd", direction, "default"), ["wc99/00a"]);
        assert_eq!(artless_rows(&store, &set("unk"), "usd", direction, "default"), ["unk/UU04c"]);
        assert_eq!(artless_rows(&store, &set("wc97"), "usd", direction, "default"), ["wc97/sg0a"]);
        // No price at all: the newest date, then the smallest Scryfall id — tsoi/CH2 `4825…` over
        // tsoi/CH1 `4d32…`, wc97/sg0a `0760…` over its three set-mates.
        assert_eq!(artless_rows(&store, &decks_and_checklists(), "tix", direction, "default"), ["tsoi/CH2"]);
        assert_eq!(artless_rows(&store, &set("unk"), "tix", direction, "default"), ["unk/MG05"]);
        assert_eq!(artless_rows(&store, &set("wc97"), "tix", direction, "default"), ["wc97/sg0a"]);
        assert_eq!(artless_rows(&store, &name("blank"), "eur", direction, "default"), ["wc04/00"]);
    }
}

#[test]
fn a_written_prefer_picks_the_row() {
    let store = store();
    let scope = decks_and_checklists();
    for orderby in ["name", "released", "usd"] {
        assert_eq!(artless_rows(&store, &scope, orderby, "asc", "oldest"), ["ptc/0"], "{orderby}");
        assert_eq!(artless_rows(&store, &scope, orderby, "asc", "newest"), ["tsoi/CH2"], "{orderby}");
        assert_eq!(artless_rows(&store, &scope, orderby, "asc", "usd_low"), ["tsoi/CH1"], "{orderby}");
        assert_eq!(artless_rows(&store, &scope, orderby, "asc", "usd_high"), ["wc97/sg0b"], "{orderby}");
        assert_eq!(artless_rows(&store, &scope, orderby, "asc", "eur_low"), ["tsoi/CH2"], "{orderby}");
        assert_eq!(artless_rows(&store, &scope, orderby, "asc", "eur_high"), ["tsoi/CH2"], "{orderby}");
        // No promo among them: the name order.
        assert_eq!(artless_rows(&store, &scope, orderby, "asc", "promo"), ["wc97/0"], "{orderby}");
        assert_eq!(artless_rows(&store, &name("blank"), orderby, "asc", "oldest"), ["ptc/0"], "{orderby}");
        assert_eq!(artless_rows(&store, &name("blank"), orderby, "asc", "newest"), ["wc04/00"], "{orderby}");
        assert_eq!(artless_rows(&store, &name("blank"), orderby, "asc", "usd_high"), ["wc97/00"], "{orderby}");
        // The one promo of the whole group, Baldur's Gate Wilderness.
        assert_eq!(artless_rows(&store, &everything(), orderby, "asc", "promo"), ["tclb/0"], "{orderby}");
        assert_eq!(artless_rows(&store, &everything(), orderby, "asc", "oldest"), ["ptc/0"], "{orderby}");
        // `prefer:default`, a default frame first: past the playtest card, the gold-bordered ad and
        // the promo dungeon to the minigame, and the first checklist of the three sets.
        assert_eq!(artless_rows(&store, &everything(), orderby, "asc", "default_frame"), ["mkhm/1"], "{orderby}");
        assert_eq!(artless_rows(&store, &scope, orderby, "asc", "default_frame"), ["tsoi/CH1"], "{orderby}");
    }
}

#[test]
fn the_row_sorts_by_its_own_keys() {
    let store = store();
    // Every `unique=art` page is the same query's `unique=prints` page with rows taken out.
    for (orderby, direction) in [("name", "asc"), ("name", "desc"), ("released", "asc"), ("released", "desc"), ("set", "asc"), ("set", "desc"), ("usd", "asc"), ("usd", "desc"), ("cmc", "asc")] {
        for tree in [everything(), decks_and_checklists(), or(&[name("blank"), name("angel")])] {
            let prints = whole(&store, &tree, &opts("printing", orderby, direction, "default")).1;
            let page = art(&store, &tree, orderby, direction, "default");
            let mut rest = prints.iter();
            assert!(page.iter().all(|row| rest.any(|p| p == row)), "{orderby} {direction}: {page:?} is not a subsequence of {prints:?}");
        }
    }
    // Blank Card's wc04/00 (2004) among Angel of the Dawn's m19/7 (2018), by date both ways.
    let both = or(&[name("blank"), name("angel")]);
    assert_eq!(art(&store, &both, "released", "asc", "default"), ["wc04/00", "m19/7"]);
    assert_eq!(art(&store, &both, "released", "desc", "default"), ["m19/7", "wc04/00"]);
}

#[test]
fn a_query_that_reads_every_language_takes_the_annex_into_the_group() {
    let store = store();
    // English only: the German printing is not in the query, and its English twin has an artwork.
    assert_eq!(art(&store, &name("behold"), "name", "asc", "default"), ["dsc/328"]);
    // `lang:de` alone: the German printing is the whole group.
    assert_eq!(art(&store, &lang("de"), "name", "asc", "default"), ["dsc/328 de"]);
    // Every language: fifteen art-less printings, one row, and it is still '______'.
    let mut every = opts("artwork", "name", "asc", "default");
    every.include_multilingual = true;
    let (total, page) = whole(&store, &everything(), &every);
    assert_eq!(page, ["unk/RL01c", "war/184", "war/184★", "m19/7", "dsc/328"]);
    assert_eq!(total, 5);
}

#[test]
fn the_cut_into_partitions_answers_what_one_archive_does() {
    let store = store();
    let trees = [everything(), decks_and_checklists(), name("blank"), set("unk"), set("wc97"), or(&[name("blank"), name("angel")]), set("war"), lang("de")];
    for n in [2, 3, 10] {
        let parts = partitions(n);
        // The premise: the group's printings really are in several archives.
        let holding = parts
            .iter()
            .filter(|p| p.query_keys(&everything(), &opts("artwork", "name", "asc", "default"), 0).unwrap().artless.is_some())
            .count();
        assert!(holding >= 2, "N={n}: only {holding} partition(s) hold an art-less printing");
        for tree in &trees {
            for (orderby, direction) in [("name", "asc"), ("name", "desc"), ("released", "desc"), ("set", "asc"), ("usd", "asc"), ("usd", "desc"), ("tix", "asc")] {
                for prefer in ["default", "oldest", "newest", "usd_low", "usd_high", "promo", "default_frame", "borderless"] {
                    for unique in ["artwork", "printing", "card"] {
                        for multilingual in [false, true] {
                            // Whole, and paged a row at a time across the group's row.
                            for (offset, limit) in [(0, 100), (0, 1), (1, 1), (2, 1), (3, 2), (5, 3), (40, 5)] {
                                let mut o = opts(unique, orderby, direction, prefer);
                                o.include_multilingual = multilingual;
                                o.offset = offset;
                                o.limit = limit;
                                assert_eq!(
                                    gathered(&parts, tree, &o),
                                    whole(&store, tree, &o),
                                    "N={n} {tree} unique={unique} order={orderby} {direction} prefer={prefer} ml={multilingual} offset={offset} limit={limit}"
                                );
                            }
                        }
                    }
                }
            }
        }
    }
}

fn is_tag(tag: &str) -> Value {
    json!({"node_type": "CardBinaryOperatorNode", "kwargs": {"lhs": attribute("card_is_tags", "is"), "op": ":", "rhs": [tag]}})
}

fn not(operand: Value) -> Value {
    json!({"node_type": "NotNode", "kwargs": {"operand": operand}})
}

/// `<tree> -is:extra -is:variation`, the conjuncts the routes append to every default search.
fn gated(tree: Value) -> Value {
    json!({"node_type": "AndNode", "kwargs": {"operands": [tree, not(is_tag("extra")), not(is_tag("variation"))]}})
}

/// The same filter with the two gates folded into ONE conjunct, `-(is:extra or is:variation)`.
fn gated_as_one(tree: Value) -> Value {
    json!({"node_type": "AndNode", "kwargs": {"operands": [tree, not(or(&[is_tag("extra"), is_tag("variation")]))]}})
}

#[test]
fn the_routes_gates_are_remembered_per_store_and_change_no_answer() {
    // A store remembers which of its art-less rows each `-is:<tag>` conjunct leaves, so a default
    // search asks its own leaves of those rows alone. The same filter written so that no conjunct
    // is a gate is evaluated row by row; the two must answer alike — cold, warm, and cut.
    let store = store();
    let trees = [everything(), decks_and_checklists(), name("blank"), set("unk"), or(&[name("blank"), name("angel")]), set("war")];
    for round in ["cold", "warm"] {
        for tree in &trees {
            for (orderby, direction) in [("name", "asc"), ("released", "desc"), ("usd", "asc"), ("tix", "desc")] {
                for prefer in ["default", "oldest", "usd_high", "promo"] {
                    let o = opts("artwork", orderby, direction, prefer);
                    assert_eq!(
                        whole(&store, &gated(tree.clone()), &o),
                        whole(&store, &gated_as_one(tree.clone()), &o),
                        "{round} {tree} order={orderby} {direction} prefer={prefer}"
                    );
                }
            }
        }
    }
    for n in [2, 3] {
        let parts = partitions(n);
        for tree in &trees {
            for unique in ["artwork", "printing", "card"] {
                let o = opts(unique, "name", "asc", "default");
                assert_eq!(gathered(&parts, &gated(tree.clone()), &o), whole(&store, &gated(tree.clone()), &o), "N={n} {tree} {unique}");
                assert_eq!(gathered(&parts, &gated(tree.clone()), &o), whole(&store, &gated_as_one(tree.clone()), &o), "N={n} {tree} {unique}");
            }
        }
    }
    // The gates are not vacuous here: they take the playtest cards, the deck fillers, the
    // checklists and the minigame out, and leave the group the promo dungeon — which is the row
    // api.scryfall.com answers `-is:illustration unique=art` with when extras are not asked for.
    assert_eq!(artless_rows(&store, &everything(), "name", "asc", "default"), ["unk/RL01c"]);
    assert_eq!(artless_rows(&store, &gated(everything()), "name", "asc", "default"), ["tclb/0"]);
    assert_eq!(artless_rows(&store, &gated(decks_and_checklists()), "name", "asc", "default"), Vec::<String>::new());
}

#[test]
fn a_query_with_no_art_less_printing_sends_no_candidate_and_is_untouched() {
    let parts = partitions(3);
    for tree in [set("war"), name("angel")] {
        for part in &parts {
            let out = part.query_keys(&tree, &opts("artwork", "name", "asc", "default"), 0).unwrap();
            assert_eq!(out.artless, None);
        }
    }
    // And the other modes never send one, whatever they match.
    for unique in ["card", "printing"] {
        for part in &parts {
            assert_eq!(part.query_keys(&everything(), &opts(unique, "name", "asc", "default"), 0).unwrap().artless, None);
        }
    }
}
