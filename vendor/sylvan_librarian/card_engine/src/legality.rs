// Legalities pack into a u64: 2 bits per format, positions handed out append-only
// by a global registry the first time a format name appears in loaded data, so
// bit assignments stay stable across reloads and engine instances. A format the
// card's JSONB omits reads as not_legal. 32 formats fit; Scryfall ships 22.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, OnceLock, RwLock};
#[cfg(feature = "python")]
use pyo3::prelude::*;
#[cfg(feature = "python")]
use pyo3::types::PyDict;
use rkyv::Archived;

const LEGALITY_NOT_LEGAL: u64 = 0;
pub(crate) const LEGALITY_LEGAL: u64 = 1;
pub(crate) const LEGALITY_RESTRICTED: u64 = 2;
pub(crate) const LEGALITY_BANNED: u64 = 3;
pub(crate) const MAX_FORMATS: usize = 32;

type FormatOrder = Arc<Vec<(String, u8)>>;

/// The format→shift map and the sorted order cached from it, as ONE addressable value.
///
/// It is a struct for a TESTING reason. These were three free-standing statics, so the test that
/// guards the cache had no registry to read except the process-global one — which every store
/// load, archive attach and legality filter in the binary also writes. That made its result a
/// function of which other tests had run first, in both directions:
///
///   - RED WITH NOTHING WRONG. It went red once in a full parallel run and passed alone. Two
///     threads that miss the cache at the same generation each build their own vector and each
///     publish it, so a caller can be handed a different `Arc` by two consecutive calls with no
///     writer between them — exactly what "reuse the cached allocation" denies. Guarding the
///     assertion on the generation holding still does NOT cover it, because the racing publisher
///     never bumps the generation; that guard was added and the test still failed under it.
///   - GREEN WITHOUT DISCRIMINATING, which is the worse half. Surviving that race meant weakening
///     the assertions to whatever holds against a registry someone else is writing: CONTAINMENT
///     instead of the exact order, a caching check SKIPPED whenever the generation moved, and an
///     early `return` whenever the shared registry happened to be full. A cache that served a
///     stale order, or dropped a format, could pass all three.
///
/// A test that constructs its own `FormatRegistry` can assert the exact order and the exact
/// allocation, unconditionally, because nothing else in the process can touch it. Production
/// behaviour is unchanged: `FORMAT_REGISTRY` below is the same single instance the whole engine
/// shared before, and a redundant concurrent rebuild remains sanctioned (see `order`).
pub(crate) struct FormatRegistry {
    /// `HashMap::new` is not `const`, so the map is lazily initialised rather than inlined —
    /// which is what lets `new` be `const` and the global be a plain `static`.
    shifts: OnceLock<RwLock<HashMap<String, u8>>>,
    /// Bumped by every writer of `shifts`; what tells a cached order it is stale.
    generation: AtomicU64,
    /// `(the generation the order was built at, the order)`. Starts at `u64::MAX` against
    /// `generation`'s 0, so the initial empty value never reads as fresh.
    order: OnceLock<RwLock<(u64, FormatOrder)>>,
}

impl FormatRegistry {
    pub(crate) const fn new() -> Self {
        Self { shifts: OnceLock::new(), generation: AtomicU64::new(0), order: OnceLock::new() }
    }

    fn shifts(&self) -> &RwLock<HashMap<String, u8>> {
        self.shifts.get_or_init(|| RwLock::new(HashMap::new()))
    }

    fn order_cell(&self) -> &RwLock<(u64, FormatOrder)> {
        self.order.get_or_init(|| RwLock::new((u64::MAX, Arc::new(Vec::new()))))
    }

    /// Mark the cached order stale. Called by every writer of `shifts`, after it releases the
    /// write lock -- never while holding it, so the two locks are never held at once in either order.
    fn invalidate(&self) {
        self.generation.fetch_add(1, AtomicOrdering::AcqRel);
    }

    /// Bit shift for a format already seen in loaded data; None matches nothing.
    fn shift(&self, format: &str) -> Option<u8> {
        self.shifts().read().ok()?.get(format).copied()
    }

    /// Bit shift for a format, assigning the next free slot if unseen (reload path).
    fn shift_or_assign(&self, format: &str) -> Option<u8> {
        if let Some(shift) = self.shift(format) {
            return Some(shift);
        }
        let mut shifts = self.shifts().write().ok()?;
        if let Some(&shift) = shifts.get(format) {
            return Some(shift); // assigned while we waited for the write lock
        }
        if shifts.len() >= MAX_FORMATS {
            return None;
        }
        let shift = (shifts.len() * 2) as u8;
        shifts.insert(format.to_string(), shift);
        drop(shifts);
        self.invalidate();
        Some(shift)
    }

    /// The registry's `(format, shift)` pairs, alphabetical, built once per registry change.
    ///
    /// `legality_bits_to_json` and its pydict twin are FIELD_TABLE extractors, so they run ONCE PER
    /// ROW. Each used to build this vector itself every time: a read lock, a clone of all 22 format
    /// names, and a sort, to decode a word that is a pure function of one `u64` and orders identically
    /// for every card in the store. A 175-card page of /cards/search -- which asks for `legalities` on
    /// every card object -- therefore paid 175 locks, 175 sorts and ~3,850 String allocations to
    /// produce 175 copies of one answer, inside a Durable Object against a metered CPU budget.
    ///
    /// The registry only grows, and only on import or archive attach, so the sorted form is cached and
    /// invalidated by generation rather than by lock discipline: a reader never blocks a writer, and a
    /// rebuild that races a write is DISCARDED rather than published, so a stale order cannot be
    /// served. Worst case is a redundant rebuild -- two readers that miss at the same generation
    /// build the same vector twice and the second publish wins. That is a wasted allocation and
    /// never a wrong answer, because both vectors hold the same pairs.
    fn order(&self) -> FormatOrder {
        let generation = self.generation.load(AtomicOrdering::Acquire);
        if let Ok(cached) = self.order_cell().read()
            && cached.0 == generation
        {
            return Arc::clone(&cached.1);
        }
        let mut entries: Vec<(String, u8)> = match self.shifts().read() {
            Ok(shifts) => shifts.iter().map(|(k, v)| (k.clone(), *v)).collect(),
            Err(_) => Vec::new(),
        };
        entries.sort();
        let built: FormatOrder = Arc::new(entries);
        if let Ok(mut slot) = self.order_cell().write() {
            // Only publish if the registry did not move while we were building it.
            if self.generation.load(AtomicOrdering::Acquire) == generation {
                *slot = (generation, Arc::clone(&built));
            }
        }
        built
    }

    /// Decode a packed legality word against this registry — see `legality_bits_to_json`.
    fn decode_to_json(&self, bits: u64) -> serde_json::Value {
        let mut out = serde_json::Map::new();
        for (format, shift) in self.order().iter() {
            let word = match (bits >> shift) & 0b11 {
                LEGALITY_LEGAL => "legal",
                LEGALITY_RESTRICTED => "restricted",
                LEGALITY_BANNED => "banned",
                _ => "not_legal",
            };
            out.insert(format.clone(), serde_json::Value::from(word));
        }
        serde_json::Value::Object(out)
    }

    /// Adopt an archive's format→shift assignments — see `sync_format_shifts`.
    ///
    /// STALENESS IS A CONTENT QUESTION, NOT A COUNT ONE. The trigger used to be
    /// `registry.len() < archive.len()`, which asks only "does the archive name MORE formats than
    /// I do". On a name-keyed map that misses every change that keeps the cardinality:
    ///
    ///   * a RENAME, which this corpus has actually seen — Scryfall renamed `brawl` to
    ///     `standardbrawl` and `historicbrawl` to `brawl` in one pass;
    ///   * one format retired and another added in the same dump.
    ///
    /// Shifts are handed out in first-seen order over an object whose keys arrive sorted, so
    /// either shape re-slots every alphabetically-later format by one. A registry that declines to
    /// adopt the new map then reads every card's legality word at its NEIGHBOUR's two bits, and
    /// binds `legality:`/`banned:`/`restricted:` to the same wrong pair. Nothing errors: the words
    /// still decode, to the wrong statuses, on a `/cards/*` body this port caches for 16 hours.
    ///
    /// It cannot bite the store as built TODAY — every Scryfall card carries the full `legalities`
    /// object, so the first row of any build assigns all 22 formats in the same sorted order and
    /// two archives of the same vocabulary carry identical maps. That is a property of Scryfall's
    /// output, not of this function, and it is not the one the caller depends on.
    fn sync(&self, archived: &Archived<HashMap<String, u8>>) {
        // The common path is one read lock and ~22 lookups: no write, no invalidation. A poisoned
        // lock reads as "agrees" and does nothing, exactly as the count check's `unwrap_or(false)`
        // did.
        let agrees = self
            .shifts()
            .read()
            .map(|m| archived.iter().all(|(format, shift)| m.get(format.as_str()) == Some(shift)))
            .unwrap_or(true);
        if agrees {
            return;
        }
        if let Ok(mut shifts) = self.shifts().write() {
            // Inserting the archive's pairs is not enough once same-count changes are visible,
            // because a retired name STILL HOLDS ITS SLOT: merge `{a:0, b:2, d:4}` over
            // `{a:0, b:2, c:4}` and `order()` emits both `c` and `d` at bits 4-5, so the name that
            // no longer exists reports the new one's status on every card. Drop exactly the
            // entries this archive contradicts — a slot it hands to a DIFFERENT name — and leave
            // every slot it never mentions alone, so a format assigned by an import running in
            // this process and absent from this archive survives the sync.
            let owner_of: HashMap<u8, &str> =
                archived.iter().map(|(format, shift)| (*shift, format.as_str())).collect();
            shifts.retain(|name, shift| match owner_of.get(&*shift) {
                Some(owner) => *owner == name.as_str(),
                None => true,
            });
            for (format, shift) in archived.iter() {
                shifts.insert(format.as_str().to_string(), *shift);
            }
        }
        self.invalidate();
    }
}

/// The process-global registry: one bit layout per process, shared by the import path, the archive
/// attach, the filter binder and every card object built. Bit assignments stay stable across
/// reloads and engine instances because this is the only instance any of them consult.
///
/// Comments in `lib.rs`, `core_api.rs` and `engine/builder/tests/legality_without_a_filter.rs`
/// call this registry FORMAT_SHIFTS, which is what the map alone used to be called when it was a
/// static of its own; `format_shifts()` below is still the accessor they mean.
static FORMAT_REGISTRY: FormatRegistry = FormatRegistry::new();

pub(crate) fn format_shifts() -> &'static RwLock<HashMap<String, u8>> {
    FORMAT_REGISTRY.shifts()
}

/// Bit shift for a format already seen in loaded data; None matches nothing.
pub(crate) fn format_shift(format: &str) -> Option<u8> {
    FORMAT_REGISTRY.shift(format)
}

/// Bit shift for a format, assigning the next free slot if unseen (reload path).
pub(crate) fn format_shift_or_assign(format: &str) -> Option<u8> {
    FORMAT_REGISTRY.shift_or_assign(format)
}

pub(crate) fn legality_code(status: &str) -> u64 {
    match status {
        "legal"      => LEGALITY_LEGAL,
        "restricted" => LEGALITY_RESTRICTED,
        "banned"     => LEGALITY_BANNED,
        _            => LEGALITY_NOT_LEGAL,
    }
}

#[cfg(feature = "python")]
pub(crate) fn jsonb_obj_to_legality_bits(d: &Bound<PyDict>, key: &str) -> u64 {
    d.get_item(key)
        .ok()
        .flatten()
        .and_then(|v| {
            v.cast::<PyDict>().ok().map(|m| {
                m.iter()
                    .filter_map(|(k, v)| {
                        let format = k.extract::<String>().ok()?;
                        let status = v.extract::<String>().ok()?;
                        let shift = format_shift_or_assign(&format)?;
                        Some(legality_code(&status) << shift)
                    })
                    .fold(0u64, |bits, b| bits | b)
            })
        })
        .unwrap_or_default()
}

/// Decode a packed legality word into a `{format: status}` Python dict covering every
/// format the registry knows, alphabetically — the field-extraction counterpart of
/// `jsonb_obj_to_legality_bits`. A format absent from the imported JSONB round-trips
/// as "not_legal", exactly as the encoder treated it.
// LOCAL PATCH (Cloudflare port): gated, because this workspace builds card_engine WITHOUT pyo3 for
// wasm32 and `Python`/`PyDict` do not exist there. Upstream has no `python` feature and its
// FIELD_TABLE — the only caller — is ungated, so this attribute belongs here and NOT upstream:
// there the cfg would be false, delete the function, and break the build. Same treatment as
// FIELD_TABLE and jsonb_obj_to_legality_bits, whose live twin is legality_bits_to_json below.
#[cfg(feature = "python")]
pub(crate) fn legality_bits_to_pydict<'a>(py: Python<'a>, bits: u64) -> PyResult<pyo3::Bound<'a, PyDict>> {
    let dict = PyDict::new(py);
    if let Ok(shifts) = format_shifts().read() {
        let mut entries: Vec<(String, u8)> = shifts.iter().map(|(k, v)| (k.clone(), *v)).collect();
        entries.sort();
        for (format, shift) in entries {
            let word = match (bits >> shift) & 0b11 {
                LEGALITY_LEGAL => "legal",
                LEGALITY_RESTRICTED => "restricted",
                LEGALITY_BANNED => "banned",
                _ => "not_legal",
            };
            dict.set_item(format, word)?;
        }
    }
    Ok(dict)
}

/// LOCAL PATCH (Cloudflare port): the JSON twin of `legality_bits_to_pydict`, for the wasm path.
///
/// `core_api.rs`'s mirror discipline in one function: FIELD_TABLE is pyo3-gated and therefore not
/// compiled here, so JSON_FIELD_TABLE is the live table and needs a decoder that speaks
/// `serde_json`. Same registry, same alphabetical order, same "absent format reads not_legal"
/// rule as the pydict version above — they must agree word-for-word or the two builds answer
/// `fields=legalities` differently.
pub(crate) fn legality_bits_to_json(bits: u64) -> serde_json::Value {
    FORMAT_REGISTRY.decode_to_json(bits)
}

/// Adopt the archive's format→shift assignments into this process's registry.
/// Cheap no-op (one read lock) once the registry has caught up.
pub(crate) fn sync_format_shifts(archived: &Archived<HashMap<String, u8>>) {
    FORMAT_REGISTRY.sync(archived);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A registry this test OWNS. Nothing else in the process can write it, so every assertion
    /// below is exact and unconditional -- see `FormatRegistry` for what reading the global one
    /// cost, and note that none of these tests touch `FORMAT_REGISTRY` at all.
    fn registry_of(formats: &[&str]) -> FormatRegistry {
        let registry = FormatRegistry::new();
        for (i, name) in formats.iter().enumerate() {
            assert_eq!(registry.shift_or_assign(name), Some((i * 2) as u8), "{name} must take the next free slot");
        }
        registry
    }

    fn pairs(order: &FormatOrder) -> Vec<(&str, u8)> {
        order.iter().map(|(name, shift)| (name.as_str(), *shift)).collect()
    }

    /// The archive side of `sync`, built the way a store carries it: `CardData::format_shifts` is
    /// a `HashMap<String, u8>`, so this serializes exactly that type and hands back the buffer for
    /// the caller to `access`.
    fn archived_shifts(pairs: &[(&str, u8)]) -> rkyv::util::AlignedVec {
        let map: HashMap<String, u8> = pairs.iter().map(|(k, v)| ((*k).to_owned(), *v)).collect();
        rkyv::to_bytes::<rkyv::rancor::Error>(&map).expect("serialize format shifts")
    }

    /// A registry's pairs, alphabetical — `order()`'s content in the shape the assertions read.
    fn registry_pairs(registry: &FormatRegistry) -> Vec<(String, u8)> {
        registry.order().iter().cloned().collect()
    }

    /// STALENESS IS CONTENT, NOT CARDINALITY. Two maps of the same SIZE can disagree about which
    /// format owns which two bits, and a registry that answers "am I behind?" by comparing counts
    /// says no to every one of them.
    ///
    /// The fixture is the shape that has actually happened to this corpus: a RENAME. Scryfall
    /// renamed `brawl` to `standardbrawl`; the count is identical before and after, and the slot
    /// the old name held is handed to the new one.
    #[test]
    fn a_same_count_archive_still_syncs() {
        let registry = registry_of(&["brawl", "commander", "modern"]);
        assert_eq!(registry_pairs(&registry), [("brawl".to_owned(), 0), ("commander".to_owned(), 2), ("modern".to_owned(), 4)]);

        // Same three slots, one different NAME on the first. The count check saw `3 < 3` and
        // returned, leaving `brawl` owning bits 0-1 for the life of the process.
        let bytes = archived_shifts(&[("standardbrawl", 0), ("commander", 2), ("modern", 4)]);
        let archived = rkyv::access::<Archived<HashMap<String, u8>>, rkyv::rancor::Error>(&bytes).expect("access");
        assert_eq!(archived.len(), 3, "the fixture is only interesting because the counts MATCH");
        registry.sync(archived);

        assert_eq!(registry.shift("standardbrawl"), Some(0), "the archive's name must become bindable");
        assert_eq!(
            registry.shift("brawl"),
            None,
            "the retired name must not keep the slot — it would report standardbrawl's status on every card"
        );
        assert_eq!(
            registry_pairs(&registry),
            [("commander".to_owned(), 2), ("modern".to_owned(), 4), ("standardbrawl".to_owned(), 0)]
        );

        // What the caller actually reads: one name at bits 0-1, and it is the archive's.
        let decoded = registry.decode_to_json(LEGALITY_BANNED);
        assert_eq!(decoded.get("standardbrawl").and_then(serde_json::Value::as_str), Some("banned"));
        assert!(decoded.get("brawl").is_none(), "a name the archive dropped must not appear in `legalities` at all");
    }

    /// A slot the archive never mentions belongs to whoever holds it. An import running in this
    /// process assigns formats through `shift_or_assign` against the same registry, and dropping
    /// those on every archive attach would un-assign a format mid-import.
    ///
    /// Also the growth case in one: an archive that is a strict SUPERSET still extends, which is
    /// the only thing the old count check could see and must keep working.
    #[test]
    fn sync_keeps_slots_the_archive_does_not_claim_and_still_extends() {
        let registry = registry_of(&["commander", "modern", "import_only"]); // 0, 2, 4

        // The archive knows `commander` and `modern`, has never heard of `import_only`, and adds
        // `alchemy` at a slot nobody holds.
        let bytes = archived_shifts(&[("commander", 0), ("modern", 2), ("alchemy", 6)]);
        let archived = rkyv::access::<Archived<HashMap<String, u8>>, rkyv::rancor::Error>(&bytes).expect("access");
        registry.sync(archived);

        assert_eq!(registry.shift("import_only"), Some(4), "a slot the archive is silent about is left alone");
        assert_eq!(registry.shift("alchemy"), Some(6), "and a format only the archive knows is adopted");
        assert_eq!(
            registry_pairs(&registry),
            [
                ("alchemy".to_owned(), 6),
                ("commander".to_owned(), 0),
                ("import_only".to_owned(), 4),
                ("modern".to_owned(), 2)
            ]
        );
    }

    /// The common path stays a pure read. `sync` runs on EVERY query (`bind_and_split_filter_value`
    /// calls it before `build_filter`), so an agreeing archive must not take the write lock or bump
    /// the generation — that would discard the cached order on every request and reintroduce the
    /// per-row rebuild `order()` exists to avoid.
    #[test]
    fn an_agreeing_archive_does_not_touch_the_registry() {
        let registry = registry_of(&["commander", "modern"]);
        let before = registry.order();

        // Exactly the registry's pairs, and then a SUBSET of them — neither is news.
        for pairs in [&[("commander", 0u8), ("modern", 2)][..], &[("modern", 2)][..]] {
            let bytes = archived_shifts(pairs);
            let archived = rkyv::access::<Archived<HashMap<String, u8>>, rkyv::rancor::Error>(&bytes).expect("access");
            registry.sync(archived);
            assert!(Arc::ptr_eq(&before, &registry.order()), "an agreeing sync must not invalidate the cached order");
        }
    }

    /// The cached order must follow the registry, or a format assigned after the first decode
    /// would be missing from every `legalities` value for the life of the process.
    #[test]
    fn format_order_follows_the_registry() {
        assert!(FormatRegistry::new().order().is_empty(), "an untouched registry orders nothing");

        // Shifts are handed out in INSERTION order and the cached order is ALPHABETICAL, so these
        // three disagree on purpose: an order that carried positions instead of stored shifts, or
        // that skipped the sort, produces a different vector here rather than the same one.
        let registry = registry_of(&["standard", "modern", "commander"]);
        let before = registry.order();
        assert_eq!(pairs(&before), [("commander", 4), ("modern", 2), ("standard", 0)]);

        // The caching itself: two calls with no writer between them reuse the ALLOCATION, not
        // merely the value.
        assert!(Arc::ptr_eq(&registry.order(), &registry.order()), "an unchanged registry must not rebuild");

        // ...and an assignment invalidates it. `alchemy` sorts FIRST, so an order that failed to
        // notice the write is not just short by one — it is wrong from index 0 onward, and every
        // format's word would be read at its neighbour's name.
        assert_eq!(registry.shift_or_assign("alchemy"), Some(6));
        let after = registry.order();
        assert_eq!(pairs(&after), [("alchemy", 6), ("commander", 4), ("modern", 2), ("standard", 0)]);
        assert!(!Arc::ptr_eq(&before, &after), "the pre-assignment allocation must not be served again");
    }

    /// `MAX_FORMATS` is the whole `u64` at 2 bits each, and refusing the 33rd format is what keeps
    /// a shift from running off the end of the word.
    ///
    /// Both tests here used to carry an "already full, nothing to assert" early return, because
    /// against the shared global registry a full registry was a state they could arrive in without
    /// having caused it. On an owned registry the cap is reached deliberately instead, so the
    /// branch is asserted rather than escaped.
    #[test]
    fn the_registry_refuses_a_format_past_max_formats() {
        let names: Vec<String> = (0..MAX_FORMATS).map(|i| format!("f{i:02}")).collect();
        let registry = registry_of(&names.iter().map(String::as_str).collect::<Vec<_>>());

        assert_eq!(registry.shift_or_assign("one_too_many"), None, "the 33rd format has no bits left");
        assert_eq!(registry.shift("one_too_many"), None, "a refused format must not become readable either");
        assert_eq!(registry.order().len(), MAX_FORMATS);
        // The last slot's word still fits in the u64 it is read out of.
        assert_eq!(registry.shift(&names[MAX_FORMATS - 1]), Some(62));
    }

    /// The decode itself is unchanged by the caching: same words, same "absent reads not_legal".
    ///
    /// TWO formats, because the shift is what a decode gets wrong and a single probe lands at
    /// shift 0 on a fresh registry — where reading `bits & 0b11` regardless of shift is right by
    /// accident. The second format is read at 2, and the first must stay `not_legal` throughout.
    #[test]
    fn decoding_still_reads_each_two_bit_word() {
        let registry = registry_of(&["aaa_untouched", "zzz_probe"]);
        let shift = registry.shift("zzz_probe").expect("just assigned");

        for (code, want) in
            [(LEGALITY_LEGAL, "legal"), (LEGALITY_RESTRICTED, "restricted"), (LEGALITY_BANNED, "banned"), (LEGALITY_NOT_LEGAL, "not_legal")]
        {
            let decoded = registry.decode_to_json(code << shift);
            assert_eq!(decoded.get("zzz_probe").and_then(serde_json::Value::as_str), Some(want));
            assert_eq!(
                decoded.get("aaa_untouched").and_then(serde_json::Value::as_str),
                Some("not_legal"),
                "a format the word says nothing about must not pick up its neighbour's status"
            );
        }
    }
}
