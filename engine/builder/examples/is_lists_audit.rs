//! Which rows of a bulk file the builder gives each measured `is:` tag — the check that
//! `is_lists.tsv` (scripts/generate-is-lists.ts) and the rules beside it tag exactly the rows
//! api.scryfall.com answers, made with the builder's own code rather than a second copy of it.
//!
//!   scripts/with-rust.sh cargo run --release -p sylvan-store-builder --example is_lists_audit \
//!       -- all-cards.jsonl.gz > tags.tsv
//!
//! One line per row carrying any of the eight: `scryfall id <TAB> tag,tag,…`. The file is read
//! twice — `is:related` is a fact about a card's other printings (`transform::RelatedCards`), so
//! every row is observed before any is tagged — and nothing is kept between the passes but one
//! oracle id per related card.

use std::io::{BufReader, BufWriter, Write};
use std::path::Path;

use sylvan_store_builder::bulk::{gunzip_if_needed, JsonlStream};
use sylvan_store_builder::is_lists::LIST_TAGS;
use sylvan_store_builder::transform::{transform_row, RelatedCards};

fn stream(path: &Path) -> JsonlStream<BufReader<Box<dyn std::io::Read>>> {
    let file = std::fs::File::open(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let reader = gunzip_if_needed(Box::new(file)).expect("gunzip");
    JsonlStream::new(BufReader::with_capacity(1 << 20, reader))
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: is_lists_audit <all-cards.jsonl[.gz]>");
    let path = Path::new(&path);

    let mut related = RelatedCards::default();
    for card in stream(path) {
        if let Some(draft) = transform_row(&card.expect("bulk row"), true).expect("transform") {
            related.observe(&draft);
        }
    }

    let mut out = BufWriter::new(std::io::stdout().lock());
    let (mut rows, mut tagged) = (0u64, 0u64);
    for card in stream(path) {
        let Some(mut draft) = transform_row(&card.expect("bulk row"), true).expect("transform") else { continue };
        related.tag(&mut draft);
        rows += 1;
        let tags: Vec<&str> = LIST_TAGS.into_iter().filter(|tag| draft.card_is_tags.iter().any(|t| t == tag)).collect();
        if !tags.is_empty() {
            tagged += 1;
            writeln!(out, "{}\t{}", draft.scryfall_id, tags.join(",")).expect("write");
        }
    }
    eprintln!("{rows} rows, {tagged} carrying a measured tag, {} related cards", related.len());
}
