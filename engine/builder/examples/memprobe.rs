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

/// Bumped whenever anything below changes the SHAPE of the generated corpus, and read by
/// `scripts/gate.sh` into the cache directory name.
///
/// The corpus is cached across gate runs because synthesizing it is pure and deterministic. That
/// is true only of the generator that wrote it: after this file changes, a cached bulk.jsonl is
/// the OLD corpus wearing the new corpus's path, and every ratio, every envelope case and every
/// fit measurement in the run is read off it. The `-ml` suffix was added by hand for exactly this
/// reason once already (a pre-multilingual corpus serving a multilingual gate); a constant the
/// generator itself publishes is the version of that fix that cannot be forgotten.
const CORPUS_SHAPE: &str = "ml-v3-spread";

/// The oracle-level VALUE SPREAD, and why it exists.
///
/// A FIELD HELD CONSTANT ACROSS EVERY ROW CANNOT DISCRIMINATE ANY RULE ABOUT THAT FIELD. The four
/// template fixtures are four real cards, so every value they do not vary was pinned at four
/// distinct values or fewer across the whole corpus — and several of those four collapsed further
/// in transform. Measured on the 12k-printing gate corpus before this existed (56,105 rows):
///
///     cmc                    2 distinct    {1.0, 4.0}
///     creature_power         2 distinct    {null, 1}
///     creature_toughness     2 distinct    {null, 1}
///     edhrec_rank            4 distinct    (one per template)
///     cubecobra_score        4 distinct    (a percent-rank OF edhrec_rank, so it inherits it)
///     card_colors            3 distinct    {R}, {G}, {U} — and card_color_identity the SAME three
///     card_border            1 distinct    "black"
///     card_watermark         1 distinct    null
///     card_frame_data        1 distinct    {"2015"}
///     card_legalities        4 distinct    (one per template; never `banned`, never `restricted`)
///     card_types             3 distinct    (one per template — no second type, no supertype)
///     produced_mana          2 distinct    {} and {G}
///     color_indicator        1 distinct    {}
///     flavor_name            1 distinct    null — so the flavor_names index built EMPTY
///
/// What that cost, concretely: four of `memprobe compare`'s twelve orderings degenerated to a
/// single tie group, so the tie-heavy grid the two-publisher check leans on was comparing one
/// undifferentiated block for `cmc`, `power`, `toughness` and `cubecobra`; and eleven of
/// `querybench`'s filter rows (`cmc>=5`, `power>=4`, `c:wu`, `c>=3`, `mana:{2}{R}`,
/// `mana>={W}{U}`, `devotion`, `banned:legacy`, `restricted:vintage`, `t>creature`,
/// `t:"artifact creature"`) were timing an EMPTY result set — a number that cannot regress
/// because there is nothing in it.
///
/// TWO FIELDS ARE STILL CONSTANT ON PURPOSE, and the rule says say so rather than leave it
/// unexplained. `life_modifier` and `hand_modifier` are null on every row because they exist only
/// on Vanguard, a layout none of the four templates is; making a slice of the corpus Vanguard
/// would change what `is:extra` and the default search exclude, moving every route bench for one
/// field's sake. They are covered where the values are real instead —
/// `tests/routes/card-object-parity.test.ts` builds an actual vanguard row ("+7"/"+1") and reads
/// the card object back.
///
/// So the spread is drawn per ORACLE CARD (not per printing: cmc, colours, power and edhrec rank
/// are oracle-level facts that every reprint shares, and the intern-dedupe ratios the probe
/// measures depend on that staying true), from weighted tables shaped like the real corpus.
///
/// DOMAINS ARE DELIBERATELY SMALLER THAN THE CARD COUNT where ties are the point. `edhrec_rank`
/// is drawn from a range about half the oracle count rather than made unique, because the compare
/// grid exists to catch build-order differences inside tie groups and a totally-ordered column
/// has none. Small domains (cmc, power, rarity, colour) are tie-heavy by nature and need no help.
struct Spread {
    mana_cost: String,
    cmc: f64,
    colors: Vec<&'static str>,
    color_identity: Vec<&'static str>,
    produced_mana: Vec<&'static str>,
    color_indicator: Vec<&'static str>,
    type_prefix: &'static str,
    power: Option<String>,
    toughness: Option<String>,
    loyalty: Option<String>,
    edhrec_rank: Option<i64>,
    penny_rank: Option<i64>,
    keywords: Vec<&'static str>,
    legalities: Vec<(&'static str, &'static str)>,
}

/// Index into an `n`-item table with geometrically decaying weights (each item ~0.8x the one
/// before), so the head is common and the tail is a handful of rows. 30 sets over 12k printings
/// puts ~2,600 printings in the largest and ~3 in the smallest.
fn zipf_index(rng: &mut Rng, n: usize) -> usize {
    let mut weights = Vec::with_capacity(n);
    let mut w = 1_000_000f64;
    for _ in 0..n {
        weights.push(w.max(1.0) as u64);
        w *= 0.8;
    }
    let total: u64 = weights.iter().sum();
    let mut r = rng.below(total);
    for (i, w) in weights.iter().enumerate() {
        if r < *w {
            return i;
        }
        r -= *w;
    }
    n - 1
}

/// Weighted pick from a `(weight, value)` table.
fn pick<'a, T>(rng: &mut Rng, table: &'a [(u64, T)]) -> &'a T {
    let total: u64 = table.iter().map(|(w, _)| *w).sum();
    let mut r = rng.below(total);
    for (w, v) in table {
        if r < *w {
            return v;
        }
        r -= *w;
    }
    &table[table.len() - 1].1
}

/// Colour classes at roughly the real corpus's mix: a tenth colourless, two thirds mono, the rest
/// spread over the guild/shard pairs and triples with a five-colour tail. Every subset shape the
/// `c:`/`id:` operators branch on (empty, singleton, pair, triple, all five) is present.
const COLOR_CLASSES: &[(u64, &[&str])] = &[
    (100, &[]),
    (130, &["W"]), (130, &["U"]), (130, &["B"]), (130, &["R"]), (130, &["G"]),
    (22, &["W", "U"]), (22, &["U", "B"]), (22, &["B", "R"]), (22, &["R", "G"]), (22, &["G", "W"]),
    (14, &["W", "B"]), (14, &["U", "R"]), (14, &["B", "G"]), (14, &["R", "W"]), (14, &["G", "U"]),
    (12, &["W", "U", "B"]), (10, &["U", "B", "R"]), (10, &["B", "R", "G"]), (8, &["W", "B", "G"]),
    (6, &["W", "U", "B", "R", "G"]),
];

/// Generic mana in the cost, weighted low the way real costs are.
const GENERIC: &[(u64, u64)] = &[(16, 0), (22, 1), (20, 2), (16, 3), (11, 4), (7, 5), (4, 6), (2, 8), (1, 12)];

/// Pips of each colour the card is: mostly one, sometimes two, rarely three.
const PIPS: &[(u64, u64)] = &[(70, 1), (23, 2), (7, 3)];

/// Creature power and toughness, weighted like the printed corpus, with the `*` that makes both
/// the integer column NULL and the text column present — the one shape where the two disagree.
const PT: &[(u64, &str)] = &[
    (6, "0"), (20, "1"), (22, "2"), (19, "3"), (13, "4"), (8, "5"), (5, "6"), (3, "7"), (2, "8"),
    (1, "10"), (1, "*"),
];

const LOYALTY: &[(u64, &str)] = &[(10, "2"), (26, "3"), (30, "4"), (18, "5"), (10, "6"), (5, "7"), (1, "X")];

/// Keyword pool for the ability soup. Kept lowercase-insensitive on purpose (`Flying` vs
/// `First strike`): the transform folds these and the catalog counts them, so the mixed casing is
/// part of what the corpus has to carry.
const KEYWORDS: &[&str] = &[
    "Flying", "Trample", "Haste", "Vigilance", "Deathtouch", "Lifelink", "Menace", "Reach", "Ward",
    "Flash", "First strike", "Double strike", "Hexproof", "Defender", "Prowess", "Scry", "Cycling",
];

const WATERMARKS: &[&str] = &[
    "boros", "izzet", "selesnya", "golgari", "dimir", "orzhov", "simic", "rakdos", "gruul",
    "azorius", "set", "planeswalker", "mirran", "phyrexian",
];

const FRAMES: &[(u64, &str)] = &[(6, "1993"), (8, "1997"), (18, "2003"), (66, "2015"), (2, "future")];

const BORDERS: &[(u64, &str)] = &[(93, "black"), (4, "white"), (2, "borderless"), (1, "silver")];

/// The formats a legality perturbation can land on. `banned` and `restricted` are RARE, which is
/// what makes them worth generating: the packed legality word stores four states in two bits, and
/// a corpus that only ever writes `legal`/`not_legal` exercises one bit of the two.
const LEGALITY_FORMATS: &[&str] =
    &["standard", "pioneer", "modern", "legacy", "vintage", "commander", "pauper", "brawl"];

/// SUPERTYPES AND THE SECOND CARD TYPE, spliced onto the template's own type line.
///
/// The four templates are one type line each — `Instant`, `Creature — Elf Druid`, `Legendary
/// Planeswalker — Jace`, `Creature — Human Wizard // Creature — Human Insect` — so `card_types`
/// held 3 distinct values across the whole corpus and `card_subtypes` 4. Two `querybench` rows
/// measured that directly: `t>creature` (a type set strictly ABOVE Creature) and
/// `t:"artifact creature"` both timed 0 rows, because no card in the corpus had a second card
/// type or a supertype to find.
///
/// The prefix goes in front of the primary types on EVERY half of the line (so a transforming
/// card's two faces agree, as a real one's supertypes do), and it is drawn per oracle card
/// because a supertype is an oracle-level fact that every reprint shares.
///
/// Two tables because the composite types are not universally legal: `Artifact Creature` and
/// `Enchantment Creature` are printed cards, `Artifact Instant` is not. Only the supertypes
/// (`Legendary`, `Snow`) go on a non-creature.
const TYPE_PREFIXES_CREATURE: &[(u64, &str)] = &[
    (68, ""),
    (9, "Legendary "),
    (10, "Artifact "),
    (4, "Snow "),
    (3, "Legendary Artifact "),
    (6, "Enchantment "),
];
const TYPE_PREFIXES_OTHER: &[(u64, &str)] = &[(84, ""), (11, "Legendary "), (5, "Snow ")];

struct OracleCard {
    template: usize,
    oracle_id: String,
    name: String,
    oracle_text: String,
    first_illustration: String,
    spread: Spread,
}

fn set_str(card: &mut Map<String, Value>, key: &str, val: String) {
    card.insert(key.to_owned(), Value::String(val));
}

/// WUBRG order, which is the order Scryfall writes colour arrays in and the order the corpus has
/// to be in for a set-equality assertion against a real answer to mean anything.
fn wubrg_sorted(mut colors: Vec<&'static str>) -> Vec<&'static str> {
    colors.sort_by_key(|c| "WUBRG".find(c).unwrap_or(9));
    colors.dedup();
    colors
}

/// Draw one oracle card's value spread. `type_line` is the template's, and it is what decides
/// which of the mutually exclusive stat groups the card gets: creatures get power/toughness,
/// planeswalkers get loyalty, and everything else gets neither — the same rule `build_draft`'s
/// `is_creaturelike` applies on the way in, so the generator never writes a stat the transform
/// would drop on the floor.
fn spread_for(rng: &mut Rng, type_line: &str, oracle_count: usize) -> Spread {
    let colors = wubrg_sorted(pick(rng, COLOR_CLASSES).to_vec());
    let generic = *pick(rng, GENERIC);
    let mut mana_cost = String::new();
    if generic > 0 || colors.is_empty() {
        mana_cost.push_str(&format!("{{{generic}}}"));
    }
    let mut cmc = generic;
    for c in &colors {
        let pips = *pick(rng, PIPS);
        cmc += pips;
        for _ in 0..pips {
            mana_cost.push_str(&format!("{{{c}}}"));
        }
    }

    // A colour identity WIDER than the cost, on about a seventh of cards — the shape a mana
    // ability or an activated cost in the rules text produces. Without it `card_colors` and
    // `card_color_identity` are the same object on every row, and an extractor reading the wrong
    // one of the two answers correctly on the whole corpus.
    let mut color_identity = colors.clone();
    if rng.chance(14) {
        let extra = ["W", "U", "B", "R", "G"][rng.below(5) as usize];
        color_identity.push(extra);
        color_identity = wubrg_sorted(color_identity);
    }

    // A MANA SOURCE, on about an eighth of cards. `produced_mana` was `{}` on all but the
    // Llanowar Elves template (2 distinct values corpus-wide), so `produces:` — a filter with its
    // own bitplane, its own six-wide colour count, and its own "independent transposition" tests —
    // had one green bit and nothing else to be wrong about here. Drawn from the card's identity
    // where it has one (a mana creature taps for its own colour) and colourless otherwise, which
    // is also what keeps `produced_mana ⊄ card_colors` a real shape rather than an accident.
    let produced_mana = if rng.chance(12) {
        if color_identity.is_empty() || rng.chance(25) {
            vec!["C"]
        } else {
            wubrg_sorted(color_identity.clone())
        }
    } else {
        Vec::new()
    };

    let (power, toughness) = if type_line.contains("Creature") {
        (Some((*pick(rng, PT)).to_owned()), Some((*pick(rng, PT)).to_owned()))
    } else {
        (None, None)
    };
    let loyalty =
        type_line.contains("Planeswalker").then(|| (*pick(rng, LOYALTY)).to_owned());

    let type_prefix = *pick(
        rng,
        if type_line.contains("Creature") { TYPE_PREFIXES_CREATURE } else { TYPE_PREFIXES_OTHER },
    );

    // The COLOUR INDICATOR — the dot a costless face wears in place of a mana cost — on most
    // coloured transform backs, which is where real ones live. It was `{}` on every row, so
    // `color_indicator`'s whole extraction path was answering about a field the corpus never set.
    // Only meaningful on the faced template; `apply_spread` writes it to the BACK face alone.
    let color_indicator = if colors.is_empty() || !rng.chance(80) { Vec::new() } else { colors.clone() };

    // A rank DOMAIN about half the card count, not a unique rank per card: the compare grid is
    // there to catch build-order differences inside tie groups, and `order=edhrec` over a totally
    // ordered column has none to catch them in. The null tail is real too — it is the trailing
    // peer group of the cubecobra percent-rank, and the missing-value arm of every rank sort.
    let edhrec_domain = (oracle_count as u64 / 2).max(2);
    let edhrec_rank = rng.chance(92).then(|| 1 + rng.below(edhrec_domain) as i64);
    let penny_rank = rng.chance(55).then(|| 1 + rng.below(2000) as i64);

    let n_keywords = *pick(rng, &[(55u64, 0usize), (25, 1), (13, 2), (7, 3)]);
    let mut keywords: Vec<&'static str> = Vec::with_capacity(n_keywords);
    for _ in 0..n_keywords {
        let k = KEYWORDS[rng.below(KEYWORDS.len() as u64) as usize];
        if !keywords.contains(&k) {
            keywords.push(k);
        }
    }

    // Legality perturbations. `banned` on ~4% of cards and `restricted` on ~1% is roughly the real
    // frequency, and it is the only way the two-bit legality code's upper states ever get written.
    let mut legalities: Vec<(&'static str, &'static str)> = Vec::new();
    if rng.chance(4) {
        legalities.push((LEGALITY_FORMATS[rng.below(LEGALITY_FORMATS.len() as u64) as usize], "banned"));
    }
    if rng.chance(1) {
        legalities.push(("vintage", "restricted"));
    }
    if rng.chance(12) {
        legalities.push((LEGALITY_FORMATS[rng.below(LEGALITY_FORMATS.len() as u64) as usize], "not_legal"));
    }

    Spread {
        mana_cost,
        cmc: cmc as f64,
        colors,
        color_identity,
        produced_mana,
        color_indicator,
        type_prefix,
        power,
        toughness,
        loyalty,
        edhrec_rank,
        penny_rank,
        keywords,
        legalities,
    }
}

/// Write one oracle card's spread onto a printing of it. Faces get the cost and the stats where
/// the template has faces (the front carries the whole cost, as a transforming card does), and
/// the card level gets them where it does not — mirroring where the real bulk data puts each.
fn apply_spread(obj: &mut Map<String, Value>, sp: &Spread) {
    let colors: Vec<Value> = sp.colors.iter().map(|c| Value::String((*c).to_owned())).collect();
    let letters = |cs: &[&'static str]| Value::Array(cs.iter().map(|c| Value::String((*c).to_owned())).collect());
    obj.insert("cmc".to_owned(), serde_json::json!(sp.cmc));
    obj.insert("color_identity".to_owned(), letters(&sp.color_identity));
    obj.insert("produced_mana".to_owned(), letters(&sp.produced_mana));
    // The supertype/second-type splice, on every `//` half of the card-level line and on each
    // face's own — `Creature — Elf Druid` becomes `Artifact Creature — Elf Druid`.
    if !sp.type_prefix.is_empty() {
        if let Some(line) = obj.get("type_line").and_then(Value::as_str) {
            let prefixed =
                line.split(" // ").map(|half| format!("{}{half}", sp.type_prefix)).collect::<Vec<_>>().join(" // ");
            set_str(obj, "type_line", prefixed);
        }
        if let Some(faces) = obj.get_mut("card_faces").and_then(Value::as_array_mut) {
            for face in faces.iter_mut() {
                let Some(f) = face.as_object_mut() else { continue };
                if let Some(line) = f.get("type_line").and_then(Value::as_str) {
                    let prefixed = format!("{}{line}", sp.type_prefix);
                    set_str(f, "type_line", prefixed);
                }
            }
        }
    }
    // Keywords: the template's (a transforming card really does keep `Transform`) plus the draw.
    let mut keywords: Vec<String> =
        str_list(obj.get("keywords")).into_iter().filter(|k| k == "Transform").collect();
    for k in &sp.keywords {
        if !keywords.iter().any(|have| have == k) {
            keywords.push((*k).to_owned());
        }
    }
    obj.insert("keywords".to_owned(), serde_json::json!(keywords));

    if let Some(legalities) = obj.get_mut("legalities").and_then(Value::as_object_mut) {
        for (format, status) in &sp.legalities {
            legalities.insert((*format).to_owned(), Value::String((*status).to_owned()));
        }
    }

    let has_faces = obj.get("card_faces").and_then(Value::as_array).is_some_and(|f| !f.is_empty());
    if has_faces {
        let faces = obj.get_mut("card_faces").and_then(Value::as_array_mut).expect("faces");
        for (i, face) in faces.iter_mut().enumerate() {
            let Some(f) = face.as_object_mut() else { continue };
            // The front face carries the cost; the back of a transforming card is castless.
            set_str(f, "mana_cost", if i == 0 { sp.mana_cost.clone() } else { String::new() });
            f.insert("colors".to_owned(), Value::Array(colors.clone()));
            // The colour indicator belongs to the COSTLESS face, which is where Scryfall puts it.
            if i > 0 && !sp.color_indicator.is_empty() {
                f.insert("color_indicator".to_owned(), letters(&sp.color_indicator));
            } else {
                f.remove("color_indicator");
            }
            // The back face is bigger, as transforming creatures are — and different, so the
            // face-merge rule (first group with a value wins) is answering about real values.
            for (key, val) in [("power", &sp.power), ("toughness", &sp.toughness)] {
                match val {
                    Some(v) if i == 0 => set_str(f, key, v.clone()),
                    Some(v) => set_str(f, key, bumped_stat(v)),
                    None => {
                        f.remove(key);
                    }
                }
            }
        }
    } else {
        set_str(obj, "mana_cost", sp.mana_cost.clone());
        obj.insert("colors".to_owned(), Value::Array(colors));
        for (key, val) in [("power", &sp.power), ("toughness", &sp.toughness), ("loyalty", &sp.loyalty)] {
            match val {
                Some(v) => set_str(obj, key, v.clone()),
                None => {
                    obj.remove(key);
                }
            }
        }
    }

    match sp.edhrec_rank {
        Some(r) => {
            obj.insert("edhrec_rank".to_owned(), serde_json::json!(r));
        }
        None => {
            obj.remove("edhrec_rank");
        }
    }
    match sp.penny_rank {
        Some(r) => {
            obj.insert("penny_rank".to_owned(), serde_json::json!(r));
        }
        None => {
            obj.remove("penny_rank");
        }
    }
}

/// `"3"` -> `"5"`, `"*"` -> `"*"`: the back face's stat, still in Scryfall's string spelling.
fn bumped_stat(v: &str) -> String {
    v.parse::<i64>().map(|n| (n + 2).to_string()).unwrap_or_else(|_| v.to_owned())
}

fn str_list(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
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
    // Sets are ZIPFIAN, not uniform. Real sets differ in size by three orders of magnitude, and
    // the difference is load-bearing here: a uniform 30 sets over 12k printings puts every set in
    // every partition at any N, which is exactly the condition under which an archive-local
    // `set_rank` on the wire would agree across two different cuts and the partition differential
    // would pass a broken sort key. The rare tail (a few printings each) is what makes one
    // partition's set inventory differ from another's — see `scripts/gate.sh`'s N=2 vs N=10 step.
    set_str(obj, "set", SETS[zipf_index(rng, SETS.len())].to_owned());
    set_str(obj, "set_name", format!("{} Horizons", title_words(rng, 1)));
    set_str(obj, "collector_number", format!("{}", 1 + rng.below(400)));
    set_str(obj, "artist", title_words(rng, 2));
    set_str(obj, "rarity", RARITIES[rng.below(RARITIES.len() as u64) as usize].to_owned());
    set_str(obj, "frame", (*pick(rng, FRAMES)).to_owned());
    set_str(obj, "border_color", (*pick(rng, BORDERS)).to_owned());
    if rng.chance(9) {
        set_str(obj, "watermark", WATERMARKS[rng.below(WATERMARKS.len() as u64) as usize].to_owned());
    } else {
        obj.remove("watermark");
    }
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
    // The Godzilla/Secret-Lair ALTERNATE NAME, on ~2% of printings. It was null on every row, and
    // the engine builds a whole `flavor_names` record table off it and puts every `name:` needle
    // to that table BEFORE the ordinary name lanes (see `FlavorNameIn` / `bind_flavor_names`). A
    // corpus with no flavor names builds that index empty, so the tier is never entered and the
    // route benches measure a name path with one of its stages missing. ~2% of 12k printings is
    // ~240 records, the same order as the ~546 on the real corpus. PRINTING-level, not oracle:
    // one printing of a card carries the alternate name and its reprints do not.
    if rng.chance(2) {
        set_str(obj, "flavor_name", format!("{} of {}", title_words(rng, 1), title_words(rng, 1)));
    } else {
        obj.remove("flavor_name");
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

    // Last, so it owns every field it writes outright: the oracle-level spread (cost, colours,
    // stats, ranks, keywords, legality perturbations), identical on every printing of this card.
    apply_spread(obj, &oracle.spread);

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
        let type_line =
            templates[template].get("type_line").and_then(Value::as_str).unwrap_or("").to_owned();
        oracles.push(OracleCard {
            template,
            oracle_id: uuid(&mut rng),
            name: title_words(&mut rng, name_words),
            oracle_text: sentence(&mut rng, text_len),
            first_illustration,
            spread: spread_for(&mut rng, &type_line, oracle_count),
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
    // `devotion>={G}{G}`, not the `devotion>=3` this row used to hold. A bare `3` is generic mana,
    // and devotion sums only the COLOUR lanes the value names (see filter.rs's Devotion arm), so
    // the old row queried zero lanes and matched zero cards on any corpus — the same "cannot
    // regress because there is nothing in it" shape the corpus spread exists to remove, but this
    // half of it was the query, not the data.
    ("devotion>={G}{G}", "devotion>={G}{G}", r#"{"node_type":"CardBinaryOperatorNode","kwargs":{"lhs":{"node_type":"CardAttributeNode","kwargs":{"attribute_name":"devotion","original_attribute":"devotion"}},"op":">=","rhs":{"node_type":"ManaValueNode","kwargs":{"value":"{G}{G}"}}}}"#),
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

/// THE ENVELOPE GRID, and it is DELIBERATELY TIE-HEAVY.
///
/// Two archives built from IDENTICAL rows can still differ byte-for-byte in their index region,
/// because index construction may break ties between equally-ranked rows in build order. That is
/// invisible to a checksum and invisible to a query whose sort key is unique — it shows up only
/// where many rows share one sort value and the archive's own order decides which comes first. So
/// every low-cardinality ordering is here (`rarity` has 4 distinct values over 4,200 cards,
/// `color` 6, `cmc` ~18, `set` 30, `power`/`toughness` ~11), in both directions, across all three
/// unique modes, with and without the annex, plus deep offsets where a tie straddling the window
/// boundary would repeat or skip a row.
///
/// A GRID IS ONLY TIE-HEAVY IF THE CORPUS IS. Four of these twelve orderings used to be ONE tie
/// group each, because the generated corpus had two distinct `cmc` values and two distinct
/// `power`/`toughness` — see `Spread`. Widening the corpus is what makes this grid mean what its
/// name says, and the two checks that read it (`compare`, `compare-parts`) share it for that
/// reason: one grid, one corpus, one set of tie groups.
fn envelope_cases() -> Vec<(String, card_engine::QueryOptions)> {
    use card_engine::QueryOptions;

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
    cases
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
    let cases = envelope_cases();

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

// ─── the answer does not depend on how the corpus was cut ────────────────────

/// THE PARTITION DIFFERENTIAL: the same corpus cut TWO WAYS must answer byte-identically.
///
/// CARD-PARTITIONING §6 originally asked for "byte-identical envelopes, partitioned vs
/// unpartitioned". That criterion is unachievable and was never met: there IS no unpartitioned
/// build. `partition_count_for` clamps at `MIN_PARTITIONS = 2`, `writeManifest` refuses a manifest
/// without partitions, and a single archive over the multilingual corpus aborts under the 124MiB
/// cap by design (the N=1 shape is superlinear — see `SPILLED_DRAFT_TO_STORE_RATIO`). The old
/// single-archive gate step was deleted rather than fixed, correctly, and that left the cut proven
/// on a small fixture, the merge proven in isolation
/// (`partitioned_key_streams_merge_to_the_unpartitioned_order`), and NOTHING joining the two.
///
/// This is the achievable form, and it is strictly stronger than either half because it joins
/// them: N=2 versus N=10 over one corpus. Both are legal cuts, both build under the cap, and byte
/// equality between them proves exactly what the original wanted — THE ANSWER DOES NOT DEPEND ON
/// HOW THE CORPUS WAS CUT. An unpartitioned reference would have proven the same thing about a
/// shape that no publisher can emit.
///
/// It reads the same tie-heavy grid `compare` does (`envelope_cases`), through the same reference
/// gather the serving DO implements: phase 1 asks every partition for its top `offset + limit`
/// keys at offset 0, the streams are bytewise-merged, and phase 2 fetches the surviving page rows
/// from the partition that owns them. Inline budget 0 — the keys-only protocol — because what is
/// on trial here is the CUT, and `inline_rows_equal_fetch_rows_for_the_same_entries` already pins
/// the budget dimension against a single store.
///
/// It runs its own NEGATIVE CONTROL in the same invocation, over the same two cuts: see
/// `localize_primary`. The check and the proof that the check can fail are one command because a
/// control that is a separate command is a control someone stops running.
fn cmd_compare_parts(rows_path: &Path, work_dir: &Path, n_a: u32, n_b: u32) {
    use sylvan_store_builder::PartitionsArg;

    let build = |n: u32| -> Vec<card_engine::BufferStore> {
        let dir = work_dir.join(format!("cut-n{n}"));
        std::fs::remove_dir_all(&dir).ok();
        let file = std::fs::File::open(rows_path).expect("open rows");
        let rows = BufReader::with_capacity(1 << 20, file).lines().filter_map(|line| {
            let line = line.expect("read row line");
            if line.is_empty() { None } else { Some(serde_json::from_str::<Value>(&line).expect("parse row")) }
        });
        let manifest =
            sylvan_store_builder::build_store_partitioned(rows, &dir, "memprobe", PartitionsArg::Fixed(n))
                .expect("partitioned build");
        let parts = manifest["partitions"].as_array().expect("partitions").clone();
        let counts: Vec<u64> = parts.iter().map(|p| p["printing_count"].as_u64().unwrap_or(0)).collect();
        eprintln!("  N={n}: {counts:?} printings per partition");
        parts
            .iter()
            .map(|p| {
                let key = p["store_key"].as_str().expect("partition store_key");
                let bytes = std::fs::read(dir.join(key)).expect("read partition archive");
                card_engine::BufferStore::from_bytes(&bytes).expect("partition loads")
            })
            .collect()
    };

    let a = build(n_a);
    let b = build(n_b);
    // A cut that did not actually spread the corpus proves nothing about cutting it.
    for (n, parts) in [(n_a, &a), (n_b, &b)] {
        let nonempty = parts.iter().filter(|p| p.card_count() > 0).count();
        assert!(nonempty as u32 == n, "N={n} left {} of {n} partitions empty — the cut is degenerate", n - nonempty as u32);
    }

    let true_node = serde_json::json!({ "node_type": "TrueNode" });
    let cases = envelope_cases();

    // ONE BUILD, TWO PASSES. The honest pass must agree on every case; the control pass must
    // disagree on at least one. They share the two cuts because building them is most of the cost,
    // and because a control that runs against different archives than the check it validates is
    // not validating that check.
    let mut compared = 0usize;
    let mut differing = 0usize;
    let mut differing_orderings: Vec<String> = Vec::new();
    for (label, opts) in &cases {
        let ga = gather(&a, &true_node, opts, false);
        let gb = gather(&b, &true_node, opts, false);
        // The envelope is `{"total_cards":T,"has_more":H,"data":[...]}`; comparing its three parts
        // in order, row string against row string, IS comparing those bytes — without ever
        // building the ~100MB string a 56k-row case would need.
        if let Some(at) = envelope_diff(&ga, &gb) {
            panic!(
                "ENVELOPE DIVERGED between N={n_a} and N={n_b}: {label}\n  \
                 total {} vs {}, has_more {} vs {}, rows {} vs {}, first differing row {at:?}\n  \
                 The answer depends on how the corpus was cut — a sort key or a merge is \
                 archive-local.",
                ga.total,
                gb.total,
                ga.has_more,
                gb.has_more,
                ga.rows.len(),
                gb.rows.len()
            );
        }
        compared += ga.rows.len();

        // The same case with the archive-local primary substituted in. Only the three orderings
        // whose primary really is a rank in-archive can carry the substitution (see
        // `localize_primary`), so the others agree here too and are simply not evidence.
        if matches!(opts.orderby.as_str(), "name" | "set" | "artist") {
            let ba = gather(&a, &true_node, opts, true);
            let bb = gather(&b, &true_node, opts, true);
            if envelope_diff(&ba, &bb).is_some() {
                differing += 1;
                if !differing_orderings.contains(&opts.orderby) {
                    differing_orderings.push(opts.orderby.clone());
                }
            }
        }
    }

    println!("match: {} envelope cases, {compared} rows byte-for-byte, N={n_a} vs N={n_b}", cases.len());
    println!("THE CUT DOES NOT CHANGE THE ANSWER");

    // THE NEGATIVE CONTROL, asserted here rather than left to a commit message. A differential
    // that cannot fail is worth nothing, and this repo produced two of those in one night.
    assert!(
        differing > 0,
        "the archive-local sort key produced IDENTICAL envelopes at N={n_a} and N={n_b} — this \
         differential cannot fail, so its passing means nothing. Fix the check, not the corpus."
    );
    // `set` by name, because it is THE case the `encode_sort_key` decision is about: a control
    // that fired only on `name` would leave the set-code-versus-`set_rank` choice unguarded.
    assert!(
        differing_orderings.iter().any(|o| o == "set"),
        "order=set survived an archive-local primary — the one ordering whose in-archive key really \
         is a `set_rank` is exactly the one this must catch. Diverged: {differing_orderings:?}"
    );
    println!(
        "CONTROL: the same differential FAILS on {differing} cases when the sort key's primary is \
         made archive-local (orderings: {})",
        differing_orderings.join(", ")
    );
}

/// `None` when the two envelopes are byte-equal; otherwise the index of the first differing row
/// (or `None` inside a `Some` when the difference is in the total, the flag, or the row count).
fn envelope_diff(a: &Gathered, b: &Gathered) -> Option<Option<usize>> {
    let row_diff = a
        .rows
        .iter()
        .zip(b.rows.iter())
        .position(|(ra, rb)| serde_json::to_string(ra).unwrap() != serde_json::to_string(rb).unwrap());
    if a.total == b.total && a.has_more == b.has_more && a.rows.len() == b.rows.len() && row_diff.is_none() {
        return None;
    }
    Some(row_diff)
}

struct Gathered {
    total: usize,
    has_more: bool,
    rows: Vec<Value>,
}

/// The reference two-phase gather, exactly as `src/engine/remote-engine.ts` performs it and as
/// `gather_reference` in the engine's own tests spells it out: every partition answers phase 1 at
/// offset 0 with its top `offset + limit` keys, the streams are bytewise-merged (each arrives
/// sorted and keys are globally unique via the scryfall tail, so sorting the concatenation IS the
/// k-way merge), the page is the merged window, and phase 2 asks each owning partition for its
/// share of the page.
fn gather(
    parts: &[card_engine::BufferStore],
    tree: &Value,
    opts: &card_engine::QueryOptions,
    break_sort_key: bool,
) -> Gathered {
    let mut phase1 = opts.clone();
    phase1.limit = opts.offset + opts.limit;
    phase1.offset = 0;

    let mut total = 0usize;
    let mut merged: Vec<(Vec<u8>, usize, u32)> = Vec::new();
    for (part, store) in parts.iter().enumerate() {
        let out = store.query_keys(tree, &phase1, 0).expect("phase 1 keys");
        total += out.total;
        let mut keys = out.keys;
        // ONLY the three string-primary orderings. The numeric columns encode a VALUE
        // (`perm_primary_key` over the f32), not a rank, so there is no archive-local variant of
        // them to substitute — and a substitution applied to their 4 raw bytes would be corruption
        // rather than the encoding under discussion, which is a divergence that proves nothing.
        if break_sort_key && matches!(opts.orderby.as_str(), "name" | "set" | "artist") {
            localize_primary(&mut keys, opts.direction == "desc");
        }
        for (key, vpid) in keys {
            assert_eq!(key[0], card_engine::SORT_KEY_VERSION, "a merge must never mix key versions");
            merged.push((key, part, vpid));
        }
    }
    merged.sort_unstable_by(|x, y| x.0.cmp(&y.0));

    let end = (opts.offset + opts.limit).min(merged.len());
    let page = if opts.offset < end { &merged[opts.offset..end] } else { &[][..] };

    let mut rows: Vec<Option<Value>> = vec![None; page.len()];
    for (part, store) in parts.iter().enumerate() {
        let mut at: Vec<usize> = Vec::new();
        let mut vpids: Vec<u32> = Vec::new();
        for (i, entry) in page.iter().enumerate() {
            if entry.1 == part {
                at.push(i);
                vpids.push(entry.2);
            }
        }
        if vpids.is_empty() {
            continue;
        }
        for (slot, row) in at.into_iter().zip(store.fetch_rows(&vpids, opts.fields.clone()).expect("phase 2")) {
            rows[slot] = Some(row);
        }
    }
    let rows: Vec<Value> = rows.into_iter().map(|r| r.expect("every page slot fetched")).collect();
    let has_more = opts.offset + rows.len() < total;
    Gathered { total, has_more, rows }
}

/// THE NEGATIVE CONTROL: rewrite each key's primary segment as its ARCHIVE-LOCAL dense rank —
/// precisely the encoding `encode_sort_key` refuses to emit.
///
/// The decision it guards is spelled out on `encode_sort_key`: `order=set` writes the set CODE and
/// never `set_rank`, `order=name` the collated name and never `name_rank`, because those ranks are
/// assigned over the rows of THIS archive. Partition A ranking `{alp, ixp, zab}` as `{0, 1, 2}`
/// and partition B ranking `{ixp, zab}` as `{0, 1}` interleaves wrongly under a bytewise merge —
/// and does so ONLY when the two partitions hold different inventories, which is why the corpus
/// draws its sets zipfian (a uniform 30-set draw puts every set in every partition, and the
/// broken key would then agree with the correct one).
///
/// This is a HARNESS substitution rather than a build flag on the engine, and it is faithful
/// because the substitution is exactly the one under discussion: the segment is replaced in place,
/// the rank is dense over the segments this partition actually holds, and the ordering INSIDE a
/// partition is unchanged (a dense rank is monotone in the value it ranks) — which is the whole
/// trap. A rank-based key passes every in-archive ordering test and fails only across the cut.
///
/// The CALLER restricts this to the three orderings whose primary is a string segment (`name`,
/// `set`, `artist`); the numeric columns have no archive-local variant to substitute, so their
/// cases run the honest key and must still agree even in this mode. That is deliberate: it keeps
/// the control's own failures attributable. A control that broke every case would not distinguish
/// "the differential detects an archive-local rank" from "the differential detects garbage".
fn localize_primary(keys: &mut [(Vec<u8>, u32)], descending: bool) {
    // push_str_segment's four shapes: absent is one byte (0x00 asc / 0x02 desc); present is 0x01,
    // the bytes (complemented when descending), then a terminator (0x00 asc / 0xFF desc). A string
    // byte is never the terminator's value, so the first one ends the segment.
    let terminator = if descending { 0xFFu8 } else { 0x00 };
    let primary_len = |key: &[u8]| -> usize {
        if key.get(1) != Some(&0x01) {
            return 1; // the absent marker, a single byte
        }
        key[2..].iter().position(|b| *b == terminator).map_or(key.len() - 1, |i| i + 2)
    };

    let mut distinct: Vec<&[u8]> = keys.iter().map(|(k, _)| &k[1..1 + primary_len(k)]).collect();
    distinct.sort_unstable();
    distinct.dedup();
    let ranks: HashMap<Vec<u8>, u32> =
        distinct.iter().enumerate().map(|(i, seg)| ((*seg).to_vec(), i as u32)).collect();

    for (key, _) in keys.iter_mut() {
        let n = primary_len(key);
        let rank = ranks[&key[1..1 + n]];
        // Complemented descending, exactly as `perm_primary_key` folds direction into its own
        // 4-byte primary — so the broken key stays a well-formed key and the merge stays a merge.
        let rank = if descending { !rank } else { rank };
        key.splice(1..1 + n, rank.to_be_bytes());
    }
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
        // The generated corpus's shape tag, for whoever caches it (scripts/gate.sh names its
        // cache directory with this). Printed bare so a shell can read it without parsing.
        "corpus-shape" => println!("{CORPUS_SHAPE}"),
        "rows" => cmd_rows(&arg(&args, "bulk"), &arg(&args, "tags"), &arg(&args, "out")),
        "partition" => {
            let parts: u32 = args.get("parts").map(|s| s.parse().expect("number")).unwrap_or(4);
            cmd_partition(&arg(&args, "rows"), parts, &arg(&args, "out-prefix"));
        }
        "build" => cmd_build(&arg(&args, "rows"), &arg(&args, "out")),
        "phases" => cmd_phases(&arg(&args, "rows"), &arg(&args, "out")),
        "spill" => cmd_spill(&arg(&args, "rows"), &arg(&args, "out")),
        "compare" => cmd_compare(&arg(&args, "a"), &arg(&args, "b")),
        "compare-parts" => {
            let n_a: u32 = args.get("a").map(|s| s.parse().expect("number")).unwrap_or(2);
            let n_b: u32 = args.get("b").map(|s| s.parse().expect("number")).unwrap_or(10);
            cmd_compare_parts(&arg(&args, "rows"), &arg(&args, "work"), n_a, n_b);
        }
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
                "unknown command {other:?}; expected gen | corpus-shape | rows | partition | build | \
                 phases | spill | compare | compare-parts --rows R --work D [--a 2] [--b 10] | \
                 tagbench | textbench | namecheck | querybench | routebench"
            );
            std::process::exit(2);
        }
    }
}
