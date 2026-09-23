//! Resumable, verified downloads: `<name>.part` grows with HTTP Range requests across retries and app restarts, and
//! only a file whose SHA-256 matches the pin is moved into place.

use super::manifest::PinnedFile;
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Debug, thiserror::Error)]
pub enum DownloadError {
    #[error("download cancelled")]
    Cancelled,
    #[error("network error: {0}")]
    Network(String),
    #[error("server answered HTTP {0} for {1}")]
    Http(u16, String),
    #[error("disk error: {0}")]
    Io(String),
    #[error("{file}: size {got} bytes, expected {want}")]
    Size { file: String, got: u64, want: u64 },
    #[error("{file}: SHA-256 {got} does not match the pinned {want}; the partial file was removed, retry to download again")]
    Checksum { file: String, got: String, want: String },
}

impl From<std::io::Error> for DownloadError {
    fn from(e: std::io::Error) -> Self {
        DownloadError::Io(e.to_string())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub file: String,
    pub phase: &'static str, // "download" | "verify"
    pub done: u64,
    pub total: u64,
    pub bytes_per_sec: f64,
}

#[derive(Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn reset(&self) {
        self.0.store(false, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

pub fn part_path(dest: &Path) -> PathBuf {
    let mut p = dest.as_os_str().to_owned();
    p.push(".part");
    PathBuf::from(p)
}

pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .user_agent(concat!("jeb-depot/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("http client")
}

/// Download `f` to `dest` (resuming a `.part`), then verify size and SHA-256. Retries transient failures.
pub async fn fetch_verified(client: &reqwest::Client, f: &PinnedFile, dest: &Path, cancel: &Cancel, mut on_progress: impl FnMut(Progress)) -> Result<(), DownloadError> {
    let part = part_path(dest);
    let mut attempt = 0u32;
    loop {
        match fetch_once(client, f, &part, cancel, &mut on_progress).await {
            Ok(()) => break,
            Err(DownloadError::Network(e)) if attempt < 6 && !cancel.is_cancelled() => {
                attempt += 1;
                log::warn!("download {} failed ({e}), retry {attempt}/6", f.file_name);
                tokio::time::sleep(Duration::from_secs(2u64.pow(attempt.min(4)))).await;
            }
            Err(e) => return Err(e),
        }
    }
    let got_size = tokio::fs::metadata(&part).await?.len();
    if got_size != f.size {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(DownloadError::Size { file: f.file_name.into(), got: got_size, want: f.size });
    }
    let got = sha256_file(&part, f.file_name, cancel, &mut on_progress).await?;
    if got != f.sha256 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(DownloadError::Checksum { file: f.file_name.into(), got, want: f.sha256.into() });
    }
    tokio::fs::rename(&part, dest).await?;
    Ok(())
}

async fn fetch_once(client: &reqwest::Client, f: &PinnedFile, part: &Path, cancel: &Cancel, on_progress: &mut impl FnMut(Progress)) -> Result<(), DownloadError> {
    let have = tokio::fs::metadata(part).await.map(|m| m.len()).unwrap_or(0);
    if have == f.size {
        return Ok(());
    }
    if have > f.size {
        tokio::fs::remove_file(part).await?;
    }
    let have = tokio::fs::metadata(part).await.map(|m| m.len()).unwrap_or(0);
    let mut req = client.get(f.url);
    if have > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let resp = req.send().await.map_err(|e| DownloadError::Network(e.to_string()))?;
    let status = resp.status();
    let (mut file, mut done) = if status == reqwest::StatusCode::PARTIAL_CONTENT {
        (tokio::fs::OpenOptions::new().append(true).open(part).await?, have)
    } else if status.is_success() {
        (tokio::fs::File::create(part).await?, 0)
    } else if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        tokio::fs::remove_file(part).await?;
        return Err(DownloadError::Network("stale partial download discarded".into()));
    } else if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(DownloadError::Network(format!("HTTP {}", status.as_u16())));
    } else {
        return Err(DownloadError::Http(status.as_u16(), f.url.into()));
    };
    let mut stream = resp.bytes_stream();
    let started = Instant::now();
    let start_done = done;
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut buf: Vec<u8> = Vec::with_capacity(8 << 20);
    while let Some(chunk) = stream.next().await {
        if cancel.is_cancelled() {
            file.write_all(&buf).await?;
            file.flush().await?;
            return Err(DownloadError::Cancelled);
        }
        let chunk = chunk.map_err(|e| DownloadError::Network(e.to_string()))?;
        buf.extend_from_slice(&chunk);
        done += chunk.len() as u64;
        if buf.len() >= (4 << 20) {
            file.write_all(&buf).await?;
            buf.clear();
        }
        if last_emit.elapsed() >= Duration::from_millis(150) {
            let secs = started.elapsed().as_secs_f64().max(1e-3);
            on_progress(Progress { file: f.file_name.into(), phase: "download", done, total: f.size, bytes_per_sec: (done - start_done) as f64 / secs });
            last_emit = Instant::now();
        }
    }
    file.write_all(&buf).await?;
    file.flush().await?;
    file.sync_all().await?;
    on_progress(Progress { file: f.file_name.into(), phase: "download", done, total: f.size, bytes_per_sec: 0.0 });
    if done < f.size {
        return Err(DownloadError::Network(format!("connection closed at {done} of {} bytes", f.size)));
    }
    Ok(())
}

/// Streaming SHA-256 with progress (the pinned GGUF is several GB).
pub async fn sha256_file(path: &Path, label: &str, cancel: &Cancel, on_progress: &mut impl FnMut(Progress)) -> Result<String, DownloadError> {
    let total = tokio::fs::metadata(path).await?.len();
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 8 << 20];
    let mut done = 0u64;
    let started = Instant::now();
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    loop {
        if cancel.is_cancelled() {
            return Err(DownloadError::Cancelled);
        }
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        done += n as u64;
        if last_emit.elapsed() >= Duration::from_millis(150) {
            on_progress(Progress { file: label.into(), phase: "verify", done, total, bytes_per_sec: done as f64 / started.elapsed().as_secs_f64().max(1e-3) });
            last_emit = Instant::now();
        }
    }
    on_progress(Progress { file: label.into(), phase: "verify", done, total, bytes_per_sec: 0.0 });
    Ok(hex::encode(hasher.finalize()))
}
