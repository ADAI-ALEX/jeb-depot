//! JEB // DEPOT desktop shell: owns the local model lifecycle (jeb-core Runtime) and exposes it to the game UI.
//! Nothing here talks to a cloud service: the only network use is the first-run download of pinned files from
//! Hugging Face and the optional update check, both started by the user.

use jeb_core::runtime::manifest::{self, MODEL_GGUF, TOKENIZER};
use jeb_core::runtime::{llama_process, sysinfo, Paths, Runtime, SetupEvent};
use jeb_core::Scheduling;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tauri::{Emitter, Manager, RunEvent, State};
use tokio::sync::Mutex;

struct AppState {
    runtime: Arc<Runtime>,
    t0: Instant,
    ui_ready_ms: Mutex<Option<f64>>,
    online_ms: Mutex<Option<f64>>,
    runs_dir: PathBuf,
}

type Res<T> = Result<T, String>;

fn emitter(app: &tauri::AppHandle) -> impl Fn(SetupEvent) + Send + Sync + '_ {
    move |ev: SetupEvent| {
        let _ = app.emit("jeb://setup", ev);
    }
}

#[tauri::command]
async fn app_info(state: State<'_, AppState>, app: tauri::AppHandle) -> Res<Value> {
    Ok(json!({
        "version": app.package_info().version.to_string(),
        "name": app.package_info().name,
        "dataDir": state.runtime.paths.data,
        "llamaBin": state.runtime.paths.llama_bin,
        "uptimeMs": state.t0.elapsed().as_secs_f64() * 1000.0,
        "model": {"name": manifest::MODEL_NAME, "source": manifest::MODEL_SOURCE, "quantisation": manifest::QUANTISATION,
                  "file": MODEL_GGUF.file_name, "size": MODEL_GGUF.size, "repo": MODEL_GGUF.repo, "revision": MODEL_GGUF.revision, "sha256": MODEL_GGUF.sha256},
        "runtime": {"llamaBuild": manifest::LLAMA_BUILD, "llamaCommit": manifest::LLAMA_COMMIT},
        // Test switches for unattended end-to-end runs (off unless the variables are set by a test harness).
        "autoInstall": std::env::var_os("JEB_DEPOT_AUTO_INSTALL").is_some(),
        "autoDemo": std::env::var_os("JEB_DEPOT_AUTO_DEMO").is_some(),
        "autoShots": std::env::var_os("JEB_DEPOT_AUTO_SHOTS").is_some(),
    }))
}

/// Save a PNG of the game screen (P key, or automatic in test runs) to <data>/screenshots.
#[tauri::command]
async fn save_screenshot(state: State<'_, AppState>, name: String, png: Vec<u8>) -> Res<String> {
    let name = safe_id(&name)?;
    let dir = state.runtime.paths.data.join("screenshots");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{name}.png"));
    std::fs::write(&path, png).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

/// Record this launch's startup numbers (<data>/state/session.json) so launches can be audited after the fact.
#[tauri::command]
async fn record_session(state: State<'_, AppState>, extra: Value) -> Res<()> {
    let rt = &state.runtime;
    let v = json!({
        "recordedAtMsSinceLaunch": state.t0.elapsed().as_secs_f64() * 1000.0,
        "uiReadyMs": *state.ui_ready_ms.lock().await,
        "appToOnlineMs": *state.online_ms.lock().await,
        "startup": rt.startup.lock().await.clone(),
        "process": rt.process_info().await,
        "loadReport": rt.load_report().await,
        "frontend": extra,
    });
    std::fs::write(rt.paths.state.join("session.json"), serde_json::to_vec_pretty(&v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

#[tauri::command]
async fn frontend_ready(state: State<'_, AppState>) -> Res<f64> {
    let ms = state.t0.elapsed().as_secs_f64() * 1000.0;
    state.ui_ready_ms.lock().await.get_or_insert(ms);
    Ok(ms)
}

#[tauri::command]
async fn setup_check(state: State<'_, AppState>) -> Res<Value> {
    serde_json::to_value(state.runtime.check().await).map_err(|e| e.to_string())
}

#[tauri::command]
async fn setup_install(state: State<'_, AppState>, app: tauri::AppHandle) -> Res<()> {
    state.runtime.install(&emitter(&app)).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn setup_cancel(state: State<'_, AppState>) -> Res<()> {
    state.runtime.cancel.cancel();
    Ok(())
}

#[tauri::command]
async fn runtime_start(state: State<'_, AppState>, app: tauri::AppHandle) -> Res<Value> {
    let rt = state.runtime.clone();
    match rt.start(&emitter(&app)).await {
        Ok(()) => {
            let ms = state.t0.elapsed().as_secs_f64() * 1000.0;
            state.online_ms.lock().await.get_or_insert(ms);
            Ok(json!({"startup": rt.startup.lock().await.clone(), "process": rt.process_info().await, "appToOnlineMs": ms}))
        }
        Err(e) => {
            let msg = e.to_string();
            let _ = app.emit("jeb://setup", json!({"stage": "failed", "message": "Local inference failed to start", "error": msg}));
            Err(msg)
        }
    }
}

#[tauri::command]
async fn runtime_stop(state: State<'_, AppState>) -> Res<()> {
    state.runtime.stop().await;
    Ok(())
}

#[tauri::command]
async fn runtime_status(state: State<'_, AppState>) -> Res<Value> {
    let rt = &state.runtime;
    Ok(json!({
        "alive": rt.alive().await,
        "online": rt.service().await.is_some(),
        "process": rt.process_info().await,
        "startup": rt.startup.lock().await.clone(),
        "lastEvent": rt.last_event().await,
        "uiReadyMs": *state.ui_ready_ms.lock().await,
        "appToOnlineMs": *state.online_ms.lock().await,
    }))
}

#[tauri::command]
async fn jeb_decide(state: State<'_, AppState>, body: Value) -> Res<Value> {
    let out = state.runtime.decide(&body, Scheduling::Primed).await.map_err(|e| e.to_string())?;
    serde_json::to_value(out).map_err(|e| e.to_string())
}

#[tauri::command]
async fn sample_resources(state: State<'_, AppState>) -> Res<Value> {
    let proc = state.runtime.process_info().await;
    let inference = proc.as_ref().and_then(|p| sysinfo::process_sample(p.pid as i32));
    let gpu = tokio::task::spawn_blocking(sysinfo::gpu_registry).await.map_err(|e| e.to_string())?;
    Ok(json!({
        "t": state.t0.elapsed().as_secs_f64() * 1000.0,
        "inference": inference,
        "app": sysinfo::process_sample(std::process::id() as i32),
        "gpu": gpu,
    }))
}

#[tauri::command]
async fn diagnostics(state: State<'_, AppState>) -> Res<Value> {
    let rt = &state.runtime;
    let bin = rt.paths.llama_bin.clone();
    let version = llama_process::runtime_version(&bin).await.ok();
    let devices = llama_process::list_devices(&bin).await;
    let proc = rt.process_info().await;
    let props = match rt.service().await {
        Some(svc) => svc.engine.props().await.ok(),
        None => None,
    };
    let props_summary = props.as_ref().map(|p| {
        json!({
            "model_ftype": p["model_ftype"], "n_ctx": p["default_generation_settings"]["n_ctx"], "total_slots": p["total_slots"],
            "build_info": p["build_info"], "modalities": p["modalities"],
        })
    });
    let hw = tokio::task::spawn_blocking(sysinfo::hardware).await.map_err(|e| e.to_string())?;
    Ok(json!({
        "hardware": hw,
        "runtime": {
            "name": "llama.cpp llama-server", "version": version, "pinnedBuild": manifest::LLAMA_BUILD, "pinnedCommit": manifest::LLAMA_COMMIT,
            "asset": manifest::LLAMA_ASSET, "assetSha256": manifest::LLAMA_ASSET_SHA256, "bin": bin, "devices": devices,
            "args": proc.as_ref().map(|p| p.args.clone()), "pid": proc.as_ref().map(|p| p.pid), "port": proc.as_ref().map(|p| p.port),
            "alive": rt.alive().await, "props": props_summary,
            "ctxSize": manifest::CTX_SIZE, "slots": manifest::PARALLEL_SLOTS, "gpuLayers": manifest::GPU_LAYERS,
        },
        "model": {
            "name": manifest::MODEL_NAME, "source": manifest::MODEL_SOURCE, "quantisation": manifest::QUANTISATION,
            "file": rt.paths.file(&MODEL_GGUF), "size": MODEL_GGUF.size, "sha256": MODEL_GGUF.sha256, "repo": MODEL_GGUF.repo, "revision": MODEL_GGUF.revision,
            "tokenizer": {"repo": TOKENIZER.repo, "revision": TOKENIZER.revision, "sha256": TOKENIZER.sha256},
        },
        "protocol": {
            "port": "szybkie-ai/jeb@4990c9a (schema.py, prompt.py, decide.py)", "template": jeb_core::prompt::TEMPLATE_VERSION,
            "calibration": rt.service().await.map(|s| s.calibration_source().to_string()), "scheduling": "primed", "nProbs": jeb_core::engine::DEFAULT_N_PROBS,
        },
        "process": proc.as_ref().and_then(|p| sysinfo::process_sample(p.pid as i32)),
        "startup": rt.startup.lock().await.clone(),
        "appToUiReadyMs": *state.ui_ready_ms.lock().await,
        "appToOnlineMs": *state.online_ms.lock().await,
        "storage": {"dataDir": rt.paths.data, "modelsBytes": sysinfo::dir_size(&rt.paths.models), "freeBytes": sysinfo::free_space(&rt.paths.data)},
        "loadReport": rt.load_report().await,
        "logTail": rt.llama_log_tail(40).await,
    }))
}

#[tauri::command]
async fn reveal_model(state: State<'_, AppState>) -> Res<()> {
    let p = state.runtime.paths.file(&MODEL_GGUF);
    let target = if p.exists() { p } else { state.runtime.paths.models.clone() };
    std::process::Command::new("/usr/bin/open").arg("-R").arg(&target).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn reveal_logs(state: State<'_, AppState>) -> Res<()> {
    std::process::Command::new("/usr/bin/open").arg(&state.runtime.paths.logs).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn clear_model_cache(state: State<'_, AppState>) -> Res<u64> {
    state.runtime.clear_models().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn check_updates(state: State<'_, AppState>) -> Res<Value> {
    state.runtime.check_updates().await.map_err(|e| e.to_string())
}

fn safe_id(id: &str) -> Res<String> {
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(id.to_string())
    } else {
        Err(format!("invalid run id {id:?}"))
    }
}

#[tauri::command]
async fn save_run(state: State<'_, AppState>, record: Value) -> Res<String> {
    let id = safe_id(record["meta"]["id"].as_str().unwrap_or(""))?;
    std::fs::create_dir_all(&state.runs_dir).map_err(|e| e.to_string())?;
    let path = state.runs_dir.join(format!("{id}.json"));
    std::fs::write(&path, serde_json::to_vec(&record).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

#[tauri::command]
async fn list_runs(state: State<'_, AppState>) -> Res<Vec<Value>> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(&state.runs_dir) else { return Ok(out) };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        // Only the header is needed for the list; runs are small enough to parse whole.
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        out.push(json!({"meta": v["meta"], "outcome": v["outcome"], "finalScore": v["finalScore"], "stats": v["stats"], "packagesTotal": v["packagesTotal"], "ticks": v["ticks"].as_array().map(|a| a.len()), "bytes": text.len()}));
    }
    out.sort_by(|a, b| b["meta"]["startedAt"].as_str().cmp(&a["meta"]["startedAt"].as_str()));
    Ok(out)
}

#[tauri::command]
async fn load_run(state: State<'_, AppState>, id: String) -> Res<Value> {
    let id = safe_id(&id)?;
    let text = std::fs::read_to_string(state.runs_dir.join(format!("{id}.json"))).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_run(state: State<'_, AppState>, id: String) -> Res<()> {
    let id = safe_id(&id)?;
    std::fs::remove_file(state.runs_dir.join(format!("{id}.json"))).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_benchmark(state: State<'_, AppState>, report: Value) -> Res<String> {
    let dir = state.runtime.paths.data.join("benchmarks");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let id = safe_id(report["id"].as_str().unwrap_or(""))?;
    let path = dir.join(format!("{id}.json"));
    std::fs::write(&path, serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

fn llama_bin(app: &tauri::App) -> PathBuf {
    if let Ok(p) = std::env::var("JEB_DEPOT_LLAMA_BIN") {
        return PathBuf::from(p);
    }
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join("llama").join("llama-server");
        if p.is_file() {
            return p;
        }
    }
    // `tauri dev` without copied resources: the fetched runtime in the source tree.
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("llama").join("llama-server")
}

pub fn run() {
    let t0 = Instant::now();
    let app = tauri::Builder::default()
        .setup(move |app| {
            let data = match std::env::var("JEB_DEPOT_DATA_DIR") {
                Ok(d) => PathBuf::from(d),
                Err(_) => app.path().app_data_dir()?,
            };
            let paths = Paths::new(data.clone(), llama_bin(app));
            paths.ensure()?;
            let runtime = Arc::new(Runtime::new(paths));
            app.manage(AppState { runtime: runtime.clone(), t0, ui_ready_ms: Mutex::new(None), online_ms: Mutex::new(None), runs_dir: data.join("runs") });
            // SIGTERM / SIGINT (logout, `kill`, test harnesses) bypass the normal exit path: stop the model first.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tokio::signal::unix::{signal, SignalKind};
                let (Ok(mut term), Ok(mut int)) = (signal(SignalKind::terminate()), signal(SignalKind::interrupt())) else { return };
                tokio::select! {
                    _ = term.recv() => {},
                    _ = int.recv() => {},
                }
                runtime.stop().await;
                handle.exit(0);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            frontend_ready,
            setup_check,
            setup_install,
            setup_cancel,
            runtime_start,
            runtime_stop,
            runtime_status,
            jeb_decide,
            sample_resources,
            diagnostics,
            reveal_model,
            reveal_logs,
            clear_model_cache,
            check_updates,
            save_run,
            list_runs,
            load_run,
            delete_run,
            save_benchmark,
            save_screenshot,
            record_session,
        ])
        .build(tauri::generate_context!())
        .expect("error while building JEB Depot");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // Never leave the inference process running after the app quits.
            if let Some(state) = handle.try_state::<AppState>() {
                state.runtime.stop_blocking();
            }
        }
    });
}
