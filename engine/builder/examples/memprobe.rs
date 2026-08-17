//! Free-plan feasibility probe: can the store build run inside a 128MB
//! Cloudflare isolate? This harness answers the native half of that question:
//!
//!   gen    synthesize a deterministic Scryfall-shaped bulk corpus at real
//!          scale (default_cards is ~100k printings) — the egress-restricted
//!          dev sandbox cannot download the real dump, and determinism is
//!          what the wasm hash-parity check needs anyway
//!   rows   run the real transform+finalize pipeline over the corpus and dump
//!          the finalized ENGINE_COLUMNS rows as JSONL (the exact byte input
//!          both the native and wasm builds consume)
//!   build  stream rows.jsonl through build_store() with a counting global
//!          allocator and report peak heap — the number to compare against
//!          the isolate's 128MB ceiling
//!
//! Usage:
//!   cargo run --release -p sylvan-store-builder --example memprobe -- gen \
//!       --printings 100000 --bulk /tmp/bulk.jsonl --tags /tmp/tags.json
//!   cargo run --release -p sylvan-store-builder --example memprobe -- rows \
//!       --bulk /tmp/bulk.jsonl --tags /tmp/tags.json --out /tmp/rows.jsonl
//!   cargo run --release -p sylvan-store-builder --example memprobe -- build \
//!       --rows /tmp/rows.jsonl --out /tmp/store-out

use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Map, Value};
use sylvan_store_builder::tags::TagData;
use sylvan_store_builder::{build_store, transform};

// ─── counting allocator ──────────────────────────────────────────────────────

struct CountingAlloc;

static CURRENT: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

fn count_alloc(size: usize) {
    let cur = CURRENT.fetch_add(size, Ordering::Relaxed) + size;
    PEAK.fetch_max(cur, Ordering::Relaxed);
}

fn count_dealloc(size: usize) {
    CURRENT.fetch_sub(size, Ordering::Relaxed);
}

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count_alloc(layout.size());
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        count_dealloc(layout.size());
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        count_dealloc(layout.size());
        count_alloc(new_size);
        unsafe { System.realloc(ptr, layout, new_size) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count_alloc(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }
}

// With vendor-alloc-counter, card_engine registers its own global allocator
// (and prints per-phase build_ckpt lines); ours must stand down. The local
// CURRENT/PEAK counters then read ~0 — the vendor's checkpoints are the data.
#[cfg(not(feature = "vendor-alloc-counter"))]
#[global_allocator]
static ALLOC: CountingAlloc = CountingAlloc;

fn reset_peak() {
    PEAK.store(CURRENT.load(Ordering::Relaxed), Ordering::Relaxed);
}

fn mb(bytes: usize) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

// ─── deterministic rng + corpus vocabulary ───────────────────────────────────

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64* — deterministic across platforms, no deps.
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn chance(&mut self, pct: u64) -> bool {
        self.below(100) < pct
    }
}

const WORDS: &[&str] = &[
    "ancient", "arcane", "ashen", "blazing", "bog", "bold", "brine", "cinder", "crystal", "cursed",
    "dawn", "dusk", "ember", "fabled", "fen", "feral", "gilded", "gloom", "grim", "hallowed",
    "hollow", "iron", "jade", "keen", "lone", "lunar", "mire", "mossy", "night", "oaken",
    "pale", "quiet", "raging", "rusted", "sable", "shrouded", "silent", "solar", "sworn", "thorn",
    "tidal", "umbral", "veiled", "wild", "winter", "wretched", "zealous", "azure", "burning", "cold",
    "warden", "seer", "titan", "wisp", "shade", "knight", "adept", "oracle", "raider", "shaman",
    "sentinel", "harbinger", "wanderer", "keeper", "reaver", "scribe", "herald", "stalker", "golem", "sprite",
    "draw", "card", "target", "creature", "player", "damage", "deals", "destroy", "exile", "return",
    "battlefield", "graveyard", "library", "hand", "counter", "spell", "mana", "add", "tap", "untap",
    "flying", "trample", "haste", "vigilance", "deathtouch", "lifelink", "menace", "reach", "ward", "flash",
    "sacrifice", "token", "copy", "search", "shuffle", "reveal", "discard", "gain", "life", "lose",
    "until", "end", "turn", "beginning", "upkeep", "combat", "whenever", "enters", "dies", "attacks",
];

const SETS: &[&str] = &[
    "alp", "brm", "cwx", "dqe", "eth", "fjm", "gkr", "hlv", "ixp", "jnw",
    "kqa", "lsb", "mtc", "nvd", "oze", "pqf", "rlg", "swh", "tui", "uvj",
    "wxk", "xyl", "yzm", "zab", "bcn", "cdo", "dep", "efq", "fgr", "ghs",
];

const RARITIES: &[&str] = &["common", "uncommon", "rare", "mythic"];

// ─── Foreign-printing synthesis (`gen --foreign-ratio`) ──────────────────────
// Weighted like the measured all_cards distribution (ja 62k : fr 59k : de 58k : es 53k : it 53k
// : zhs 41k : pt 40k : zht 24k : ru 22k : ko 15k), so the gate's ratios are read off a corpus
// with the real language shape rather than a uniform one.
const FOREIGN_LANGS: &[(&str, u64)] = &[
    ("ja", 62), ("fr", 59), ("de", 58), ("es", 53), ("it", 53),
    ("zhs", 41), ("pt", 40), ("zht", 24), ("ru", 22), ("ko", 15),
];
const FOREIGN_LANG_WEIGHT_SUM: u64 = 427;

// Accent- and script-bearing word pools, one per script family: the printed-name index, the
// fuzzy fold path and the interner all behave differently on multi-byte text, so the synthetic
// corpus must actually carry some.
const LATIN_ACCENT_WORDS: &[&str] = &[
    "árbol", "niño", "déluge", "forêt", "über", "größe", "salão", "coração", "perché", "città",
    "señal", "étoile", "grimório", "relâmpago", "dragão", "fantôme", "espíritu", "montaña",
];
const JA_WORDS: &[&str] =
    &["稲妻", "一撃", "ショック", "森", "島", "山", "沼", "平地", "戦士", "魔法", "竜", "霊", "呪文", "破壊", "召喚"];
const ZH_WORDS: &[&str] = &["闪电", "冲击", "森林", "海岛", "山脉", "沼泽", "平原", "战士", "法术", "巨龙", "幽灵", "毁灭"];
const KO_WORDS: &[&str] = &["번개", "일격", "숲", "섬", "산", "늪", "들판", "전사", "마법", "용", "유령", "파괴"];
const RU_WORDS: &[&str] =
    &["молния", "удар", "лес", "остров", "гора", "болото", "равнина", "воин", "заклинание", "дракон", "призрак"];

fn lang_words(lang: &str) -> &'static [&'static str] {
    match lang {
        "ja" => JA_WORDS,
        "zhs" | "zht" => ZH_WORDS,
        "ko" => KO_WORDS,
        "ru" => RU_WORDS,
        _ => LATIN_ACCENT_WORDS,
    }
}

// Composition units for printed NAMES. Names need far more entropy than the small word pools
// give: 4,200 cards × 10 languages is ~42k distinct names, and pool-word pairs collide across
// CARDS — which both deflates the printed-name index below its real cardinality and makes every
// typo'd fuzzy lookup ambiguous. Composed units give ~10^5+ combinations per language while
// keeping the multi-byte scripts real.
const LATIN_SYLLABLES: &[&str] = &[
    "ra", "vé", "ño", "lor", "ün", "za", "mi", "côr", "tha", "gué",
    "dro", "ßen", "pa", "lî", "chi", "õe", "ka", "sur", "ël", "bri",
];
const JA_CHARS: &[&str] = &[
    "稲", "妻", "撃", "森", "島", "山", "沼", "戦", "士", "魔", "法", "竜", "霊", "呪", "文",
    "破", "壊", "召", "喚", "光", "影", "風", "火", "水", "雷", "剣", "盾", "王", "夜", "星",
];
const ZH_CHARS: &[&str] = &[
    "闪", "电", "冲", "击", "森", "林", "海", "岛", "山", "脉", "沼", "泽", "战", "士", "法",
    "术", "巨", "龙", "幽", "灵", "毁", "灭", "光", "影", "风", "火", "水", "雷", "剑", "夜",
];
const KO_SYLLABLES: &[&str] = &[
    "번", "개", "일", "격", "숲", "섬", "산", "늪", "들", "전", "사", "마", "법", "용", "유",
    "령", "파", "괴", "빛", "밤", "별", "칼", "왕", "물", "불",
];
const RU_SYLLABLES: &[&str] = &[
    "мо", "лни", "я", "уда", "р", "ле", "с", "го", "ра", "бо", "ло", "то", "вои", "н", "дра",
    "кон", "при", "зра", "к", "звез", "да", "ночь", "меч",
];

/// One composed printed-name word: 2–4 units from the language's own script.
fn printed_word(rng: &mut Rng, lang: &str) -> String {
    let units: &[&str] = match lang {
        "ja" => JA_CHARS,
        "zhs" | "zht" => ZH_CHARS,
        "ko" => KO_SYLLABLES,
        "ru" => RU_SYLLABLES,
        _ => LATIN_SYLLABLES,
    };
    let n = 2 + rng.below(3) as usize;
    (0..n).map(|_| units[rng.below(units.len() as u64) as usize]).collect()
}

/// Printed strings are a pure function of (oracle_id, lang): every reprint of a card in one
/// language shares its printed name/type/text, which is BOTH how the real corpus behaves and
/// what produces the measured ~1.7x intern-dedupe (unique printed names ≈ (oracle, lang) pairs,
/// not printings). fnv-seeded so the whole corpus stays byte-identical under the fixed gen seed.
fn printed_rng(oracle_id: &str, lang: &str) -> Rng {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in oracle_id.bytes().chain(lang.bytes()) {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    Rng(h | 1)
}

fn printed_phrase(rng: &mut Rng, lang: &str, words: usize) -> String {
    let pool = lang_words(lang);
    let sep = if matches!(lang, "ja" | "zhs" | "zht") { "" } else { " " };
    (0..words).map(|_| pool[rng.below(pool.len() as u64) as usize]).collect::<Vec<_>>().join(sep)
}

/// One foreign printing of `canonical`: its own scryfall id and language, printed_* keys by the
/// measured presence classes (90% full triplet, ~8% name-only, remainder name+type; multiface:
/// full triplets per face, or the prepare shape — front face name+type only, back face nothing),
/// most carrying their own multiverse id.
fn foreign_twin(rng: &mut Rng, canonical: &Value, oracle: &OracleCard, lang: &str) -> Value {
    let mut card = canonical.clone();
    let obj = card.as_object_mut().expect("card is an object");
    set_str(obj, "id", uuid(rng));
    set_str(obj, "lang", lang.to_owned());
    let mut prng = printed_rng(&oracle.oracle_id, lang);
    // Composed name (collision-free at corpus scale), pool-word type line and text (whose
    // cross-card repetition is realistic — type lines DO repeat).
    let name = {
        let sep = if matches!(lang, "ja" | "zhs" | "zht") { "" } else { " " };
        format!("{}{sep}{}", printed_word(&mut prng, lang), printed_word(&mut prng, lang))
    };
    let type_line = printed_phrase(&mut prng, lang, 2);
    let text_words = 12 + prng.below(20) as usize;
    let text = printed_phrase(&mut prng, lang, text_words);
    if rng.chance(60) {
        obj.insert("multiverse_ids".to_owned(), serde_json::json!([400_000 + rng.below(500_000)]));
    } else {
        obj.remove("multiverse_ids");
    }
    let faces = obj.get("card_faces").and_then(Value::as_array).cloned();
    match faces {
        Some(mut faces) if !faces.is_empty() => {
            let prepare_shape = rng.chance(20);
            for (i, face) in faces.iter_mut().enumerate() {
                let Some(f) = face.as_object_mut() else { continue };
                if prepare_shape {
                    if i == 0 {
                        f.insert("printed_name".to_owned(), Value::String(name.clone()));
                        f.insert("printed_type_line".to_owned(), Value::String(type_line.clone()));
                    }
                    // The back face of a prepare-style printing is never localized: NO keys.
                } else {
                    // Per-face names differ; derive the back face's from the shared stream so it
                    // stays a function of (oracle, lang) too.
                    let face_name =
                        if i == 0 { name.clone() } else { printed_word(&mut prng, lang) };
                    f.insert("printed_name".to_owned(), Value::String(face_name));
                    f.insert("printed_type_line".to_owned(), Value::String(type_line.clone()));
                    f.insert("printed_text".to_owned(), Value::String(text.clone()));
                }
            }
            obj.insert("card_faces".to_owned(), Value::Array(faces));
        }
        _ => {
            obj.insert("printed_name".to_owned(), Value::String(name));
            if rng.chance(90) {
                obj.insert("printed_type_line".to_owned(), Value::String(type_line));
                obj.insert("printed_text".to_owned(), Value::String(text));
            } else if !rng.chance(80) {
                obj.insert("printed_type_line".to_owned(), Value::String(type_line));
            }
        }
    }
    card
}

fn word(rng: &mut Rng) -> &'static str {
    WORDS[rng.below(WORDS.len() as u64) as usize]
}

fn title_words(rng: &mut Rng, n: usize) -> String {
    let mut out = String::new();
    for i in 0..n {
        if i > 0 {
            out.push(' ');
        }
        let w = word(rng);
        let mut cs = w.chars();
        if let Some(c) = cs.next() {
            out.extend(c.to_uppercase());
            out.push_str(cs.as_str());
        }
    }
    out
}

fn sentence(rng: &mut Rng, target_chars: usize) -> String {
    let mut out = String::new();
    while out.len() < target_chars {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word(rng));
    }
    out.push('.');
    out
}

fn uuid(rng: &mut Rng) -> String {
    let a = rng.next();
    let b = rng.next();
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        (a >> 32) as u32,
        (a >> 16) & 0xffff,
        a & 0xffff,
        (b >> 48) & 0xffff,
        b & 0xffff_ffff_ffff
    )
}

// ─── gen ─────────────────────────────────────────────────────────────────────

const BOLT: &str = include_str!("../src/fixtures/lightning_bolt.json");
const ELVES: &str = include_str!("../src/fixtures/llanowar_elves.json");
const JACE: &str = include_str!("../src/fixtures/jace_the_mind_sculptor.json");
const DELVER: &str = include_str!("../src/fixtures/delver_of_secrets.json");

struct OracleCard {
    template: usize,
    oracle_id: String,
    name: String,
    oracle_text: String,
    first_illustration: String,
}

fn set_str(card: &mut Map<String, Value>, key: &str, val: String) {
    card.insert(key.to_owned(), Value::String(val));
}

/// Synthesize one printing of an oracle card from its template fixture.
fn printing(
    rng: &mut Rng,
    templates: &[Value],
    oracle: &OracleCard,
    illustration_ids: &mut Vec<String>,
) -> Value {
    let mut card = templates[oracle.template].clone();
    let obj = card.as_object_mut().expect("fixture is an object");

    let scryfall_id = uuid(rng);
    // Reprints mostly share art; new illustrations appear on ~40% of printings.
    let illustration_id = if rng.chance(40) {
        let id = uuid(rng);
        illustration_ids.push(id.clone());
        id
    } else {
        oracle.first_illustration.clone()
    };

    set_str(obj, "id", scryfall_id);
    set_str(obj, "oracle_id", oracle.oracle_id.clone());
    set_str(obj, "illustration_id", illustration_id);
    set_str(obj, "name", oracle.name.clone());
    set_str(obj, "oracle_text", oracle.oracle_text.clone());
    let set_idx = rng.below(SETS.len() as u64) as usize;
    set_str(obj, "set", SETS[set_idx].to_owned());
    set_str(obj, "set_name", format!("{} Horizons", title_words(rng, 1)));
    set_str(obj, "collector_number", format!("{}", 1 + rng.below(400)));
    set_str(obj, "artist", title_words(rng, 2));
    set_str(obj, "rarity", RARITIES[rng.below(RARITIES.len() as u64) as usize].to_owned());
    set_str(
        obj,
        "released_at",
        format!("{}-{:02}-{:02}", 1996 + rng.below(30), 1 + rng.below(12), 1 + rng.below(28)),
    );
    if rng.chance(50) {
        let len = 60 + rng.below(60) as usize;
        set_str(obj, "flavor_text", sentence(rng, len));
    } else {
        obj.remove("flavor_text");
    }
    let mut prices = Map::new();
    for (k, present) in [("usd", 85u64), ("eur", 70), ("tix", 40)] {
        let v = if rng.chance(present) {
            Value::String(format!("{}.{:02}", rng.below(120), rng.below(100)))
        } else {
            Value::Null
        };
        prices.insert(k.to_owned(), v);
    }
    prices.insert("usd_foil".to_owned(), Value::Null);
    obj.insert("prices".to_owned(), Value::Object(prices));

    // Multi-face templates (delver): faces carry their own name/oracle_text —
    // give each face this oracle card's generated text so the interner sees
    // realistic unique-text volume, exactly like distinct real oracle cards.
    if let Some(faces) = obj.get_mut("card_faces").and_then(Value::as_array_mut) {
        for (i, face) in faces.iter_mut().enumerate() {
            if let Some(f) = face.as_object_mut() {
                set_str(f, "name", format!("{} {}", oracle.name, i));
                set_str(f, "oracle_text", format!("{} {}", oracle.oracle_text, i));
            }
        }
        set_str(obj, "name", format!("{} 0 // {} 1", oracle.name, oracle.name));
    }

    card
}

fn cmd_gen(printings: usize, foreign_ratio: f64, bulk_path: &Path, tags_path: &Path) {
    let templates: Vec<Value> = [BOLT, ELVES, JACE, DELVER]
        .iter()
        .map(|s| serde_json::from_str(s).expect("fixture parses"))
        .collect();

    let mut rng = Rng(0x5EED_CAFE_F00D_D00D);
    // Real default_cards: ~100k printings over ~35k oracle cards.
    let oracle_count = printings * 35 / 100;
    let mut oracles = Vec::with_capacity(oracle_count);
    let mut illustration_ids: Vec<String> = Vec::new();
    for _ in 0..oracle_count {
        // Template mix: mostly simple spells/creatures, ~5% multi-face.
        let template = match rng.below(100) {
            0..=44 => 0,
            45..=74 => 1,
            75..=94 => 2,
            _ => 3,
        };
        let first_illustration = uuid(&mut rng);
        illustration_ids.push(first_illustration.clone());
        let name_words = 2 + rng.below(2) as usize;
        let text_len = 140 + rng.below(160) as usize;
        oracles.push(OracleCard {
            template,
            oracle_id: uuid(&mut rng),
            name: title_words(&mut rng, name_words),
            oracle_text: sentence(&mut rng, text_len),
            first_illustration,
        });
    }

    let out = std::fs::File::create(bulk_path).expect("create bulk output");
    let mut w = BufWriter::with_capacity(1 << 20, out);
    let mut written = 0usize;
    let mut foreign_written = 0usize;
    'outer: loop {
        for oracle in &oracles {
            // Zipf-ish printing counts: most cards 1-2 printings, a tail with many.
            let copies = if rng.chance(15) { 1 + rng.below(10) } else { 1 } as usize;
            for _ in 0..copies {
                let card = printing(&mut rng, &templates, oracle, &mut illustration_ids);
                serde_json::to_writer(&mut w, &card).expect("write bulk row");
                w.write_all(b"\n").expect("write newline");
                // Foreign twins of THIS printing, at most one per language (as in the real bulk),
                // each language included with probability ratio·weight/Σweights — so the corpus
                // lands at ~`foreign_ratio` foreign rows per canonical with the measured language
                // mix. `--printings` keeps meaning CANONICAL printings; foreign rows are extra.
                for &(lang, weight) in FOREIGN_LANGS {
                    let per_mille = (foreign_ratio * weight as f64 * 1000.0 / FOREIGN_LANG_WEIGHT_SUM as f64) as u64;
                    if per_mille > 0 && rng.below(1000) < per_mille.min(1000) {
                        let twin = foreign_twin(&mut rng, &card, oracle, lang);
                        serde_json::to_writer(&mut w, &twin).expect("write foreign row");
                        w.write_all(b"\n").expect("write newline");
                        foreign_written += 1;
                    }
                }
                written += 1;
                if written == printings {
                    break 'outer;
                }
            }
        }
    }
    w.flush().expect("flush bulk");
    if foreign_ratio > 0.0 {
        eprintln!("  plus {foreign_written} foreign printings (ratio {:.2})", foreign_written as f64 / written as f64);
    }

    // Tag corpus: slugs over ~40% of oracle ids (avg ~4) and ~30% of
    // illustration ids (avg ~2), mirroring real tagger coverage shape.
    let slug_pool: Vec<String> = (0..2000).map(|_| format!("{}-{}", word(&mut rng), word(&mut rng))).collect();
    let mut oracle_tags: Map<String, Value> = Map::new();
    for o in &oracles {
        if rng.chance(40) {
            let n = 1 + rng.below(6);
            let slugs: Vec<Value> = (0..n)
                .map(|_| Value::String(slug_pool[rng.below(slug_pool.len() as u64) as usize].clone()))
                .collect();
            oracle_tags.insert(o.oracle_id.clone(), Value::Array(slugs));
        }
    }
    let mut art_tags: Map<String, Value> = Map::new();
    for ill in &illustration_ids {
        if rng.chance(30) {
            let n = 1 + rng.below(4);
            let slugs: Vec<Value> = (0..n)
                .map(|_| Value::String(slug_pool[rng.below(slug_pool.len() as u64) as usize].clone()))
                .collect();
            art_tags.insert(ill.clone(), Value::Array(slugs));
        }
    }
    let tags_json = serde_json::json!({ "oracle": oracle_tags, "art": art_tags });
    std::fs::write(tags_path, tags_json.to_string()).expect("write tags");

    eprintln!(
        "generated {written} printings over {oracle_count} oracle cards -> {} ({} oracle tag entries, {} art tag entries)",
        bulk_path.display(),
        tags_json["oracle"].as_object().unwrap().len(),
        tags_json["art"].as_object().unwrap().len(),
    );
}

// ─── rows ────────────────────────────────────────────────────────────────────

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

fn cmd_rows(bulk_path: &Path, tags_path: &Path, out_path: &Path) {
    let tags = load_tag_data(tags_path);
    let bulk = std::fs::File::open(bulk_path).expect("open bulk");
    let mut drafts = Vec::new();
    for line in BufReader::with_capacity(1 << 20, bulk).lines() {
        let line = line.expect("read bulk line");
        if line.is_empty() {
            continue;
        }
        let card: Value = serde_json::from_str(&line).expect("parse bulk card");
        // The synthetic corpus's canonical rule: lang == "en". Production derives the flag from
        // id-membership in default_cards (reconciliation 5); this generator only ever emits
        // English canonical rows, so the two rules coincide here by construction.
        let is_canonical = card.get("lang").and_then(Value::as_str) == Some("en");
        if let Some(draft) = transform::transform_row(&card, is_canonical).expect("transform") {
            drafts.push(draft);
        }
    }
    eprintln!("transformed {} drafts", drafts.len());

    let out = std::fs::File::create(out_path).expect("create rows output");
    let mut w = BufWriter::with_capacity(1 << 20, out);
    let mut n = 0usize;
    for row in transform::finalize(drafts, &tags) {
        serde_json::to_writer(&mut w, &row).expect("write row");
        w.write_all(b"\n").expect("write newline");
        n += 1;
    }
    w.flush().expect("flush rows");
    eprintln!("finalized {n} rows -> {}", out_path.display());
}

// ─── build ───────────────────────────────────────────────────────────────────

fn cmd_build(rows_path: &Path, out_dir: &Path) {
    let file = std::fs::File::open(rows_path).expect("open rows");
    let reader = BufReader::with_capacity(1 << 20, file);
    let rows = reader.lines().filter_map(|line| {
        let line = line.expect("read row line");
        if line.is_empty() { None } else { Some(serde_json::from_str::<Value>(&line).expect("parse row")) }
    });

    reset_peak();
    let before = CURRENT.load(Ordering::Relaxed);
    let manifest = build_store(rows, out_dir, "memprobe").expect("build store");
    let peak = PEAK.load(Ordering::Relaxed);

    println!("store_key       {}", manifest.store_key);
    println!("cards           {}", manifest.card_count);
    println!("printings       {}", manifest.printing_count);
    println!("store_bytes     {} ({:.1} MB)", manifest.store_bytes, mb(manifest.store_bytes as usize));
    println!("heap_before     {:.1} MB", mb(before));
    println!("heap_peak       {:.1} MB  <-- compare against the 128MB isolate ceiling", mb(peak));
}

/// Like `build`, but drives StoreBuilder directly with per-phase heap
/// checkpoints, to attribute the peak: staging (rows+interners) vs finish
/// (build_card_data + rkyv serialize).
fn cmd_phases(rows_path: &Path, out_dir: &Path) {
    use card_engine::StoreBuilder;

    let file = std::fs::File::open(rows_path).expect("open rows");
    let reader = BufReader::with_capacity(1 << 20, file);

    reset_peak();
    let before = CURRENT.load(Ordering::Relaxed);

    let mut builder = StoreBuilder::new();
    for line in reader.lines() {
        let line = line.expect("read row line");
        if line.is_empty() {
            continue;
        }
        let row: Value = serde_json::from_str(&line).expect("parse row");
        builder.add_card(&row).expect("add_card");
    }
    let staged_current = CURRENT.load(Ordering::Relaxed);
    let staged_peak = PEAK.load(Ordering::Relaxed);

    reset_peak();
    std::fs::create_dir_all(out_dir).expect("mkdir out");
    let store_path = out_dir.join("phases.store");
    let out = std::fs::File::create(&store_path).expect("create store");
    // Captures heap state at the first write: finish_to_writer runs
    // build_card_data fully before write_archive touches the writer, so the
    // first-write checkpoint is "CardData built, rkyv about to start".
    struct CheckpointWriter<W: Write> {
        inner: W,
        at_first_write: Option<(usize, usize)>,
    }
    impl<W: Write> Write for CheckpointWriter<W> {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if self.at_first_write.is_none() {
                self.at_first_write = Some((CURRENT.load(Ordering::Relaxed), PEAK.load(Ordering::Relaxed)));
            }
            self.inner.write(buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.inner.flush()
        }
    }
    let mut w = CheckpointWriter { inner: BufWriter::with_capacity(1 << 20, out), at_first_write: None };
    // `None`: this probe measures the SEARCH archive's build peak, which is the number the wasm
    // memory cap binds. The card-object archive is written and dropped earlier in the same call.
    let stats = builder.finish_to_writer(&mut w).expect("finish");
    w.flush().expect("flush");
    let (card_data_current, card_data_peak) = w.at_first_write.expect("store was written");
    let finish_peak = PEAK.load(Ordering::Relaxed);

    let store_bytes = std::fs::metadata(&store_path).expect("stat store").len();
    println!("cards            {}", stats.card_count);
    println!("printings        {}", stats.printing_count);
    println!("store_bytes      {:.1} MB", mb(store_bytes as usize));
    println!("heap_before      {:.1} MB", mb(before));
    println!("staged_current   {:.1} MB   (rows + interners resident after staging)", mb(staged_current));
    println!("staged_peak      {:.1} MB   (peak during staging)", mb(staged_peak));
    println!("card_data_now    {:.1} MB   (resident when rkyv starts: CardData incl. indexes)", mb(card_data_current));
    println!("card_data_peak   {:.1} MB   (peak during build_card_data itself)", mb(card_data_peak));
    println!("finish_peak      {:.1} MB   (overall finish peak incl. rkyv)", mb(finish_peak));
}

/// The SpillingStoreBuilder path natively: rows spill to an in-memory blob
/// list (standing in for DO SQLite), replay in sorted order, and the output
/// must be byte-identical to the Vec path. This validates the vendor patch
/// before the same path runs memory-capped in wasm.
fn cmd_spill(rows_path: &Path, out_dir: &Path) {
    use card_engine::SpillingStoreBuilder;

    let file = std::fs::File::open(rows_path).expect("open rows");
    let reader = BufReader::with_capacity(1 << 20, file);

    reset_peak();
    let mut builder = SpillingStoreBuilder::new();
    let mut spilled: Vec<Vec<u8>> = Vec::new();
    for line in reader.lines() {
        let line = line.expect("read row line");
        if line.is_empty() {
            continue;
        }
        let row: Value = serde_json::from_str(&line).expect("parse row");
        spilled.push(builder.add_card(&row).expect("add_card"));
    }
    let spill_bytes: usize = spilled.iter().map(Vec::len).sum();
    eprintln!("staged {} rows, spilled {:.1} MB of blobs", builder.staged_rows(), mb(spill_bytes));

    let order = builder.sorted_order();
    std::fs::create_dir_all(out_dir).expect("mkdir out");
    let store_path = out_dir.join("spill.store");
    let out = std::fs::File::create(&store_path).expect("create store");
    let mut w = BufWriter::with_capacity(1 << 20, out);
    let stats = builder
        .finish_from_sorted(order.iter().map(|&i| std::mem::take(&mut spilled[i as usize])), &mut w)
        .expect("finish_from_sorted");
    w.flush().expect("flush");

    println!("cards           {}", stats.card_count);
    println!("printings       {}", stats.printing_count);
    println!("store_bytes     {:.1} MB", mb(std::fs::metadata(&store_path).expect("stat").len() as usize));
    println!("heap_peak       {:.1} MB (native; includes the in-memory spill stand-in)", mb(PEAK.load(Ordering::Relaxed)));
}

/// Collection-index narrowing cost, by value DENSITY.
///
/// The hybrid-encoding question (should `oracle_tags`/`art_tags` store dense values as bitmaps
/// like `frame_data` does?) is not answerable from byte counts alone. Storage crosses over at
/// 1/32 of the domain; the NARROWING guard (`MAX_NARROW_FRACTION`) fires at 1/4. Values between
/// those two are the ones a hybrid moves behind a stricter gate, and lib.rs's frame_data arm
/// records what that cost when it happened by accident: `o:this frame:2003` went 52us -> 1,809us.
///
/// So this measures the values that actually sit in that band, alone and under a selective text
/// driver (the shape that regressed), rather than a convenient tag name.
fn cmd_tagbench(store_path: &Path, iters: usize) {
    use card_engine::{BufferStore, QueryOptions};
    use std::time::Instant;

    let bytes = std::fs::read(store_path).expect("read store");
    let store = BufferStore::from_bytes(&bytes).expect("load store");
    let n_cards = store.card_count();
    let n_printings = store.size();

    // The wire shapes, taken verbatim from src/parser (parseScryfallQuery) rather than
    // reconstructed: rhs is a BARE ARRAY for collection attributes, and a StringValueNode for text.
    let tag_tree = |attr: &str, orig: &str, value: &str| {
        format!(
            r#"{{"node_type":"CardBinaryOperatorNode","kwargs":{{"lhs":{{"node_type":"CardAttributeNode","kwargs":{{"attribute_name":"{attr}","original_attribute":"{orig}"}}}},"op":":","rhs":["{value}"]}}}}"#
        )
    };
    let text_tree = |needle: &str| {
        format!(
            r#"{{"node_type":"CardBinaryOperatorNode","kwargs":{{"lhs":{{"node_type":"CardAttributeNode","kwargs":{{"attribute_name":"oracle_text","original_attribute":"o"}}}},"op":":","rhs":{{"node_type":"StringValueNode","kwargs":{{"value":"{needle}"}}}}}}}}"#
        )
    };
    let and_tree = |a: &str, b: &str| format!(r#"{{"node_type":"AndNode","kwargs":{{"operands":[{a},{b}]}}}}"#);

    let time_query = |tree: &str| -> (u128, usize) {
        let opts = QueryOptions { limit: 175, ..QueryOptions::default() };
        // Warm: first run pays lazy statics and any one-time index touch.
        let warm = store.query(tree, &opts).expect("query");
        let mut best = u128::MAX;
        for _ in 0..iters {
            let t = Instant::now();
            let r = store.query(tree, &opts).expect("query");
            best = best.min(t.elapsed().as_micros());
            std::hint::black_box(r.total);
        }
        (best, warm.total)
    };

    for (field, attr, orig, domain) in [
        ("oracle_tags", "card_oracle_tags", "oracletag", n_cards),
        ("art_tags", "card_art_tags", "arttag", n_printings),
    ] {
        let top = store.top_collection_values(field, 8);
        println!("\n=== {field} (domain {domain}) ===");
        println!(
            "{:<28} {:>9} {:>8} {:>7} {:>12} {:>14} {:>10}",
            "value", "postings", "density", "band", "alone (us)", "o:draw AND (us)", "matches"
        );
        for (value, count) in &top {
            // Which side of each crossover this value falls on: `store` = a bitmap would be
            // smaller (>1/32); `gate` = a hybrid would newly subject it to MAX_NARROW_FRACTION
            // (>1/4). "BAND" is store-but-not-gate; "GATED" is the regression-prone region.
            let density = *count as f64 / domain as f64;
            let band = if density > 0.25 {
                "GATED"
            } else if density > 0.03125 {
                "BAND"
            } else {
                "sparse"
            };
            let alone = tag_tree(attr, orig, value);
            let combined = and_tree(&text_tree("draw"), &alone);
            let (t_alone, matches) = time_query(&alone);
            let (t_and, _) = time_query(&combined);
            println!(
                "{:<28} {:>9} {:>7.2}% {:>7} {:>12} {:>14} {:>10}",
                value, count, 100.0 * density, band, t_alone, t_and, matches
            );
        }
    }

    // Controls: the text driver by itself, so the AND column can be read as "what did adding the
    // tag cost", and a bare TrueNode for the floor.
    let (t_text, n_text) = time_query(&text_tree("draw"));
    let (t_true, n_true) = time_query(r#"{"node_type": "TrueNode"}"#);
    println!("\ncontrol  o:draw alone            {t_text} us ({n_text} matches)");
    println!("control  TrueNode                {t_true} us ({n_true} matches)");
}

/// Text and name search cost, per INDEX TIER.
///
/// The two largest remaining archive reductions are both text-shaped, and both trade bytes for work
/// on this path, so neither can be judged without it:
///
///   - `oracle_text_lower` / `flavor_text_lower` are exact `to_lowercase()` duplicates on 100% of
///     rows (~7.5 MiB). Dropping them means matching case-insensitively against the cased text, so
///     the cost lands on whatever VERIFIES a text predicate.
///   - `card_name_folded` differs from `card_name_lower` on 88 of 31,724 cards (~1.45 MiB after
///     alignment). Interning it moves the folded read behind a branch and an occasional `str_at`.
///
/// Aimed at the TIERS rather than at queries that look representative, because the tiers are what
/// the change moves: a >=4-char word hits the word dictionary, a 3-char needle the exact trigram
/// table, a longer substring a trigram intersection plus a verify scan, a 2-char name needle the
/// bigram index, and fuzzy name a full similarity scan. The verify-scan rows are the ones that
/// would pay for a `_lower` removal; the fuzzy and bigram rows are the ones `card_name_folded`
/// would pay for. Recording both now means the "after" has something honest to sit beside.
fn cmd_textbench(store_path: &Path, iters: usize) {
    use card_engine::{BufferStore, QueryOptions};
    use std::time::Instant;

    let bytes = std::fs::read(store_path).expect("read store");
    let store = BufferStore::from_bytes(&bytes).expect("load store");

    // Wire shapes taken verbatim from src/parser (parseScryfallQuery).
    let text_tree = |attr: &str, orig: &str, needle: &str| {
        format!(
            r#"{{"node_type":"CardBinaryOperatorNode","kwargs":{{"lhs":{{"node_type":"CardAttributeNode","kwargs":{{"attribute_name":"{attr}","original_attribute":"{orig}"}}}},"op":":","rhs":{{"node_type":"StringValueNode","kwargs":{{"value":"{needle}"}}}}}}}}"#
        )
    };

    let time_query = |tree: &str| -> (u128, usize) {
        let opts = QueryOptions { limit: 175, ..QueryOptions::default() };
        let warm = store.query(tree, &opts).expect("query");
        let mut best = u128::MAX;
        for _ in 0..iters {
            let t = Instant::now();
            let r = store.query(tree, &opts).expect("query");
            best = best.min(t.elapsed().as_micros());
            std::hint::black_box(r.total);
        }
        (best, warm.total)
    };

    println!("{:<34} {:<26} {:>10} {:>10}", "tier", "query", "us", "matches");
    for (tier, attr, orig, needle) in [
        ("oracle: word dictionary (>=4)", "oracle_text", "o", "battlefield"),
        ("oracle: word dictionary (common)", "oracle_text", "o", "draw"),
        ("oracle: exact trigram (3-char)", "oracle_text", "o", "lif"),
        ("oracle: trigram + verify scan", "oracle_text", "o", "attlefield"),
        ("oracle: phrase + verify scan", "oracle_text", "o", "draw card"),
        ("oracle: 2-char, no tier (scan)", "oracle_text", "o", "qx"),
        ("name: bigram (2-char)", "card_name", "name", "wa"),
        ("name: word", "card_name", "name", "ward"),
        ("name: substring + verify", "card_name", "name", "arden"),
        ("flavor: verify scan", "flavor_text", "ft", "death"),
    ] {
        let (t, n) = time_query(&text_tree(attr, orig, needle));
        println!("{:<34} {:<26} {:>10} {:>10}", tier, format!("{orig}:{needle}"), t, n);
    }

    // Fuzzy name resolution is a different path again: a full similarity scan over every card's
    // folded name, which is exactly what `card_name_folded` would make indirect.
    let t = Instant::now();
    let mut best = u128::MAX;
    for _ in 0..iters {
        let s = Instant::now();
        let r = store.fuzzy_card_by_name("jace beleran", 0.5, 0.05, None);
        best = best.min(s.elapsed().as_micros());
        std::hint::black_box(r.is_ok());
    }
    let _ = t;
    println!("{:<34} {:<26} {:>10} {:>10}", "name: fuzzy (full scan)", "fuzzy 'jace beleran'", best, "-");
}

/// Every serving route that is NOT a `/search` query, timed.
///
/// `textbench` exists because the text tiers are where the archive reductions land. This exists
/// because of what building that bench turned up: `?fuzzy=` was costing 25.8ms, 22x the next worst
/// thing measured, and nothing had ever timed it. That was not a text-search finding — it was a
/// finding about a ROUTE nobody had put a clock on.
///
/// So this puts a clock on the rest of them. The `/cards/*` surface reaches the engine through nine
/// entry points besides `query`, several of which are linear scans over the corpus by construction
/// (`card_by_illustration_id` compares a u128 against every printing; `autocomplete` calls
/// `starts_with` on every card). Whether that matters is a question about constants, and constants
/// are measured, not reasoned about.
fn cmd_routebench(store_path: &Path, iters: usize) {
    use card_engine::{BufferStore, QueryOptions};
    use std::time::Instant;

    let bytes = std::fs::read(store_path).expect("read store");
    let store = BufferStore::from_bytes(&bytes).expect("load store");

    // Real ids from the corpus, so no route is measured against a miss (a miss can be the FAST
    // path — `card_by_illustration_id` returns early on an unparseable id — which would flatter
    // exactly the scan this is trying to catch).
    let f = |names: &[&str]| Some(names.iter().map(|s| (*s).to_owned()).collect::<Vec<String>>());
    let sample = store
        .sample_preferred(200, 42, f(&["scryfall_id", "oracle_id", "illustration_id", "name"]))
        .expect("sample");
    let get = |i: usize, k: &str| sample[i].get(k).and_then(|v| v.as_str()).unwrap_or("").to_owned();
    let (sid, oid, name) = (get(0, "scryfall_id"), get(0, "oracle_id"), get(0, "name"));
    let ids: Vec<String> = (0..75.min(sample.len())).map(|i| get(i, "scryfall_id")).collect();
    let folded = name.to_lowercase();

    let time = |label: &str, mut run: Box<dyn FnMut() -> String + '_>| {
        let note = run();
        let mut best = u128::MAX;
        for _ in 0..iters {
            let t = Instant::now();
            let out = run();
            best = best.min(t.elapsed().as_micros());
            std::hint::black_box(out);
        }
        println!("{:<38} {:>10} us   {}", label, best, note);
    };

    time("card_by_scryfall_id", Box::new(|| {
        format!("{:?}", store.card_by_scryfall_id(&sid, None).expect("q").is_some())
    }));
    time("cards_by_scryfall_ids (75)", Box::new(|| {
        format!("{} rows", store.cards_by_scryfall_ids(&ids, None).expect("q").len())
    }));
    time("printings_of_oracle_id", Box::new(|| {
        format!("{} rows", store.printings_of_oracle_id(&oid, None).expect("q").len())
    }));
    time("exact_card_by_name", Box::new(|| {
        format!("{:?}", store.exact_card_by_name(&folded, None, None).expect("q").is_some())
    }));
    // A LINEAR SCAN that stops at the first match, so one sample id measures only how early that
    // card happens to sit. Sweeping 200 and reporting the worst is what says whether the scan
    // matters — the tail is the number a user with an unlucky illustration actually pays.
    {
        let mut worst = (0u128, String::new());
        let mut total = 0u128;
        let n = sample.len();
        for i in 0..n {
            let id = get(i, "illustration_id");
            if id.is_empty() {
                continue;
            }
            let t = Instant::now();
            std::hint::black_box(store.card_by_illustration_id(&id, None).expect("q"));
            let us = t.elapsed().as_micros();
            total += us;
            if us > worst.0 {
                worst = (us, id);
            }
        }
        println!(
            "{:<38} {:>10} us   worst of {} sampled (mean {} us)",
            "card_by_illustration_id", worst.0, n, total / n.max(1) as u128
        );
    }
    time("card_by_external_id (multiverse)", Box::new(|| {
        format!("{:?}", store.card_by_external_id("multiverse", 3, None).expect("q").is_some())
    }));
    // Needles taken FROM the corpus, not hardcoded: a needle that matches nothing is fast whether
    // or not the route narrows, so hardcoded real-Scryfall words would measure nothing at all on a
    // synthetic corpus -- which is exactly the corpus the gate builds.
    let prefix: String = folded.chars().take(3).collect();
    // EVERY WORD of a whole name, not one word of it: a common word matches most of the corpus, so
    // scanning and narrowing do nearly the same work and the ratio cannot tell them apart. A full
    // name matches ~1 card, which is where narrowing is worth 100x and a regression is obvious.
    //
    // Split, because that is the shape the route passes — `/cards/named?fuzzy=` splits on
    // non-word characters, so a word never contains a space. Handing the whole spaced name in as
    // ONE word measured the separator-spanning narrowing tier instead of the ordinary one, and on
    // a synthetic corpus whose names have more than two words it matched nothing at all: a
    // tripwire that reports 0 rows cannot fail.
    let name_words: Vec<String> = folded.split_whitespace().map(str::to_owned).collect();
    time("autocomplete(3-char prefix)", Box::new(|| format!("{} names", store.autocomplete(&prefix, 20).len())));
    time("cards_containing_all_words", Box::new(|| {
        format!("{} rows", store.cards_containing_all_words(&name_words, None, 20, None).expect("q").len())
    }));
    // A KNOWN full scan over every card, so the gate has a scan-shaped reference to compare the
    // narrowed routes against. A binary-search baseline is sub-microsecond and too small to divide
    // by; this is the number that says what "went back to scanning" costs on THIS corpus.
    time("fuzzy_card_by_name (full scan)", Box::new(|| {
        format!("{:?}", store.fuzzy_card_by_name(&folded, 0.5, 0.05, None).map(|(s, _)| s))
    }));

    // The foreign name lane, against a REAL printed name from this store (a hit, like every
    // other measured route — a miss can be the fast path). Labeled `printed_*`, not
    // `exact_card_by_name (…)`, so the gate's awk prefixes cannot match two lines at once.
    // Skipped when the store has no foreign rows (a legacy corpus), so this bench still runs
    // against old archives.
    let ml_opts = QueryOptions {
        limit: 200,
        unique: "printing".to_owned(),
        include_multilingual: true,
        fields: f(&["printed_name"]),
        ..QueryOptions::default()
    };
    let printed = store.query(r#"{"node_type": "TrueNode"}"#, &ml_opts).ok().and_then(|out| {
        out.rows.iter().find_map(|r| r.get("printed_name").and_then(|v| v.as_str()).map(str::to_owned))
    });
    match printed {
        Some(printed) => {
            let folded_printed = transform::fold_accents(&printed.to_lowercase());
            time("printed_exact_hit", Box::new(|| {
                format!("{:?}", store.exact_card_by_name(&folded_printed, None, None).expect("q").is_some())
            }));
            // One character dropped: the typo shape the fuzzy lane exists for, valid in every
            // script the generator emits.
            let typo: String = folded_printed
                .chars()
                .enumerate()
                .filter(|(i, _)| *i != 1)
                .map(|(_, c)| c)
                .collect();
            time("printed_fuzzy_hit", Box::new(|| {
                format!("{:?}", store.fuzzy_card_by_name(&typo, 0.4, 0.05, None).map(|(s, _)| s))
            }));
        }
        None => eprintln!("  (no foreign rows in this store; printed-name lanes skipped)"),
    }
    time("sample_preferred(75)", Box::new(|| format!("{} rows", store.sample_preferred(75, 7, None).expect("q").len())));

    // Paging: a deep offset is the shape that makes a streamed sort walk furthest, and it is the
    // one a crawler reaches by following next_page.
    let true_node = r#"{"node_type": "TrueNode"}"#;
    for (label, offset) in [("query orderby=name offset=0", 0usize), ("query orderby=name offset=9000", 9000)] {
        let opts = QueryOptions { limit: 175, offset, orderby: "name".to_owned(), ..QueryOptions::default() };
        time(label, Box::new(|| format!("{} total", store.query(true_node, &opts).expect("q").total)));
    }
    for (label, unique) in [("query unique=printing", "printing"), ("query unique=artwork", "artwork")] {
        let opts = QueryOptions { limit: 175, unique: unique.to_owned(), ..QueryOptions::default() };
        time(label, Box::new(|| format!("{} total", store.query(true_node, &opts).expect("q").total)));
    }
}

/// Deterministic digest of the folded-name routes, so narrowing them can be proved to change
/// nothing. Timings say a change is faster; only this says it still answers the same.
fn cmd_namecheck(store_path: &Path) {
    use card_engine::BufferStore;

    let bytes = std::fs::read(store_path).expect("read store");
    let store = BufferStore::from_bytes(&bytes).expect("load store");
    let f = |n: &[&str]| Some(n.iter().map(|s| (*s).to_owned()).collect::<Vec<String>>());
    let sample = store.sample_preferred(400, 11, f(&["name"])).expect("sample");

    let mut lines: Vec<String> = Vec::new();
    for row in &sample {
        let Some(name) = row.get("name").and_then(|v| v.as_str()) else { continue };
        let folded = name.to_lowercase();
        // exact: the whole name, and each face of a split card, which is the fallback arm.
        for needle in std::iter::once(folded.clone()).chain(folded.split(" // ").map(str::to_owned)) {
            let got = store
                .exact_card_by_name(&needle, None, None)
                .expect("exact")
                .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_owned))
                .unwrap_or_else(|| "<none>".to_owned());
            lines.push(format!("exact {needle} -> {got}"));
        }
        // containment: each word of the name, and the first two together.
        let words: Vec<String> = folded.split_whitespace().map(str::to_owned).collect();
        for w in words.iter().take(3) {
            let got = store.cards_containing_all_words(std::slice::from_ref(w), None, 2, None).expect("words");
            let names: Vec<&str> = got.iter().filter_map(|v| v.get("name").and_then(|n| n.as_str())).collect();
            lines.push(format!("words [{w}] -> {names:?}"));
        }
        if words.len() >= 2 {
            let pair = words[..2].to_vec();
            let got = store.cards_containing_all_words(&pair, None, 2, None).expect("words");
            let names: Vec<&str> = got.iter().filter_map(|v| v.get("name").and_then(|n| n.as_str())).collect();
            lines.push(format!("words {pair:?} -> {names:?}"));
        }
    }
    // The residue's three list fields, per printing, folded into the digest — read back against
    // the SAME sampled ids on both sides of a change.
    {
        let ids = store
            .sample_preferred(300, 5, f(&["scryfall_id"]))
            .expect("sample ids")
            .into_iter()
            .filter_map(|v| v.get("scryfall_id").and_then(|s| s.as_str()).map(str::to_owned))
            .collect::<Vec<_>>();
        for id in &ids {
            let row = store
                .card_by_scryfall_id(id, f(&["multiverse_ids", "promo_types", "frame_effects"]))
                .expect("by id");
            if let Some(r) = row {
                lines.push(format!(
                    "residue {id} -> {} {} {}",
                    r.get("multiverse_ids").map(ToString::to_string).unwrap_or_default(),
                    r.get("promo_types").map(ToString::to_string).unwrap_or_default(),
                    r.get("frame_effects").map(ToString::to_string).unwrap_or_default()
                ));
            }
        }
    }

    // Autocomplete's accent cases, printed rather than digested: the whole point of folding the
    // needle is that an ASCII query reaches a name carrying diacritics, and that is worth reading.
    for needle in ["eowyn", "jotun", "lim-dul", "aether", "lig"] {
        let got = store.autocomplete(needle, 5);
        println!("  autocomplete {needle:>8} -> {got:?}");
    }

    // Sorted so the digest does not depend on sample iteration order.
    lines.sort();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for l in &lines {
        for b in l.as_bytes() {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x1000_0000_01b3);
        }
    }
    println!("namecheck {} probes, digest {h:016x}", lines.len());
}

/// The `/search` FILTER surface, timed leaf by leaf.
///
/// `tagbench` covers collection leaves, `textbench` the text tiers, `routebench` the nine
/// non-search entry points. What none of them touch is the rest of the filter language -- mana,
/// legality, ranges, colour, negation, boolean composition, and the sorts that are not by name.
/// That gap is the reason this exists: every large win tonight came from putting a clock on
/// something nobody had, and three of them sat behind routes that looked unremarkable.
///
/// The trees are REAL PARSER OUTPUT, generated from `src/parser`'s `parseScryfallQuery` and pasted
/// verbatim rather than hand-written, because a hand-built tree tests the bench author's memory of
/// the wire format and not the engine.
///
/// Read it looking for OUTLIERS, not absolutes: ~100-200us is the norm on this corpus, and the 1ms
/// flag is the threshold that separated the 25.8ms fuzzy scan and the two ~900us name routes from
/// everything around them.
fn cmd_querybench(store_path: &Path, iters: usize) {
    use card_engine::{BufferStore, QueryOptions};
    use std::time::Instant;

    let bytes = std::fs::read(store_path).expect("read store");
    let store = BufferStore::from_bytes(&bytes).expect("load store");

    const FILTERS: &[(&str, &str, &str)] = &[
    ("mana: exact cost", "mana:{2}{R}", r#"{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"mana_cost_jsonb","original_attribute":"mana"}},"op":":","rhs":{"node_type":"ManaValueNode","kwargs":{"value":"{2}{R}"}}}}"#),
    ("mana>= superset", "mana>={W}{U}", r#"{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"mana_cost_jsonb","original_attribute":"mana"}},"op":">=","rhs":{"node_type":"ManaValueNode","kwargs":{"value":"{W}{U}"}}}}"#),
    ("devotion>=3", "devotion>=3", r#"{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"devotion","original_attribute":"devotion"}},"op":">=","rhs":{"node_type":"ManaValueNode","kwargs":{"value":"3"}}}}"#),
    ("legal:modern", "legal:modern", r#"{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"card_legalities","original_attribute":"legal"}},"op":":","rhs":["modern"]}}"#),
    ("banned:legacy", "banned:legacy", r#"{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"card_legalities","original_attribute":"banned"}},"op":":","rhs":["legacy"]}}"#),
    ("restricted:vintage", "restricted:vintage", r#"{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"card_legalities","original_attribute":"restricted"}},"op":":","rhs":["vintage"]}}"#),
    ("cmc>=5", "cmc>=5", r#"{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"cmc","original_attribute":"cmc"}},"op":">=","rhs":{"node_type":"NumericValueNode","kwargs":{"value":5}}}}"#),
    ("usd<0.5", "usd<0.5", r#"{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"price_usd","original_attribute":"usd"}},"op":"<","rhs":{"node_type":"NumericValueNode","kwargs":{"value":0.5}}}}"#),
    ("power>=4", "power>=4", r#"{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"creature_power","original_attribute":"power"}},"op":">=","rhs":{"node_type":"NumericValueNode","kwargs":{"value":4}}}}"#),
    ("year>=2020", "year>=2020", r#"{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"released_at","original_attribute":"year"}},"op":">=","rhs":{"node_type":"StringValueNode","kwargs":{"value":"2020"}}}}"#),
    ("cn>200", "cn>200", r#"{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"collector_number_int","original_attribute":"cn"}},"op":">","rhs":{"node_type":"NumericValueNode","kwargs":{"value":200}}}}"#),
    ("c:wu", "c:wu", r#"{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"card_colors","original_attribute":"c"}},"op":":","rhs":["W","U"]}}"#),
    ("id<=wubrg", "id<=wubrg", r#"{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"card_color_identity","original_attribute":"id"}},"op":"<=","rhs":["W","U","B","R","G"]}}"#),
    ("c>=3 (colour count)", "c>=3", r#"{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"card_colors","original_attribute":"c"}},"op":">=","rhs":{"node_type":"NumericValueNode","kwargs":{"value":3}}}}"#),
    ("t:creature (substring)", "t:creature", r#"{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"card_types","original_attribute":"t"}},"op":":","rhs":["Creature"]}}"#),
    ("t:creat (partial word)", "t:creat", r#"{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"card_subtypes","original_attribute":"t"}},"op":":","rhs":["Creat"]}}"#),
    ("t:elf (subtype)", "t:elf", r#"{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"card_subtypes","original_attribute":"t"}},"op":":","rhs":["Elf"]}}"#),
    ("t:\"artifact creature\"", "t:\"artifact creature\"", r#"{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"card_subtypes","original_attribute":"t"}},"op":":","rhs":["Artifact Creature"]}}"#),
    ("t:zzzz (bind only, 0 rows)", "t:zzzz", r#"{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"card_subtypes","original_attribute":"t"}},"op":":","rhs":["Zzzz"]}}"#),
    ("t>creature (type mask)", "t>creature", r#"{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"card_types","original_attribute":"t"}},"op":">","rhs":["Creature"]}}"#),
    ("NOT t:creature", "-t:creature", r#"{"node_type":"NotNode","kwargs":{"operand":{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"card_types","original_attribute":"t"}},"op":":","rhs":["Creature"]}}}}"#),
    ("NOT legal:modern", "-legal:modern", r#"{"node_type":"NotNode","kwargs":{"operand":{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"card_legalities","original_attribute":"legal"}},"op":":","rhs":["modern"]}}}}"#),
    ("And of three leaves", "t:creature c:r cmc>=4", r#"{"node_type":"AndNode","kwargs":{"operands":[{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"card_types","original_attribute":"t"}},"op":":","rhs":["Creature"]}},{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"card_colors","original_attribute":"c"}},"op":":","rhs":["R"]}},{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"cmc","original_attribute":"cmc"}},"op":">=","rhs":{"node_type":"NumericValueNode","kwargs":{"value":4}}}}]}}"#),
    ("Or of two broad leaves", "cmc>=5 or usd<0.5", r#"{"node_type":"OrNode","kwargs":{"operands":[{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"cmc","original_attribute":"cmc"}},"op":">=","rhs":{"node_type":"NumericValueNode","kwargs":{"value":5}}}},{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"price_usd","original_attribute":"usd"}},"op":"<","rhs":{"node_type":"NumericValueNode","kwargs":{"value":0.5}}}}]}}"#),
    ];

    let time = |tree: &str, opts: &QueryOptions| -> (u128, usize) {
        let warm = store.query(tree, opts).expect("query");
        let mut best = u128::MAX;
        for _ in 0..iters {
            let t = Instant::now();
            let r = store.query(tree, opts).expect("query");
            best = best.min(t.elapsed().as_micros());
            std::hint::black_box(r.total);
        }
        (best, warm.total)
    };

    let flag = |us: u128| if us > 1000 { "  <-- OVER 1ms" } else { "" };

    println!("{:<26} {:<24} {:>10} {:>10}", "case", "query", "us", "matches");
    let default = QueryOptions { limit: 175, ..QueryOptions::default() };
    for (label, query, tree) in FILTERS {
        let (us, n) = time(tree, &default);
        println!("{:<26} {:<24} {:>10} {:>10}{}", label, query, us, n, flag(us));
    }

    // Sorting: a different plan per column, and the streamed walk only pays off where the column has
    // a stored permutation. `released`/`rarity`/`artist`/`set` have none (see SortPermutations), so
    // those rows are the ones that fall back to a general sort.
    println!();
    let true_node = r#"{"node_type": "TrueNode"}"#;
    for col in ["edhrec", "usd", "released", "rarity", "artist", "set", "cmc", "power"] {
        for (tag, offset) in [("offset 0", 0usize), ("offset 9000", 9000)] {
            let opts =
                QueryOptions { limit: 175, offset, orderby: col.to_owned(), ..QueryOptions::default() };
            let (us, n) = time(true_node, &opts);
            println!("{:<26} {:<24} {:>10} {:>10}{}", format!("order={col}"), tag, us, n, flag(us));
        }
    }

    // Artwork mode over a real predicate, rather than the bare TrueNode `routebench` already covers.
    println!();
    for (label, tree) in [("unique=artwork + cmc>=5", FILTERS[6].2), ("unique=artwork + c:wu", FILTERS[11].2)] {
        let opts = QueryOptions { limit: 175, unique: "artwork".to_owned(), ..QueryOptions::default() };
        let (us, n) = time(tree, &opts);
        println!("{:<26} {:<24} {:>10} {:>10}{}", label, "", us, n, flag(us));
    }

    // The floor, so every row above reads as "what did this predicate cost on top of paging".
    let (us, n) = time(true_node, &default);
    println!("\n{:<26} {:<24} {:>10} {:>10}", "control TrueNode", "", us, n);
}

/// Semantic parity gate between two store files. Archive bytes are
/// legitimately nondeterministic (HashMap seeding permutes index entry order,
/// run-to-run even on one machine), so equality is defined over what the
/// serving surface can observe: every printing with every field, in engine
/// result order, plus catalogs, counts, and seeded samples.
fn cmd_compare(a_path: &Path, b_path: &Path) {
    use card_engine::{BufferStore, QueryOptions};

    let load = |p: &Path| {
        let bytes = std::fs::read(p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()));
        BufferStore::from_bytes(&bytes).unwrap_or_else(|e| panic!("load {}: {e}", p.display()))
    };
    let a = load(a_path);
    let b = load(b_path);

    assert_eq!(a.card_count(), b.card_count(), "card_count");
    assert_eq!(a.size(), b.size(), "printing count");
    assert_eq!(a.common_card_types(), b.common_card_types(), "common_card_types");
    assert_eq!(a.common_card_keywords(), b.common_card_keywords(), "common_card_keywords");

    let true_node = r#"{"node_type": "TrueNode"}"#;

    // THE GRID IS DELIBERATELY TIE-HEAVY. Two archives built from IDENTICAL rows can still
    // differ byte-for-byte in their index region, because index construction may break ties
    // between equally-ranked rows in build order. That is invisible to a checksum and invisible
    // to a query whose sort key is unique -- it shows up only where many rows share one sort
    // value and the archive's own order decides which comes first. So every low-cardinality
    // ordering is here (`rarity` has 5 distinct values over 4,200 cards, `color` 6, `cmc` ~10,
    // `set` a handful), in both directions, across all three unique modes, with and without the
    // annex, plus deep offsets where a tie straddling the window boundary would repeat or skip a
    // row. If these all agree the two builders answer identically, which is the property the
    // two-publisher design actually needs -- byte equality of the archive is not it.
    let orderings = [
        "rarity", "color", "cmc", "set", "name", "released", "artist", "edhrec", "usd", "power", "toughness",
        "cubecobra",
    ];
    let mut cases: Vec<(String, QueryOptions)> = Vec::new();
    for orderby in orderings {
        for direction in ["asc", "desc"] {
            for unique in ["card", "printing", "artwork"] {
                for ml in [false, true] {
                    cases.push((
                        format!("TrueNode orderby={orderby} {direction} unique={unique} ml={ml}"),
                        QueryOptions {
                            orderby: orderby.to_owned(),
                            direction: direction.to_owned(),
                            unique: unique.to_owned(),
                            include_multilingual: ml,
                            limit: 200_000,
                            ..QueryOptions::default()
                        },
                    ));
                }
            }
        }
    }
    // Deep offsets: a tie group straddling the page boundary is where a build-order difference
    // turns into a repeated or skipped row rather than a merely reordered one.
    for (offset, limit) in [(0usize, 175usize), (3, 4), (1234, 500), (9000, 175), (40_000, 175), (55_000, 175)] {
        for orderby in ["rarity", "color", "set"] {
            cases.push((
                format!("TrueNode orderby={orderby} offset={offset} limit={limit} (printing+ml)"),
                QueryOptions {
                    orderby: orderby.to_owned(),
                    unique: "printing".to_owned(),
                    include_multilingual: true,
                    offset,
                    limit,
                    ..QueryOptions::default()
                },
            ));
        }
    }

    let mut compared = 0usize;
    for (label, opts) in &cases {
        let qa = a.query(true_node, opts).expect("query a");
        let qb = b.query(true_node, opts).expect("query b");
        assert_eq!(qa.total, qb.total, "total: {label}");
        assert_eq!(qa.rows.len(), qb.rows.len(), "row count: {label}");
        for (i, (ra, rb)) in qa.rows.iter().zip(qb.rows.iter()).enumerate() {
            assert_eq!(ra, rb, "row {i} differs: {label}");
        }
        compared += qa.rows.len();
    }
    println!("match: {} envelope cases, {compared} rows compared row-for-row", cases.len());

    // Text searches exercise the trigram/word/bigram index tiers — the
    // structures the lean two-pass builder constructs — across their distinct
    // lookup paths: ≥4-char words (word dictionary), 3-char needles (exact
    // trigram), longer substrings (trigram intersection + verify), and 2-char
    // name needles (bigram index).
    let text_query = |attr: &str, original: &str, needle: &str| {
        format!(
            r#"{{"kwargs":{{"lhs":{{"kwargs":{{"attribute_name":"{attr}","original_attribute":"{original}"}},"node_type":"CardAttributeNode"}},"op":":","rhs":{{"kwargs":{{"value":"{needle}"}},"node_type":"StringValueNode"}}}},"node_type":"CardBinaryOperatorNode"}}"#
        )
    };
    for (label, tree) in [
        ("oracle word", text_query("oracle_text", "oracle", "draw")),
        ("oracle word 2", text_query("oracle_text", "oracle", "battlefield")),
        ("oracle substring", text_query("oracle_text", "oracle", "attlefield")),
        ("oracle 3-char", text_query("oracle_text", "oracle", "lif")),
        ("oracle phrase", text_query("oracle_text", "oracle", "draw card")),
        ("name 2-char", text_query("card_name", "name", "wa")),
        ("name word", text_query("card_name", "name", "ward")),
    ] {
        let opts = QueryOptions { limit: 200_000, ..QueryOptions::default() };
        let qa = a.query(&tree, &opts).expect("text query a");
        let qb = b.query(&tree, &opts).expect("text query b");
        assert_eq!(qa.total, qb.total, "total: {label}");
        for (i, (ra, rb)) in qa.rows.iter().zip(qb.rows.iter()).enumerate() {
            assert_eq!(ra, rb, "row {i} differs: {label}");
        }
        println!("match: {label} ({} matches)", qa.total);
    }

    // sample_preferred is deliberately NOT compared: its pool walk depends on
    // archive-internal iteration order, which HashMap seeding permutes on
    // every rebuild — two runs of the unpatched Vec path differ too. It backs
    // random_search, where cross-build stability was never a property.
    for seed in [1u64, 42, 999] {
        let sa = a.sample_preferred(50, seed, None).expect("sample a");
        let sb = b.sample_preferred(50, seed, None).expect("sample b");
        assert_eq!(sa.len(), sb.len(), "sample_preferred size, seed {seed}");
    }
    println!("match: sample_preferred sizes (content is build-order-random by design)");
    println!("STORES SEMANTICALLY IDENTICAL");
}

// ─── partition ───────────────────────────────────────────────────────────────

/// Cut a rows.jsonl into per-partition row files by the SHARED hash (`fnv1a64(oracle_id) % N`),
/// so the gate's wasm-fit probe can run the capped build one partition at a time — each in its
/// own process, which is what structurally guarantees the builder never holds two partitions'
/// state at once.
fn cmd_partition(rows_path: &Path, parts: u32, out_prefix: &Path) {
    let rows = std::fs::File::open(rows_path).expect("open rows");
    let mut outs: Vec<BufWriter<std::fs::File>> = (0..parts)
        .map(|k| {
            let path = PathBuf::from(format!("{}{k}.jsonl", out_prefix.display()));
            BufWriter::with_capacity(1 << 20, std::fs::File::create(path).expect("create partition rows"))
        })
        .collect();
    let mut counts = vec![0usize; parts as usize];
    for line in BufReader::with_capacity(1 << 20, rows).lines() {
        let line = line.expect("read row line");
        if line.is_empty() {
            continue;
        }
        let row: Value = serde_json::from_str(&line).expect("parse row");
        let oracle = row.get("oracle_id").and_then(Value::as_str).expect("row has oracle_id");
        let k = card_engine::partition_of_oracle_id(oracle, parts) as usize;
        outs[k].write_all(line.as_bytes()).expect("write row");
        outs[k].write_all(b"\n").expect("write newline");
        counts[k] += 1;
    }
    for o in &mut outs {
        o.flush().expect("flush partition rows");
    }
    eprintln!("partitioned into {parts}: {counts:?} rows");
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
        "gen" => {
            let printings: usize = args.get("printings").map(|s| s.parse().expect("number")).unwrap_or(100_000);
            let foreign_ratio: f64 =
                args.get("foreign-ratio").map(|s| s.parse().expect("ratio")).unwrap_or(0.0);
            cmd_gen(printings, foreign_ratio, &arg(&args, "bulk"), &arg(&args, "tags"));
        }
        "rows" => cmd_rows(&arg(&args, "bulk"), &arg(&args, "tags"), &arg(&args, "out")),
        "partition" => {
            let parts: u32 = args.get("parts").map(|s| s.parse().expect("number")).unwrap_or(4);
            cmd_partition(&arg(&args, "rows"), parts, &arg(&args, "out-prefix"));
        }
        "build" => cmd_build(&arg(&args, "rows"), &arg(&args, "out")),
        "phases" => cmd_phases(&arg(&args, "rows"), &arg(&args, "out")),
        "spill" => cmd_spill(&arg(&args, "rows"), &arg(&args, "out")),
        "compare" => cmd_compare(&arg(&args, "a"), &arg(&args, "b")),
        "tagbench" => {
            let iters: usize = args.get("iters").map(|s| s.parse().expect("number")).unwrap_or(25);
            cmd_tagbench(&arg(&args, "store"), iters);
        }
        "textbench" => {
            let iters: usize = args.get("iters").map(|s| s.parse().expect("number")).unwrap_or(25);
            cmd_textbench(&arg(&args, "store"), iters);
        }
        "namecheck" => cmd_namecheck(&arg(&args, "store")),
        "querybench" => {
            let iters: usize = args.get("iters").map(|s| s.parse().expect("number")).unwrap_or(25);
            cmd_querybench(&arg(&args, "store"), iters);
        }
        "routebench" => {
            let iters: usize = args.get("iters").map(|s| s.parse().expect("number")).unwrap_or(25);
            cmd_routebench(&arg(&args, "store"), iters);
        }
        other => {
            eprintln!(
                "unknown command {other:?}; expected gen | rows | partition | build | phases | spill | \
                 compare | tagbench | textbench | namecheck | querybench | routebench"
            );
            std::process::exit(2);
        }
    }
}
