//! sylvan-store-builder: build a card_engine archive from Scryfall bulk data.
//!
//! Modes:
//!   sylvan-store-builder --out DIR            build locally (no upload)
//!   sylvan-store-builder --out DIR --upload   build, then publish to R2
//!   sylvan-store-builder --serve              container mode: HTTP control
//!                                             plane on :8080 (POST /run,
//!                                             GET /status, GET /healthz);
//!                                             each run builds + publishes.
//!
//! R2 publishing reads R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY /
//! CF_ACCOUNT_ID / R2_BUCKET from the environment (see .env.example).
//! Pipeline sequence per engine/builder/PIPELINE.md, mirroring upstream's
//! _run_import_under_lock.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};

use serde_json::json;
use sylvan_store_builder::{build_store, bulk, r2, tags, transform};

struct Args {
    out: Option<PathBuf>,
    upload: bool,
    serve: bool,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args { out: None, upload: false, serve: false };
    let mut argv = std::env::args().skip(1);
    while let Some(arg) = argv.next() {
        match arg.as_str() {
            "--out" => {
                let v = argv.next().ok_or("--out requires a directory argument")?;
                args.out = Some(PathBuf::from(v));
            }
            "--upload" => args.upload = true,
            "--serve" => args.serve = true,
            "--help" | "-h" => {
                return Err("usage: sylvan-store-builder (--out DIR [--upload] | --serve)".to_owned());
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    if args.serve == args.out.is_some() {
        return Err("exactly one of --serve or --out DIR is required".to_owned());
    }
    Ok(args)
}

#[derive(Clone, serde::Serialize)]
struct Status {
    /// idle | running | done | failed — the contract with ImportCoordinator.
    state: &'static str,
    phase: String,
    detail: Option<String>,
    printings: usize,
    started_at: Option<String>,
    finished_at: Option<String>,
}

impl Status {
    fn idle() -> Self {
        Status {
            state: "idle",
            phase: "idle".to_owned(),
            detail: None,
            printings: 0,
            started_at: None,
            finished_at: None,
        }
    }
}

fn now_unix() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_owned())
}

fn set_phase(status: &Arc<Mutex<Status>>, phase: &str) {
    let mut s = status.lock().unwrap();
    s.phase = phase.to_owned();
    eprintln!("phase: {phase}");
}

/// The full import: fetch → transform → tags → finalize → build → publish.
/// Mirrors upstream _run_import_under_lock; any error aborts the whole run
/// (upstream's KeyError/NOT-NULL semantics — never a partial store).
fn run_import(out_dir: &Path, upload: bool, status: &Arc<Mutex<Status>>) -> Result<(), String> {
    // Fail fast on missing credentials before minutes of downloading.
    let r2_client = if upload {
        Some(r2::R2Client::from_env().map_err(|e| format!("R2 configuration: {e}"))?)
    } else {
        None
    };

    set_phase(status, "downloading card data");
    let client = bulk::BulkClient::new().map_err(|e| format!("bulk client: {e}"))?;
    let mut drafts = Vec::new();
    for card in client.stream(bulk::DEFAULT_CARDS).map_err(|e| format!("bulk stream: {e}"))? {
        let card = card.map_err(|e| format!("bulk read: {e}"))?;
        if let Some(draft) = transform::transform(&card).map_err(|e| format!("transform: {e}"))? {
            drafts.push(draft);
        }
        if drafts.len() % 10_000 == 0 {
            status.lock().unwrap().printings = drafts.len();
        }
    }
    status.lock().unwrap().printings = drafts.len();

    set_phase(status, "downloading tags");
    let tag_data = tags::fetch_tag_data(&client).map_err(|e| format!("tags: {e}"))?;

    set_phase(status, "computing scores and finalizing rows");
    let rows = transform::finalize(drafts, &tag_data);

    set_phase(status, "building store");
    let manifest = build_store(rows, out_dir, &now_unix()).map_err(|e| format!("store build: {e}"))?;
    let manifest_path = out_dir.join("manifest.json");
    std::fs::write(&manifest_path, manifest.to_json().to_string())
        .map_err(|e| format!("write manifest: {e}"))?;
    eprintln!(
        "built {} ({} cards, {} printings)",
        manifest.store_key, manifest.card_count, manifest.printing_count
    );

    if let Some(r2_client) = r2_client {
        set_phase(status, "uploading store to R2");
        let store_file = std::fs::File::open(out_dir.join(&manifest.store_key))
            .map_err(|e| format!("open store: {e}"))?;
        r2_client
            .put_store(store_file, &manifest.store_key)
            .map_err(|e| format!("upload store: {e}"))?;
        // Manifest LAST: it is the commit point readers act on. A crash before
        // this line leaves the previous manifest (and store) fully live.
        r2_client
            .put_json("manifest.json", &manifest.to_json())
            .map_err(|e| format!("upload manifest: {e}"))?;
        eprintln!("published {} + manifest.json", manifest.store_key);

        // Old stores accumulate ~70MB/night otherwise. Keep a few for isolates
        // still mid-swap on the previous manifest; failure here is logged, not
        // fatal — the publish above already succeeded.
        set_phase(status, "pruning old stores");
        match r2_client.prune_old_stores("card-store-", 3) {
            Ok(deleted) if deleted.is_empty() => eprintln!("prune: nothing to delete"),
            Ok(deleted) => eprintln!("prune: deleted {}", deleted.join(", ")),
            Err(e) => eprintln!("prune failed (non-fatal): {e}"),
        }
    }
    Ok(())
}

fn spawn_import(status: Arc<Mutex<Status>>) -> bool {
    {
        let mut s = status.lock().unwrap();
        if s.state == "running" {
            return false;
        }
        *s = Status {
            state: "running",
            phase: "starting".to_owned(),
            detail: None,
            printings: 0,
            started_at: Some(now_unix()),
            finished_at: None,
        };
    }
    std::thread::spawn(move || {
        let out_dir = std::env::temp_dir().join("sylvan-store-build");
        let result = run_import(&out_dir, true, &status);
        let mut s = status.lock().unwrap();
        s.finished_at = Some(now_unix());
        match result {
            Ok(()) => {
                s.state = "done";
                s.phase = "done".to_owned();
            }
            Err(e) => {
                eprintln!("import failed: {e}");
                s.state = "failed";
                s.phase = "failed".to_owned();
                s.detail = Some(e);
            }
        }
    });
    true
}

/// Minimal HTTP/1.1 control plane — three fixed routes, no framework. The only
/// client is the ImportCoordinator DO over Cloudflare's container network.
fn handle_conn(mut conn: TcpStream, status: &Arc<Mutex<Status>>) {
    let mut reader = BufReader::new(match conn.try_clone() {
        Ok(c) => c,
        Err(_) => return,
    });
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    // Drain headers; bodies are unused by this control plane.
    let mut line = String::new();
    while reader.read_line(&mut line).is_ok() && line.trim() != "" {
        line.clear();
    }

    let mut parts = request_line.split_whitespace();
    let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let (code, body) = match (method, path) {
        ("GET", "/healthz") => (200, json!({"ok": true}).to_string()),
        ("GET", "/status") => (200, serde_json::to_string(&*status.lock().unwrap()).unwrap()),
        ("POST", "/run") => {
            if spawn_import(Arc::clone(status)) {
                (202, json!({"ok": true, "started": true}).to_string())
            } else {
                (409, json!({"ok": false, "detail": "import already running"}).to_string())
            }
        }
        _ => (404, json!({"ok": false, "detail": "not found"}).to_string()),
    };
    let reason = match code {
        200 => "OK",
        202 => "Accepted",
        409 => "Conflict",
        _ => "Not Found",
    };
    let _ = write!(
        conn,
        "HTTP/1.1 {code} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len(),
    );
}

fn serve() -> ExitCode {
    let status = Arc::new(Mutex::new(Status::idle()));
    let listener = match TcpListener::bind("0.0.0.0:8080") {
        Ok(l) => l,
        Err(e) => {
            eprintln!("bind :8080 failed: {e}");
            return ExitCode::FAILURE;
        }
    };
    eprintln!("control plane listening on :8080");
    for conn in listener.incoming() {
        match conn {
            Ok(conn) => handle_conn(conn, &status),
            Err(e) => eprintln!("accept error: {e}"),
        }
    }
    ExitCode::SUCCESS
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(msg) => {
            eprintln!("{msg}");
            return ExitCode::FAILURE;
        }
    };

    if args.serve {
        return serve();
    }

    let out_dir = args.out.expect("checked in parse_args");
    let status = Arc::new(Mutex::new(Status::idle()));
    match run_import(&out_dir, args.upload, &status) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("store build failed: {e}");
            ExitCode::FAILURE
        }
    }
}
