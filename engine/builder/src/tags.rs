//! Oracle + art tag import.
//!
//! Port of `vendor/sylvan_librarian/api/tag_import.py`. Tags come from the same
//! Scryfall `/bulk-data` endpoint as the cards, dump types `oracle_tags` and
//! `art_tags` (`BulkDataKey.ORACLE_TAGS` / `ART_TAGS`): gzipped JSONL, one tag
//! object per line, shape `{id, slug, parent_ids: [...], taggings: [{oracle_id}
//! | {illustration_id}, ...]}`.
//!
//! Upstream flow (import_oracle_tags / import_art_tags, lines 144-217):
//! - `_build_uuid_to_slug`: tag UUID → slug.
//! - `_build_all_ancestors`: slug → every ancestor slug, transitively. A search
//!   for a parent tag must match cards tagged with any descendant, achieved by
//!   denormalizing all ancestor slugs onto each card at import time.
//! - For each tag and each of its taggings, attach `{slug: true}` plus every
//!   ancestor slug to the tagging's `oracle_id` (oracle tags) or
//!   `illustration_id` (art tags).
//! - `_sync_card_tags` then writes those objects into
//!   `magic.cards.card_oracle_tags` (matched on the row's `oracle_id` column)
//!   and `card_art_tags` (matched on `illustration_id`); rows without an entry
//!   get `{}`. In this pipeline the "write" happens in `transform::finalize`.
//!
//! Memory shape: the real dumps carry ~700k taggings (~59MB of JSONL), and the
//! wasm import folds them inside a 112MB linear-memory cap shared with the
//! aggregation and finalize phases. Two consequences drive this module's API:
//! - **Streaming**: [`TagAccumulator`] consumes one record at a time and keeps
//!   only compact folded state (uuid→slug, parent links, id→slug-index lists).
//!   Buffering the records themselves — even pruned to the read fields — costs
//!   hundreds of bytes per tagging and blew the wasm heap on real data.
//! - **Interning**: [`TagData`] stores each slug string once in a shared table
//!   and per-id lists as `u32` indices. The expanded (ancestor-denormalized)
//!   maps are ~1.4M id→slug pairs; duplicated `String`s would cost ~50MB where
//!   indices cost ~12MB.
//!
//! Not ported: `_sync_hierarchy` (the `oracle_tags` / `art_tag_relationships`
//! Postgres tables). They back SQL-side tag expansion; the engine consumes only
//! the denormalized per-card tag objects (`card_from_pydict` reads
//! `card_oracle_tags` / `card_art_tags`), which this module produces.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

// The dump download is native-only (reqwest); the accumulator below it is
// shared with the wasm import, which feeds records over its ABI instead.
#[cfg(not(target_arch = "wasm32"))]
use crate::bulk::{ART_TAGS, BulkClient, BulkError, ORACLE_TAGS};

/// Which id field a dump's taggings are keyed by.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TagKind {
    /// `oracle_tags` dump: taggings carry `oracle_id`, lands in [`TagData::oracle`].
    Oracle,
    /// `art_tags` dump: taggings carry `illustration_id`, lands in [`TagData::art`].
    Art,
}

/// Denormalized tag assignments, ready for `transform::finalize`.
///
/// Slugs are interned: `oracle` / `art` values index into `slugs`, and each
/// per-id list is sorted by slug text and deduped (JSONB object key order is
/// irrelevant to the engine — `jsonb_obj_to_ids` sorts and dedupes — sorted
/// keeps output stable). Serde derives: the wasm import snapshots TagData
/// across Durable Object evictions (tags_export / tags_restore in
/// engine/wasm-import); the private lookup index is rebuilt on demand.
#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
pub struct TagData {
    /// Shared slug table; the maps' values index into it.
    pub slugs: Vec<String>,
    /// oracle_id → slug indices (incl. ancestors) for `card_oracle_tags`.
    pub oracle: HashMap<String, Vec<u32>>,
    /// illustration_id → slug indices (incl. ancestors) for `card_art_tags`.
    pub art: HashMap<String, Vec<u32>>,
    /// Slugified alias → the canonical slug it stands for, from the oracle dump.
    ///
    /// THIS PORT DIVERGES FROM UPSTREAM HERE, deliberately. Upstream #914 resolves aliases at
    /// import by stamping them as extra keys next to the slug and its ancestors, so query time
    /// stays a dumb exact match. That is the right trade on Postgres and the wrong one here: the
    /// keys cost 6,252,880 bytes in the archive (measured — two builds off the same dumps, alias
    /// stamping on and off), which pushed the store from 74.8MB to 81.1MB and across the 25MB
    /// chunk grid from 3 KV values to 4. Every cold load then pays a fourth serialized read; the
    /// production median went 337ms to 691ms.
    ///
    /// An alias key carries no information the slug key does not. `slug_to_aliases` attaches
    /// alias `a` to slug `s`, and `finish_into` pushes `a` under exactly the condition it pushes
    /// `s` — `s` in the visited set. So `art:flames` and `art:fire` select the identical rows by
    /// construction, and the 1,024,204 stamped entries are pure duplication of a 2,150-entry map.
    ///
    /// Resolving at query time instead costs ~51KB carried once. See src/parser/tag-aliases.gen.ts
    /// for the generated map and getArtTagsComparisonKeys for the resolution.
    pub oracle_aliases: HashMap<String, String>,
    /// The same, from the art dump. Kept separate because the two dumps are separate namespaces:
    /// nothing guarantees an art alias means anything in oracle space, and merging them would let
    /// one dump's spelling silently answer for the other's.
    pub art_aliases: HashMap<String, String>,
    /// slug → index, lazily (re)built by `intern` — not part of the snapshot.
    #[serde(skip)]
    index: HashMap<String, u32>,
}

impl TagData {
    /// Index of `slug` in the shared table, adding it if new.
    pub fn intern(&mut self, slug: &str) -> u32 {
        if self.index.len() != self.slugs.len() {
            // Deserialized snapshot: the skipped index is stale — rebuild.
            self.index = self.slugs.iter().enumerate().map(|(i, s)| (s.clone(), i as u32)).collect();
        }
        if let Some(&i) = self.index.get(slug) {
            return i;
        }
        let i = self.slugs.len() as u32;
        self.slugs.push(slug.to_owned());
        self.index.insert(slug.to_owned(), i);
        i
    }

    /// Slug strings for a per-id index list, in stored (sorted) order.
    /// Out-of-range indices (corrupt snapshot) are dropped rather than panicking.
    pub fn resolve(&self, idxs: &[u32]) -> Vec<&str> {
        idxs.iter().filter_map(|&i| self.slugs.get(i as usize).map(String::as_str)).collect()
    }

    /// Build from plain id → slug-list maps (tests, memprobe's tags.json).
    pub fn from_slug_maps(oracle: HashMap<String, Vec<String>>, art: HashMap<String, Vec<String>>) -> TagData {
        let mut data = TagData::default();
        let mut convert = |m: HashMap<String, Vec<String>>| -> HashMap<String, Vec<u32>> {
            m.into_iter()
                .map(|(id, mut slugs)| {
                    slugs.sort_unstable();
                    slugs.dedup();
                    (id, slugs.iter().map(|s| data.intern(s)).collect())
                })
                .collect()
        };
        let oracle = convert(oracle);
        let art = convert(art);
        data.oracle = oracle;
        data.art = art;
        data
    }
}

/// Normalize a written tag spelling to the slug form tags are stored under.
///
/// The twin of `slugify_tag` in api/parsing/card_query_nodes.py (ported to src/parser as
/// `slugifyTag`). Both sides must agree exactly: the import stores alias keys through this, and the
/// query side normalizes the search term through it, so a disagreement means `art:"open mouth"`
/// silently finds nothing.
///
/// A hand loop rather than a regex, to keep the `regex` crate out of the builder.
fn slugify_tag(val: &str) -> String {
    let mut out = String::with_capacity(val.len());
    let mut pending_hyphen = false;
    for ch in val.trim().chars() {
        let lowered = ch.to_ascii_lowercase();
        if lowered.is_ascii_alphanumeric() {
            if pending_hyphen && !out.is_empty() {
                out.push('-');
            }
            pending_hyphen = false;
            out.push(lowered);
        } else {
            // Runs of non-alphanumerics fold to ONE hyphen, and leading/trailing runs to none —
            // Python's re.sub(r"[^a-z0-9]+", "-", ...).strip("-").
            pending_hyphen = true;
        }
    }
    out
}

/// The fields the import reads from one tag-dump record. Typed (rather than
/// `serde_json::Value`) so parsing a line allocates only these strings —
/// unknown fields (label, description, taggings' annotation/weight…) are
/// skipped without allocating. `aliases` moved out of that list with upstream
/// #914, which made them searchable keys.
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct TagRecord {
    id: Option<String>,
    slug: Option<String>,
    parent_ids: Vec<String>,
    /// Alternate spellings Scryfall's tagger resolves to the tag before matching -- which is why
    /// `art:flames` finds the `fire` tag there (upstream #914).
    aliases: Vec<String>,
    taggings: Vec<TagTagging>,
}

#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct TagTagging {
    oracle_id: Option<String>,
    illustration_id: Option<String>,
}

impl TagRecord {
    /// Lenient extraction matching the historical `Value`-based reading: any
    /// field of the wrong type reads as absent instead of failing the record.
    fn from_value(v: &Value) -> TagRecord {
        let tag_str = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).map(str::to_string);
        TagRecord {
            id: tag_str(v, "id"),
            slug: tag_str(v, "slug"),
            parent_ids: v
                .get("parent_ids")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default(),
            aliases: v
                .get("aliases")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default(),
            taggings: v
                .get("taggings")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .map(|t| TagTagging {
                            oracle_id: tag_str(t, "oracle_id"),
                            illustration_id: tag_str(t, "illustration_id"),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        }
    }
}

/// Streaming fold of one dump's records into compact intermediate state;
/// [`finish_into`](Self::finish_into) resolves ancestors and produces the
/// dump's map in a [`TagData`]. Records never accumulate — only the folded
/// maps grow.
#[derive(Default)]
pub struct TagAccumulator {
    /// `_build_uuid_to_slug` (tag_import.py lines 22-23), last record wins.
    uuid_to_slug: HashMap<String, String>,
    /// tag uuid → raw parent uuids. Kept unresolved until finish because a
    /// parent may reference a record later in the dump (upstream resolves
    /// against the complete uuid→slug map).
    parent_uuids: HashMap<String, Vec<String>>,
    /// Local slug interner for the folded tagging lists.
    slugs: Vec<String>,
    slug_index: HashMap<String, u32>,
    /// tagged id → direct (record) slug indices; deduped at finish.
    oracle: HashMap<String, Vec<u32>>,
    art: HashMap<String, Vec<u32>>,
    /// slugified alias → the slugs claiming it. Resolved at finish, because an alias that lands on
    /// a real slug or that two tags both claim is ambiguous and gets dropped (upstream #914's
    /// `_build_slug_to_aliases`); neither can be decided until the whole dump is seen.
    alias_claimants: HashMap<String, HashSet<String>>,
    /// Every slug this dump declared, for the "alias collides with a real slug" test.
    declared_slugs: HashSet<String>,
}

impl TagAccumulator {
    fn intern_local(&mut self, slug: &str) -> u32 {
        if let Some(&i) = self.slug_index.get(slug) {
            return i;
        }
        let i = self.slugs.len() as u32;
        self.slugs.push(slug.to_owned());
        self.slug_index.insert(slug.to_owned(), i);
        i
    }

    /// One JSONL line. Returns false for junk lines (unparseable or not an
    /// object), which are skipped — same posture as the bulk card stream.
    pub fn add_line(&mut self, line: &[u8]) -> bool {
        // Fast path: typed parse, no Value materialization. Any type mismatch
        // (non-string id, numeric parent id, …) falls back to the lenient
        // per-field extraction so odd-but-parseable records keep the exact
        // historical semantics instead of being dropped wholesale.
        match serde_json::from_slice::<TagRecord>(line) {
            Ok(rec) => {
                self.fold(rec);
                true
            }
            Err(_) => match serde_json::from_slice::<Value>(line) {
                Ok(v @ Value::Object(_)) => {
                    self.fold(TagRecord::from_value(&v));
                    true
                }
                _ => false,
            },
        }
    }

    /// One already-parsed record (the native download path).
    pub fn add_value(&mut self, v: &Value) -> bool {
        if !v.is_object() {
            return false;
        }
        self.fold(TagRecord::from_value(v));
        true
    }

    fn fold(&mut self, rec: TagRecord) {
        let TagRecord { id, slug, parent_ids, aliases, taggings } = rec;
        if let (Some(id), Some(slug)) = (id, slug.as_ref()) {
            self.uuid_to_slug.insert(id.clone(), slug.clone());
            self.parent_uuids.insert(id, parent_ids);
        }
        if let Some(slug) = slug.as_ref() {
            self.declared_slugs.insert(slug.clone());
            for alias in &aliases {
                // Slugified on the way in, because half the art aliases are written with spaces
                // ("open mouth" for `loose-lips`) and the query side slugifies the search term the
                // same way — both spellings have to reach the same stored key.
                let slugified = slugify_tag(alias);
                if !slugified.is_empty() {
                    self.alias_claimants.entry(slugified).or_default().insert(slug.clone());
                }
            }
        }
        // Upstream indexes tag["slug"] directly in the tagging loop (KeyError
        // aborts); a tag without a slug never occurs in the dumps, and skipping
        // matches the uuid_to_slug treatment of such a record everywhere else.
        let Some(slug) = slug else { return };
        if taggings.is_empty() {
            return;
        }
        let si = self.intern_local(&slug);
        for t in taggings {
            // upstream: `if oid:` — falsy (empty) ids are skipped
            if let Some(oid) = t.oracle_id
                && !oid.is_empty()
            {
                self.oracle.entry(oid).or_default().push(si);
            }
            if let Some(ill) = t.illustration_id
                && !ill.is_empty()
            {
                self.art.entry(ill).or_default().push(si);
            }
        }
    }

    /// Resolve ancestors and write this dump's map into `data`, replacing
    /// `data.oracle` (kind Oracle) or `data.art` (kind Art). Mirrors
    /// `_build_all_ancestors` (lines 26-56) + the tagging attach loop
    /// (lines 155-164 / 193-202): each tagged id gets the tag's own slug plus
    /// every ancestor slug, transitively, BFS with a visited set so cycles
    /// terminate and a tag is never its own ancestor. Parents whose UUID has
    /// no known slug are skipped, and a duplicated slug's parent set follows
    /// upstream's dict-overwrite (last record wins).
    pub fn finish_into(mut self, kind: TagKind, data: &mut TagData) {
        // Parent uuids → local slug indices, now that uuid_to_slug is complete.
        let parent_uuids = std::mem::take(&mut self.parent_uuids);
        let mut slug_parents: HashMap<u32, Vec<u32>> = HashMap::new();
        for (id, puuids) in &parent_uuids {
            let Some(slug) = self.uuid_to_slug.get(id).cloned() else { continue };
            let si = self.intern_local(&slug);
            let pslugs: Vec<String> = puuids.iter().filter_map(|p| self.uuid_to_slug.get(p).cloned()).collect();
            let parents: Vec<u32> = pslugs.iter().map(|ps| self.intern_local(ps)).collect();
            slug_parents.insert(si, parents);
        }

        // Aliases, resolved now that the whole dump is known. An alias that lands on a real slug,
        // or that two tags both claim, is ambiguous and is dropped rather than guessed at — the
        // slug always wins. Neither dump contains one today, so this guards upstream data changing.
        //
        // Recorded as alias → slug for the query side to resolve through, rather than stamped onto
        // the expanded lists below the way upstream does it. See TagData::oracle_aliases.
        //
        // Scoped so the &mut borrow of `data` ends before `data.intern` is called below.
        {
            let aliases = match kind {
                TagKind::Oracle => &mut data.oracle_aliases,
                TagKind::Art => &mut data.art_aliases,
            };
            // finish_into REPLACES this dump's half of `data`, so a second run over the same
            // TagData must not inherit the first run's aliases.
            aliases.clear();
            let mut dropped = 0usize;
            for (alias, claimants) in &self.alias_claimants {
                if self.declared_slugs.contains(alias) || claimants.len() > 1 {
                    dropped += 1;
                    continue;
                }
                if let Some(owner) = claimants.iter().next() {
                    aliases.insert(alias.clone(), owner.clone());
                }
            }
            if dropped > 0 {
                eprintln!("tags: dropping {dropped} ambiguous alias(es)");
            }
        }

        // Per local slug: {self} ∪ ancestors, as indices into `data.slugs`.
        let data_idx: Vec<u32> = self.slugs.iter().map(|s| data.intern(s)).collect();
        let mut expanded: Vec<Vec<u32>> = Vec::with_capacity(self.slugs.len());
        for si in 0..self.slugs.len() as u32 {
            let mut out = vec![data_idx[si as usize]];
            let mut visited: HashSet<u32> = HashSet::from([si]);
            let mut queue: Vec<u32> = slug_parents.get(&si).cloned().unwrap_or_default();
            while let Some(current) = queue.pop() {
                if !visited.insert(current) {
                    continue;
                }
                out.push(data_idx[current as usize]);
                if let Some(parents) = slug_parents.get(&current) {
                    queue.extend(parents.iter().copied().filter(|p| !visited.contains(p)));
                }
            }
            // No alias keys are stamped here — see TagData::oracle_aliases for why this port
            // resolves them at query time instead. Upstream pushes them onto every visited slug at
            // this point, which is what makes them ride along on the ancestors; the query-side map
            // gets the same reach for free, because resolving `flames` to `fire` happens before the
            // stored `fire` key (already denormalized onto descendants above) is matched.
            expanded.push(out);
        }

        let direct = match kind {
            TagKind::Oracle => std::mem::take(&mut self.oracle),
            TagKind::Art => std::mem::take(&mut self.art),
        };
        let mut built: HashMap<String, Vec<u32>> = HashMap::with_capacity(direct.len());
        let mut scratch: HashSet<u32> = HashSet::new();
        for (id, sis) in direct {
            scratch.clear();
            for si in sis {
                scratch.extend(expanded[si as usize].iter().copied());
            }
            let mut v: Vec<u32> = scratch.iter().copied().collect();
            v.sort_unstable_by(|&a, &b| data.slugs[a as usize].cmp(&data.slugs[b as usize]));
            built.insert(id, v);
        }
        match kind {
            TagKind::Oracle => data.oracle = built,
            TagKind::Art => data.art = built,
        }
    }
}

/// Download both tag dumps and build the assignment maps, streaming each
/// record through the accumulator (the dumps are never held in memory).
#[cfg(not(target_arch = "wasm32"))]
pub fn fetch_tag_data(client: &BulkClient) -> Result<TagData, BulkError> {
    let mut data = TagData::default();
    for (key, kind) in [(ORACLE_TAGS, TagKind::Oracle), (ART_TAGS, TagKind::Art)] {
        let mut acc = TagAccumulator::default();
        for rec in client.stream(key)? {
            acc.add_value(&rec?);
        }
        acc.finish_into(kind, &mut data);
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tag(id: &str, slug: &str, parent_ids: &[&str], taggings: Value) -> Value {
        json!({"id": id, "slug": slug, "parent_ids": parent_ids, "taggings": taggings})
    }

    fn tag_with_aliases(id: &str, slug: &str, parent_ids: &[&str], aliases: &[&str], taggings: Value) -> Value {
        json!({"id": id, "slug": slug, "parent_ids": parent_ids, "aliases": aliases, "taggings": taggings})
    }

    fn build(tags: &[Value], kind: TagKind) -> TagData {
        let mut acc = TagAccumulator::default();
        for t in tags {
            acc.add_line(t.to_string().as_bytes());
        }
        let mut data = TagData::default();
        acc.finish_into(kind, &mut data);
        data
    }

    fn slugs(data: &TagData, kind: TagKind, id: &str) -> Vec<String> {
        let map = match kind {
            TagKind::Oracle => &data.oracle,
            TagKind::Art => &data.art,
        };
        data.resolve(&map[id]).into_iter().map(str::to_string).collect()
    }

    #[test]
    fn taggings_map_to_ids_with_ancestors() {
        // removal → parent "interaction" → grandparent "gameplay".
        let tags = vec![
            tag("u1", "gameplay", &[], json!([])),
            tag("u2", "interaction", &["u1"], json!([])),
            tag("u3", "removal", &["u2"], json!([{"oracle_id": "o-1"}, {"oracle_id": "o-2"}])),
            tag("u4", "mana-dork", &[], json!([{"oracle_id": "o-2"}])),
        ];
        let data = build(&tags, TagKind::Oracle);
        assert_eq!(slugs(&data, TagKind::Oracle, "o-1"), vec!["gameplay", "interaction", "removal"]);
        assert_eq!(
            slugs(&data, TagKind::Oracle, "o-2"),
            vec!["gameplay", "interaction", "mana-dork", "removal"]
        );
    }

    #[test]
    fn art_tags_use_illustration_id_field() {
        let tags = vec![tag("u1", "squirrel", &[], json!([{"illustration_id": "ill-1"}, {"oracle_id": "o-9"}]))];
        let data = build(&tags, TagKind::Art);
        assert_eq!(data.art.len(), 1);
        assert_eq!(slugs(&data, TagKind::Art, "ill-1"), vec!["squirrel"]);
        // Taggings without the requested field land in the other map only.
        let data = build(&tags, TagKind::Oracle);
        assert!(data.oracle.contains_key("o-9"));
        assert!(!data.oracle.contains_key("ill-1"));
    }

    #[test]
    fn ancestor_cycle_terminates_and_excludes_self() {
        // a → b → a cycle: each gets the other as ancestor, never itself
        // (mirrors upstream's visited-set seeding with the slug itself).
        let tags = vec![
            tag("ua", "a", &["ub"], json!([{"oracle_id": "o-1"}])),
            tag("ub", "b", &["ua"], json!([])),
        ];
        let data = build(&tags, TagKind::Oracle);
        assert_eq!(slugs(&data, TagKind::Oracle, "o-1"), vec!["a", "b"]);
    }

    #[test]
    fn unknown_parent_ids_are_skipped() {
        let tags = vec![tag("u1", "child", &["missing-uuid"], json!([{"oracle_id": "o-1"}]))];
        let data = build(&tags, TagKind::Oracle);
        assert_eq!(slugs(&data, TagKind::Oracle, "o-1"), vec!["child"]);
    }

    #[test]
    fn empty_and_missing_ids_are_skipped() {
        let tags = vec![tag("u1", "t", &[], json!([{"oracle_id": ""}, {}, {"oracle_id": "o-1"}]))];
        let data = build(&tags, TagKind::Oracle);
        assert_eq!(data.oracle.len(), 1);
        assert!(data.oracle.contains_key("o-1"));
    }

    #[test]
    fn parent_defined_after_child_still_resolves() {
        // Streaming must not resolve parents early: the parent record appears
        // after the child that references it.
        let tags = vec![
            tag("u2", "child", &["u1"], json!([{"oracle_id": "o-1"}])),
            tag("u1", "parent", &[], json!([])),
        ];
        let data = build(&tags, TagKind::Oracle);
        assert_eq!(slugs(&data, TagKind::Oracle, "o-1"), vec!["child", "parent"]);
    }

    #[test]
    fn wrong_typed_fields_fall_back_to_lenient_extraction() {
        // Numeric id: the typed parse rejects it, the Value fallback reads it
        // as absent — taggings still attach via the record's slug.
        let mut acc = TagAccumulator::default();
        assert!(acc.add_line(br#"{"id": 7, "slug": "s", "parent_ids": [3], "taggings": [{"oracle_id": "o-1"}]}"#));
        let mut data = TagData::default();
        acc.finish_into(TagKind::Oracle, &mut data);
        assert_eq!(slugs(&data, TagKind::Oracle, "o-1"), vec!["s"]);
    }

    #[test]
    fn junk_lines_are_rejected() {
        let mut acc = TagAccumulator::default();
        assert!(!acc.add_line(b"not json"));
        assert!(!acc.add_line(b"[1, 2]"));
        assert!(!acc.add_line(b"\"string\""));
    }

    #[test]
    fn duplicate_taggings_dedupe_and_sort() {
        let tags = vec![
            tag("u1", "zebra", &[], json!([{"oracle_id": "o-1"}, {"oracle_id": "o-1"}])),
            tag("u2", "aardvark", &[], json!([{"oracle_id": "o-1"}])),
        ];
        let data = build(&tags, TagKind::Oracle);
        assert_eq!(slugs(&data, TagKind::Oracle, "o-1"), vec!["aardvark", "zebra"]);
    }

    #[test]
    fn snapshot_roundtrip_preserves_resolution() {
        let tags = vec![
            tag("u1", "parent", &[], json!([])),
            tag("u2", "child", &["u1"], json!([{"oracle_id": "o-1"}])),
        ];
        let data = build(&tags, TagKind::Oracle);
        let restored: TagData = serde_json::from_slice(&serde_json::to_vec(&data).unwrap()).unwrap();
        assert_eq!(slugs(&restored, TagKind::Oracle, "o-1"), vec!["child", "parent"]);
        // intern() on a restored snapshot rebuilds the skipped index instead
        // of duplicating existing slugs.
        let mut restored = restored;
        let before = restored.slugs.len();
        restored.intern("parent");
        assert_eq!(restored.slugs.len(), before);
    }
    #[test]
    fn aliases_are_recorded_as_a_map_and_never_stamped_as_keys() {
        // upstream #914: Scryfall's tagger resolves an alias to its tag before matching, which is
        // why `art:flames` finds the `fire` tag there. Upstream stamps `flames` next to `fire` on
        // every tagging; this port records the mapping once and resolves at query time instead
        // (see TagData::oracle_aliases). The stored keys must therefore stay canonical.
        let tags = vec![tag_with_aliases("u1", "fire", &[], &["flames"], json!([{"oracle_id": "o-1"}]))];
        let data = build(&tags, TagKind::Oracle);
        assert_eq!(slugs(&data, TagKind::Oracle, "o-1"), vec!["fire"], "alias must not be stamped");
        assert_eq!(data.oracle_aliases.get("flames").map(String::as_str), Some("fire"));
    }

    #[test]
    fn spaced_aliases_are_slugified_into_the_map() {
        // Half the art aliases are written with spaces. The query side slugifies the search term
        // the same way, so both spellings have to land on one map key — if those two functions
        // ever disagree, `art:"open mouth"` silently returns nothing.
        let tags = vec![tag_with_aliases("u1", "loose-lips", &[], &["Open Mouth"], json!([{"oracle_id": "o-1"}]))];
        let data = build(&tags, TagKind::Oracle);
        assert_eq!(slugs(&data, TagKind::Oracle, "o-1"), vec!["loose-lips"]);
        assert_eq!(data.oracle_aliases.get("open-mouth").map(String::as_str), Some("loose-lips"));
    }

    #[test]
    fn an_alias_of_an_ancestor_resolves_to_that_ancestor() {
        // Scryfall resolves the alias BEFORE expanding the hierarchy, so an alias of a PARENT has
        // to reach a card tagged only with the child. Upstream buys that by stamping the parent's
        // alias onto the child's taggings; here it falls out of the map for free, because the
        // ancestor slug is already denormalized onto the child and `flames` resolves to it.
        let tags = vec![
            tag_with_aliases("u1", "fire", &[], &["flames"], json!([])),
            tag("u2", "bolt", &["u1"], json!([{"oracle_id": "o-1"}])),
        ];
        let data = build(&tags, TagKind::Oracle);
        let stored = slugs(&data, TagKind::Oracle, "o-1");
        assert_eq!(stored, vec!["bolt", "fire"]);
        // The resolution the query side will perform, and the reach it buys: `flames` -> `fire`,
        // and `fire` is present on a card tagged only `bolt`.
        let resolved = data.oracle_aliases.get("flames").map(String::as_str).unwrap();
        assert_eq!(resolved, "fire");
        assert!(stored.iter().any(|s| s == resolved));
    }

    #[test]
    fn a_second_finish_into_replaces_rather_than_accumulates_aliases() {
        // finish_into replaces its half of TagData. The alias map has to follow that, or a
        // re-import would leave a retired alias resolving forever.
        let mut data = TagData::default();
        let first = vec![tag_with_aliases("u1", "fire", &[], &["flames"], json!([{"oracle_id": "o-1"}]))];
        let mut acc = TagAccumulator::default();
        for t in &first {
            acc.add_line(t.to_string().as_bytes());
        }
        acc.finish_into(TagKind::Oracle, &mut data);
        assert!(data.oracle_aliases.contains_key("flames"));

        let second = vec![tag_with_aliases("u1", "fire", &[], &["blaze"], json!([{"oracle_id": "o-1"}]))];
        let mut acc = TagAccumulator::default();
        for t in &second {
            acc.add_line(t.to_string().as_bytes());
        }
        acc.finish_into(TagKind::Oracle, &mut data);
        assert_eq!(data.oracle_aliases.get("blaze").map(String::as_str), Some("fire"));
        assert!(!data.oracle_aliases.contains_key("flames"), "retired alias must not survive");
    }

    #[test]
    fn the_two_dumps_keep_separate_alias_namespaces() {
        // An art spelling must not answer for an oracle one, and vice versa.
        let art = vec![tag_with_aliases("u1", "fire", &[], &["flames"], json!([{"illustration_id": "i-1"}]))];
        let mut data = TagData::default();
        let mut acc = TagAccumulator::default();
        for t in &art {
            acc.add_line(t.to_string().as_bytes());
        }
        acc.finish_into(TagKind::Art, &mut data);
        assert_eq!(data.art_aliases.get("flames").map(String::as_str), Some("fire"));
        assert!(data.oracle_aliases.is_empty());
    }

    #[test]
    fn an_alias_that_is_also_a_real_slug_is_dropped() {
        // Ambiguous: the slug always wins rather than the alias silently redirecting it.
        let tags = vec![
            tag_with_aliases("u1", "fire", &[], &["burn"], json!([{"oracle_id": "o-1"}])),
            tag("u2", "burn", &[], json!([{"oracle_id": "o-2"}])),
        ];
        let data = build(&tags, TagKind::Oracle);
        assert_eq!(slugs(&data, TagKind::Oracle, "o-1"), vec!["fire"], "alias dropped, not attached");
        assert_eq!(slugs(&data, TagKind::Oracle, "o-2"), vec!["burn"]);
    }

    #[test]
    fn an_alias_two_tags_both_claim_is_dropped() {
        let tags = vec![
            tag_with_aliases("u1", "fire", &[], &["hot"], json!([{"oracle_id": "o-1"}])),
            tag_with_aliases("u2", "lava", &[], &["hot"], json!([{"oracle_id": "o-2"}])),
        ];
        let data = build(&tags, TagKind::Oracle);
        assert_eq!(slugs(&data, TagKind::Oracle, "o-1"), vec!["fire"]);
        assert_eq!(slugs(&data, TagKind::Oracle, "o-2"), vec!["lava"]);
    }

    /// The slugifier exists three times — Python (upstream), TypeScript (src/parser) and here —
    /// and a disagreement between any two makes `art:"open mouth"` silently return nothing.
    ///
    /// So the cases are not hand-written here: they are GENERATED from the vendored Python by
    /// scripts/export-parser-fixtures.py, and tests/parser/tag-slugs.test.ts reads the same file.
    /// Upstream is the single source of truth, and a change there fails both ports at once.
    #[test]
    fn slugify_tag_matches_the_generated_python_expectations() {
        let raw = include_str!("../../../tests/parser/fixtures/tag-slugs.json");
        let cases: Vec<Value> = serde_json::from_str(raw).expect("tag-slugs fixture");
        assert!(!cases.is_empty(), "fixture is empty — did the exporter run?");
        for case in &cases {
            let input = case["input"].as_str().expect("input");
            let want = case["slug"].as_str().expect("slug");
            assert_eq!(slugify_tag(input), want, "slugify_tag({input:?})");
        }
    }

}
