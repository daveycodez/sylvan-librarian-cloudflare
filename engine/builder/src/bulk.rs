//! Scryfall bulk data discovery + streaming download.
//!
//! Port of `vendor/sylvan_librarian/api/scryfall_bulk_data_fetcher.py`.
//!
//! Upstream's flow, mirrored here:
//! - GET `https://api.scryfall.com/bulk-data` and index records by `type`
//!   (`ScryfallBulkDataFetcher.list_bulk_data`).
//! - Each record's dump URL lives in `jsonl_download_uri` (`_DOWNLOAD_URI_FIELD`,
//!   fetcher line 40): Scryfall moved the dumps to gzipped JSONL and the old
//!   plain-JSON `download_uri` field no longer exists. A missing field is a hard
//!   `BulkDataFormatError` (fetcher lines 184-191), never a silent fallback.
//! - The payload is served as `.jsonl.gz` with `Content-Type: application/gzip`
//!   and *no* `Content-Encoding`, so the HTTP client hands back raw gzip bytes.
//!   Upstream sniffs the gzip magic instead of trusting headers/suffix
//!   (`_gunzip_if_needed`, lines 57-97) and decodes concatenated members; so do we.
//! - The decompressed stream is JSONL: one card object per line. Unparseable or
//!   non-object lines are skipped with a cap on individual logs, and a file of
//!   at least `PARSE_COVERAGE_MIN_BYTES` whose parsed coverage falls below
//!   `PARSE_COVERAGE_THRESHOLD` fails hard (`stream_data_for_key`, lines 235-297).
//!   (Upstream counts str characters; we count bytes — same 0.8 ratio check,
//!   equivalent in practice for a corpus that is overwhelmingly ASCII.)
//! - Scryfall rejects default HTTP-library User-Agents (400 generic_user_agent)
//!   and asks for an explicit Accept header (fetcher lines 122-124); upstream
//!   sends `magic-api/<YYYYMMDD>`, we send `sylvan-store-builder/<YYYYMMDD>`.
//! - Transport retries: 5 attempts with backoff on 429/500/502/503/504
//!   (fetcher lines 128-134).
//!
//! Deliberately not ported: the on-disk zstd cache (`_ensure_cached`). Upstream
//! shares one download across multiple long-lived worker processes; this builder
//! is a single-shot container job, so it streams straight from the network.

use std::io::{BufRead, BufReader, Read};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use flate2::read::MultiGzDecoder;
use serde_json::Value;

/// Bulk data types this pipeline consumes (subset of upstream's `BulkDataKey`).
pub const DEFAULT_CARDS: &str = "default_cards";
pub const ORACLE_TAGS: &str = "oracle_tags";
pub const ART_TAGS: &str = "art_tags";

/// Field on each /bulk-data record holding the dump URL (fetcher line 40).
const DOWNLOAD_URI_FIELD: &str = "jsonl_download_uri";

/// Coverage-check thresholds (fetcher lines 29-30).
const PARSE_COVERAGE_MIN_BYTES: u64 = 1_000_000;
const PARSE_COVERAGE_THRESHOLD: f64 = 0.8;

/// Log at most this many individual unparseable lines (fetcher line 36).
const MAX_UNPARSEABLE_LINE_LOGS: u32 = 5;

const BULK_DATA_URL: &str = "https://api.scryfall.com/bulk-data";

/// Retry policy mirroring upstream's urllib3 `Retry(total=5, backoff_factor=1,
/// status_forcelist=[429, 500, 502, 503, 504])` (fetcher lines 128-134).
const RETRY_TOTAL: u32 = 5;
const RETRY_STATUSES: [u16; 5] = [429, 500, 502, 503, 504];

#[derive(Debug, thiserror::Error)]
pub enum BulkError {
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("GET {url} returned HTTP {status} after retries, body[:500]={body:?}")]
    Status { url: String, status: u16, body: String },
    /// Mirrors upstream `BulkDataFormatError`.
    #[error("bulk data format error: {0}")]
    Format(String),
    /// Mirrors upstream `BulkDataParseError`.
    #[error("bulk data parse error: {0}")]
    Parse(String),
    #[error("io error while streaming bulk data: {0}")]
    Io(#[from] std::io::Error),
}

/// `magic-api/<YYYYMMDD>` equivalent (api/utils/http_utils.py `make_user_agent`),
/// with this crate's own name. Scryfall rejects default HTTP-library UAs.
pub fn make_user_agent() -> String {
    let days = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0);
    let (y, m, d) = civil_from_days(days as i64);
    format!("sylvan-store-builder/{y:04}{m:02}{d:02}")
}

/// Days-since-epoch → (year, month, day). Howard Hinnant's civil_from_days.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub struct BulkClient {
    http: reqwest::blocking::Client,
}

impl BulkClient {
    pub fn new() -> Result<Self, BulkError> {
        // No whole-body timeout: the dump download takes minutes. Upstream uses a
        // 60s per-attempt timeout on a streaming request, which requests applies
        // between reads; connect_timeout is the closest blocking-reqwest analog.
        let http = reqwest::blocking::Client::builder()
            .user_agent(make_user_agent())
            .connect_timeout(Duration::from_secs(60))
            .timeout(None)
            .build()?;
        Ok(Self { http })
    }

    /// GET with retries, mirroring `ScryfallBulkDataFetcher._get` + the urllib3
    /// Retry config: retry transport errors and retryable statuses with
    /// exponential backoff, and surface the final response body on failure.
    fn get_with_retry(&self, url: &str) -> Result<reqwest::blocking::Response, BulkError> {
        let mut last_err: Option<BulkError> = None;
        for attempt in 0..=RETRY_TOTAL {
            if attempt > 0 {
                // urllib3: backoff_factor * 2^(attempt-1) seconds.
                std::thread::sleep(Duration::from_secs(1 << (attempt - 1).min(5)));
            }
            match self
                .http
                .get(url)
                .header(reqwest::header::ACCEPT, "application/json")
                .send()
            {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    if resp.status().is_success() {
                        return Ok(resp);
                    }
                    let retryable = RETRY_STATUSES.contains(&status);
                    let body: String = resp.text().unwrap_or_default().chars().take(500).collect();
                    let err = BulkError::Status { url: url.to_string(), status, body };
                    if !retryable {
                        return Err(err);
                    }
                    last_err = Some(err);
                }
                Err(e) => last_err = Some(BulkError::Http(e)),
            }
        }
        Err(last_err.expect("at least one attempt was made"))
    }

    /// Fetch the /bulk-data listing and return the record for `kind`
    /// (`list_bulk_data` + `get_download_uri_for_key`). SCRYFALL_BULK_URL
    /// overrides the listing URL (mirrors, local test servers) — the same
    /// var the ImportCoordinator honors.
    pub fn jsonl_download_uri(&self, kind: &str) -> Result<String, BulkError> {
        let listing_url = std::env::var("SCRYFALL_BULK_URL").unwrap_or_else(|_| BULK_DATA_URL.to_owned());
        let body = self.get_with_retry(&listing_url)?.text()?;
        let listing: Value = serde_json::from_str(&body)
            .map_err(|e| BulkError::Format(format!("/bulk-data response is not JSON: {e}")))?;
        download_uri_from_listing(&listing, kind)
    }

    /// Stream one bulk dump as an iterator of JSON card/tag objects.
    pub fn stream(&self, kind: &str) -> Result<JsonlStream<BufReader<Box<dyn Read>>>, BulkError> {
        let uri = self.jsonl_download_uri(kind)?;
        let resp = self.get_with_retry(&uri)?;
        let reader = gunzip_if_needed(Box::new(resp))?;
        Ok(JsonlStream::new(BufReader::with_capacity(1 << 16, reader)))
    }
}

/// Extract `jsonl_download_uri` for record `type == kind` from a /bulk-data
/// listing. Missing record or missing field is a Format error, mirroring
/// `get_download_uri_for_key` (fetcher lines 171-191).
pub fn download_uri_from_listing(listing: &Value, kind: &str) -> Result<String, BulkError> {
    let records = listing
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| BulkError::Format("/bulk-data response has no 'data' array".into()))?;
    let record = records
        .iter()
        .find(|r| r.get("type").and_then(Value::as_str) == Some(kind))
        .ok_or_else(|| BulkError::Format(format!("/bulk-data listing has no record of type {kind:?}")))?;
    match record.get(DOWNLOAD_URI_FIELD).and_then(Value::as_str) {
        Some(uri) => Ok(uri.to_string()),
        None => {
            let mut fields: Vec<&str> = record.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default();
            fields.sort_unstable();
            Err(BulkError::Format(format!(
                "Scryfall bulk data record for {kind} has no {DOWNLOAD_URI_FIELD:?} field (present fields: {fields:?}); the /bulk-data schema has changed"
            )))
        }
    }
}

/// Decompress a byte stream if it is gzipped, else pass it through unchanged.
/// Sniffs the gzip magic bytes rather than trusting the URL suffix or headers
/// (`_gunzip_if_needed`, fetcher lines 57-97). `MultiGzDecoder` decodes
/// concatenated gzip members as one logical stream, matching upstream's loop
/// over `unused_data`; a stream that ends mid-member surfaces as an io error
/// from the decoder (upstream raises BulkDataFormatError).
pub fn gunzip_if_needed(mut inner: Box<dyn Read>) -> Result<Box<dyn Read>, BulkError> {
    let mut magic = [0u8; 2];
    let mut filled = 0;
    while filled < 2 {
        match inner.read(&mut magic[filled..])? {
            0 => break,
            n => filled += n,
        }
    }
    let prefixed: Box<dyn Read> = Box::new(std::io::Cursor::new(magic[..filled].to_vec()).chain(inner));
    if filled == 2 && magic == [0x1f, 0x8b] {
        Ok(Box::new(MultiGzDecoder::new(prefixed)))
    } else {
        Ok(prefixed)
    }
}

/// Yields one parsed JSON object per JSONL line, tracking parse coverage.
///
/// Mirrors `stream_data_for_key` (fetcher lines 235-297): blank lines are
/// ignored, lines that are not a JSON object are skipped (logged up to a cap),
/// and after the final line a non-trivially-sized stream that parsed less than
/// the coverage threshold yields a terminal `BulkError::Parse`. As upstream
/// notes, the coverage check only fires for consumers that iterate to
/// exhaustion.
pub struct JsonlStream<R: BufRead> {
    reader: R,
    line_buf: String,
    total_bytes: u64,
    parsed_bytes: u64,
    object_count: u64,
    skipped_lines: u64,
    finished: bool,
}

impl<R: BufRead> JsonlStream<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            line_buf: String::new(),
            total_bytes: 0,
            parsed_bytes: 0,
            object_count: 0,
            skipped_lines: 0,
            finished: false,
        }
    }

    /// Objects successfully yielded so far.
    pub fn object_count(&self) -> u64 {
        self.object_count
    }

    fn coverage_failure(&self) -> Option<BulkError> {
        if self.total_bytes >= PARSE_COVERAGE_MIN_BYTES
            && (self.parsed_bytes as f64) < PARSE_COVERAGE_THRESHOLD * self.total_bytes as f64
        {
            return Some(BulkError::Parse(format!(
                "Parsed only {} objects covering {} of {} bytes; the bulk data file format may have changed",
                self.object_count, self.parsed_bytes, self.total_bytes
            )));
        }
        None
    }
}

impl<R: BufRead> Iterator for JsonlStream<R> {
    type Item = Result<Value, BulkError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.finished {
            return None;
        }
        loop {
            self.line_buf.clear();
            match self.reader.read_line(&mut self.line_buf) {
                Err(e) => {
                    self.finished = true;
                    return Some(Err(BulkError::Io(e)));
                }
                Ok(0) => {
                    self.finished = true;
                    if self.skipped_lines > 0 {
                        eprintln!("Skipped {} unparseable lines total in bulk stream", self.skipped_lines);
                    }
                    return self.coverage_failure().map(Err);
                }
                Ok(n) => {
                    self.total_bytes += n as u64;
                    let stripped = self.line_buf.trim();
                    if stripped.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Value>(stripped) {
                        // A non-object line means the layout is not JSONL; skip it and
                        // let the coverage check turn systematic failure into a hard error.
                        Ok(card @ Value::Object(_)) => {
                            self.object_count += 1;
                            self.parsed_bytes += n as u64;
                            return Some(Ok(card));
                        }
                        _ => {
                            self.skipped_lines += 1;
                            if self.skipped_lines <= u64::from(MAX_UNPARSEABLE_LINE_LOGS) {
                                let head: String = stripped.chars().take(120).collect();
                                eprintln!("Skipping unparseable line: {head}");
                            }
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use std::io::Write;

    fn gz(data: &[u8]) -> Vec<u8> {
        let mut enc = GzEncoder::new(Vec::new(), Compression::default());
        enc.write_all(data).unwrap();
        enc.finish().unwrap()
    }

    fn read_all(r: Box<dyn Read>) -> Vec<u8> {
        let mut out = Vec::new();
        let mut r = r;
        r.read_to_end(&mut out).unwrap();
        out
    }

    #[test]
    fn gunzip_passthrough_for_plain_data() {
        let data = b"{\"a\":1}\n".to_vec();
        let out = read_all(gunzip_if_needed(Box::new(std::io::Cursor::new(data.clone()))).unwrap());
        assert_eq!(out, data);
    }

    #[test]
    fn gunzip_decodes_gzip_payload() {
        let plain = b"{\"a\":1}\n{\"b\":2}\n";
        let out = read_all(gunzip_if_needed(Box::new(std::io::Cursor::new(gz(plain)))).unwrap());
        assert_eq!(out, plain);
    }

    #[test]
    fn gunzip_decodes_concatenated_members() {
        // Upstream explicitly re-arms the decompressor for multi-member dumps
        // (fetcher lines 90-94); MultiGzDecoder must do the same.
        let mut payload = gz(b"{\"a\":1}\n");
        payload.extend(gz(b"{\"b\":2}\n"));
        let out = read_all(gunzip_if_needed(Box::new(std::io::Cursor::new(payload))).unwrap());
        assert_eq!(out, b"{\"a\":1}\n{\"b\":2}\n");
    }

    #[test]
    fn gunzip_short_stream_passthrough() {
        let out = read_all(gunzip_if_needed(Box::new(std::io::Cursor::new(b"x".to_vec()))).unwrap());
        assert_eq!(out, b"x");
    }

    #[test]
    fn jsonl_stream_yields_objects_and_skips_junk() {
        let data = "{\"a\":1}\n\nnot json\n[1,2]\n{\"b\":2}\n";
        let stream = JsonlStream::new(BufReader::new(data.as_bytes()));
        let items: Vec<_> = stream.collect();
        // Small stream: coverage check is bypassed (< PARSE_COVERAGE_MIN_BYTES).
        let vals: Vec<Value> = items.into_iter().map(|r| r.unwrap()).collect();
        assert_eq!(vals, vec![serde_json::json!({"a": 1}), serde_json::json!({"b": 2})]);
    }

    #[test]
    fn jsonl_stream_coverage_failure_on_large_junk() {
        // > 1MB of unparseable lines with a single valid object: mirrors the
        // "dump is no longer one-object-per-line" hard failure.
        let mut data = String::from("{\"a\":1}\n");
        for _ in 0..20_000 {
            data.push_str(&"x".repeat(60));
            data.push('\n');
        }
        let stream = JsonlStream::new(BufReader::new(data.as_bytes()));
        let items: Vec<_> = stream.collect();
        assert!(items[0].as_ref().unwrap().is_object());
        match items.last().unwrap() {
            Err(BulkError::Parse(msg)) => assert!(msg.contains("bulk data file format")),
            other => panic!("expected Parse error, got {other:?}"),
        }
    }

    #[test]
    fn download_uri_from_listing_reads_jsonl_field() {
        let listing = serde_json::json!({"data": [
            {"type": "oracle_cards", "jsonl_download_uri": "https://example.com/oracle.jsonl.gz"},
            {"type": "default_cards", "jsonl_download_uri": "https://example.com/default.jsonl.gz"},
        ]});
        assert_eq!(
            download_uri_from_listing(&listing, DEFAULT_CARDS).unwrap(),
            "https://example.com/default.jsonl.gz"
        );
    }

    #[test]
    fn download_uri_missing_field_is_format_error() {
        // Mirrors BulkDataFormatError when Scryfall renames the field again.
        let listing = serde_json::json!({"data": [
            {"type": "default_cards", "download_uri": "https://example.com/old-style.json"},
        ]});
        match download_uri_from_listing(&listing, DEFAULT_CARDS) {
            Err(BulkError::Format(msg)) => {
                assert!(msg.contains("jsonl_download_uri"));
                assert!(msg.contains("download_uri"));
            }
            other => panic!("expected Format error, got {other:?}"),
        }
    }

    #[test]
    fn user_agent_is_date_stamped() {
        let ua = make_user_agent();
        assert!(ua.starts_with("sylvan-store-builder/2"), "{ua}");
        assert_eq!(ua.len(), "sylvan-store-builder/".len() + 8);
    }

    #[test]
    fn civil_from_days_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1)); // 2024-01-01
    }

    /// Optional live check that the /bulk-data listing still has the shape we
    /// parse. Run with: cargo test -- --ignored
    #[test]
    #[ignore = "hits the live Scryfall API"]
    fn live_bulk_data_listing_has_default_cards() {
        let client = BulkClient::new().unwrap();
        let uri = client.jsonl_download_uri(DEFAULT_CARDS).unwrap();
        assert!(uri.starts_with("https://"), "{uri}");
    }
}
