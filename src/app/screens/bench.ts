/** BENCH: inference latency and resources, JEB vs RULES on identical seeded missions, reproducibility. */
import { POLICIES, type PolicyId } from "../../decision/policies";
import { SMALL, text, wrap } from "../../render/font";
import { C, mix } from "../../render/palette";
import { gameplayBenchmark, inferenceBenchmark, reproducibility, type GameplayRow, type InferenceReport, type ReproReport } from "../../run/benchmark";
import { fmtBytes, fmtMs, pct, type UI } from "../../ui/widgets";
import type { App } from "../app";

type Job = "inference" | "gameplay-quick" | "gameplay-full" | "repro";

export class BenchScreen {
  private job: Job | null = null;
  private progress = "";
  private inference: InferenceReport | null = null;
  private rows: GameplayRow[] = [];
  private repro: ReproReport | null = null;
  private error: string | null = null;
  private abort: AbortController | null = null;
  private policy: PolicyId = "argmax";
  private savedTo: string | null = null;
  private startedAt = "";

  constructor(private app: App) {}

  private async runJob(job: Job): Promise<void> {
    const app = this.app;
    if (this.job) return;
    if (!app.status.online) {
      app.toast("BENCHMARKS NEED JEB ONLINE", C.red);
      return;
    }
    // Nothing else may talk to the model while we measure it.
    if (app.sim.ctl?.running) app.sim.ctl.toggle();
    this.job = job;
    this.error = null;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.startedAt = new Date().toISOString();
    const perms = app.settings.permutations;
    try {
      if (job === "inference") {
        this.progress = "WARMING UP...";
        this.inference = await inferenceBenchmark(app.jeb, app.backend.inApp ? { sample: () => app.backend.sampleResources() } : null, 40, (i) => (this.progress = `REQUEST ${i}/40`), signal);
      } else if (job === "repro") {
        const r = await reproducibility(app.jeb, 1, 1, this.policy, perms, (l, t) => (this.progress = `${l} · TICK ${t}`), signal);
        this.repro = r.report;
        for (const run of r.runs) await app.backend.saveRun(run);
      } else {
        this.rows = [];
        const levels = job === "gameplay-quick" ? [1] : [1, 2, 3, 4];
        await gameplayBenchmark(
          app.jeb,
          { levels, seeds: [1], policy: this.policy, model: "JEB-4B GGUF Q8_0", runtime: "llama.cpp Metal", permutations: perms },
          async (row, run, done, total) => {
            this.rows.push(row);
            this.progress = `${done}/${total} RUNS DONE`;
            await app.backend.saveRun(run);
          },
          (l, t) => (this.progress = `${l} · TICK ${t} · ${this.rows.length} DONE`),
          signal,
        );
      }
      await this.save(job);
      app.toast("BENCHMARK COMPLETE", C.green);
    } catch (e) {
      this.error = e instanceof DOMException && e.name === "AbortError" ? "CANCELLED" : e instanceof Error ? e.message : String(e);
    } finally {
      this.job = null;
      this.progress = "";
      void app.replay.refresh();
    }
  }

  private async save(job: Job): Promise<void> {
    const app = this.app;
    await app.refreshStatus();
    const report = {
      id: `bench-${job}-${Date.now().toString(36)}`,
      job,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      hardware: app.diag?.hardware ?? null,
      runtime: app.diag?.runtime ?? null,
      model: app.diag?.model ?? null,
      loadReport: app.diag?.loadReport ?? null,
      startup: app.status.startup,
      appToOnlineMs: app.status.appToOnlineMs,
      permutations: app.settings.permutations,
      inference: job === "inference" ? this.inference : undefined,
      gameplay: job.startsWith("gameplay") ? this.rows : undefined,
      reproducibility: job === "repro" ? this.repro : undefined,
    };
    this.savedTo = await app.backend.saveBenchmark(report);
  }

  draw(ui: UI, _dt: number): void {
    const fb = ui.fb;
    const app = this.app;
    const busy = this.job !== null;
    const online = app.status.online;
    // controls
    ui.panel(2, 17, 476, 30, "BENCHMARK", { led: busy ? C.amber : online ? C.green : C.red, right: busy ? this.progress : this.savedTo ? "REPORT SAVED" : "" });
    const by = 27;
    if (ui.button(6, by, 92, 14, "INFERENCE ×40", { disabled: busy || !online, accent: C.cyan, tip: "40 real move+risk requests on fixed seeded states" })) void this.runJob("inference");
    if (ui.button(100, by, 92, 14, "GAMEPLAY QUICK", { disabled: busy || !online, accent: C.green, tip: "Level 1, seed 1: JEB and RULES (~2-3 min)" })) void this.runJob("gameplay-quick");
    if (ui.button(194, by, 92, 14, "GAMEPLAY FULL", { disabled: busy || !online, accent: C.green, tip: "Levels 1-4, seed 1: JEB and RULES (~15 min)" })) void this.runJob("gameplay-full");
    if (ui.button(288, by, 76, 14, "REPRO CHECK", { disabled: busy || !online, accent: C.amber, tip: "The same JEB mission twice: identical?" })) void this.runJob("repro");
    const pi = ui.segmented(366, by, 72, 14, POLICIES.map((p) => ({ label: p.short, tip: `JEB policy: ${p.label}`, disabled: busy })), POLICIES.findIndex((p) => p.id === this.policy));
    if (pi !== null) this.policy = (POLICIES[pi] as { id: PolicyId }).id;
    if (ui.button(440, by, 34, 14, "STOP", { disabled: !busy, accent: C.red })) this.abort?.abort();
    if (this.error) text(fb, SMALL, this.error.toUpperCase(), 240, 49, C.red, { align: "center", shadow: null, maxWidth: 470 });

    this.drawInference(ui, 2, 54, 190, 212);
    this.drawGameplay(ui, 196, 54, 282, 156);
    this.drawRepro(ui, 196, 214, 282, 52);
  }

  private kv(ui: UI, x: number, y: number, w: number, k: string, v: string, c = C.white): void {
    text(ui.fb, SMALL, k, x, y, C.steel3, { shadow: null });
    text(ui.fb, SMALL, v, x + w, y, c, { align: "right", shadow: null });
  }

  private drawInference(ui: UI, x: number, y: number, w: number, h: number): void {
    const app = this.app;
    ui.panel(x, y, w, h, "INFERENCE ON THIS MAC");
    const r = this.inference;
    const st = app.status.startup;
    const hw = app.diag?.hardware;
    const lr = app.diag?.loadReport;
    const ix = x + 7;
    const iw = w - 14;
    let ly = y + 10;
    const row = (k: string, v: string, c?: number): void => {
      this.kv(ui, ix, ly, iw, k, v, c);
      ly += 7;
    };
    row("DEVICE", hw ? `${hw.cpu} · ${Math.round(hw.memoryBytes / 2 ** 30)} GB` : "--");
    row("GPU", lr?.device ? `${lr.device} (${hw?.gpuCores ?? "?"} CORES)` : "--");
    row("OFFLOAD", lr?.layersOffloaded ?? "--", C.green);
    row("MODEL SIZE", fmtBytes(app.info?.model.size));
    ly += 2;
    text(ui.fb, SMALL, "STARTUP", ix, ly, C.cyan, { shadow: null });
    ly += 8;
    row("APP START → UI READY", fmtMs(app.diag?.appToUiReadyMs));
    row("COLD START → JEB ONLINE", fmtMs(app.status.appToOnlineMs));
    row("MODEL LOAD (SPAWN→READY)", fmtMs(st?.modelLoadMs));
    row("FIRST INFERENCE (COLD)", fmtMs(st?.firstInferenceMs));
    row("WARM INFERENCE", fmtMs(st?.warmInferenceMs));
    ly += 2;
    text(ui.fb, SMALL, r ? `LATENCY · ${r.n} REQUESTS × ${r.questionsPerRequest} QUESTIONS` : "LATENCY · RUN INFERENCE ×40", ix, ly, C.cyan, { shadow: null });
    ly += 8;
    if (r) {
      text(ui.fb, SMALL, "MS", ix, ly, C.steel, { shadow: null });
      ["MEAN", "P50", "P95", "P99"].forEach((k, i) => text(ui.fb, SMALL, k, ix + 70 + i * 28, ly, C.steel, { align: "right", shadow: null }));
      ly += 7;
      const line = (label: string, s: InferenceReport["model"], c: number): void => {
        text(ui.fb, SMALL, label, ix, ly, c, { shadow: null });
        [s.mean, s.p50, s.p95, s.p99].forEach((v, i) => text(ui.fb, SMALL, v === null ? "--" : `${Math.round(v)}`, ix + 70 + i * 28, ly, C.white, { align: "right", shadow: null }));
        ly += 7;
      };
      line("MODEL ONLY", r.model, C.cyan);
      line("BACKEND", r.backend, C.mist);
      line("END-TO-END", r.endToEnd, C.amber);
      ly += 2;
      row("DECISIONS / SECOND", `${r.requestsPerSecond.toFixed(2)} (${r.questionsPerSecond.toFixed(1)} Q/S)`);
      row("PROMPT TOKENS / REQUEST", `${Math.round(r.tokensPerRequest)} (${Math.round(r.promptTokensPerSecond)} TOK/S)`);
      row("RAM (LLAMA-SERVER PEAK)", `${fmtBytes(r.peakFootprintBytes)} FOOTPRINT`);
      row("CPU (LLAMA-SERVER)", r.cpuUtilizationPct === null ? "--" : `${Math.round(r.cpuUtilizationPct)}% OF ONE CORE`);
      row("GPU UTILISATION", r.gpuUtilizationPct === null ? "--" : `${Math.round(r.gpuUtilizationPct)}% (IOKIT, ${r.samples} SAMPLES)`);
      row("ENERGY / POWER", "NOT MEASURED (NEEDS ROOT)", C.steel);
    } else wrap(ui.fb, SMALL, "MODEL = LLAMA-SERVER'S OWN COMPUTE TIME. END-TO-END = WHAT THE GAME WAITS: TOKENIZATION, PRIMING, EVERY LLAMA-SERVER CALL, IPC AND JSON.", ix, ly, iw, C.steel3, { shadow: null });
  }

  private drawGameplay(ui: UI, x: number, y: number, w: number, h: number): void {
    const fb = ui.fb;
    ui.panel(x, y, w, h, "GAMEPLAY · IDENTICAL SEEDED MISSIONS", { right: `${this.rows.length} RUNS` });
    const cols = [
      { k: "RUN", x: 7, a: "left" as const },
      { k: "DLV", x: 88, a: "right" as const },
      { k: "FAIL", x: 108, a: "right" as const },
      { k: "HIT", x: 124, a: "right" as const },
      { k: "BAT", x: 142, a: "right" as const },
      { k: "SCORE", x: 170, a: "right" as const },
      { k: "TICKS", x: 194, a: "right" as const },
      { k: "CONF", x: 216, a: "right" as const },
      { k: "E2E/TICK", x: 250, a: "right" as const },
      { k: "DONE", x: 274, a: "right" as const },
    ];
    let ly = y + 10;
    for (const c of cols) text(fb, SMALL, c.k, x + c.x, ly, C.steel, { align: c.a, shadow: null });
    ly += 8;
    if (!this.rows.length) {
      wrap(fb, SMALL, "EACH ROW IS ONE COMPLETE MISSION. JEB AND RULES PLAY THE SAME LEVEL, SEED AND STATE REPRESENTATION. NO WINNER IS PRESET: THESE ARE MEASUREMENTS.", x + 8, ly + 6, w - 16, C.steel3, { shadow: null });
      return;
    }
    for (const r of this.rows.slice(-15)) {
      const s = r.summary;
      const c = r.controller === "jeb" ? C.cyan : C.amber;
      fb.rect(x + 4, ly - 1, w - 8, 7, mix(C.panel, c, 0.08));
      const vals = [
        `L${r.levelId} S${r.seed} ${r.controller === "jeb" ? `JEB ${r.policy.toUpperCase()}` : "RULES"}`,
        `${s.delivered}/${s.total}`,
        `${s.failedDeliveries}`,
        `${s.collisions}`,
        `${Math.round(s.batteryLeft)}%`,
        `${s.score}`,
        `${s.ticks}`,
        r.controller === "jeb" ? pct(s.meanMoveConfidence) : "-",
        r.controller === "jeb" ? fmtMs(s.tick.mean) : "-",
        s.outcome === "complete" ? "✓" : s.outcome === "battery_failure" ? "BAT" : "TIME",
      ];
      cols.forEach((col, i) => text(fb, SMALL, vals[i] as string, x + col.x, ly, i === 0 ? c : C.white, { align: col.a, shadow: null }));
      ly += 7;
    }
    // aggregates
    const agg = (ctl: "jeb" | "rules"): string => {
      const rs = this.rows.filter((r) => r.controller === ctl);
      if (!rs.length) return "--";
      const d = rs.reduce((a, r) => a + r.summary.delivered, 0);
      const t = rs.reduce((a, r) => a + r.summary.total, 0);
      const hits = rs.reduce((a, r) => a + r.summary.collisions, 0);
      const sc = rs.reduce((a, r) => a + r.summary.score, 0);
      const bf = rs.reduce((a, r) => a + r.summary.batteryFailures, 0);
      return `${d}/${t} DELIVERED (${pct(d / t)}) · ${hits} COLLISIONS · ${bf} BATTERY FAILURES · SCORE ${sc}`;
    };
    fb.rect(x + 4, y + h - 18, w - 8, 1, C.panel3);
    text(fb, SMALL, `JEB   ${agg("jeb")}`, x + 7, y + h - 15, C.cyan, { shadow: null, maxWidth: w - 14 });
    text(fb, SMALL, `RULES ${agg("rules")}`, x + 7, y + h - 8, C.amber, { shadow: null, maxWidth: w - 14 });
  }

  private drawRepro(ui: UI, x: number, y: number, w: number, h: number): void {
    const fb = ui.fb;
    ui.panel(x, y, w, h, "REPRODUCIBILITY", { accent: C.amber });
    const r = this.repro;
    if (!r) {
      wrap(fb, SMALL, "RUNS THE SAME JEB MISSION (L1, SEED 1) TWICE AND COMPARES EVERY ACTION AND EVERY PROBABILITY. SIMULATION AND SAMPLING ARE SEEDED; THE MODEL RUNS AT TEMPERATURE 0.", x + 8, y + 12, w - 16, C.steel3, { shadow: null });
      return;
    }
    const ok = r.actionsIdentical;
    text(fb, SMALL, ok ? "✓ IDENTICAL RUNS" : `✕ DIVERGED AT TICK ${r.firstDivergence}`, x + 8, y + 12, ok ? C.green : C.amber, { shadow: null });
    text(fb, SMALL, `L${r.levelId} S${r.seed} ${r.policy.toUpperCase()} · TICKS ${r.ticksA} / ${r.ticksB} · SCORE ${r.scoreA} / ${r.scoreB}`, x + 8, y + 22, C.white, { shadow: null });
    text(fb, SMALL, `LARGEST PROBABILITY DIFFERENCE BETWEEN THE RUNS: ${r.maxProbDelta.toFixed(6)}`, x + 8, y + 32, C.mist, { shadow: null });
    text(fb, SMALL, "BOTH RUNS SAVED: COMPARE THEM IN REPLAY", x + 8, y + 42, C.steel3, { shadow: null });
  }
}
