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
//! Not ported: `_sync_hierarchy` (the `oracle_tags` / `art_tag_relationships`
//! Postgres tables). They back SQL-side tag expansion; the engine consumes only
//! the denormalized per-card tag objects (`card_from_pydict` reads
//! `card_oracle_tags` / `card_art_tags`), which this module produces.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

// The dump download is native-only (reqwest); the map-building logic below it
// is shared with the wasm import, which feeds records over its ABI instead.
#[cfg(not(target_arch = "wasm32"))]
use crate::bulk::{ART_TAGS, BulkClient, BulkError, ORACLE_TAGS};

/// Denormalized tag assignments, ready for `transform::finalize`.
/// Values are sorted slug lists (JSONB object key order is irrelevant to the
/// engine — `jsonb_obj_to_ids` sorts and dedupes — sorted keeps output stable).
/// Serde derives: the wasm import snapshots TagData across Durable Object
/// evictions (tags_export / tags_restore in engine/wasm-import).
#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
pub struct TagData {
    /// oracle_id → slugs (incl. ancestors) for `card_oracle_tags`.
    pub oracle: HashMap<String, Vec<String>>,
    /// illustration_id → slugs (incl. ancestors) for `card_art_tags`.
    pub art: HashMap<String, Vec<String>>,
}

/// Download both tag dumps and build the assignment maps.
#[cfg(not(target_arch = "wasm32"))]
pub fn fetch_tag_data(client: &BulkClient) -> Result<TagData, BulkError> {
    let oracle_tags: Vec<Value> = client.stream(ORACLE_TAGS)?.collect::<Result<_, _>>()?;
    let art_tags: Vec<Value> = client.stream(ART_TAGS)?.collect::<Result<_, _>>()?;
    Ok(TagData {
        oracle: build_id_to_tags(&oracle_tags, "oracle_id"),
        art: build_id_to_tags(&art_tags, "illustration_id"),
    })
}

fn tag_str(tag: &Value, key: &str) -> Option<String> {
    tag.get(key).and_then(Value::as_str).map(str::to_string)
}

/// `_build_uuid_to_slug` (tag_import.py lines 22-23).
fn build_uuid_to_slug(tags: &[Value]) -> HashMap<String, String> {
    tags.iter()
        .filter_map(|t| Some((tag_str(t, "id")?, tag_str(t, "slug")?)))
        .collect()
}

/// `_build_all_ancestors` (lines 26-56): slug → all ancestor slugs (parents,
/// grandparents, ...). BFS over parent links with a visited set, so cycles
/// terminate and a tag is never its own ancestor. Parents whose UUID has no
/// known slug are skipped, and a duplicated slug's parent set is the LAST
/// tag's (dict-overwrite semantics, line 38).
fn build_all_ancestors(tags: &[Value], uuid_to_slug: &HashMap<String, String>) -> HashMap<String, HashSet<String>> {
    let mut slug_to_parents: HashMap<String, HashSet<String>> = HashMap::new();
    for tag in tags {
        let Some(id) = tag_str(tag, "id") else { continue };
        let Some(slug) = uuid_to_slug.get(&id) else { continue };
        let parents: HashSet<String> = tag
            .get("parent_ids")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .filter_map(|pid| uuid_to_slug.get(pid).cloned())
                    .collect()
            })
            .unwrap_or_default();
        slug_to_parents.insert(slug.clone(), parents);
    }

    let mut result: HashMap<String, HashSet<String>> = HashMap::new();
    for slug in slug_to_parents.keys() {
        let mut ancestors: HashSet<String> = HashSet::new();
        let mut visited: HashSet<&str> = HashSet::from([slug.as_str()]);
        let mut queue: Vec<&str> = slug_to_parents[slug].iter().map(String::as_str).collect();
        while let Some(current) = queue.pop() {
            if !visited.insert(current) {
                continue;
            }
            ancestors.insert(current.to_string());
            if let Some(parents) = slug_to_parents.get(current) {
                queue.extend(parents.iter().map(String::as_str).filter(|p| !visited.contains(*p)));
            }
        }
        result.insert(slug.clone(), ancestors);
    }
    result
}

/// The tagging loop of import_oracle_tags (lines 155-164) / import_art_tags
/// (lines 193-202), generic over the id field: for every tagging, the tag's
/// own slug plus all its ancestors attach to the tagged id.
pub fn build_id_to_tags(tags: &[Value], id_field: &str) -> HashMap<String, Vec<String>> {
    let uuid_to_slug = build_uuid_to_slug(tags);
    let all_ancestors = build_all_ancestors(tags, &uuid_to_slug);

    let mut id_to_tags: HashMap<String, HashSet<String>> = HashMap::new();
    for tag in tags {
        // Upstream indexes tag["slug"] directly here (KeyError aborts); a tag
        // without a slug never occurs in the dumps, and skipping matches the
        // uuid_to_slug treatment of such a record everywhere else.
        let Some(slug) = tag_str(tag, "slug") else { continue };
        let Some(taggings) = tag.get("taggings").and_then(Value::as_array) else { continue };
        for tagging in taggings {
            let Some(id) = tagging.get(id_field).and_then(Value::as_str) else { continue };
            if id.is_empty() {
                continue; // upstream: `if oid:` — falsy ids are skipped
            }
            let entry = id_to_tags.entry(id.to_string()).or_default();
            entry.insert(slug.clone());
            if let Some(ancestors) = all_ancestors.get(&slug) {
                entry.extend(ancestors.iter().cloned());
            }
        }
    }

    id_to_tags
        .into_iter()
        .map(|(id, set)| {
            let mut v: Vec<String> = set.into_iter().collect();
            v.sort_unstable();
            (id, v)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tag(id: &str, slug: &str, parent_ids: &[&str], taggings: Value) -> Value {
        json!({"id": id, "slug": slug, "parent_ids": parent_ids, "taggings": taggings})
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
        let map = build_id_to_tags(&tags, "oracle_id");
        assert_eq!(map["o-1"], vec!["gameplay", "interaction", "removal"]);
        assert_eq!(map["o-2"], vec!["gameplay", "interaction", "mana-dork", "removal"]);
    }

    #[test]
    fn art_tags_use_illustration_id_field() {
        let tags = vec![tag("u1", "squirrel", &[], json!([{"illustration_id": "ill-1"}, {"oracle_id": "o-9"}]))];
        let map = build_id_to_tags(&tags, "illustration_id");
        assert_eq!(map.len(), 1);
        assert_eq!(map["ill-1"], vec!["squirrel"]);
        // Taggings without the requested field are ignored (tagging.get(field)).
        assert!(build_id_to_tags(&tags, "oracle_id").contains_key("o-9"));
    }

    #[test]
    fn ancestor_cycle_terminates_and_excludes_self() {
        // a → b → a cycle: each gets the other as ancestor, never itself
        // (mirrors upstream's visited-set seeding with the slug itself).
        let tags = vec![
            tag("ua", "a", &["ub"], json!([{"oracle_id": "o-1"}])),
            tag("ub", "b", &["ua"], json!([])),
        ];
        let map = build_id_to_tags(&tags, "oracle_id");
        assert_eq!(map["o-1"], vec!["a", "b"]);
    }

    #[test]
    fn unknown_parent_ids_are_skipped() {
        let tags = vec![tag("u1", "child", &["missing-uuid"], json!([{"oracle_id": "o-1"}]))];
        let map = build_id_to_tags(&tags, "oracle_id");
        assert_eq!(map["o-1"], vec!["child"]);
    }

    #[test]
    fn empty_and_missing_ids_are_skipped() {
        let tags = vec![tag("u1", "t", &[], json!([{"oracle_id": ""}, {}, {"oracle_id": "o-1"}]))];
        let map = build_id_to_tags(&tags, "oracle_id");
        assert_eq!(map.len(), 1);
        assert!(map.contains_key("o-1"));
    }
}
