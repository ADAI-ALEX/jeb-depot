/**
 * The bridge to the desktop shell. Inside the app every call is a Tauri IPC command handled by the Rust side
 * (jeb-core). In a plain browser (vite preview) there is no local model, and this says so instead of faking one.
 */
import type { JebTransport, JebWireResult } from "../decision/jebEngine";
import type { RunRecord } from "../run/record";

export type Stage = "checking_runtime" | "checking_model" | "needs_download" | "downloading" | "verifying" | "starting_inference" | "optimising" | "online" | "failed" | "stopped";

export interface Progress {
  file: string;
  phase: "download" | "verify";
  done: number;
  total: number;
  bytesPerSec: number;
}

export interface SetupEvent {
  stage: Stage;
  message: string;
  progress?: Progress;
  error?: string;
}

export interface FileStatus {
  id: string;
  fileName: string;
  size: number;
  sha256: string;
  installed: boolean;
  verified: boolean;
  partialBytes: number;
  repo: string;
  revision: string;
  description: string;
}

export interface CheckReport {
  runtimeOk: boolean;
  runtimeVersion: string | null;
  runtimeError: string | null;
  files: FileStatus[];
  downloadBytes: number;
  installBytes: number;
  requiredFreeBytes: number;
  freeBytes: number | null;
  modelPath: string;
}

export interface StartupMetrics {
  model_load_ms: number | null;
  first_inference_ms: number | null;
  warm_inference_ms: number | null;
  verify_ms: number | null;
}

export interface ProcessInfo {
  pid: number;
  port: number;
  url: string;
  loadMs: number;
  args: string[];
}

export interface RuntimeStatus {
  alive: boolean;
  online: boolean;
  process: ProcessInfo | null;
  startup: StartupMetrics;
  lastEvent: SetupEvent | null;
  uiReadyMs: number | null;
  appToOnlineMs: number | null;
}

export interface ProcessSample {
  pid: number;
  residentBytes: number;
  footprintBytes: number;
  cpuSeconds: number;
}

export interface ResourceSample {
  t: number;
  inference: ProcessSample | null;
  app: ProcessSample | null;
  gpu: { model: string; cores: number; utilizationPct: number | null; inUseMemory: number | null };
}

export interface AppInfo {
  version: string;
  name: string;
  dataDir: string;
  llamaBin: string;
  uptimeMs: number;
  model: { name: string; source: string; quantisation: string; file: string; size: number; repo: string; revision: string; sha256: string };
  runtime: { llamaBuild: number; llamaCommit: string };
}

export interface RunListItem {
  meta: RunRecord["meta"];
  outcome: RunRecord["outcome"];
  finalScore: number;
  stats: RunRecord["stats"];
  packagesTotal: number;
  ticks: number;
  bytes: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Diagnostics = Record<string, any>;

export interface Backend extends JebTransport {
  readonly inApp: boolean;
  appInfo(): Promise<AppInfo>;
  frontendReady(): Promise<number>;
  setupCheck(): Promise<CheckReport>;
  setupInstall(): Promise<void>;
  setupCancel(): Promise<void>;
  runtimeStart(): Promise<{ startup: StartupMetrics; process: ProcessInfo; appToOnlineMs: number }>;
  runtimeStop(): Promise<void>;
  runtimeStatus(): Promise<RuntimeStatus>;
  sampleResources(): Promise<ResourceSample>;
  diagnostics(): Promise<Diagnostics>;
  revealModel(): Promise<void>;
  revealLogs(): Promise<void>;
  clearModelCache(): Promise<number>;
  checkUpdates(): Promise<unknown[]>;
  saveRun(record: RunRecord): Promise<string>;
  listRuns(): Promise<RunListItem[]>;
  loadRun(id: string): Promise<RunRecord>;
  deleteRun(id: string): Promise<void>;
  saveBenchmark(report: Record<string, unknown>): Promise<string>;
  onSetup(cb: (ev: SetupEvent) => void): () => void;
}

class TauriBackend implements Backend {
  readonly name = "tauri";
  readonly inApp = true;
  // Loaded lazily so the browser preview never touches Tauri globals.
  private core = import("@tauri-apps/api/core");
  private events = import("@tauri-apps/api/event");

  private async call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await this.core;
    try {
      return await invoke<T>(cmd, args);
    } catch (e) {
      throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));
    }
  }

  decide(body: Record<string, unknown>): Promise<JebWireResult> {
    return this.call("jeb_decide", { body });
  }
  appInfo(): Promise<AppInfo> {
    return this.call("app_info");
  }
  frontendReady(): Promise<number> {
    return this.call("frontend_ready");
  }
  setupCheck(): Promise<CheckReport> {
    return this.call("setup_check");
  }
  setupInstall(): Promise<void> {
    return this.call("setup_install");
  }
  setupCancel(): Promise<void> {
    return this.call("setup_cancel");
  }
  runtimeStart(): Promise<{ startup: StartupMetrics; process: ProcessInfo; appToOnlineMs: number }> {
    return this.call("runtime_start");
  }
  runtimeStop(): Promise<void> {
    return this.call("runtime_stop");
  }
  runtimeStatus(): Promise<RuntimeStatus> {
    return this.call("runtime_status");
  }
  sampleResources(): Promise<ResourceSample> {
    return this.call("sample_resources");
  }
  diagnostics(): Promise<Diagnostics> {
    return this.call("diagnostics");
  }
  revealModel(): Promise<void> {
    return this.call("reveal_model");
  }
  revealLogs(): Promise<void> {
    return this.call("reveal_logs");
  }
  clearModelCache(): Promise<number> {
    return this.call("clear_model_cache");
  }
  checkUpdates(): Promise<unknown[]> {
    return this.call("check_updates");
  }
  saveRun(record: RunRecord): Promise<string> {
    return this.call("save_run", { record });
  }
  listRuns(): Promise<RunListItem[]> {
    return this.call("list_runs");
  }
  loadRun(id: string): Promise<RunRecord> {
    return this.call("load_run", { id });
  }
  deleteRun(id: string): Promise<void> {
    return this.call("delete_run", { id });
  }
  saveBenchmark(report: Record<string, unknown>): Promise<string> {
    return this.call("save_benchmark", { report });
  }
  onSetup(cb: (ev: SetupEvent) => void): () => void {
    let un: (() => void) | null = null;
    let cancelled = false;
    void this.events.then(({ listen }) =>
      listen<SetupEvent>("jeb://setup", (e) => cb(e.payload)).then((f) => {
        if (cancelled) f();
        else un = f;
      }),
    );
    return () => {
      cancelled = true;
      un?.();
    };
  }
}

const NOT_IN_APP = "The browser preview has no local model. Open JEB Depot.app to run JEB-4B.";

/** Browser preview: RULES and MANUAL work; everything that needs the local model reports that it is unavailable. */
class PreviewBackend implements Backend {
  readonly name = "preview";
  readonly inApp = false;
  private runs = new Map<string, RunRecord>();
  decide(): Promise<JebWireResult> {
    return Promise.reject(new Error(NOT_IN_APP));
  }
  async appInfo(): Promise<AppInfo> {
    return { version: "preview", name: "JEB Depot (browser preview)", dataDir: "-", llamaBin: "-", uptimeMs: performance.now(), model: { name: "JEB-4B", source: "-", quantisation: "-", file: "-", size: 0, repo: "-", revision: "-", sha256: "-" }, runtime: { llamaBuild: 0, llamaCommit: "-" } };
  }
  async frontendReady(): Promise<number> {
    return performance.now();
  }
  async setupCheck(): Promise<CheckReport> {
    return { runtimeOk: false, runtimeVersion: null, runtimeError: NOT_IN_APP, files: [], downloadBytes: 0, installBytes: 0, requiredFreeBytes: 0, freeBytes: null, modelPath: "-" };
  }
  setupInstall(): Promise<void> {
    return Promise.reject(new Error(NOT_IN_APP));
  }
  async setupCancel(): Promise<void> {}
  runtimeStart(): Promise<never> {
    return Promise.reject(new Error(NOT_IN_APP));
  }
  async runtimeStop(): Promise<void> {}
  async runtimeStatus(): Promise<RuntimeStatus> {
    return { alive: false, online: false, process: null, startup: { model_load_ms: null, first_inference_ms: null, warm_inference_ms: null, verify_ms: null }, lastEvent: null, uiReadyMs: null, appToOnlineMs: null };
  }
  sampleResources(): Promise<ResourceSample> {
    return Promise.reject(new Error(NOT_IN_APP));
  }
  async diagnostics(): Promise<Diagnostics> {
    return { error: NOT_IN_APP };
  }
  revealModel(): Promise<void> {
    return Promise.reject(new Error(NOT_IN_APP));
  }
  revealLogs(): Promise<void> {
    return Promise.reject(new Error(NOT_IN_APP));
  }
  clearModelCache(): Promise<number> {
    return Promise.reject(new Error(NOT_IN_APP));
  }
  checkUpdates(): Promise<unknown[]> {
    return Promise.reject(new Error(NOT_IN_APP));
  }
  async saveRun(record: RunRecord): Promise<string> {
    this.runs.set(record.meta.id, record);
    return "(memory)";
  }
  async listRuns(): Promise<RunListItem[]> {
    return [...this.runs.values()].map((r) => ({ meta: r.meta, outcome: r.outcome, finalScore: r.finalScore, stats: r.stats, packagesTotal: r.packagesTotal, ticks: r.ticks.length, bytes: 0 })).reverse();
  }
  async loadRun(id: string): Promise<RunRecord> {
    const r = this.runs.get(id);
    if (!r) throw new Error(`no run ${id}`);
    return r;
  }
  async deleteRun(id: string): Promise<void> {
    this.runs.delete(id);
  }
  async saveBenchmark(): Promise<string> {
    return "(memory)";
  }
  onSetup(): () => void {
    return () => {};
  }
}

export function createBackend(): Backend {
  const w = globalThis as unknown as { __TAURI_INTERNALS__?: unknown };
  return w.__TAURI_INTERNALS__ ? new TauriBackend() : new PreviewBackend();
}
