//! Lifecycle of the local `llama-server` child process: spawn on a free loopback port with a random API key, wait
//! for the model to load, capture logs, stop it cleanly, and clean up a stale child left by a crash.

use super::manifest::{CTX_SIZE, GPU_LAYERS, PARALLEL_SLOTS};
use serde::Serialize;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};

#[derive(Debug, thiserror::Error)]
pub enum StartError {
    #[error("the bundled llama.cpp runtime is missing ({0})")]
    MissingRuntime(String),
    #[error("model file is missing ({0})")]
    MissingModel(String),
    #[error("could not start llama-server: {0}")]
    Spawn(String),
    #[error("llama-server exited during startup (status {status}). Last log lines:\n{tail}")]
    Exited { status: String, tail: String },
    #[error("llama-server did not become ready within {0} s")]
    Timeout(u64),
}

#[derive(Debug, Clone)]
pub struct LlamaConfig {
    pub bin: PathBuf,
    pub model: PathBuf,
    pub log_path: PathBuf,
    pub pid_path: PathBuf,
    pub ctx_size: u32,
    pub gpu_layers: u32,
    pub parallel: u32,
    pub startup_timeout: Duration,
}

impl LlamaConfig {
    pub fn new(bin: PathBuf, model: PathBuf, logs_dir: &Path, state_dir: &Path) -> Self {
        LlamaConfig {
            bin,
            model,
            log_path: logs_dir.join("llama-server.log"),
            pid_path: state_dir.join("llama-server.pid"),
            ctx_size: CTX_SIZE,
            gpu_layers: GPU_LAYERS,
            parallel: PARALLEL_SLOTS,
            startup_timeout: Duration::from_secs(180),
        }
    }

    pub fn args(&self, port: u16, api_key: &str) -> Vec<String> {
        vec![
            "-m".into(),
            self.model.display().to_string(),
            "--host".into(),
            "127.0.0.1".into(),
            "--port".into(),
            port.to_string(),
            "-ngl".into(),
            self.gpu_layers.to_string(),
            "-c".into(),
            self.ctx_size.to_string(),
            "-np".into(),
            self.parallel.to_string(),
            "--cache-ram".into(),
            "0".into(),
            "--no-webui".into(),
            "--alias".into(),
            "jeb-4b".into(),
            // Info level, so the load report (device, layers offloaded, buffer sizes) is printed; the log file is capped.
            "-lv".into(),
            "4".into(),
            "--api-key".into(),
            api_key.to_string(),
        ]
    }
}

/// What llama-server reported while loading the model (parsed from its log, not assumed).
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LoadReport {
    pub device: Option<String>,
    pub layers_offloaded: Option<String>,
    pub gpu_model_buffer_mib: Option<f64>,
    pub cpu_model_buffer_mib: Option<f64>,
    pub kv_buffer_mib: Option<f64>,
    pub recurrent_buffer_mib: Option<f64>,
    pub compute_buffer_mib: Option<f64>,
    pub n_ctx_slot: Option<u64>,
    pub model_type: Option<String>,
    pub threads: Option<u64>,
}

impl LoadReport {
    fn mib(line: &str) -> Option<f64> {
        let tail = line.split('=').nth(1)?.trim();
        tail.split_whitespace().next()?.parse().ok()
    }

    pub fn observe(&mut self, line: &str) {
        if line.contains("ggml_metal_init: found device:") {
            self.device = line.split("found device:").nth(1).map(|s| s.trim().to_string());
        } else if let Some(rest) = line.split("load_tensors: offloaded ").nth(1) {
            self.layers_offloaded = Some(rest.trim().to_string());
        } else if line.contains("MTL0_Mapped model buffer size") || line.contains("MTL0 model buffer size") {
            self.gpu_model_buffer_mib = Self::mib(line);
        } else if line.contains("CPU_Mapped model buffer size") {
            self.cpu_model_buffer_mib = Self::mib(line);
        } else if line.contains("KV buffer size") {
            self.kv_buffer_mib = Self::mib(line);
        } else if line.contains("RS buffer size") {
            self.recurrent_buffer_mib = Self::mib(line);
        } else if line.contains("MTL0 compute buffer size") {
            self.compute_buffer_mib = Self::mib(line);
        } else if let Some(rest) = line.split("n_ctx_slot = ").nth(1) {
            self.n_ctx_slot = rest.split(|c: char| !c.is_ascii_digit()).next().and_then(|s| s.parse().ok());
        } else if let Some(rest) = line.split("threadpool init, n_threads = ").nth(1) {
            self.threads = rest.trim().parse().ok();
        } else if let Some(rest) = line.split("print_info: model type").nth(1) {
            self.model_type = rest.split('=').nth(1).map(|s| s.trim().to_string());
        }
    }
}

/// Log file cap: llama-server logs every request at info level; stop writing past this size.
const LOG_CAP_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub port: u16,
    pub url: String,
    /// Spawn until `/health` answered 200 (model mapped, Metal buffers allocated, slot ready).
    pub load_ms: f64,
    pub args: Vec<String>,
}

pub struct LlamaProcess {
    child: Child,
    pub info: ProcessInfo,
    pub api_key: String,
    pid_path: PathBuf,
    pub load: Arc<std::sync::Mutex<LoadReport>>,
    tail: Arc<std::sync::Mutex<VecDeque<String>>>,
}

type SharedLog = Arc<tokio::sync::Mutex<(Option<tokio::fs::File>, u64)>>;

/// Forward one output stream of the child: parse the load report, keep a tail in memory, append to the capped log.
fn pump<R: tokio::io::AsyncRead + Unpin + Send + 'static>(stream: R, report: Arc<std::sync::Mutex<LoadReport>>, tail: Arc<std::sync::Mutex<VecDeque<String>>>, log: SharedLog) {
    tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(stream).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            report.lock().unwrap().observe(&line);
            {
                let mut t = tail.lock().unwrap();
                if t.len() >= 400 {
                    t.pop_front();
                }
                t.push_back(line.clone());
            }
            let mut g = log.lock().await;
            let (file, written) = &mut *g;
            if let Some(f) = file.as_mut() {
                if *written < LOG_CAP_BYTES {
                    let bytes = format!("{line}\n");
                    *written += bytes.len() as u64;
                    let _ = f.write_all(bytes.as_bytes()).await;
                    if *written >= LOG_CAP_BYTES {
                        let _ = f.write_all(b"[jeb-depot] log capped at 8 MB; later lines are kept in memory only\n").await;
                    }
                }
            }
        }
    });
}

fn free_port() -> std::io::Result<u16> {
    let l = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(l.local_addr()?.port())
}

pub fn random_key() -> String {
    let mut b = [0u8; 24];
    getrandom::fill(&mut b).expect("os randomness");
    hex::encode(b)
}

pub fn log_tail(path: &Path, lines: usize) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

/// A llama-server we started in an earlier session that outlived the app (crash, force quit): stop it.
pub fn kill_stale(pid_path: &Path) {
    let Ok(text) = std::fs::read_to_string(pid_path) else { return };
    let _ = std::fs::remove_file(pid_path);
    let Ok(pid) = text.trim().parse::<i32>() else { return };
    let name = super::sysinfo::process_name(pid);
    if name.as_deref().map(|n| n.contains("llama-server")).unwrap_or(false) {
        log::warn!("stopping stale llama-server pid {pid} from a previous session");
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
        for _ in 0..50 {
            if super::sysinfo::process_name(pid).is_none() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
    }
}

impl LlamaProcess {
    pub async fn start(cfg: &LlamaConfig) -> Result<Self, StartError> {
        if !cfg.bin.is_file() {
            return Err(StartError::MissingRuntime(cfg.bin.display().to_string()));
        }
        if !cfg.model.is_file() {
            return Err(StartError::MissingModel(cfg.model.display().to_string()));
        }
        kill_stale(&cfg.pid_path);
        if let Some(dir) = cfg.log_path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Keep the previous session's log for diagnostics.
        if cfg.log_path.exists() {
            let _ = std::fs::rename(&cfg.log_path, cfg.log_path.with_extension("prev.log"));
        }
        let api_key = random_key();
        let port = free_port().map_err(|e| StartError::Spawn(e.to_string()))?;
        let args = cfg.args(port, &api_key);
        let log_file = tokio::fs::File::create(&cfg.log_path).await.map_err(|e| StartError::Spawn(format!("log file: {e}")))?;
        let log: SharedLog = Arc::new(tokio::sync::Mutex::new((Some(log_file), 0)));
        let report = Arc::new(std::sync::Mutex::new(LoadReport::default()));
        let tail = Arc::new(std::sync::Mutex::new(VecDeque::with_capacity(400)));
        let t0 = Instant::now();
        let mut child = Command::new(&cfg.bin)
            .args(&args)
            .current_dir(cfg.bin.parent().unwrap_or(Path::new("/")))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| StartError::Spawn(e.to_string()))?;
        if let Some(out) = child.stdout.take() {
            pump(out, report.clone(), tail.clone(), log.clone());
        }
        if let Some(err) = child.stderr.take() {
            pump(err, report.clone(), tail.clone(), log.clone());
        }
        let tail_text = |n: usize| -> String {
            let t = tail.lock().unwrap();
            t.iter().skip(t.len().saturating_sub(n)).cloned().collect::<Vec<_>>().join("\n")
        };
        let pid = child.id().unwrap_or(0);
        let _ = std::fs::write(&cfg.pid_path, pid.to_string());
        let url = format!("http://127.0.0.1:{port}");
        let http = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(2)).build().expect("http client");
        loop {
            if let Ok(Some(status)) = child.try_wait() {
                let _ = std::fs::remove_file(&cfg.pid_path);
                // Let the pumps drain the last lines before reporting.
                tokio::time::sleep(Duration::from_millis(150)).await;
                return Err(StartError::Exited { status: status.to_string(), tail: tail_text(25) });
            }
            if t0.elapsed() > cfg.startup_timeout {
                let _ = child.kill().await;
                let _ = std::fs::remove_file(&cfg.pid_path);
                return Err(StartError::Timeout(cfg.startup_timeout.as_secs()));
            }
            if let Ok(r) = http.get(format!("{url}/health")).bearer_auth(&api_key).send().await {
                if r.status().is_success() {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        let load_ms = t0.elapsed().as_secs_f64() * 1000.0;
        // The key is a secret; keep it out of anything we display or log.
        let shown_args = args.iter().map(|a| if *a == api_key { "<random key>".to_string() } else { a.clone() }).collect();
        Ok(LlamaProcess { child, info: ProcessInfo { pid, port, url, load_ms, args: shown_args }, api_key, pid_path: cfg.pid_path.clone(), load: report, tail })
    }

    pub fn log_tail(&self, n: usize) -> String {
        let t = self.tail.lock().unwrap();
        t.iter().skip(t.len().saturating_sub(n)).cloned().collect::<Vec<_>>().join("\n")
    }

    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    pub async fn stop(&mut self) {
        if let Some(pid) = self.child.id() {
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
            if tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await.is_err() {
                let _ = self.child.kill().await;
            }
        }
        let _ = std::fs::remove_file(&self.pid_path);
    }

    /// Synchronous best-effort stop for exit paths that cannot await.
    pub fn stop_blocking(&mut self) {
        if let Some(pid) = self.child.id() {
            unsafe {
                libc::kill(pid as i32, libc::SIGTERM);
            }
            for _ in 0..50 {
                if matches!(self.child.try_wait(), Ok(Some(_))) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = self.child.start_kill();
        }
        let _ = std::fs::remove_file(&self.pid_path);
    }
}

/// `llama-server --version` of the bundled runtime (fast, no model load).
pub async fn runtime_version(bin: &Path) -> Result<String, String> {
    let out = Command::new(bin).arg("--version").stdin(Stdio::null()).output().await.map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stderr).to_string() + &String::from_utf8_lossy(&out.stdout);
    text.lines().find(|l| l.starts_with("version:")).map(|l| l.trim_start_matches("version:").trim().to_string()).ok_or_else(|| format!("unexpected --version output: {}", text.trim()))
}

/// `llama-server --list-devices`: the compute devices the runtime sees (e.g. "MTL0: Apple M1 Pro (12124 MiB, …)").
pub async fn list_devices(bin: &Path) -> Vec<String> {
    let Ok(out) = Command::new(bin).arg("--list-devices").stdin(Stdio::null()).output().await else { return vec![] };
    let text = String::from_utf8_lossy(&out.stdout).to_string() + &String::from_utf8_lossy(&out.stderr);
    text.lines().map(str::trim).filter(|l| l.contains(": ") && (l.starts_with("MTL") || l.starts_with("BLAS") || l.starts_with("CPU"))).map(String::from).collect()
}
