//! Model / runtime lifecycle: check what is installed, download and verify what is missing, start the local
//! inference process, warm it up, answer decisions, stop and restart it. Shared by the Tauri app and `jebd`.

pub mod download;
pub mod llama_process;
pub mod manifest;
pub mod sysinfo;

use crate::decide::Calibration;
use crate::engine::Scheduling;
use crate::prompt::HfTokenizer;
use crate::service::{DecideOutput, JebService, ServiceError};
use download::{Cancel, DownloadError, Progress};
use llama_process::{LlamaConfig, LlamaProcess, ProcessInfo, StartError};
use manifest::{InstalledFile, InstalledManifest, PinnedFile, FILES, MODEL_GGUF, TOKENIZER};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex, RwLock};

#[derive(Debug, Clone)]
pub struct Paths {
    /// App-managed data directory (models, logs, state). Never a user-chosen folder.
    pub data: PathBuf,
    pub models: PathBuf,
    pub logs: PathBuf,
    pub state: PathBuf,
    /// The bundled `llama-server` executable (its dylibs sit next to it).
    pub llama_bin: PathBuf,
}

impl Paths {
    pub fn new(data: PathBuf, llama_bin: PathBuf) -> Self {
        Paths { models: data.join("models"), logs: data.join("logs"), state: data.join("state"), data, llama_bin }
    }

    pub fn ensure(&self) -> std::io::Result<()> {
        for d in [&self.data, &self.models, &self.logs, &self.state] {
            std::fs::create_dir_all(d)?;
        }
        Ok(())
    }

    pub fn file(&self, f: &PinnedFile) -> PathBuf {
        self.models.join(f.file_name)
    }

    fn installed_path(&self) -> PathBuf {
        self.models.join("installed.json")
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    CheckingRuntime,
    CheckingModel,
    NeedsDownload,
    Downloading,
    Verifying,
    StartingInference,
    Optimising,
    Online,
    Failed,
    Stopped,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupEvent {
    pub stage: Stage,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<Progress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl SetupEvent {
    fn new(stage: Stage, message: impl Into<String>) -> Self {
        SetupEvent { stage, message: message.into(), progress: None, error: None }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub id: String,
    pub file_name: String,
    pub size: u64,
    pub sha256: String,
    /// Present with the pinned size.
    pub installed: bool,
    /// SHA-256 checked against the pin (re-checked at start whenever size or mtime changed).
    pub verified: bool,
    /// Bytes already in a resumable partial download.
    pub partial_bytes: u64,
    pub repo: String,
    pub revision: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckReport {
    pub runtime_ok: bool,
    pub runtime_version: Option<String>,
    pub runtime_error: Option<String>,
    pub files: Vec<FileStatus>,
    /// Bytes still to download (partial downloads already subtracted).
    pub download_bytes: u64,
    /// Final on-disk size of everything installed.
    pub install_bytes: u64,
    /// Free space needed now: the rest of the download plus headroom.
    pub required_free_bytes: u64,
    pub free_bytes: Option<u64>,
    pub model_path: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StartupMetrics {
    /// Spawn of llama-server until it reports ready (model mapped, Metal buffers allocated).
    pub model_load_ms: Option<f64>,
    /// First decision after load (includes Metal pipeline compilation for the shapes used).
    pub first_inference_ms: Option<f64>,
    /// Warm decision on the same canned state, for comparison.
    pub warm_inference_ms: Option<f64>,
    /// Hashing time of the model on this launch (0 when the recorded verification was still valid).
    pub verify_ms: Option<f64>,
}

pub struct Runtime {
    pub paths: Paths,
    http: reqwest::Client,
    pub cancel: Cancel,
    process: Mutex<Option<LlamaProcess>>,
    service: RwLock<Option<Arc<JebService>>>,
    pub startup: Mutex<StartupMetrics>,
    last_event: Mutex<Option<SetupEvent>>,
    process_info: Mutex<Option<ProcessInfo>>,
    install_lock: Mutex<()>,
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn mtime_secs(p: &Path) -> Option<i64> {
    std::fs::metadata(p).ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs() as i64)
}

#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error(transparent)]
    Download(#[from] DownloadError),
    #[error(transparent)]
    Start(#[from] StartError),
    #[error("{0}")]
    Other(String),
}

/// A representative robot tick (the shape the simulator sends) used to warm the Metal pipelines.
fn warmup_request() -> Value {
    json!({
        "model": "jeb-4b",
        "state": "ROBOT: tile (3,4), facing east, battery 88%, not carrying\nTARGET: package A at shelf row 2, 6 steps on the planned route\nFORWARD: open floor, on route, 5 steps from there\nLEFT: shelf, blocked\nRIGHT: open floor, 7 steps from there\nREVERSE: open floor, 7 steps from there\nTRAFFIC: none within 4 tiles\nHAZARDS: none nearby\nBATTERY: enough for about 170 steps; nearest charger 4 steps away\nMISSION: 0 of 6 delivered, score 0, 300 ticks left",
        "questions": {
            "move": {"type": "choice", "instructions": "Which way should the robot move this tick?", "criteria": {"LEFT": null, "FORWARD": null, "RIGHT": null, "REVERSE": null}},
            "risk": {"type": "score", "instructions": "How risky is the robot's immediate situation?", "criteria": ["LOW", "MEDIUM", "HIGH"]}
        }
    })
}

impl Runtime {
    pub fn new(paths: Paths) -> Self {
        Runtime {
            paths,
            http: download::http_client(),
            cancel: Cancel::default(),
            process: Mutex::new(None),
            service: RwLock::new(None),
            startup: Mutex::new(StartupMetrics::default()),
            last_event: Mutex::new(None),
            process_info: Mutex::new(None),
            install_lock: Mutex::new(()),
        }
    }

    fn load_installed(&self) -> InstalledManifest {
        std::fs::read_to_string(self.paths.installed_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    fn save_installed(&self, m: &InstalledManifest) -> Result<(), RuntimeError> {
        let tmp = self.paths.installed_path().with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(m).unwrap()).map_err(|e| RuntimeError::Other(e.to_string()))?;
        std::fs::rename(&tmp, self.paths.installed_path()).map_err(|e| RuntimeError::Other(e.to_string()))
    }

    /// Is this pinned file present and recorded as verified with the same size and mtime?
    fn verified_record(&self, f: &PinnedFile, m: &InstalledManifest) -> bool {
        let path = self.paths.file(f);
        let Some(rec) = m.get(f.id) else { return false };
        let Ok(meta) = std::fs::metadata(&path) else { return false };
        rec.sha256 == f.sha256 && rec.size == meta.len() && Some(rec.mtime) == mtime_secs(&path)
    }

    pub async fn check(&self) -> CheckReport {
        let _ = self.paths.ensure();
        let (runtime_ok, runtime_version, runtime_error) = if self.paths.llama_bin.is_file() {
            match llama_process::runtime_version(&self.paths.llama_bin).await {
                Ok(v) => (true, Some(v), None),
                Err(e) => (false, None, Some(e)),
            }
        } else {
            (false, None, Some(format!("bundled runtime not found at {}", self.paths.llama_bin.display())))
        };
        let installed = self.load_installed();
        let mut files = Vec::new();
        let mut download_bytes = 0;
        for f in FILES {
            let path = self.paths.file(&f);
            let present = path.is_file() && std::fs::metadata(&path).map(|m| m.len() == f.size).unwrap_or(false);
            let partial = std::fs::metadata(download::part_path(&path)).map(|m| m.len()).unwrap_or(0);
            if !present {
                download_bytes += f.size.saturating_sub(partial);
            }
            files.push(FileStatus {
                id: f.id.into(),
                file_name: f.file_name.into(),
                size: f.size,
                sha256: f.sha256.into(),
                installed: present,
                verified: present && self.verified_record(&f, &installed),
                partial_bytes: partial,
                repo: f.repo.into(),
                revision: f.revision.into(),
                description: f.description.into(),
            });
        }
        let install_bytes: u64 = FILES.iter().map(|f| f.size).sum();
        // Headroom: 512 MB for logs/replays and the filesystem's own reserve.
        let required_free_bytes = if download_bytes > 0 { download_bytes + 512 * 1024 * 1024 } else { 0 };
        CheckReport {
            runtime_ok,
            runtime_version,
            runtime_error,
            files,
            download_bytes,
            install_bytes,
            required_free_bytes,
            free_bytes: sysinfo::free_space(&self.paths.models),
            model_path: self.paths.file(&MODEL_GGUF).display().to_string(),
        }
    }

    async fn emit(&self, ev: SetupEvent, on_event: &(dyn Fn(SetupEvent) + Send + Sync)) {
        *self.last_event.lock().await = Some(ev.clone());
        on_event(ev);
    }

    pub async fn last_event(&self) -> Option<SetupEvent> {
        self.last_event.lock().await.clone()
    }

    /// Download and verify every missing pinned file. Idempotent; resumes partial downloads.
    pub async fn install(&self, on_event: &(dyn Fn(SetupEvent) + Send + Sync)) -> Result<(), RuntimeError> {
        let _guard = self.install_lock.lock().await;
        self.paths.ensure().map_err(|e| RuntimeError::Other(e.to_string()))?;
        self.cancel.reset();
        let mut installed = self.load_installed();
        for f in FILES {
            let dest = self.paths.file(&f);
            if dest.is_file() && std::fs::metadata(&dest).map(|m| m.len() == f.size).unwrap_or(false) {
                continue;
            }
            let label = if f.id == "model" { "Downloading JEB-4B..." } else { "Downloading tokenizer..." };
            self.emit(SetupEvent::new(Stage::Downloading, label), on_event).await;
            let t0 = Instant::now();
            let cb = |p: Progress| {
                let stage = if p.phase == "verify" { Stage::Verifying } else { Stage::Downloading };
                let msg = if p.phase == "verify" { format!("Verifying {}...", f.file_name) } else { label.to_string() };
                let ev = SetupEvent { stage, message: msg, progress: Some(p), error: None };
                if let Ok(mut g) = self.last_event.try_lock() {
                    *g = Some(ev.clone());
                }
                on_event(ev);
            };
            download::fetch_verified(&self.http, &f, &dest, &self.cancel, cb).await?;
            log::info!("installed {} in {:.1} s", f.file_name, t0.elapsed().as_secs_f64());
            installed.upsert(InstalledFile {
                id: f.id.into(),
                file_name: f.file_name.into(),
                sha256: f.sha256.into(),
                size: f.size,
                revision: f.revision.into(),
                repo: f.repo.into(),
                mtime: mtime_secs(&dest).unwrap_or(0),
                verified_at: now_secs(),
            });
            self.save_installed(&installed)?;
        }
        Ok(())
    }

    /// Re-hash installed files whose verification record is missing or stale (size / mtime changed).
    async fn verify_installed(&self, on_event: &(dyn Fn(SetupEvent) + Send + Sync)) -> Result<f64, RuntimeError> {
        let mut installed = self.load_installed();
        let mut spent = 0.0;
        for f in FILES {
            if self.verified_record(&f, &installed) {
                continue;
            }
            let path = self.paths.file(&f);
            let t0 = Instant::now();
            let got = download::sha256_file(&path, f.file_name, &self.cancel, &mut |p: Progress| {
                on_event(SetupEvent { stage: Stage::Verifying, message: format!("Verifying {}...", f.file_name), progress: Some(p), error: None })
            })
            .await?;
            spent += t0.elapsed().as_secs_f64() * 1000.0;
            if got != f.sha256 {
                let _ = std::fs::remove_file(&path);
                return Err(RuntimeError::Download(DownloadError::Checksum { file: f.file_name.into(), got, want: f.sha256.into() }));
            }
            installed.upsert(InstalledFile {
                id: f.id.into(),
                file_name: f.file_name.into(),
                sha256: f.sha256.into(),
                size: f.size,
                revision: f.revision.into(),
                repo: f.repo.into(),
                mtime: mtime_secs(&path).unwrap_or(0),
                verified_at: now_secs(),
            });
            self.save_installed(&installed)?;
        }
        Ok(spent)
    }

    /// Start llama-server with the installed model, load the tokenizer, warm the Metal pipelines.
    pub async fn start(&self, on_event: &(dyn Fn(SetupEvent) + Send + Sync)) -> Result<(), RuntimeError> {
        self.stop().await;
        let verify_ms = self.verify_installed(on_event).await?;
        self.emit(SetupEvent::new(Stage::StartingInference, "Starting local inference..."), on_event).await;
        let cfg = LlamaConfig::new(self.paths.llama_bin.clone(), self.paths.file(&MODEL_GGUF), &self.paths.logs, &self.paths.state);
        let proc = LlamaProcess::start(&cfg).await?;
        let tokenizer = HfTokenizer::from_file(&self.paths.file(&TOKENIZER)).map_err(RuntimeError::Other)?;
        let svc = Arc::new(JebService::new(tokenizer, &proc.info.url, &proc.api_key, Calibration::default()));
        {
            let mut m = self.startup.lock().await;
            m.model_load_ms = Some(proc.info.load_ms);
            m.verify_ms = Some(verify_ms);
        }
        *self.process_info.lock().await = Some(proc.info.clone());
        *self.process.lock().await = Some(proc);
        self.emit(SetupEvent::new(Stage::Optimising, "Optimising for Apple Silicon... (Metal warm-up)"), on_event).await;
        let req = warmup_request();
        let t0 = Instant::now();
        svc.decide(&req, Scheduling::Primed).await.map_err(|e| RuntimeError::Other(format!("warm-up decision failed: {e}")))?;
        let first = t0.elapsed().as_secs_f64() * 1000.0;
        let t1 = Instant::now();
        svc.decide(&req, Scheduling::Primed).await.map_err(|e| RuntimeError::Other(format!("warm-up decision failed: {e}")))?;
        let warm = t1.elapsed().as_secs_f64() * 1000.0;
        {
            let mut m = self.startup.lock().await;
            m.first_inference_ms = Some(first);
            m.warm_inference_ms = Some(warm);
        }
        *self.service.write().await = Some(svc);
        self.emit(SetupEvent::new(Stage::Online, "JEB ONLINE"), on_event).await;
        Ok(())
    }

    pub async fn stop(&self) {
        *self.service.write().await = None;
        if let Some(mut p) = self.process.lock().await.take() {
            p.stop().await;
        }
        *self.process_info.lock().await = None;
    }

    pub fn stop_blocking(&self) {
        if let Ok(mut g) = self.process.try_lock() {
            if let Some(mut p) = g.take() {
                p.stop_blocking();
            }
        }
    }

    pub async fn service(&self) -> Option<Arc<JebService>> {
        self.service.read().await.clone()
    }

    pub async fn process_info(&self) -> Option<ProcessInfo> {
        self.process_info.lock().await.clone()
    }

    /// Is the inference process alive? (It can die underneath us: OOM, kill, crash.)
    pub async fn alive(&self) -> bool {
        match self.process.lock().await.as_mut() {
            Some(p) => p.is_running(),
            None => false,
        }
    }

    pub async fn decide(&self, body: &Value, scheduling: Scheduling) -> Result<DecideOutput, RuntimeError> {
        let svc = self.service().await.ok_or_else(|| RuntimeError::Other("JEB is offline: the local inference process is not running".into()))?;
        match svc.decide(body, scheduling).await {
            Ok(out) => Ok(out),
            Err(ServiceError::Engine(e)) => {
                let alive = self.alive().await;
                Err(RuntimeError::Other(if alive { format!("local inference error: {e}") } else { format!("the local inference process stopped: {e}") }))
            }
            Err(e) => Err(RuntimeError::Other(e.to_string())),
        }
    }

    /// Delete downloaded model files (and partials). The app returns to the first-run screen.
    pub async fn clear_models(&self) -> Result<u64, RuntimeError> {
        self.stop().await;
        let freed = sysinfo::dir_size(&self.paths.models);
        if self.paths.models.exists() {
            std::fs::remove_dir_all(&self.paths.models).map_err(|e| RuntimeError::Other(e.to_string()))?;
        }
        self.paths.ensure().map_err(|e| RuntimeError::Other(e.to_string()))?;
        Ok(freed)
    }

    /// The live process' recent output, else the log file of the last run.
    pub async fn llama_log_tail(&self, lines: usize) -> String {
        if let Some(p) = self.process.lock().await.as_ref() {
            return p.log_tail(lines);
        }
        llama_process::log_tail(&self.paths.logs.join("llama-server.log"), lines)
    }

    /// What the running llama-server reported while loading (device, offload, buffers).
    pub async fn load_report(&self) -> Option<llama_process::LoadReport> {
        self.process.lock().await.as_ref().map(|p| p.load.lock().unwrap().clone())
    }

    /// Compare the pinned revision with the source repository's current state (network).
    pub async fn check_updates(&self) -> Result<Value, RuntimeError> {
        let mut out = Vec::new();
        for f in FILES {
            let url = format!("https://huggingface.co/api/models/{}/tree/main", f.repo);
            let resp = self.http.get(&url).send().await.map_err(|e| RuntimeError::Other(format!("update check failed (offline?): {e}")))?;
            if !resp.status().is_success() {
                return Err(RuntimeError::Other(format!("update check: HTTP {} from {url}", resp.status().as_u16())));
            }
            let tree: Value = resp.json().await.map_err(|e| RuntimeError::Other(e.to_string()))?;
            let entry = tree.as_array().and_then(|a| a.iter().find(|e| e["path"] == f.path_in_repo)).cloned();
            let upstream_sha = entry.as_ref().and_then(|e| e["lfs"]["oid"].as_str().map(String::from));
            let meta: Value = self.http.get(format!("https://huggingface.co/api/models/{}", f.repo)).send().await.map_err(|e| RuntimeError::Other(e.to_string()))?.json().await.map_err(|e| RuntimeError::Other(e.to_string()))?;
            out.push(json!({
                "file": f.file_name,
                "repo": f.repo,
                "pinnedRevision": f.revision,
                "upstreamRevision": meta["sha"],
                "upstreamModified": meta["lastModified"],
                "pinnedSha256": f.sha256,
                "upstreamSha256": upstream_sha,
                "fileChanged": upstream_sha.as_deref().map(|s| s != f.sha256),
            }));
        }
        Ok(Value::Array(out))
    }
}
