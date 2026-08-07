//! S3-compatible upload to Cloudflare R2.
//!
//! Uses rusty-s3 (SigV4 presigning, no tokio) + blocking reqwest. Environment:
//! - `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`: R2 API token credentials.
//! - `CF_ACCOUNT_ID`: account id; the endpoint is
//!   `https://{account}.r2.cloudflarestorage.com` (path-style, region "auto").
//! - `R2_BUCKET`: bucket name.
//!
//! `put_store` multipart-uploads a large object (the ~70MB store archive) from
//! any `Read`; `put_json` PUTs a small JSON document (the manifest) in one shot.

use std::io::Read;
use std::time::Duration;

use rusty_s3::actions::{CreateMultipartUpload, ListObjectsV2};
use rusty_s3::{Bucket, Credentials, S3Action, UrlStyle};
use serde_json::Value;

/// Part size for multipart uploads. S3/R2 minimum is 5 MiB (except the last
/// part); 16 MiB puts the ~70MB store at ~5 parts.
const PART_SIZE: usize = 16 * 1024 * 1024;

/// Presigned URL validity. Uploads happen immediately after signing; an hour
/// comfortably covers a slow part upload with retries.
const SIGN_TTL: Duration = Duration::from_secs(3600);

#[derive(Debug, thiserror::Error)]
pub enum R2Error {
    #[error("missing environment variable {0}")]
    MissingEnv(&'static str),
    #[error("invalid R2 endpoint: {0}")]
    Endpoint(String),
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("{action} for {key:?} returned HTTP {status}: {body}")]
    Status { action: &'static str, key: String, status: u16, body: String },
    #[error("could not parse CreateMultipartUpload response: {0}")]
    MultipartResponse(String),
    #[error("UploadPart response for {key:?} part {part} had no ETag header")]
    MissingEtag { key: String, part: u16 },
    #[error("io error reading upload source: {0}")]
    Io(#[from] std::io::Error),
}

pub struct R2Client {
    bucket: Bucket,
    creds: Credentials,
    http: reqwest::blocking::Client,
}

impl R2Client {
    /// Build a client from the standard environment variables.
    pub fn from_env() -> Result<Self, R2Error> {
        let need = |name: &'static str| std::env::var(name).map_err(|_| R2Error::MissingEnv(name));
        let access_key = need("R2_ACCESS_KEY_ID")?;
        let secret_key = need("R2_SECRET_ACCESS_KEY")?;
        let account_id = need("CF_ACCOUNT_ID")?;
        let bucket = need("R2_BUCKET")?;
        Self::from_parts(&account_id, &bucket, access_key, secret_key)
    }

    pub fn from_parts(
        account_id: &str,
        bucket: &str,
        access_key: impl Into<String>,
        secret_key: impl Into<String>,
    ) -> Result<Self, R2Error> {
        let endpoint = format!("https://{account_id}.r2.cloudflarestorage.com");
        let endpoint_url: url::Url = endpoint.parse().map_err(|e| R2Error::Endpoint(format!("{endpoint}: {e}")))?;
        // R2 supports path-style addressing; region is always "auto".
        let bucket = Bucket::new(endpoint_url, UrlStyle::Path, bucket.to_string(), "auto")
            .map_err(|e| R2Error::Endpoint(format!("{endpoint}: {e}")))?;
        let http = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(300))
            .build()?;
        Ok(Self { bucket, creds: Credentials::new(access_key, secret_key), http })
    }

    /// The presigned URL an object would be uploaded to (exposed for tests).
    pub fn object_url(&self, key: &str) -> String {
        self.bucket.put_object(Some(&self.creds), key).sign(SIGN_TTL).to_string()
    }

    fn check(resp: reqwest::blocking::Response, action: &'static str, key: &str) -> Result<reqwest::blocking::Response, R2Error> {
        if resp.status().is_success() {
            return Ok(resp);
        }
        let status = resp.status().as_u16();
        let body: String = resp.text().unwrap_or_default().chars().take(500).collect();
        Err(R2Error::Status { action, key: key.to_string(), status, body })
    }

    /// PUT a small JSON document (e.g. the manifest).
    pub fn put_json(&self, key: &str, value: &Value) -> Result<(), R2Error> {
        let url = self.bucket.put_object(Some(&self.creds), key).sign(SIGN_TTL);
        let resp = self
            .http
            .put(url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(value.to_string())
            .send()?;
        Self::check(resp, "PutObject", key)?;
        Ok(())
    }

    /// List object keys under `prefix`. One page (1000 keys) — far beyond what
    /// pruning ever sees, since imports prune down to a handful each run.
    pub fn list_keys(&self, prefix: &str) -> Result<Vec<String>, R2Error> {
        let mut action = self.bucket.list_objects_v2(Some(&self.creds));
        action.with_prefix(prefix);
        let url = action.sign(SIGN_TTL);
        let resp = Self::check(self.http.get(url).send()?, "ListObjectsV2", prefix)?;
        let body = resp.text()?;
        let parsed = ListObjectsV2::parse_response(&body).map_err(|e| R2Error::MultipartResponse(e.to_string()))?;
        Ok(parsed.contents.into_iter().map(|c| c.key).collect())
    }

    /// DELETE one object.
    pub fn delete_object(&self, key: &str) -> Result<(), R2Error> {
        let url = self.bucket.delete_object(Some(&self.creds), key).sign(SIGN_TTL);
        Self::check(self.http.delete(url).send()?, "DeleteObject", key)?;
        Ok(())
    }

    /// Delete all but the newest `keep` objects under `prefix`, returning the
    /// deleted keys. Store keys embed a fixed-width unix timestamp
    /// (`card-store-v{version}-{secs}.store`), so descending lexicographic
    /// order is newest-first. Called AFTER the manifest publish, so the
    /// manifest's own store is always among the kept newest.
    pub fn prune_old_stores(&self, prefix: &str, keep: usize) -> Result<Vec<String>, R2Error> {
        let mut keys = self.list_keys(prefix)?;
        keys.sort_unstable_by(|a, b| b.cmp(a));
        let old: Vec<String> = keys.into_iter().skip(keep).collect();
        for key in &old {
            self.delete_object(key)?;
        }
        Ok(old)
    }

    /// Multipart-upload `reader`'s contents to `key`. Aborts the multipart
    /// upload on any failure so R2 doesn't accumulate orphaned parts.
    pub fn put_store(&self, mut reader: impl Read, key: &str) -> Result<(), R2Error> {
        // 1. CreateMultipartUpload
        let create = self.bucket.create_multipart_upload(Some(&self.creds), key);
        let url = create.sign(SIGN_TTL);
        let resp = Self::check(self.http.post(url).send()?, "CreateMultipartUpload", key)?;
        let body = resp.text()?;
        let upload = CreateMultipartUpload::parse_response(&body).map_err(|e| R2Error::MultipartResponse(e.to_string()))?;
        let upload_id = upload.upload_id().to_string();

        match self.upload_parts(&mut reader, key, &upload_id) {
            Ok(etags) => {
                // 3. CompleteMultipartUpload
                let action = self.bucket.complete_multipart_upload(
                    Some(&self.creds),
                    key,
                    &upload_id,
                    etags.iter().map(String::as_str),
                );
                let url = action.sign(SIGN_TTL);
                let body = action.body();
                Self::check(self.http.post(url).body(body).send()?, "CompleteMultipartUpload", key)?;
                Ok(())
            }
            Err(e) => {
                // Best-effort abort; the original error is what matters.
                let abort = self.bucket.abort_multipart_upload(Some(&self.creds), key, &upload_id);
                let _ = self.http.delete(abort.sign(SIGN_TTL)).send();
                Err(e)
            }
        }
    }

    /// 2. UploadPart loop: read PART_SIZE chunks, PUT each, collect ETags.
    fn upload_parts(&self, reader: &mut impl Read, key: &str, upload_id: &str) -> Result<Vec<String>, R2Error> {
        let mut etags = Vec::new();
        let mut part_number: u16 = 1;
        loop {
            let chunk = read_up_to(reader, PART_SIZE)?;
            // Always send part 1, even empty (a zero-byte object is legal);
            // afterwards an empty chunk means EOF.
            if chunk.is_empty() && part_number > 1 {
                break;
            }
            let is_last_short = chunk.len() < PART_SIZE;
            let url = self
                .bucket
                .upload_part(Some(&self.creds), key, part_number, upload_id)
                .sign(SIGN_TTL);
            let resp = Self::check(self.http.put(url).body(chunk).send()?, "UploadPart", key)?;
            let etag = resp
                .headers()
                .get(reqwest::header::ETAG)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
                .ok_or(R2Error::MissingEtag { key: key.to_string(), part: part_number })?;
            etags.push(etag);
            part_number += 1;
            if is_last_short {
                break;
            }
        }
        Ok(etags)
    }
}

/// Read up to `limit` bytes from `reader` (short only at EOF).
fn read_up_to(reader: &mut impl Read, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(limit.min(1 << 20));
    let mut take = reader.take(limit as u64);
    take.read_to_end(&mut buf)?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client() -> R2Client {
        R2Client::from_parts("acct123", "stores", "AKIDEXAMPLE", "SECRETEXAMPLE").unwrap()
    }

    #[test]
    fn endpoint_and_path_style_url() {
        let url = client().object_url("card-store-v1.store");
        assert!(url.starts_with("https://acct123.r2.cloudflarestorage.com/stores/card-store-v1.store?"), "{url}");
        // SigV4 query-string presigning markers.
        assert!(url.contains("X-Amz-Signature="), "{url}");
        assert!(url.contains("X-Amz-Credential="), "{url}");
        // R2's fixed region.
        assert!(url.contains("auto"), "{url}");
    }

    #[test]
    fn read_up_to_chunks_reader() {
        let data = vec![7u8; 10];
        let mut r = std::io::Cursor::new(data);
        assert_eq!(read_up_to(&mut r, 4).unwrap().len(), 4);
        assert_eq!(read_up_to(&mut r, 4).unwrap().len(), 4);
        assert_eq!(read_up_to(&mut r, 4).unwrap().len(), 2); // short at EOF
        assert!(read_up_to(&mut r, 4).unwrap().is_empty());
    }

    #[test]
    fn from_env_reports_missing_variables() {
        // Don't set the vars in-process (env is process-global across tests);
        // just assert the error path names the missing variable.
        // R2_ACCESS_KEY_ID is checked first.
        if std::env::var("R2_ACCESS_KEY_ID").is_err() {
            match R2Client::from_env() {
                Err(R2Error::MissingEnv(name)) => assert_eq!(name, "R2_ACCESS_KEY_ID"),
                other => panic!("expected MissingEnv, got {:?}", other.err()),
            }
        }
    }
}
