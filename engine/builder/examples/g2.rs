//! G2 differential-gate harness: the REAL-corpus acceptance step (plan G2 /
//! Track B B6 / CARD-PARTITIONING §6), driven entirely from local files —
//! no network, no KV.
//!
//!   tags-from-rows   reconstruct the {oracle, art} slug maps from an existing
//!                    finalized rows.jsonl (the tag corpus rides every row, so
//!                    an English build's rows are a complete local tag source)
//!   rows             stream the real all_cards bulk through transform_row with
//!                    is_canonical = id-membership in default_cards, finalize,
//!                    write rows.jsonl — and run the canonical differential
//!                    (derived rule vs default_cards membership) in the same pass
//!   build            build_store (unpartitioned reference) or
//!                    build_store_partitioned (--partitions auto|N) from rows.jsonl
//!   diff             envelope differential: the parser fixture corpus plus the
//!                    lang:/include_multilingual/unique/deep-offset grid through
//!                    (a) the reference archive's pages and (b) the reference
//!                    gather over the partition archives — byte-identical or die
//!                    printing the first divergent case in full
//!   fuzzy            the program's origin case: resolve a foreign name against
//!                    a real archive and print the printing it lands on
//!
//! Everything here reuses the production build seams (build_store,
//! build_store_partitioned, transform_row, finalize) — the only novel logic is
//! the gather, which is a line-for-line twin of core_api's `gather_reference`
//! test reference (the algorithm remote-engine.ts is held to).

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

use card_engine::{BufferStore, QueryOptions, SORT_KEY_VERSION};
use serde_json::{json, Value};
use sylvan_store_builder::bulk::{gunzip_if_needed, JsonlStream};
use sylvan_store_builder::tags::{CanonicalIds, TagData};
use sylvan_store_builder::{build_store, build_store_partitioned, transform, PartitionsArg};

fn mb(n: u64) -> f64 {
    n as f64 / 1_048_576.0
}

/// Stream a (possibly gzipped) JSONL bulk file as parsed objects.
fn stream_bulk(path: &Path) -> JsonlStream<BufReader<Box<dyn std::io::Read>>> {
    let file = std::fs::File::open(path).unwrap_or_else(|e| panic!("open {}: {e}", path.display()));
    let reader = gunzip_if_needed(Box::new(file)).expect("gunzip");
    JsonlStream::new(BufReader::with_capacity(1 << 20, reader))
}

// ─── tags-from-rows ──────────────────────────────────────────────────────────

/// Every finalized row carries its card's full oracle-tag and art-tag key sets
/// (`card_oracle_tags` keyed by oracle_id, `card_art_tags` by illustration_id),
/// so a prior build's rows.jsonl IS a complete local snapshot of the tag dumps
/// it was built from. Reconstructing the slug maps from it gives the G2 build a
/// real tag corpus without a network fetch.
fn cmd_tags_from_rows(rows_path: &Path, out_path: &Path) {
    let file = std::fs::File::open(rows_path).expect("open rows");
    let mut oracle: HashMap<String, Vec<String>> = HashMap::new();
    let mut art: HashMap<String, Vec<String>> = HashMap::new();
    for line in BufReader::with_capacity(1 << 20, file).lines() {
        let line = line.expect("read line");
        if line.is_empty() {
            continue;
        }
        let row: Value = serde_json::from_str(&line).expect("parse row");
        let keys = |v: &Value| -> Vec<String> {
            v.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default()
        };
        if let Some(oid) = row.get("oracle_id").and_then(Value::as_str) {
            let tags = keys(&row["card_oracle_tags"]);
            if !tags.is_empty() {
                oracle.entry(oid.to_owned()).or_insert(tags);
            }
        }
        if let Some(ill) = row.get("illustration_id").and_then(Value::as_str) {
            let tags = keys(&row["card_art_tags"]);
            if !tags.is_empty() {
                art.entry(ill.to_owned()).or_insert(tags);
            }
        }
    }
    let out = json!({ "oracle": oracle, "art": art });
    std::fs::write(out_path, out.to_string()).expect("write tags");
    eprintln!(
        "reconstructed {} oracle-tag entries, {} art-tag entries -> {}",
        out["oracle"].as_object().unwrap().len(),
        out["art"].as_object().unwrap().len(),
        out_path.display()
    );
}

fn load_tag_data(tags_path: &Path) -> TagData {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(tags_path).expect("read tags")).expect("parse tags");
    let to_map = |key: &str| -> HashMap<String, Vec<String>> {
        v[key]
            .as_object()
            .expect("tag map")
            .iter()
            .map(|(id, slugs)| {
                let mut slugs: Vec<String> =
                    slugs.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_owned()).collect();
                slugs.sort();
                slugs.dedup();
                (id.clone(), slugs)
            })
            .collect()
    };
    TagData::from_slug_maps(to_map("oracle"), to_map("art"))
}

// ─── rows ────────────────────────────────────────────────────────────────────

fn cmd_rows(default_path: &Path, all_path: &Path, tags_path: &Path, out_path: &Path) {
    // 1. The canonical set: id-membership in default_cards, the production rule.
    eprintln!("reading default_cards ids from {}...", default_path.display());
    let mut canonical = CanonicalIds::default();
    let mut default_ids: Vec<String> = Vec::new();
    for card in stream_bulk(default_path) {
        let card = card.expect("default_cards read");
        if let Some(id) = card.get("id").and_then(Value::as_str) {
            canonical.insert(id);
            default_ids.push(id.to_owned());
        }
    }
    eprintln!("  {} default_cards ids ({} unique canonical)", default_ids.len(), canonical.len());

    // 2. Stream all_cards: transform each line with the caller's canonicity fact,
    //    measure staged-draft bytes exactly as the coordinator stages them
    //    ([u64 hash prefix][RowDraft JSON]), and collect the tuples the canonical
    //    differential needs.
    eprintln!("streaming all_cards from {}...", all_path.display());
    struct Tuple {
        id: String,
        lang: String,
        set: String,
        cn: String,
    }
    let mut tuples: Vec<Tuple> = Vec::new();
    let mut drafts = Vec::new();
    let mut draft_bytes: u64 = 0;
    let (mut parsed, mut filtered, mut canon_drafts, mut foreign_drafts) = (0u64, 0u64, 0u64, 0u64);
    for card in stream_bulk(all_path) {
        let card = card.expect("all_cards read");
        parsed += 1;
        let id = card.get("id").and_then(Value::as_str).unwrap_or("").to_owned();
        tuples.push(Tuple {
            id: id.clone(),
            lang: card.get("lang").and_then(Value::as_str).unwrap_or("").to_owned(),
            set: card.get("set").and_then(Value::as_str).unwrap_or("").to_owned(),
            cn: card.get("collector_number").and_then(Value::as_str).unwrap_or("").to_owned(),
        });
        let is_canonical = canonical.contains(&id);
        match transform::transform_row(&card, is_canonical).expect("transform") {
            Some(draft) => {
                // The coordinator's staged framing: 8-byte partition-hash prefix + draft JSON.
                draft_bytes += 8 + serde_json::to_vec(&draft).expect("draft json").len() as u64;
                if is_canonical {
                    canon_drafts += 1;
                } else {
                    foreign_drafts += 1;
                }
                drafts.push(draft);
            }
            None => filtered += 1,
        }
        if parsed % 100_000 == 0 {
            eprintln!("  {parsed} lines, {} drafts...", drafts.len());
        }
    }
    eprintln!(
        "  parsed {parsed} lines: {} drafts ({canon_drafts} canonical + {foreign_drafts} foreign), {filtered} filtered",
        drafts.len()
    );
    eprintln!("  staged draft bytes (coordinator framing): {draft_bytes} ({:.1}MB)", mb(draft_bytes));

    // 3. Canonical differential (plan reconciliation 5): the derived rule —
    //    lang=="en" OR no English printing shares (set, collector_number) —
    //    must cover every default_cards id (subset), and its over-include is
    //    reported, not shipped.
    let en_set_cn: HashSet<(&str, &str)> =
        tuples.iter().filter(|t| t.lang == "en").map(|t| (t.set.as_str(), t.cn.as_str())).collect();
    let derived = |t: &Tuple| t.lang == "en" || !en_set_cn.contains(&(t.set.as_str(), t.cn.as_str()));
    let by_id: HashMap<&str, &Tuple> = tuples.iter().map(|t| (t.id.as_str(), t)).collect();
    let mut missing_from_all = 0u64;
    let mut violation_count = 0u64;
    let mut subset_violations: Vec<String> = Vec::new();
    for id in &default_ids {
        match by_id.get(id.as_str()) {
            None => missing_from_all += 1,
            Some(t) => {
                if !derived(t) {
                    violation_count += 1;
                    if subset_violations.len() < 10 {
                        subset_violations.push(format!("{id} lang={} {}/{}", t.lang, t.set, t.cn));
                    }
                }
            }
        }
    }
    let mut over_include = 0u64;
    let mut over_samples: Vec<String> = Vec::new();
    for t in &tuples {
        if derived(t) && !canonical.contains(&t.id) {
            over_include += 1;
            if over_samples.len() < 10 {
                over_samples.push(format!("{} lang={} {}/{}", t.id, t.lang, t.set, t.cn));
            }
        }
    }
    eprintln!("canonical differential:");
    eprintln!("  default_cards ids missing from all_cards: {missing_from_all}");
    eprintln!("  default ids the derived rule would NOT mark canonical (subset violations): {violation_count}");
    for s in &subset_violations {
        eprintln!("    {s}");
    }
    eprintln!("  derived-rule over-include (derived canonical but NOT in default_cards): {over_include}");
    for s in &over_samples {
        eprintln!("    {s}");
    }

    // 4. Finalize against the reconstructed tag corpus and write rows.jsonl.
    //    labels (the oracle_cards representative pin) are deliberately absent:
    //    that dump is network-only and its absence shifts scores identically in
    //    both build shapes, which is all the differential requires.
    eprintln!("finalizing {} drafts...", drafts.len());
    let tags = load_tag_data(tags_path);
    let out = std::fs::File::create(out_path).expect("create rows");
    let mut w = BufWriter::with_capacity(1 << 20, out);
    let mut rows = 0u64;
    let mut row_bytes = 0u64;
    for row in transform::finalize(drafts, &tags) {
        let bytes = serde_json::to_vec(&row).expect("row json");
        row_bytes += bytes.len() as u64 + 1;
        w.write_all(&bytes).expect("write row");
        w.write_all(b"\n").expect("write newline");
        rows += 1;
    }
    w.flush().expect("flush rows");
    eprintln!("finalized {rows} rows ({:.1}MB) -> {}", mb(row_bytes), out_path.display());
    println!(
        "{}",
        json!({
            "all_cards_lines": parsed,
            "drafts": canon_drafts + foreign_drafts,
            "canonical_drafts": canon_drafts,
            "foreign_drafts": foreign_drafts,
            "filtered": filtered,
            "staged_draft_bytes": draft_bytes,
            "rows": rows,
            "rows_bytes": row_bytes,
            "default_ids": default_ids.len(),
            "canonical_subset_violations": violation_count,
            "canonical_missing_from_all_cards": missing_from_all,
            "derived_rule_over_include": over_include,
        })
    );
}

// ─── build ───────────────────────────────────────────────────────────────────

fn rows_iter(rows_path: &Path) -> impl Iterator<Item = Value> {
    let file = std::fs::File::open(rows_path).expect("open rows");
    BufReader::with_capacity(1 << 20, file).lines().filter_map(|line| {
        let line = line.expect("read row line");
        if line.is_empty() { None } else { Some(serde_json::from_str::<Value>(&line).expect("parse row")) }
    })
}

fn cmd_build(rows_path: &Path, out_dir: &Path, partitions: Option<PartitionsArg>) {
    std::fs::create_dir_all(out_dir).expect("mkdir out");
    let started = std::time::Instant::now();
    let manifest_json = match partitions {
        Some(arg) => build_store_partitioned(rows_iter(rows_path), out_dir, "g2", arg).expect("partitioned build"),
        None => build_store(rows_iter(rows_path), out_dir, "g2").expect("build").to_json(),
    };
    std::fs::write(out_dir.join("manifest.json"), manifest_json.to_string()).expect("write manifest");
    eprintln!("build wall: {:.1}s", started.elapsed().as_secs_f64());
    println!("{manifest_json}");
}

// ─── diff ────────────────────────────────────────────────────────────────────

/// THE REFERENCE GATHER — a twin of core_api's `gather_reference` test fn
/// (phase-1 keys at offset 0 / bytewise k-way merge / phase-2 fetch from the
/// owning partition / splice), made fallible so error-parity cases can be
/// compared instead of panicking.
fn gather_reference(
    partitions: &[BufferStore],
    tree: &Value,
    opts: &QueryOptions,
    inline_budget: usize,
) -> Result<(usize, Vec<Value>, bool), String> {
    let mut phase1 = opts.clone();
    phase1.limit = opts.offset + opts.limit;
    phase1.offset = 0;
    // Inline rows only at offset 0 — see BufferStore::query_keys for why a prefix cannot cover a
    // deep page. Identical rule to src/engine/gather.ts's inlineRowBudget.
    let inline = if opts.offset == 0 { inline_budget } else { 0 };
    let mut total = 0usize;
    let mut merged: Vec<(Vec<u8>, usize, u32, usize)> = Vec::new();
    let mut carried: Vec<Vec<Value>> = Vec::with_capacity(partitions.len());
    for (part, store) in partitions.iter().enumerate() {
        let out = store.query_keys(tree, &phase1, inline).map_err(|e| format!("{e:?}"))?;
        total += out.total;
        for (local, (key, vpid)) in out.keys.into_iter().enumerate() {
            assert_eq!(key[0], SORT_KEY_VERSION, "the gather must refuse mixed key versions");
            merged.push((key, part, vpid, local));
        }
        carried.push(out.rows);
    }
    merged.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    let end = (opts.offset + opts.limit).min(merged.len());
    let page = if opts.offset < end { &merged[opts.offset..end] } else { &[][..] };

    let mut rows: Vec<Option<Value>> = vec![None; page.len()];
    for (part, store) in partitions.iter().enumerate() {
        let mut owed_at: Vec<usize> = Vec::new();
        let mut owed_vpids: Vec<u32> = Vec::new();
        for i in 0..page.len() {
            if page[i].1 != part {
                continue;
            }
            match carried[part].get(page[i].3) {
                Some(row) => rows[i] = Some(row.clone()),
                None => {
                    owed_at.push(i);
                    owed_vpids.push(page[i].2);
                }
            }
        }
        if owed_vpids.is_empty() {
            continue;
        }
        let fetched = store.fetch_rows(&owed_vpids, opts.fields.clone()).map_err(|e| format!("{e:?}"))?;
        for (slot, row) in owed_at.into_iter().zip(fetched) {
            rows[slot] = Some(row);
        }
    }
    let data: Vec<Value> = rows.into_iter().map(|r| r.expect("every page slot fetched")).collect();
    let has_more = opts.offset + data.len() < total;
    Ok((total, data, has_more))
}

/// The inline-row budget src/engine/gather.ts computes for a real request — kept here as a
/// deliberate twin (`INLINE_SLACK` / `inlineRowBudget`) so the G2 gate exercises the SHAPE
/// production runs, not just the keys-only protocol. Nothing depends on the two staying equal:
/// the budget is a hint, and a mismatch costs a phase-2 call, never an answer.
fn inline_row_budget(offset: usize, limit: usize, partition_count: usize) -> usize {
    if offset > 0 || partition_count == 0 {
        return 0;
    }
    limit.min(limit.div_ceil(partition_count) + 16)
}

/// Both protocols, held against each other: keys-only (phase 2 for everything) and the inline
/// budget production uses. They must agree exactly — that is the whole claim of folding phase 2
/// into phase 1 — so a divergence stops the gate here rather than surfacing as a wrong page.
fn gather_both(
    partitions: &[BufferStore],
    tree: &Value,
    opts: &QueryOptions,
) -> Result<(usize, Vec<Value>, bool), String> {
    let keys_only = gather_reference(partitions, tree, opts, 0)?;
    let budget = inline_row_budget(opts.offset, opts.limit, partitions.len());
    let inlined = gather_reference(partitions, tree, opts, budget)?;
    if keys_only != inlined {
        return Err(format!(
            "inline budget {budget} changed the gather's answer (offset={} limit={})",
            opts.offset, opts.limit
        ));
    }
    Ok(inlined)
}

fn lang_filter(value: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "op": ":",
            "lhs": { "node_type": "CardAttributeNode",
                     "kwargs": { "attribute_name": "card_lang", "original_attribute": "lang" } },
            "rhs": { "node_type": "StringValueNode", "kwargs": { "value": value } },
        }
    })
}

fn name_filter(value: &str) -> Value {
    json!({
        "node_type": "CardBinaryOperatorNode",
        "kwargs": {
            "op": ":",
            "lhs": { "node_type": "CardAttributeNode",
                     "kwargs": { "attribute_name": "card_name", "original_attribute": "name" } },
            "rhs": { "node_type": "StringValueNode", "kwargs": { "value": value } },
        }
    })
}

fn and2(a: Value, b: Value) -> Value {
    json!({ "node_type": "AndNode", "kwargs": { "operands": [a, b] } })
}

fn opts_for(orderby: &str, direction: &str, unique: &str, ml: bool, offset: usize, limit: usize) -> QueryOptions {
    QueryOptions {
        unique: unique.to_owned(),
        orderby: orderby.to_owned(),
        direction: direction.to_owned(),
        offset,
        limit,
        include_multilingual: ml,
        ..QueryOptions::default()
    }
}

fn key_grid() -> Vec<(&'static str, &'static str, &'static str, bool)> {
    vec![
        ("name", "asc", "card", false),
        ("name", "desc", "card", false),
        ("set", "asc", "printing", false),
        ("released", "desc", "printing", false),
        ("cmc", "asc", "card", false),
        ("artist", "asc", "printing", false),
        ("artist", "desc", "printing", false),
        ("edhrec", "asc", "card", false),
        ("usd", "desc", "printing", false),
        ("name", "asc", "printing", true),
        ("released", "asc", "printing", true),
        ("name", "asc", "artwork", false),
        ("name", "asc", "artwork", true),
    ]
}

fn cmd_diff(reference_path: &Path, parts_dir: &Path, corpus_path: &Path) {
    let load = |p: &Path| {
        let bytes = std::fs::read(p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()));
        BufferStore::from_bytes(&bytes).unwrap_or_else(|e| panic!("load {}: {e}", p.display()))
    };
    eprintln!("loading reference {}...", reference_path.display());
    let reference = load(reference_path);

    // Partition archives: every *-p<k>.store in the dir, ordered by k.
    let mut part_files: Vec<(u32, PathBuf)> = std::fs::read_dir(parts_dir)
        .expect("read parts dir")
        .filter_map(|e| {
            let path = e.expect("dir entry").path();
            let name = path.file_name()?.to_str()?.to_owned();
            let k: u32 = name.strip_suffix(".store")?.rsplit_once("-p")?.1.parse().ok()?;
            Some((k, path))
        })
        .collect();
    part_files.sort_by_key(|(k, _)| *k);
    assert!(!part_files.is_empty(), "no -p<k>.store files in {}", parts_dir.display());
    eprintln!("loading {} partitions from {}...", part_files.len(), parts_dir.display());
    let partitions: Vec<BufferStore> = part_files.iter().map(|(_, p)| load(p)).collect();

    assert_eq!(
        reference.size(),
        partitions.iter().map(BufferStore::size).sum::<usize>(),
        "printing counts must sum across partitions"
    );
    assert_eq!(
        reference.card_count(),
        partitions.iter().map(BufferStore::card_count).sum::<usize>(),
        "card counts must sum across partitions"
    );

    // The case corpus: every parser fixture query (real parser output trees),
    // a widened sweep for every 7th, plus the curated multilingual /
    // deep-offset / unique grid.
    let fixtures: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(corpus_path).expect("read corpus")).expect("parse corpus");
    let mut cases: Vec<(String, Value, QueryOptions)> = Vec::new();
    let mut fixture_count = 0usize;
    for (i, fixture) in fixtures.iter().enumerate() {
        let Some(tree_str) = fixture.get("tree").and_then(Value::as_str) else { continue };
        let Ok(tree) = serde_json::from_str::<Value>(tree_str) else { continue };
        let query = fixture.get("query").and_then(Value::as_str).unwrap_or("?").to_owned();
        fixture_count += 1;
        cases.push((format!("fixture[{i}] {query}"), tree.clone(), opts_for("edhrec", "asc", "card", false, 0, 175)));
        if i % 7 == 0 {
            cases.push((
                format!("fixture[{i}] {query} (printing+ml, name asc)"),
                tree,
                opts_for("name", "asc", "printing", true, 0, 175),
            ));
        }
    }
    eprintln!("{fixture_count} parser fixture trees loaded");

    let true_node = json!({ "node_type": "TrueNode" });
    for (orderby, direction, unique, ml) in key_grid() {
        for (offset, limit) in [(0usize, 175usize), (3, 4), (7, 50), (9000, 175), (100_000, 5)] {
            cases.push((
                format!("TrueNode orderby={orderby} {direction} unique={unique} ml={ml} offset={offset} limit={limit}"),
                true_node.clone(),
                opts_for(orderby, direction, unique, ml, offset, limit),
            ));
        }
    }
    for (label, tree) in [
        ("lang:ja", lang_filter("ja")),
        ("lang:pt", lang_filter("pt")),
        ("lang:pt \"unmoored ego\"", and2(name_filter("unmoored ego"), lang_filter("pt"))),
        ("\"unmoored ego\" (ml implied off)", name_filter("unmoored ego")),
    ] {
        for (orderby, unique, ml) in [
            ("name", "card", false),
            ("name", "printing", false),
            ("name", "printing", true),
            ("released", "printing", true),
            ("edhrec", "card", true),
        ] {
            cases.push((
                format!("{label} orderby={orderby} unique={unique} ml={ml}"),
                tree.clone(),
                opts_for(orderby, "asc", unique, ml, 0, 175),
            ));
        }
    }

    eprintln!("running {} envelope cases...", cases.len());
    let (mut ok, mut err_parity) = (0usize, 0usize);
    for (i, (label, tree, opts)) in cases.iter().enumerate() {
        let want = reference.query_value(tree, opts);
        let got = gather_both(&partitions, tree, opts);
        match (want, got) {
            (Err(we), Err(ge)) => {
                let _ = ge; // both sides refuse: error parity
                eprintln!("  error-parity: {label} ({we:?})");
                err_parity += 1;
            }
            (Err(we), Ok(_)) => {
                eprintln!("DIVERGENT (reference errors, gather answers): {label}");
                eprintln!("  tree: {tree}");
                eprintln!("  reference error: {we:?}");
                std::process::exit(1);
            }
            (Ok(_), Err(ge)) => {
                eprintln!("DIVERGENT (gather errors, reference answers): {label}");
                eprintln!("  tree: {tree}");
                eprintln!("  gather error: {ge}");
                std::process::exit(1);
            }
            (Ok(want), Ok((total, data, has_more))) => {
                let want_has_more = opts.offset + want.rows.len() < want.total;
                let want_env =
                    json!({ "total_cards": want.total, "has_more": want_has_more, "data": want.rows }).to_string();
                let got_env = json!({ "total_cards": total, "has_more": has_more, "data": data }).to_string();
                if want_env != got_env {
                    eprintln!("DIVERGENT ENVELOPE: {label}");
                    eprintln!("  tree: {tree}");
                    eprintln!(
                        "  opts: orderby={} {} unique={} ml={} offset={} limit={}",
                        opts.orderby, opts.direction, opts.unique, opts.include_multilingual, opts.offset, opts.limit
                    );
                    eprintln!("  reference envelope:\n{want_env}");
                    eprintln!("  gathered envelope:\n{got_env}");
                    std::process::exit(1);
                }
                ok += 1;
            }
        }
        if (i + 1) % 200 == 0 {
            eprintln!("  {}/{} cases...", i + 1, cases.len());
        }
    }
    println!("ENVELOPES BYTE-IDENTICAL: {ok} cases matched, {err_parity} error-parity cases, 0 divergent");
}

// ─── fuzzy ───────────────────────────────────────────────────────────────────

fn cmd_fuzzy(store_path: &Path, needle: &str) {
    let bytes = std::fs::read(store_path).expect("read store");
    let store = BufferStore::from_bytes(&bytes).expect("load store");
    let folded = transform::fold_accents(&needle.to_lowercase());
    let want = |names: &[&str]| Some(names.iter().map(|s| (*s).to_owned()).collect::<Vec<String>>());
    let fields = ["name", "printed_name", "set_code", "collector_number", "lang", "scryfall_id"];
    let (status, row) = store
        .fuzzy_card_by_name(&folded, 0.5, 0.05, want(&fields))
        .or_else(|_| store.fuzzy_card_by_name(&folded, 0.5, 0.05, None))
        .expect("fuzzy");
    println!("needle {needle:?} (folded {folded:?}) -> {status}");
    if let Some(row) = row {
        println!("{row}");
    }
}

// ─── main ────────────────────────────────────────────────────────────────────

fn arg(args: &HashMap<String, String>, key: &str) -> PathBuf {
    PathBuf::from(args.get(key).unwrap_or_else(|| panic!("missing --{key}")))
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let cmd = argv.first().map(String::as_str).unwrap_or("");
    let mut args: HashMap<String, String> = HashMap::new();
    let mut it = argv.iter().skip(1);
    while let Some(k) = it.next() {
        let k = k.strip_prefix("--").expect("flags start with --");
        args.insert(k.to_owned(), it.next().expect("flag value").clone());
    }

    match cmd {
        "tags-from-rows" => cmd_tags_from_rows(&arg(&args, "rows"), &arg(&args, "out")),
        "rows" => cmd_rows(&arg(&args, "default"), &arg(&args, "all"), &arg(&args, "tags"), &arg(&args, "out")),
        "build" => {
            let partitions = args.get("partitions").map(|v| {
                if v == "auto" { PartitionsArg::Auto } else { PartitionsArg::Fixed(v.parse().expect("partition count")) }
            });
            cmd_build(&arg(&args, "rows"), &arg(&args, "out"), partitions);
        }
        "diff" => cmd_diff(&arg(&args, "reference"), &arg(&args, "parts-dir"), &arg(&args, "corpus")),
        "fuzzy" => cmd_fuzzy(&arg(&args, "store"), args.get("needle").expect("--needle")),
        other => {
            eprintln!("unknown command {other:?}; expected tags-from-rows | rows | build | diff | fuzzy");
            std::process::exit(2);
        }
    }
}
