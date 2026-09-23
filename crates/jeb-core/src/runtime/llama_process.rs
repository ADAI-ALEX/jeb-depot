//! Lifecycle of the local `llama-server` child process: spawn on a free loopback port with a random API key, wait
//! for the model to load, capture logs, stop it cleanly, and clean up a stale child left by a crash.

use super::manifest::{CTX_SIZE, GPU_LAYERS, PARALLEL_SLOTS};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
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
            "--api-key".into(),
            api_key.to_string(),
        ]
    }
}

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
        let log = std::fs::File::create(&cfg.log_path).map_err(|e| StartError::Spawn(format!("log file: {e}")))?;
        let log2 = log.try_clone().map_err(|e| StartError::Spawn(e.to_string()))?;
        let t0 = Instant::now();
        let mut child = Command::new(&cfg.bin)
            .args(&args)
            .current_dir(cfg.bin.parent().unwrap_or(Path::new("/")))
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log2))
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| StartError::Spawn(e.to_string()))?;
        let pid = child.id().unwrap_or(0);
        let _ = std::fs::write(&cfg.pid_path, pid.to_string());
        let url = format!("http://127.0.0.1:{port}");
        let http = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(2)).build().expect("http client");
        loop {
            if let Ok(Some(status)) = child.try_wait() {
                let _ = std::fs::remove_file(&cfg.pid_path);
                return Err(StartError::Exited { status: status.to_string(), tail: log_tail(&cfg.log_path, 25) });
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
        Ok(LlamaProcess { child, info: ProcessInfo { pid, port, url, load_ms, args: shown_args }, api_key, pid_path: cfg.pid_path.clone() })
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
