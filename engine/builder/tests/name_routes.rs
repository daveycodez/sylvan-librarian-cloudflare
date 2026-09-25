//! The name routes (backlog n6) against the REAL corpus: every answer the router gives from a
//! routed partition must be the answer asking all N partitions gives.
//!
//! The router (`scryfallExactName` and `scryfallCollectionBatch` in
//! src/engine/partitioned-engine.ts) asks the partition the routing filter names for a name, and
//! stops there whenever that partition's reply SETTLES the name (`nameReplySettles`). That is only
//! sound if the builders' name keys cover every name the engine can match, in every partition that
//! can match it, with the served flag wherever a served card answers — so this emulates the router
//! over the name keys `name_routing_keys_of` emits for every row of a built corpus, against that
//! corpus's own partition stores, and compares with the all-partition merge:
//!
//!   * every distinct name the corpus carries — whole, face and flavor, every row, canonical or
//!     not — and its collated spelling, each × {no set, a set it is printed in, some other set},
//!     for `exact=` and for a collection `{name}` (with and without a `?q=` scope);
//!   * 5,000 misspellings, under EVERY hint the filter could read for a key it never held (none,
//!     sole p and served s for every p and s), because a missing key reads an arbitrary byte;
//!   * the direct invariants underneath: a partition that ranks a name emitted its key, one that
//!     ranks it served emitted it served, and a `!"name"` search pinned to a sole partition finds
//!     nothing anywhere else (multilingual rows included).
//!
//! Ignored: it needs a built corpus. Point it at one (read-only) and run in release:
//!
//!   SYLVAN_STORE_BUILD=/path/to/store-build scripts/with-rust.sh cargo test --release \
//!     -p sylvan-store-builder --test name_routes -- --ignored --nocapture
//!
//! `SYLVAN_SKIP_PIN_CHECK=1` skips the `!` check — nearly all of its ~5 minutes.
//! `SYLVAN_NAME_KEYS_OUT=<file>` also writes the name keys as `<partition>\t<key>` lines (deduped
//! per partition, the native builder's shape), for sizing the filter on the TypeScript side.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Write};

use card_engine::{fnv1a64_oracle_id, BufferStore, CollectionScope, QueryOptions};
use serde_json::{Map, Value};
use sylvan_store_builder::transform::name_routing_keys_of;

/// A reply's rank, as the router compares it: `(served, tier, score)`.
type Rank = (u8, u8, f64);

#[derive(Clone, Copy, Debug)]
struct Reply {
    rank: Option<Rank>,
    present: bool,
}

#[derive(Clone, Copy, Debug)]
enum Hint {
    None,
    Sole(usize),
    Served(usize),
}

/// `beatsExactRank`: lexicographic, strictly greater.
fn beats(a: Rank, b: Option<Rank>) -> bool {
    match b {
        None => true,
        Some(b) => (a.0, a.1).cmp(&(b.0, b.1)).then(a.2.partial_cmp(&b.2).unwrap()).is_gt(),
    }
}

/// Every reply merged in partition order — the fan-out's answer.
fn merge(replies: &[Reply]) -> Option<(usize, Rank)> {
    let mut best: Option<(usize, Rank)> = None;
    for (p, r) in replies.iter().enumerate() {
        if let Some(rank) = r.rank
            && beats(rank, best.map(|b| b.1))
        {
            best = Some((p, rank));
        }
    }
    best
}

/// The router: the hinted partition's reply when it settles the name, else the merge.
fn route(hint: Hint, replies: &[Reply]) -> Option<(usize, Rank)> {
    match hint {
        Hint::Sole(p) if replies[p].rank.is_some() || replies[p].present => replies[p].rank.map(|r| (p, r)),
        Hint::Served(s) if replies[s].rank.is_some_and(|r| r.0 == 1) => replies[s].rank.map(|r| (s, r)),
        _ => merge(replies),
    }
}

/// `nameKey` in src/engine/routing-filter.ts: the key the router hashes, or None (not routed).
fn router_key(folded: &str) -> Option<String> {
    let stripped: String =
        folded.chars().filter(|c| !matches!(c, '\u{2018}' | '\u{2019}' | '\u{201c}' | '\u{201d}' | '\u{2013}' | '\u{2014}')).collect();
    if !stripped.is_ascii() {
        return None;
    }
    let collated: String = stripped.chars().filter(char::is_ascii_alphanumeric).collect();
    (!collated.is_empty()).then(|| format!("nm:{collated}"))
}

/// What the sealed filter holds for one name key: which partitions emitted it, which served.
#[derive(Default, Clone, Copy)]
struct Owners {
    all: u64,
    served: u64,
}

impl Owners {
    /// The seal's rule (`RoutingKeyAccumulator.seal`).
    fn hint(self) -> Hint {
        if self.all.count_ones() == 1 {
            Hint::Sole(self.all.trailing_zeros() as usize)
        } else if self.served.count_ones() == 1 {
            Hint::Served(self.served.trailing_zeros() as usize)
        } else {
            Hint::None
        }
    }
}

/// The fields of a finalized row the name keys read, and the set a name is printed in.
#[derive(serde::Deserialize)]
struct RowNames {
    oracle_id: String,
    #[serde(default)]
    card_name_folded: String,
    #[serde(default)]
    flavor_name_folded: Option<String>,
    #[serde(default)]
    is_canonical: bool,
    #[serde(default)]
    card_is_tags: Map<String, Value>,
    #[serde(default)]
    card_set_code: Option<String>,
}

fn halves(name: &str) -> Vec<&str> {
    let parts: Vec<&str> = name.split(" // ").collect();
    if parts.len() == 2 { parts } else { Vec::new() }
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

fn misspell(rng: &mut Rng, name: &str) -> String {
    let mut chars: Vec<char> = name.chars().collect();
    let letter = (b'a' + rng.below(26) as u8) as char;
    let at = rng.below(chars.len().max(1));
    match rng.below(4) {
        0 if chars.len() > 1 => {
            chars.remove(at);
        }
        1 => chars.insert(at, letter),
        2 if !chars.is_empty() => chars[at] = letter,
        _ if chars.len() > 1 => {
            let next = (at + 1) % chars.len();
            chars.swap(at, next);
        }
        _ => chars.push(letter),
    }
    chars.into_iter().collect()
}

#[test]
#[ignore = "needs a built corpus: SYLVAN_STORE_BUILD=<store-build dir>"]
fn name_routes_match_the_all_partition_merge() {
    let Ok(dir) = std::env::var("SYLVAN_STORE_BUILD") else {
        eprintln!("SYLVAN_STORE_BUILD is not set; nothing to check");
        return;
    };
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(format!("{dir}/manifest.json")).unwrap()).unwrap();
    let n = manifest["partition_count"].as_u64().unwrap() as usize;
    assert!(n <= 64);

    // ── the name keys, exactly as the builders emit them ────────────────────
    let started = std::time::Instant::now();
    let mut owners: HashMap<String, Owners> = HashMap::new();
    let mut lines_per_partition: Vec<HashSet<String>> = vec![HashSet::new(); n];
    let mut raw_lines = 0usize;
    // Every distinct folded name the corpus carries, with a set it is printed in.
    let mut needles: HashMap<String, String> = HashMap::new();
    let mut sets: Vec<String> = Vec::new();
    let mut set_seen: HashSet<String> = HashSet::new();
    let rows = std::io::BufReader::new(std::fs::File::open(format!("{dir}/rows.jsonl")).unwrap());
    let mut keys = Vec::new();
    for line in rows.lines() {
        let row: RowNames = serde_json::from_str(&line.unwrap()).unwrap();
        let p = (fnv1a64_oracle_id(&row.oracle_id) % n as u64) as usize;
        keys.clear();
        let extra = row.card_is_tags.contains_key("extra");
        name_routing_keys_of(&row.card_name_folded, row.flavor_name_folded.as_deref(), row.is_canonical, extra, &mut keys);
        raw_lines += keys.len();
        for key in &keys {
            lines_per_partition[p].insert(key.clone());
            let (served, bare) = match key.strip_prefix("ns:") {
                Some(k) => (true, k),
                None => (false, key.strip_prefix("nm:").unwrap()),
            };
            let o = owners.entry(format!("nm:{bare}")).or_default();
            o.all |= 1 << p;
            if served {
                o.served |= 1 << p;
            }
        }
        let set = row.card_set_code.clone().unwrap_or_default();
        if set_seen.insert(set.clone()) {
            sets.push(set.clone());
        }
        let mut names = vec![row.card_name_folded.as_str()];
        names.extend(halves(&row.card_name_folded));
        if let Some(f) = row.flavor_name_folded.as_deref() {
            names.push(f);
            names.extend(halves(f));
        }
        for name in names.into_iter().filter(|s| !s.is_empty()) {
            needles.entry(name.to_owned()).or_insert_with(|| set.clone());
            // The collated spelling too: it is the same key, and it misses the (folded) flavor pass.
            if let Some(key) = router_key(name) {
                needles.entry(key[3..].to_owned()).or_insert_with(|| set.clone());
            }
        }
    }
    let deduped: usize = lines_per_partition.iter().map(HashSet::len).sum();
    let (mut sole, mut served, mut ambiguous) = (0, 0, 0);
    for o in owners.values() {
        match o.hint() {
            Hint::Sole(_) => sole += 1,
            Hint::Served(_) => served += 1,
            Hint::None => ambiguous += 1,
        }
    }
    eprintln!(
        "name keys: {} distinct ({sole} sole = {:.1}%, {served} served-sole, {ambiguous} undecidable); \
         {raw_lines} raw lines, {deduped} after per-partition dedupe; {} needles; {:.1?}",
        owners.len(),
        100.0 * sole as f64 / owners.len() as f64,
        needles.len(),
        started.elapsed()
    );
    if let Ok(out) = std::env::var("SYLVAN_NAME_KEYS_OUT") {
        let mut w = std::io::BufWriter::new(std::fs::File::create(out).unwrap());
        for (p, keys) in lines_per_partition.iter().enumerate() {
            let mut keys: Vec<&String> = keys.iter().collect();
            keys.sort();
            for key in keys {
                writeln!(w, "{p}\t{key}").unwrap();
            }
        }
    }
    let hint_of = |needle: &str| router_key(needle).and_then(|k| owners.get(&k).copied()).map_or(Hint::None, Owners::hint);

    // ── the stores ──────────────────────────────────────────────────────────
    let stores: Vec<BufferStore> = manifest["partitions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|part| {
            let key = part["store_key"].as_str().unwrap();
            BufferStore::from_bytes(&std::fs::read(format!("{dir}/{key}")).unwrap()).unwrap()
        })
        .collect();

    // The cases: (needle, set, which of the three set variants).
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut named: Vec<(&str, &str)> = needles.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    named.sort();
    let mut cases: Vec<(String, Option<String>)> = Vec::with_capacity(named.len() * 3);
    for &(needle, set) in &named {
        cases.push((needle.to_owned(), None));
        cases.push((needle.to_owned(), Some(set.to_owned())));
        cases.push((needle.to_owned(), Some(sets[rng.below(sets.len())].clone())));
    }
    let routable: Vec<&str> = named.iter().map(|&(k, _)| k).filter(|k| router_key(k).is_some()).collect();
    let mut misspelled: Vec<(String, Option<String>)> = Vec::new();
    for i in 0..5000 {
        let pick = routable[rng.below(routable.len())];
        let wrong = misspell(&mut rng, pick);
        let set = (i % 2 == 1).then(|| sets[rng.below(sets.len())].clone());
        misspelled.push((wrong, set));
    }

    // ── every partition's replies, one thread per partition ──────────────────
    let started = std::time::Instant::now();
    let scope = CollectionScope { prefer: "newest".to_owned(), filter_tree: None };
    type PartitionReplies = (Vec<Reply>, Vec<Reply>, Vec<Reply>, Vec<Reply>);
    let replies: Vec<PartitionReplies> = std::thread::scope(|s| {
        let handles: Vec<_> = stores
            .iter()
            .map(|store| {
                let (cases, misspelled, scope) = (&cases, &misspelled, &scope);
                s.spawn(move || {
                    let present = |needle: &str| store.exact_name_rank(needle, None).is_some();
                    let exact = |(needle, set): &(String, Option<String>)| {
                        let rank = store.exact_name_rank(needle, set.as_deref()).map(|(a, b, c)| (a, b, f64::from(c)));
                        Reply { rank, present: rank.is_some() || (set.is_some() && present(needle)) }
                    };
                    let collection = |scope: Option<&CollectionScope>| {
                        let idents: Vec<(&str, Option<&str>)> =
                            cases.iter().map(|(n, s)| (n.as_str(), s.as_deref())).collect();
                        store
                            .collection_name_ranks(&idents, scope)
                            .unwrap()
                            .into_iter()
                            .zip(cases)
                            .map(|(rank, (needle, _))| Reply { rank, present: rank.is_some() || present(needle) })
                            .collect::<Vec<_>>()
                    };
                    (
                        cases.iter().map(exact).collect(),
                        collection(None),
                        collection(Some(scope)),
                        misspelled.iter().map(exact).collect(),
                    )
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    eprintln!("replies: {} cases + {} misspellings × {n} partitions in {:.1?}", cases.len(), misspelled.len(), started.elapsed());

    // ── the router against the merge ─────────────────────────────────────────
    type Pick = fn(&PartitionReplies) -> &Vec<Reply>;
    let column = |pick: Pick, i: usize| -> Vec<Reply> {
        replies.iter().map(|r| pick(r)[i]).collect()
    };
    let mut mismatches: Vec<String> = Vec::new();
    let mut single = [0usize; 3];
    let surfaces: [(&str, Pick); 3] =
        [("exact", |r| &r.0), ("collection", |r| &r.1), ("collection+scope", |r| &r.2)];
    for (i, (needle, set)) in cases.iter().enumerate() {
        let hint = hint_of(needle);
        for (s, (surface, pick)) in surfaces.iter().enumerate() {
            let col = column(*pick, i);
            let (routed, merged) = (route(hint, &col), merge(&col));
            if routed.map(|r| r.0) != merged.map(|m| m.0) || routed.map(|r| r.1) != merged.map(|m| m.1) {
                mismatches.push(format!("{surface} {needle:?} set={set:?} hint={hint:?}: routed {routed:?} merged {merged:?}"));
            }
            let settled = match hint {
                Hint::Sole(p) => col[p].rank.is_some() || col[p].present,
                Hint::Served(p) => col[p].rank.is_some_and(|r| r.0 == 1),
                Hint::None => false,
            };
            single[s] += usize::from(settled);
        }
        // The invariants underneath, without the set: a partition that ranks the name emitted its key,
        // and one ranking it SERVED emitted it served.
        if set.is_none()
            && let Some(key) = router_key(needle)
        {
            let o = owners.get(&key).copied().unwrap_or_default();
            for (p, r) in replies.iter().enumerate() {
                if let Some(rank) = r.0[i].rank {
                    if o.all & (1 << p) == 0 {
                        mismatches.push(format!("{needle:?}: partition {p} ranks it {rank:?} but emitted no key"));
                    } else if rank.0 == 1 && o.served & (1 << p) == 0 {
                        mismatches.push(format!("{needle:?}: partition {p} ranks it served but emitted it unserved"));
                    }
                }
            }
        }
    }
    let (mut misspelled_checks, mut still_names) = (0usize, 0usize);
    for (i, (needle, set)) in misspelled.iter().enumerate() {
        let col = column(|r| &r.3, i);
        let merged = merge(&col);
        // An edit that only moves a separator ("canyo ncrab") collates to a REAL key, whose value the
        // filter holds exactly — so only that value can be read for it. Every other misspelling is a
        // key the filter never held, and may read as any hint at all.
        let hints: Vec<Hint> = if router_key(needle).is_some_and(|k| owners.contains_key(&k)) {
            still_names += 1;
            vec![hint_of(needle)]
        } else {
            std::iter::once(Hint::None).chain((0..n).map(Hint::Sole)).chain((0..n).map(Hint::Served)).collect()
        };
        for hint in hints {
            misspelled_checks += 1;
            let routed = route(hint, &col);
            if routed.map(|r| r.0) != merged.map(|m| m.0) {
                mismatches.push(format!("misspelling {needle:?} set={set:?} hint={hint:?}: routed {routed:?} merged {merged:?}"));
            }
        }
    }
    eprintln!(
        "router vs merge: {} cases × 3 surfaces + {misspelled_checks} misspelling×hint checks \
         ({still_names} misspellings still collate to a real name); \
         settled by one partition: exact {:.1}%, collection {:.1}%, scoped {:.1}%",
        cases.len(),
        100.0 * single[0] as f64 / cases.len() as f64,
        100.0 * single[1] as f64 / cases.len() as f64,
        100.0 * single[2] as f64 / cases.len() as f64,
    );

    // ── `!"name"` pinned to a sole partition finds nothing anywhere else ────────
    let started = std::time::Instant::now();
    let skip_pins = std::env::var_os("SYLVAN_SKIP_PIN_CHECK").is_some();
    let opts = QueryOptions { unique: "printing".to_owned(), limit: 1, include_multilingual: true, ..QueryOptions::default() };
    let pinned: Vec<(&String, usize)> =
        owners.iter().filter_map(|(k, o)| if let Hint::Sole(p) = o.hint() { Some((k, p)) } else { None }).collect();
    let leaks: Vec<String> = std::thread::scope(|s| {
        let handles: Vec<_> = stores
            .iter()
            .enumerate()
            .map(|(q, store)| {
                let (pinned, opts) = (&pinned, &opts);
                s.spawn(move || {
                    pinned
                        .iter()
                        .filter(|&&(k, p)| !skip_pins && p != q && k[3..].is_ascii())
                        .filter_map(|&(k, p)| {
                            let tree = serde_json::json!({"node_type": "ExactNameNode", "kwargs": {"value": &k[3..]}});
                            let total = store.query(&tree.to_string(), opts).unwrap().total;
                            (total > 0).then(|| format!("!{:?} pinned to {p} but partition {q} matches {total}", &k[3..]))
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap()).collect()
    });
    if skip_pins {
        eprintln!("`!` pins: SKIPPED (SYLVAN_SKIP_PIN_CHECK) — ~5 minutes on ten partitions");
    } else {
        eprintln!("`!` pins: {} sole keys × {} other partitions checked in {:.1?}", pinned.len(), n - 1, started.elapsed());
    }
    mismatches.extend(leaks);

    for m in mismatches.iter().take(40) {
        eprintln!("MISMATCH {m}");
    }
    assert!(mismatches.is_empty(), "{} mismatches", mismatches.len());
}
