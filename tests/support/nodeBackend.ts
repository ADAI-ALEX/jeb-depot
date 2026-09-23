/**
 * A Backend for driving the real App in Node: decisions go to the real local JEB-4B through `jebd serve`
 * (the same Rust code as the desktop app); runs are kept in memory. Used by the screen harness and E2E test.
 */
import { execFileSync } from "node:child_process";
import type { JebWireResult } from "../../src/decision/jebEngine";
import type { AppInfo, Backend, CheckReport, Diagnostics, ProcessInfo, ResourceSample, RunListItem, RuntimeStatus, SetupEvent, StartupMetrics } from "../../src/platform/backend";
import type { RunRecord } from "../../src/run/record";
import { DEV_DATA, JEBD, JebdProcess, LLAMA_BIN } from "./jebd";

interface JebdStatus {
  process: ProcessInfo | null;
  startup: StartupMetrics;
  hardware: Record<string, unknown>;
  sample: ResourceSample["inference"];
  gpu: ResourceSample["gpu"];
  alive: boolean;
  loadReport: Record<string, unknown> | null;
  logTail: string;
}

export class NodeBackend implements Backend {
  readonly name = "node";
  readonly inApp = true;
  jebd: JebdProcess | null = null;
  private runs = new Map<string, RunRecord>();
  private t0 = performance.now();
  private listeners: ((e: SetupEvent) => void)[] = [];

  decide(body: Record<string, unknown>): Promise<JebWireResult> {
    if (!this.jebd) return Promise.reject(new Error("JEB is offline"));
    return this.jebd.decide(body);
  }

  async appInfo(): Promise<AppInfo> {
    return {
      version: "0.1.0",
      name: "JEB Depot (node harness)",
      dataDir: DEV_DATA,
      llamaBin: LLAMA_BIN,
      uptimeMs: performance.now() - this.t0,
      model: { name: "JEB-4B", source: "szybkie-ai/jeb-4b", quantisation: "GGUF Q8_0", file: "jeb-4b.Q8_0.gguf", size: 4610580768, repo: "mradermacher/jeb-4b-GGUF", revision: "1cd0e3331840840912a81fa5752d2e627c6728f0", sha256: "2966bfb3" },
      runtime: { llamaBuild: 11149, llamaCommit: "d2e54583c" },
    };
  }

  async frontendReady(): Promise<number> {
    return performance.now() - this.t0;
  }

  async setupCheck(): Promise<CheckReport> {
    return JSON.parse(execFileSync(JEBD, ["check", "--data-dir", DEV_DATA, "--llama-bin", LLAMA_BIN]).toString()) as CheckReport;
  }

  setupInstall(): Promise<void> {
    return Promise.reject(new Error("the harness uses the already installed model"));
  }

  async setupCancel(): Promise<void> {}

  async runtimeStart(): Promise<{ startup: StartupMetrics; process: ProcessInfo; appToOnlineMs: number }> {
    for (const l of this.listeners) l({ stage: "starting_inference", message: "Starting local inference..." });
    this.jebd = JebdProcess.serve();
    await this.jebd.ready;
    const s = await this.status();
    for (const l of this.listeners) l({ stage: "online", message: "JEB ONLINE" });
    return { startup: s.startup, process: s.process as ProcessInfo, appToOnlineMs: performance.now() - this.t0 };
  }

  async runtimeStop(): Promise<void> {
    await this.jebd?.close();
    this.jebd = null;
  }

  private status(): Promise<JebdStatus> {
    if (!this.jebd) return Promise.reject(new Error("offline"));
    return this.jebd.call<JebdStatus>("status");
  }

  async runtimeStatus(): Promise<RuntimeStatus> {
    const s = this.jebd ? await this.status() : null;
    return { alive: !!s?.alive, online: !!s?.alive, process: s?.process ?? null, startup: s?.startup ?? { model_load_ms: null, first_inference_ms: null, warm_inference_ms: null, verify_ms: null }, lastEvent: null, uiReadyMs: null, appToOnlineMs: null };
  }

  async sampleResources(): Promise<ResourceSample> {
    const s = await this.status();
    return { t: performance.now() - this.t0, inference: s.sample, app: null, gpu: s.gpu };
  }

  async diagnostics(): Promise<Diagnostics> {
    const s = await this.status();
    return {
      hardware: s.hardware,
      loadReport: s.loadReport,
      logTail: s.logTail,
      process: s.sample,
      startup: s.startup,
      runtime: { version: "0.5.0-dev (build 11149, commit d2e54583c)", pinnedBuild: 11149, pinnedCommit: "d2e54583c", devices: [], pid: s.process?.pid, port: s.process?.port, alive: s.alive, ctxSize: 4096, slots: 1 },
      model: { name: "JEB-4B", quantisation: "GGUF Q8_0", size: 4610580768, file: `${DEV_DATA}/models/jeb-4b.Q8_0.gguf`, repo: "mradermacher/jeb-4b-GGUF", revision: "1cd0e3331840840912a81fa5752d2e627c6728f0", sha256: "2966bfb34b48d4c0917018508be3859132a18296167e1a65c9cad83a10cf969e" },
      protocol: { template: "qwen-chat-v1", nProbs: 40, scheduling: "primed", calibration: "identity" },
      storage: { modelsBytes: 4623388750, freeBytes: null },
      appToUiReadyMs: 0,
    };
  }

  async revealModel(): Promise<void> {}
  async revealLogs(): Promise<void> {}
  clearModelCache(): Promise<number> {
    return Promise.reject(new Error("not in the harness"));
  }
  async checkUpdates(): Promise<unknown[]> {
    return [];
  }
  async saveRun(record: RunRecord): Promise<string> {
    this.runs.set(record.meta.id, structuredClone(record));
    return `(memory) ${record.meta.id}`;
  }
  async listRuns(): Promise<RunListItem[]> {
    return [...this.runs.values()].reverse().map((r) => ({ meta: r.meta, outcome: r.outcome, finalScore: r.finalScore, stats: r.stats, packagesTotal: r.packagesTotal, ticks: r.ticks.length, bytes: 0 }));
  }
  async loadRun(id: string): Promise<RunRecord> {
    const r = this.runs.get(id);
    if (!r) throw new Error(`no run ${id}`);
    return structuredClone(r);
  }
  async deleteRun(id: string): Promise<void> {
    this.runs.delete(id);
  }
  async saveBenchmark(): Promise<string> {
    return "(memory)";
  }
  onSetup(cb: (ev: SetupEvent) => void): () => void {
    this.listeners.push(cb);
    return () => (this.listeners = this.listeners.filter((l) => l !== cb));
  }
}
