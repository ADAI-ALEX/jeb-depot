/** SETTINGS: what is installed and running (all read from the live system), model maintenance, diagnostics. */
import { moveQuestion, riskQuestion } from "../../decision/questions";
import { SMALL, text, wrap } from "../../render/font";
import { C } from "../../render/palette";
import { benchmarkStates } from "../../run/benchmark";
import { fmtBytes, fmtMs, pct, type UI } from "../../ui/widgets";
import type { App } from "../app";

export class SettingsScreen {
  private confirm: "clear" | "redownload" | null = null;
  private confirmUntil = 0;
  private busy: string | null = null;
  private note: { text: string; color: number } | null = null;
  private advanced = true;
  private updates: string[] | null = null;

  constructor(private app: App) {}

  private async act(label: string, f: () => Promise<string>): Promise<void> {
    if (this.busy) return;
    this.busy = label;
    this.note = null;
    try {
      this.note = { text: await f(), color: C.green };
    } catch (e) {
      this.note = { text: e instanceof Error ? e.message : String(e), color: C.red };
    } finally {
      this.busy = null;
      void this.app.loadDiagnostics();
    }
  }

  private async diagnose(): Promise<string> {
    const app = this.app;
    await app.loadDiagnostics();
    if (!app.status.online) return "DIAGNOSTICS REFRESHED · JEB IS OFFLINE, NO TEST DECISION MADE";
    const [s] = await benchmarkStates(1);
    if (!s) return "DIAGNOSTICS REFRESHED";
    const res = await app.jeb.decide(s.obs, s.text, [moveQuestion(), riskQuestion()]);
    const mass = Object.values(res.dists).map((d) => d?.inSetMass ?? 0);
    return `TEST DECISION OK · MODEL ${fmtMs(res.timing?.modelMs)} · REQUEST ${fmtMs(res.timing?.clientMs)} · IN-SET MASS ${pct(Math.min(...mass), 1)}`;
  }

  draw(ui: UI, _dt: number): void {
    const fb = ui.fb;
    const app = this.app;
    const d = app.diag;
    const hw = d?.hardware;
    const lr = d?.loadReport;
    const rt = d?.runtime;
    const online = app.status.online;
    if (this.confirm && app.time > this.confirmUntil) this.confirm = null;

    // model & runtime
    const x = 2;
    const w = 236;
    ui.panel(x, 17, w, 126, "MODEL & RUNTIME", { led: online ? C.green : C.red });
    const ix = x + 7;
    const iw = w - 14;
    let ly = 27;
    const row = (k: string, v: string, c = C.white): void => {
      text(fb, SMALL, k, ix, ly, C.steel3, { shadow: null });
      text(fb, SMALL, v, ix + iw, ly, c, { align: "right", shadow: null, maxWidth: iw - 64 });
      ly += 8;
    };
    row("MODEL", "JEB-4B (SZYBKIE-AI, ROUND 3)");
    row("RUNTIME", rt?.version ? `LLAMA.CPP ${String(rt.version).replace(/\s*\(.*$/, "")} B${rt.pinnedBuild}` : "--");
    row("QUANTISATION", d?.model?.quantisation ?? "--");
    row("MODEL SIZE", fmtBytes(d?.model?.size));
    row("BACKEND", lr?.device ? `METAL · ${lr.device}` : (rt?.devices?.[0] ?? "--"));
    row("DEVICE", hw ? `${hw.macModel} · ${hw.cpu} · ${Math.round(hw.memoryBytes / 2 ** 30)} GB` : "--");
    row("ACCELERATION", lr?.layersOffloaded ? `METAL GPU · ${lr.layersOffloaded}` : online ? "METAL (LOAD REPORT PENDING)" : "--", C.green);
    row("STORAGE USED", d?.storage ? `${fmtBytes(d.storage.modelsBytes)} · ${fmtBytes(d.storage.freeBytes)} FREE` : "--");
    row("STARTUP", "AUTOMATIC ON LAUNCH");
    text(fb, SMALL, "MODEL PATH", ix, ly, C.steel3, { shadow: null });
    ly += 7;
    text(fb, SMALL, String(d?.model?.file ?? "--"), ix, ly, C.mist, { shadow: null, maxWidth: iw - 44 });
    if (ui.button(ix + iw - 42, ly - 3, 42, 11, "REVEAL", { disabled: !app.backend.inApp, tip: "Reveal in Finder" })) void app.backend.revealModel();
    ly += 10;
    text(fb, SMALL, `SOURCE ${d?.model?.repo ?? "--"} @ ${String(d?.model?.revision ?? "").slice(0, 8)}`, ix, ly, C.steel, { shadow: null, maxWidth: iw });

    // actions
    ui.panel(x, 147, w, 66, "MAINTENANCE");
    const bx = ix;
    let by = 156;
    const bw = 108;
    if (ui.button(bx, by, bw, 12, "CHECK FOR MODEL UPDATES", { disabled: !!this.busy || !app.backend.inApp, tip: "Compares the pinned revision with Hugging Face (network)" }))
      void this.act("updates", async () => {
        const r = (await app.backend.checkUpdates()) as { file: string; pinnedRevision: string; upstreamRevision: string; fileChanged: boolean | null }[];
        this.updates = r.map((u) => `${u.file}: ${u.fileChanged ? "UPSTREAM FILE CHANGED" : "UNCHANGED"} (PINNED ${String(u.pinnedRevision).slice(0, 8)}, UPSTREAM ${String(u.upstreamRevision).slice(0, 8)})`);
        return r.some((u) => u.fileChanged) ? "AN UPSTREAM FILE CHANGED: THE APP STAYS ON THE VERIFIED PIN" : "UP TO DATE: UPSTREAM FILES MATCH THE PINNED CHECKSUMS";
      });
    if (ui.button(bx + bw + 6, by, bw, 12, this.confirm === "redownload" ? "CONFIRM RE-DOWNLOAD?" : "RE-DOWNLOAD MODEL", { disabled: !!this.busy || !app.backend.inApp, accent: C.amber, tip: "Deletes the model and downloads it again" })) {
      if (this.confirm !== "redownload") {
        this.confirm = "redownload";
        this.confirmUntil = app.time + 4;
      } else {
        this.confirm = null;
        void this.act("redownload", async () => {
          await app.backend.clearModelCache();
          app.status.online = false;
          app.boot.phase = "checking";
          app.go("boot");
          return "MODEL REMOVED: DOWNLOAD STARTS FROM THE SETUP SCREEN";
        });
      }
    }
    by += 15;
    if (ui.button(bx, by, bw, 12, this.confirm === "clear" ? "CONFIRM CLEAR?" : "CLEAR MODEL CACHE", { disabled: !!this.busy || !app.backend.inApp, accent: C.red, tip: "Stops JEB and deletes the downloaded files" })) {
      if (this.confirm !== "clear") {
        this.confirm = "clear";
        this.confirmUntil = app.time + 4;
      } else {
        this.confirm = null;
        void this.act("clear", async () => {
          const freed = await app.backend.clearModelCache();
          app.status.online = false;
          return `MODEL CACHE CLEARED (${fmtBytes(freed)} FREED). THE APP WILL ASK BEFORE DOWNLOADING AGAIN.`;
        });
      }
    }
    if (ui.button(bx + bw + 6, by, bw, 12, "RUN DIAGNOSTICS", { disabled: !!this.busy, accent: C.cyan, tip: "Refresh system info and make one real test decision" })) void this.act("diag", () => this.diagnose());
    by += 15;
    if (ui.button(bx, by, bw, 12, online ? "RESTART JEB" : "START JEB", { disabled: !!this.busy || !app.backend.inApp, accent: C.green })) void this.act("restart", async () => ((await app.restartJeb()) ? "JEB RESTARTED" : `JEB FAILED TO START: ${app.status.error ?? ""}`));
    if (ui.button(bx + bw + 6, by, bw, 12, "RUN BENCHMARK", { accent: C.cyan })) app.go("bench");
    if (this.busy) text(fb, SMALL, `WORKING: ${this.busy.toUpperCase()}...`, ix, 216, C.amber, { shadow: null });
    else if (this.note) wrap(fb, SMALL, this.note.text.toUpperCase(), ix, 216, iw, this.note.color, { shadow: null, maxLines: 2 });
    if (this.updates) this.updates.forEach((u, i) => text(fb, SMALL, u.toUpperCase(), ix, 232 + i * 7, C.steel3, { shadow: null, maxWidth: iw }));

    // preferences
    ui.panel(x, 247, w, 19);
    text(fb, SMALL, "CRT", ix, 254, C.steel3, { shadow: null });
    const crt = ui.segmented(ix + 16, 251, 44, 11, [{ label: "ON" }, { label: "OFF" }], app.settings.crt ? 0 : 1);
    if (crt !== null) {
      app.settings.crt = crt === 0;
      app.saveSettings();
    }
    text(fb, SMALL, "ROUTE", ix + 66, 254, C.steel3, { shadow: null });
    const rtg = ui.segmented(ix + 90, 251, 44, 11, [{ label: "ON" }, { label: "OFF" }], app.settings.showRoute ? 0 : 1);
    if (rtg !== null) {
      app.settings.showRoute = rtg === 0;
      app.saveSettings();
    }
    text(fb, SMALL, "AVG", ix + 140, 254, C.steel3, { shadow: null });
    const pm = ui.segmented(ix + 156, 251, 44, 11, [{ label: "1×", tip: "One presentation per question (default, faster)" }, { label: "2×", tip: "Average 2 option orderings: less label bias, ~280 ms slower per tick" }], app.settings.permutations - 1);
    if (pm !== null) {
      app.settings.permutations = (pm + 1) as 1 | 2;
      app.saveSettings();
    }

    // advanced diagnostics
    const ax = 242;
    const aw = 236;
    ui.panel(ax, 17, aw, 249, "ADVANCED DIAGNOSTICS", { right: this.advanced ? "▼" : "▶" });
    if (ui.hover(ax, 13, aw, 10) && ui.input.pressed) this.advanced = !this.advanced;
    if (!this.advanced) return;
    const jx = ax + 7;
    const jw = aw - 14;
    let jy = 27;
    const dr = (k: string, v: unknown, c = C.white): void => {
      text(fb, SMALL, k, jx, jy, C.steel3, { shadow: null });
      text(fb, SMALL, v === null || v === undefined || v === "" ? "--" : String(v).toUpperCase(), jx + jw, jy, c, { align: "right", shadow: null, maxWidth: jw - 70 });
      jy += 7;
    };
    const st = app.status.startup;
    dr("OS VERSION", hw ? `MACOS ${hw.osVersion} (${hw.osBuild})` : null);
    dr("CPU", hw ? `${hw.cpu} · ${hw.performanceCores}P + ${hw.efficiencyCores}E` : null);
    dr("GPU", hw ? `${hw.gpu} · ${hw.gpuCores} CORES` : null);
    dr("UNIFIED MEMORY", hw ? fmtBytes(hw.memoryBytes) : null);
    dr("ARCH", hw?.arch);
    dr("RUNTIME VERSION", rt?.version);
    dr("PINNED BUILD", rt ? `B${rt.pinnedBuild} (${rt.pinnedCommit})` : null);
    dr("MODEL VERSION", d?.model ? `${d.model.repo}@${String(d.model.revision).slice(0, 10)}` : null);
    dr("MODEL SHA-256", d?.model ? String(d.model.sha256).slice(0, 16) + "…" : null);
    dr("QUANTISATION", d?.model?.quantisation);
    dr("CONTEXT SIZE", rt ? `${rt.ctxSize} · ${rt.slots} SLOT (${lr?.nCtxSlot ?? "?"} PER SLOT)` : null);
    dr("THREADS", lr?.threads);
    dr("ACCELERATION", lr?.device ? `METAL · ${lr.layersOffloaded ?? "?"}` : null, C.green);
    dr("GPU MODEL BUFFER", lr?.gpuModelBufferMib ? `${lr.gpuModelBufferMib.toFixed(0)} MIB` : null);
    dr("KV / RECURRENT / COMPUTE", lr ? `${lr.kvBufferMib ?? "?"} / ${lr.recurrentBufferMib ?? "?"} / ${lr.computeBufferMib ?? "?"} MIB` : null);
    dr("PORT (LOOPBACK ONLY)", rt?.port ? `127.0.0.1:${rt.port} · API KEY` : null);
    dr("PID", rt?.pid);
    dr("BACKEND STATUS", rt ? (rt.alive ? "RUNNING" : "STOPPED") : null, rt?.alive ? C.green : C.red);
    dr("MODEL LOAD TIME", fmtMs(st?.modelLoadMs));
    dr("FIRST / WARM INFERENCE", `${fmtMs(st?.firstInferenceMs)} / ${fmtMs(st?.warmInferenceMs)}`);
    const lt = app.sim.ctl?.lastTactical?.rec;
    dr("LAST INFERENCE", lt?.timing ? `${fmtMs(lt.timing.modelMs)} MODEL · ${lt.timing.tokensEvaluated} TOK` : null);
    dr("PROCESS MEMORY", d?.process ? `${fmtBytes(d.process.footprintBytes)} FOOTPRINT · ${fmtBytes(d.process.residentBytes)} RSS` : null);
    dr("JEB PROTOCOL", d?.protocol ? `${d.protocol.template} · N_PROBS ${d.protocol.nProbs} · ${d.protocol.scheduling}` : null);
    dr("CALIBRATION", d?.protocol?.calibration ?? "IDENTITY");
    jy += 2;
    text(fb, SMALL, "LLAMA-SERVER LOG (TAIL)", jx, jy, C.cyan, { shadow: null });
    jy += 8;
    ui.well(jx - 2, jy - 2, jw + 4, 266 - jy - 2);
    const lines = String(d?.logTail ?? "").split("\n").filter(Boolean).slice(-9);
    for (const l of lines) {
      text(fb, SMALL, l.replace(/^\d+\.\d+\.\d+\.\d+ /, "").slice(0, 60), jx, jy, C.steel3, { shadow: null, maxWidth: jw });
      jy += 7;
    }
  }
}
