//! `unique=art` ANSWERS AN ARTWORK TWO CARDS SHARE AS ONE ROW — through the whole native pipeline
//! (Scryfall JSON → transform → finalize → store → query), in one archive and cut into
//! partitions, where the two cards land in different archives and the gather has to keep one
//! candidate, place it and count it once.
//!
//! Real card objects, api.scryfall.com 2026-10-10. Four artworks, each on two cards:
//!
//! ```text
//! Volley Veteran + the front card `Goblins`     j25/142, fdn/550 (and fdn/550 in Japanese) + fj25/32
//! Alora, Merry Thief + Alora, Rogue Companion   clb/55, clb/481 + Alchemy's hbg/5
//! Wolf, a token under two oracle ids            teld/14, tblc/35 + t2xm/19
//! Wildwood Scourge + the front card `Plus One`  m21/214, cmm/332, fdn/236 + fjmp/28
//! ```
//!
//! and one artwork of one card beside them (Temple of Deceit: thb/245, fdn/697), which nothing
//! here may change. The answers are api.scryfall.com's for these printings, asked with
//! `include_extras=true`:
//!
//! ```text
//! (!"Volley Veteran" or !"Goblins" e:fj25)       j25/142          without it  fj25/32
//!                                                lang:ja          fdn/550 in Japanese
//! (!"Alora, Merry Thief" or !"Alora, Rogue…")    clb/55           without it  clb/481
//! !"Wolf" (e:teld or e:tblc or e:t2xm)           teld/14          without it  tblc/35
//! (!"Wildwood Scourge" or !"Plus One")           m21/214
//!     prefer:oldest fjmp/28   prefer:newest fdn/236   prefer:usd-high cmm/332   prefer:promo fjmp/28
//!     order=usd m21/214       order=tix fdn/236
//! ```
//!
//! — the artwork's representative (Scryfall's record of it) where the query holds it, the first
//! of the query's `order=name unique=prints` where it does not, and the art-less group's own keys
//! under a prefer or a price order. card_engine's section beside `shared_rank_key` carries the
//! measurement: 36 shared artworks asked both ways and five scopes whole, id for id.

use std::sync::atomic::{AtomicUsize, Ordering};

use card_engine::{merge_artless, merge_shared, ArtlessKey, BufferStore, QueryOptions, SharedKey};
use serde_json::{json, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::transform::{finalize, transform_row};

const FIXTURES: [&str; 16] = [
    "volley_veteran_j25_142",
    "volley_veteran_fdn_550",
    "volley_veteran_fdn_550_ja",
    "goblins_fj25_32",
    "alora_merry_thief_clb_55",
    "alora_merry_thief_clb_481",
    "alora_rogue_companion_hbg_5",
    "wolf_teld_14",
    "wolf_tblc_35",
    "wolf_t2xm_19",
    "wildwood_scourge_m21_214",
    "wildwood_scourge_cmm_332",
    "wildwood_scourge_fdn_236",
    "plus_one_fjmp_28",
    // One card's one artwork, two printings: not shared, and answered as it always was.
    "temple_of_deceit_thb_245",
    "temple_of_deceit_fdn_697",
];

fn fixture(name: &str) -> Value {
    let path = format!("{}/src/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The finished rows of `names`: every English printing canonical, as `default_cards` has them,
/// and the Japanese Volley Veteran an annex row.
fn rows_of(names: &[&str]) -> Vec<Value> {
    let cards: Vec<Value> = names.iter().map(|n| fixture(n)).collect();
    let drafts = cards.iter().map(|c| transform_row(c, c["lang"] == "en").unwrap().unwrap()).collect();
    finalize(drafts, &TagData::default()).collect()
}

fn rows() -> Vec<Value> {
    rows_of(&FIXTURES)
}

fn store_of(rows: Vec<Value>) -> BufferStore {
    static BUILDS: AtomicUsize = AtomicUsize::new(0);
    let build = BUILDS.fetch_add(1, Ordering::Relaxed);
    let out_dir = std::env::temp_dir().join(format!("sylvan-shared-artworks-{}-{build}", std::process::id()));
    let manifest = sylvan_store_builder::build_store(rows.into_iter(), &out_dir, "1754000000").expect("build");
    let bytes = std::fs::read(out_dir.join(&manifest.store_key)).unwrap();
    std::fs::remove_dir_all(&out_dir).ok();
    BufferStore::from_bytes(&bytes).expect("store loads")
}

/// The fixtures as ONE store.
fn store() -> BufferStore {
    store_of(rows())
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

fn number(cn: &str) -> Value {
    leaf("collector_number", "cn", json!({"node_type": "StringValueNode", "kwargs": {"value": cn}}))
}

fn name(word: &str) -> Value {
    leaf("card_name", "name", json!({"node_type": "CollatedNameValueNode", "kwargs": {"value": word}}))
}

fn lang(code: &str) -> Value {
    leaf("card_lang", "lang", json!({"node_type": "StringValueNode", "kwargs": {"value": code}}))
}

fn is_tag(tag: &str) -> Value {
    json!({"node_type": "CardBinaryOperatorNode", "kwargs": {"lhs": attribute("card_is_tags", "is"), "op": ":", "rhs": [tag]}})
}

fn or(operands: &[Value]) -> Value {
    json!({"node_type": "OrNode", "kwargs": {"operands": operands}})
}

fn and(operands: &[Value]) -> Value {
    json!({"node_type": "AndNode", "kwargs": {"operands": operands}})
}

fn not(operand: Value) -> Value {
    json!({"node_type": "NotNode", "kwargs": {"operand": operand}})
}

fn everything() -> Value {
    json!({"node_type": "TrueNode"})
}

/// `<tree> -is:extra -is:variation`, the conjuncts the routes append to every default search.
fn gated(tree: Value) -> Value {
    and(&[tree, not(is_tag("extra")), not(is_tag("variation"))])
}

/// The two cards of each artwork, by a word of each name.
fn volley() -> Value {
    or(&[name("volley"), name("goblins")])
}
fn alora() -> Value {
    name("alora")
}
fn wolf() -> Value {
    name("wolf")
}
fn wildwood() -> Value {
    or(&[name("wildwood"), name("plus")])
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
    if lang == "en" { base } else { format!("{base} {lang}") }
}

/// One archive's answer: the total and the page as `set/number`.
fn whole(store: &BufferStore, tree: &Value, opts: &QueryOptions) -> (usize, Vec<String>) {
    let out = store.query_value(tree, opts).expect("query");
    (out.total, out.rows.iter().map(label).collect())
}

/// The page under `unique=art` in one archive.
fn art(store: &BufferStore, tree: &Value, orderby: &str, direction: &str, prefer: &str) -> Vec<String> {
    whole(store, tree, &opts("artwork", orderby, direction, prefer)).1
}

/// The gather a serving Durable Object runs (src/engine/gather.ts): every partition's best
/// `offset + limit` keys from zero, merged bytewise; the art-less group's candidates reduced to
/// one and each shared artwork's to one (`merge_artless`, `merge_shared`), merged in by their own
/// keys and counted once each; the page's rows fetched from the partitions that own them.
fn gathered(parts: &[BufferStore], tree: &Value, opts: &QueryOptions) -> (usize, Vec<String>) {
    let mut phase1 = opts.clone();
    phase1.limit = opts.offset + opts.limit;
    phase1.offset = 0;
    let mut total = 0;
    let mut merged: Vec<(Vec<u8>, usize, u32)> = Vec::new();
    let mut artless: Vec<Option<ArtlessKey>> = Vec::new();
    let mut shared: Vec<Vec<SharedKey>> = Vec::new();
    for (part, store) in parts.iter().enumerate() {
        let out = store.query_keys(tree, &phase1, 0).expect("phase 1");
        total += out.total;
        merged.extend(out.keys.into_iter().map(|(key, vpid)| (key, part, vpid)));
        artless.push(out.artless);
        shared.push(out.shared);
    }
    if let Some(part) = merge_artless(&artless) {
        let rep = artless[part].take().unwrap();
        total += 1;
        merged.push((rep.key, part, rep.vpid));
    }
    for (part, at) in merge_shared(&shared) {
        let rep = &shared[part][at].candidate;
        total += 1;
        merged.push((rep.key.clone(), part, rep.vpid));
    }
    merged.sort_unstable();
    let page = merged.iter().skip(opts.offset).take(opts.limit);
    let rows = page.map(|(_, part, vpid)| label(&parts[*part].fetch_rows(&[*vpid], opts.fields.clone()).expect("phase 2")[0]));
    (total, rows.collect())
}

#[test]
fn an_artwork_two_cards_share_is_one_row_and_it_is_the_artworks_representative() {
    let store = store();
    // Sixteen rows, fifteen canonical printings of nine cards, FIVE artworks.
    let (total, page) = whole(&store, &everything(), &opts("artwork", "name", "asc", "default"));
    assert_eq!(page, ["clb/55", "thb/245", "j25/142", "m21/214", "teld/14"]);
    assert_eq!(total, 5);
    // Each artwork with both its cards in the query: Scryfall's record of it.
    assert_eq!(art(&store, &volley(), "name", "asc", "default"), ["j25/142"]);
    assert_eq!(art(&store, &alora(), "name", "asc", "default"), ["clb/55"]);
    assert_eq!(art(&store, &wolf(), "name", "asc", "default"), ["teld/14"]);
    assert_eq!(art(&store, &wildwood(), "name", "asc", "default"), ["m21/214"]);
    // The other two modes are what they were: every printing, and every card.
    assert_eq!(whole(&store, &everything(), &opts("printing", "name", "asc", "default")).0, 15);
    assert_eq!(whole(&store, &everything(), &opts("card", "name", "asc", "default")).0, 9);
    // ...and a card's artwork answers alone exactly as before: the query need not hold both.
    assert_eq!(art(&store, &name("goblins"), "name", "asc", "default"), ["fj25/32"]);
    assert_eq!(art(&store, &name("rogue"), "name", "asc", "default"), ["hbg/5"]);
    assert_eq!(art(&store, &set("t2xm"), "name", "asc", "default"), ["t2xm/19"]);
}

#[test]
fn without_the_representative_the_row_is_the_first_of_the_querys_name_order_across_the_cards() {
    let store = store();
    // `Goblins` sorts before Volley Veteran: the front card answers, not the card's own fdn/550.
    assert_eq!(art(&store, &and(&[volley(), not(number("142"))]), "name", "asc", "default"), ["fj25/32"]);
    // `Alora, Merry Thief` before `Alora, Rogue Companion`: the card's second printing, not Alchemy's.
    assert_eq!(art(&store, &and(&[alora(), not(number("55"))]), "name", "asc", "default"), ["clb/481"]);
    // One name, two oracle ids: the token card that holds the representative comes first, and
    // its other printing answers.
    assert_eq!(art(&store, &and(&[wolf(), not(set("teld"))]), "name", "asc", "default"), ["tblc/35"]);
    // `Plus One` before `Wildwood Scourge`.
    assert_eq!(art(&store, &and(&[wildwood(), not(set("m21"))]), "name", "asc", "default"), ["fjmp/28"]);
    // Whatever the order asked for: the choice is not the sort.
    for (orderby, direction) in [("name", "desc"), ("released", "asc"), ("released", "desc"), ("set", "asc"), ("cmc", "desc"), ("rarity", "asc")] {
        assert_eq!(art(&store, &wildwood(), orderby, direction, "default"), ["m21/214"], "{orderby} {direction}");
        assert_eq!(art(&store, &and(&[wildwood(), not(set("m21"))]), orderby, direction, "default"), ["fjmp/28"], "{orderby} {direction}");
    }
}

#[test]
fn a_prefer_or_a_price_order_picks_across_the_cards() {
    let store = store();
    for orderby in ["name", "released"] {
        // The front card is the oldest printing of the painting (2020-06-18, two weeks before the
        // card's own first) and Foundations' the newest.
        assert_eq!(art(&store, &wildwood(), orderby, "asc", "oldest"), ["fjmp/28"], "{orderby}");
        assert_eq!(art(&store, &wildwood(), orderby, "asc", "newest"), ["fdn/236"], "{orderby}");
        // Prices: m21/214 $0.19, fdn/236 $0.21, cmm/332 $0.26, and the front card has none.
        assert_eq!(art(&store, &wildwood(), orderby, "asc", "usd_low"), ["m21/214"], "{orderby}");
        assert_eq!(art(&store, &wildwood(), orderby, "asc", "usd_high"), ["cmm/332"], "{orderby}");
        // No promo among them: the name order, which the front card leads.
        assert_eq!(art(&store, &wildwood(), orderby, "asc", "promo"), ["fjmp/28"], "{orderby}");
    }
    for direction in ["asc", "desc"] {
        assert_eq!(art(&store, &wildwood(), "usd", direction, "default"), ["m21/214"]);
        // 0.03 tix twice (m21/214 and fdn/236): the newer.
        assert_eq!(art(&store, &wildwood(), "tix", direction, "default"), ["fdn/236"]);
    }
}

#[test]
fn the_row_sorts_by_its_own_keys_and_is_counted_once() {
    let store = store();
    // Every `unique=art` page is the same query's `unique=prints` page with rows taken out.
    for (orderby, direction) in [("name", "asc"), ("name", "desc"), ("released", "asc"), ("released", "desc"), ("set", "asc"), ("set", "desc"), ("usd", "asc"), ("usd", "desc"), ("cmc", "asc")] {
        for tree in [everything(), volley(), or(&[wolf(), wildwood()]), and(&[everything(), not(set("m21"))])] {
            let prints = whole(&store, &tree, &opts("printing", orderby, direction, "default")).1;
            let (total, page) = whole(&store, &tree, &opts("artwork", orderby, direction, "default"));
            let mut rest = prints.iter();
            assert!(page.iter().all(|row| rest.any(|p| p == row)), "{orderby} {direction}: {page:?} is not a subsequence of {prints:?}");
            assert_eq!(total, page.len(), "{orderby} {direction}");
        }
    }
    // By date both ways: Wolf's teld/14 (2019) before Wildwood Scourge's m21/214 (2020).
    let both = or(&[wolf(), wildwood()]);
    assert_eq!(art(&store, &both, "released", "asc", "default"), ["teld/14", "m21/214"]);
    assert_eq!(art(&store, &both, "released", "desc", "default"), ["m21/214", "teld/14"]);
    // A page at a time, across the shared rows.
    let all = art(&store, &everything(), "name", "asc", "default");
    for offset in 0..6 {
        let mut o = opts("artwork", "name", "asc", "default");
        o.offset = offset;
        o.limit = 2;
        let (total, page) = whole(&store, &everything(), &o);
        assert_eq!(total, 5);
        assert_eq!(page, all.iter().skip(offset).take(2).cloned().collect::<Vec<_>>(), "offset {offset}");
    }
}

#[test]
fn a_default_search_hides_the_front_card_and_the_artwork_is_still_one_row() {
    let store = store();
    // `-is:extra -is:variation`: the front cards and the tokens are out, Alchemy's card is not.
    let (total, page) = whole(&store, &gated(everything()), &opts("artwork", "name", "asc", "default"));
    assert_eq!(page, ["clb/55", "thb/245", "j25/142", "m21/214"]);
    assert_eq!(total, 4);
    // Alora's two cards are both in a default search, and are one artwork there too.
    assert_eq!(whole(&store, &gated(alora()), &opts("card", "name", "asc", "default")).0, 2);
    assert_eq!(art(&store, &gated(alora()), "name", "asc", "default"), ["clb/55"]);
    assert_eq!(art(&store, &gated(and(&[alora(), not(number("55"))])), "name", "asc", "default"), ["clb/481"]);
    // Cold and warm: the gates' lists are remembered per store and change no answer.
    for _ in 0..2 {
        assert_eq!(art(&store, &gated(wildwood()), "name", "asc", "default"), ["m21/214"]);
        assert_eq!(art(&store, &gated(volley()), "released", "desc", "default"), ["j25/142"]);
        assert_eq!(art(&store, &gated(wildwood()), "usd", "asc", "usd_high"), ["cmm/332"]);
    }
}

#[test]
fn a_query_that_reads_every_language_takes_the_annex_into_the_artwork() {
    let store = store();
    // `lang:ja` alone: the Japanese printing is the artwork's whole answer.
    assert_eq!(art(&store, &and(&[volley(), lang("ja")]), "name", "asc", "default"), ["fdn/550 ja"]);
    // Every language: still one row, and still the English representative.
    let mut every = opts("artwork", "name", "asc", "default");
    every.include_multilingual = true;
    assert_eq!(whole(&store, &volley(), &every), (1, vec!["j25/142".to_owned()]));
    let (total, page) = whole(&store, &everything(), &every);
    assert_eq!(page, ["clb/55", "thb/245", "j25/142", "m21/214", "teld/14"]);
    assert_eq!(total, 5);
}

#[test]
fn an_artwork_one_card_carries_is_not_kept_apart() {
    // A store of ONE of each pair's cards: no artwork is shared, no printing is marked, and no
    // `unique=art` query sends a candidate — it runs as it ran before there were any.
    let alone = store_of(rows_of(&["volley_veteran_j25_142", "volley_veteran_fdn_550", "wolf_teld_14", "wolf_tblc_35", "temple_of_deceit_thb_245", "temple_of_deceit_fdn_697"]));
    let keys = alone.query_keys(&everything(), &opts("artwork", "name", "asc", "default"), 0).unwrap();
    assert!(keys.shared.is_empty() && keys.artless.is_none());
    assert_eq!(keys.total, 3);
    assert_eq!(art(&alone, &everything(), "name", "asc", "default"), ["thb/245", "j25/142", "teld/14"]);
    // ...and in the store of both, a query that matches no shared artwork sends none either,
    // while one that does sends one candidate an artwork and leaves it out of its own count.
    let store = store();
    let temple = store.query_keys(&name("temple"), &opts("artwork", "name", "asc", "default"), 0).unwrap();
    assert!(temple.shared.is_empty());
    assert_eq!((temple.total, temple.keys.len()), (1, 1));
    let all = store.query_keys(&everything(), &opts("artwork", "name", "asc", "default"), 0).unwrap();
    assert_eq!((all.total, all.keys.len(), all.shared.len()), (1, 1, 4));
    // Every candidate, whatever page was asked for: the count is theirs to give.
    let mut one = opts("artwork", "name", "asc", "default");
    one.limit = 1;
    assert_eq!(store.query_keys(&everything(), &one, 0).unwrap().shared.len(), 4);
    // The other modes never send any.
    for unique in ["printing", "card"] {
        assert!(store.query_keys(&everything(), &opts(unique, "name", "asc", "default"), 0).unwrap().shared.is_empty());
    }
}

#[test]
fn the_cut_into_partitions_answers_what_one_archive_does() {
    let store = store();
    let trees = [
        everything(),
        volley(),
        alora(),
        wolf(),
        wildwood(),
        or(&[wolf(), wildwood()]),
        and(&[everything(), not(set("m21"))]),
        and(&[everything(), not(number("142")), not(number("55")), not(set("teld"))]),
        gated(everything()),
        name("temple"),
        lang("ja"),
    ];
    for n in [2, 3, 5, 10] {
        let parts = partitions(n);
        // The premise: the two cards of some artwork really are in different archives.
        let sent: Vec<Vec<SharedKey>> = parts
            .iter()
            .map(|p| p.query_keys(&everything(), &opts("artwork", "name", "asc", "default"), 0).unwrap().shared)
            .collect();
        let candidates: usize = sent.iter().map(Vec::len).sum();
        assert_eq!(merge_shared(&sent).len(), 4, "N={n}");
        assert!(candidates > 4, "N={n}: every shared artwork's cards fell into one partition");
        for tree in &trees {
            for (orderby, direction) in [("name", "asc"), ("name", "desc"), ("released", "desc"), ("set", "asc"), ("usd", "asc"), ("usd", "desc"), ("tix", "asc")] {
                for prefer in ["default", "oldest", "newest", "usd_low", "usd_high", "promo", "default_frame", "borderless"] {
                    for unique in ["artwork", "printing", "card"] {
                        for multilingual in [false, true] {
                            // Whole, and paged a row at a time across the shared rows.
                            for (offset, limit) in [(0, 100), (0, 1), (1, 1), (2, 1), (3, 2), (4, 3), (40, 5)] {
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
