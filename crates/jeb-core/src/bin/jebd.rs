//! `jebd` — headless driver for tests, parity checks and benchmarks (the desktop app does not use it).
//!
//!   jebd check   --data-dir DIR --llama-bin PATH      what is installed, what a download would cost
//!   jebd install --data-dir DIR --llama-bin PATH      download + verify the pinned files (progress on stderr)
//!   jebd serve   --data-dir DIR --llama-bin PATH      start llama-server, then answer JSON lines on stdin
//!   jebd attach  --engine-url URL --tokenizer FILE [--api-key K]
//!                                                     answer JSON lines against an existing llama-server
//!
//! Stdin lines: {"id": 1, "op": "decide", "body": {System One request}, "scheduling": "primed" | "scratch"}
//!              {"id": 2, "op": "status"} | {"id": 3, "op": "restart"} | {"id": 4, "op": "stop"}
//! Stdout lines: {"id": 1, "ok": true, "result": {...}} or {"id": 1, "ok": false, "error": "..."}

use jeb_core::decide::Calibration;
use jeb_core::prompt::HfTokenizer;
use jeb_core::runtime::{sysinfo, Paths, Runtime, SetupEvent};
use jeb_core::{JebService, Scheduling};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn log_event(ev: SetupEvent) {
    match &ev.progress {
        Some(p) => eprintln!("[{:?}] {} {:.1}% ({:.1} MB/s)", ev.stage, p.file, 100.0 * p.done as f64 / p.total.max(1) as f64, p.bytes_per_sec / 1e6),
        None => eprintln!("[{:?}] {}", ev.stage, ev.message),
    }
}

enum Backend {
    Managed(Arc<Runtime>),
    Attached(Arc<JebService>),
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).cloned().unwrap_or_default();
    let paths = || {
        let data = PathBuf::from(arg(&args, "--data-dir").expect("--data-dir required"));
        let bin = PathBuf::from(arg(&args, "--llama-bin").expect("--llama-bin required"));
        Paths::new(data, bin)
    };
    let backend = match cmd.as_str() {
        "check" => {
            let rt = Runtime::new(paths());
            println!("{}", serde_json::to_string_pretty(&rt.check().await).unwrap());
            return;
        }
        "install" => {
            let rt = Runtime::new(paths());
            if let Err(e) = rt.install(&log_event).await {
                eprintln!("install failed: {e}");
                std::process::exit(1);
            }
            println!("{}", serde_json::to_string_pretty(&rt.check().await).unwrap());
            return;
        }
        "serve" => {
            let rt = Arc::new(Runtime::new(paths()));
            if let Err(e) = rt.start(&log_event).await {
                eprintln!("start failed: {e}");
                std::process::exit(2);
            }
            Backend::Managed(rt)
        }
        "attach" => {
            let url = arg(&args, "--engine-url").expect("--engine-url required");
            let tok = HfTokenizer::from_file(&PathBuf::from(arg(&args, "--tokenizer").expect("--tokenizer required"))).unwrap();
            let key = arg(&args, "--api-key").unwrap_or_default();
            Backend::Attached(Arc::new(JebService::new(tok, &url, &key, Calibration::default())))
        }
        _ => {
            eprintln!("usage: jebd check|install|serve|attach ... (see source header)");
            std::process::exit(64);
        }
    };
    eprintln!("[jebd] ready");
    let mut out = tokio::io::stdout();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let _ = out.write_all(format!("{}\n", json!({"ok": false, "error": format!("bad json: {e}")})).as_bytes()).await;
                continue;
            }
        };
        let id = msg["id"].clone();
        let scheduling: Scheduling = serde_json::from_value(msg["scheduling"].clone()).unwrap_or_default();
        let reply = match (msg["op"].as_str().unwrap_or(""), &backend) {
            ("decide", Backend::Managed(rt)) => match rt.decide(&msg["body"], scheduling).await {
                Ok(r) => json!({"id": id, "ok": true, "result": r}),
                Err(e) => json!({"id": id, "ok": false, "error": e.to_string()}),
            },
            ("decide", Backend::Attached(svc)) => match svc.decide(&msg["body"], scheduling).await {
                Ok(r) => json!({"id": id, "ok": true, "result": r}),
                Err(e) => json!({"id": id, "ok": false, "error": e.to_string()}),
            },
            ("tokenize", Backend::Attached(svc)) => {
                use jeb_core::prompt::Tokenize;
                json!({"id": id, "ok": true, "result": svc.tokenizer().encode(msg["text"].as_str().unwrap_or(""))})
            }
            ("tokenize", Backend::Managed(rt)) => match rt.service().await {
                Some(svc) => {
                    use jeb_core::prompt::Tokenize;
                    json!({"id": id, "ok": true, "result": svc.tokenizer().encode(msg["text"].as_str().unwrap_or(""))})
                }
                None => json!({"id": id, "ok": false, "error": "offline"}),
            },
            ("status", Backend::Managed(rt)) => {
                let info = rt.process_info().await;
                let sample = info.as_ref().and_then(|i| sysinfo::process_sample(i.pid as i32));
                json!({"id": id, "ok": true, "result": {"process": info, "startup": rt.startup.lock().await.clone(), "hardware": sysinfo::hardware(), "sample": sample, "gpu": sysinfo::gpu_registry(), "alive": rt.alive().await}})
            }
            ("restart", Backend::Managed(rt)) => match rt.start(&log_event).await {
                Ok(()) => json!({"id": id, "ok": true, "result": {"process": rt.process_info().await, "startup": rt.startup.lock().await.clone()}}),
                Err(e) => json!({"id": id, "ok": false, "error": e.to_string()}),
            },
            ("stop", Backend::Managed(rt)) => {
                rt.stop().await;
                json!({"id": id, "ok": true})
            }
            (op, _) => json!({"id": id, "ok": false, "error": format!("unsupported op {op:?} for this mode")}),
        };
        let _ = out.write_all(format!("{reply}\n").as_bytes()).await;
        let _ = out.flush().await;
        if msg["op"] == "stop" {
            break;
        }
    }
    if let Backend::Managed(rt) = backend {
        rt.stop().await;
    }
}
