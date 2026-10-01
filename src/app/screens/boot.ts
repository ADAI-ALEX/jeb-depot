/**
 * INITIALISING JEB: check the bundled runtime, check the model, offer the download (sizes shown before it
 * starts), download + verify with live progress, start local inference, warm up Metal, then open the simulator.
 */
import { BIG, SMALL, text, wrap } from "../../render/font";
import { C, mix } from "../../render/palette";
import { robotSprite } from "../../render/sprites";
import type { CheckReport } from "../../platform/backend";
import { fmtBytes, fmtMs, type UI } from "../../ui/widgets";
import type { App } from "../app";

type Phase = "checking" | "consent" | "downloading" | "starting" | "online" | "failed" | "no-runtime";

interface Step {
  key: string;
  label: string;
  state: "todo" | "active" | "done" | "skip" | "fail";
  detail: string;
}

export class BootScreen {
  phase: Phase = "checking";
  private steps: Step[] = [
    { key: "runtime", label: "CHECKING LOCAL RUNTIME...", state: "todo", detail: "" },
    { key: "model", label: "CHECKING MODEL...", state: "todo", detail: "" },
    { key: "download", label: "DOWNLOADING JEB-4B...", state: "todo", detail: "" },
    { key: "verify", label: "VERIFYING FILES...", state: "todo", detail: "" },
    { key: "start", label: "STARTING LOCAL INFERENCE...", state: "todo", detail: "" },
    { key: "optimise", label: "OPTIMISING FOR APPLE SILICON...", state: "todo", detail: "" },
  ];
  private check: CheckReport | null = null;
  private error: string | null = null;
  private onlineAt = 0;
  private t = 0;
  private started = false;
  private phaseSeen: Phase | null = null;
  private phaseSince = 0;

  constructor(private app: App) {}

  private step(key: string): Step {
    return this.steps.find((s) => s.key === key) as Step;
  }

  /** Kick off the flow once (called on the first frame). */
  private async run(): Promise<void> {
    const app = this.app;
    this.phase = "checking";
    this.error = null;
    for (const s of this.steps) if (s.state === "fail") s.state = "todo";
    this.step("runtime").state = "active";
    let check: CheckReport;
    try {
      check = await app.backend.setupCheck();
    } catch (e) {
      return this.fail("runtime", e);
    }
    this.check = check;
    app.status.check = check;
    if (!check.runtimeOk) {
      this.step("runtime").state = "fail";
      this.step("runtime").detail = check.runtimeError ?? "runtime unavailable";
      this.phase = "no-runtime";
      this.error = check.runtimeError;
      return;
    }
    this.step("runtime").state = "done";
    this.step("runtime").detail = `LLAMA.CPP ${check.runtimeVersion?.replace(/^.*build (\d+).*$/, "BUILD $1") ?? ""} · METAL · BUNDLED`;
    this.step("model").state = "active";
    await new Promise((r) => setTimeout(r, 250));
    const missing = check.files.filter((f) => !f.installed);
    if (missing.length) {
      this.step("model").state = "done";
      this.step("model").detail = "NOT INSTALLED YET";
      // Unattended test runs (JEB_DEPOT_AUTO_INSTALL) skip the consent click; users always see the sizes first.
      const info = app.info ?? (await app.backend.appInfo().catch(() => null));
      if (info?.autoInstall) {
        await this.install();
        return;
      }
      this.phase = "consent";
      return;
    }
    this.step("model").state = "done";
    this.step("model").detail = "JEB-4B GGUF Q8_0 · INSTALLED";
    this.step("download").state = "skip";
    this.step("download").detail = "ALREADY ON THIS MAC";
    await this.start();
  }

  private async install(): Promise<void> {
    this.phase = "downloading";
    this.error = null;
    this.step("download").state = "active";
    try {
      await this.app.backend.setupInstall();
    } catch (e) {
      return this.fail("download", e);
    }
    this.step("download").state = "done";
    this.step("download").detail = "COMPLETE, SHA-256 VERIFIED";
    this.step("verify").state = "done";
    this.step("verify").detail = "PINNED CHECKSUMS MATCH";
    await this.start();
  }

  private async start(): Promise<void> {
    const app = this.app;
    this.phase = "starting";
    if (this.step("verify").state === "todo") this.step("verify").state = "active";
    try {
      const r = await app.backend.runtimeStart();
      app.status.startup = r.startup;
      app.status.appToOnlineMs = r.appToOnlineMs;
      app.status.online = true;
      for (const s of this.steps) if (s.state === "active" || s.state === "todo") s.state = "done";
      this.step("start").detail = `MODEL LOADED IN ${fmtMs(r.startup.modelLoadMs)}`;
      this.step("optimise").detail = `METAL WARM-UP: FIRST ${fmtMs(r.startup.firstInferenceMs)}, THEN ${fmtMs(r.startup.warmInferenceMs)}`;
      if (this.step("verify").detail === "") this.step("verify").detail = r.startup.verifyMs ? `HASHED IN ${fmtMs(r.startup.verifyMs)}` : "VERIFIED EARLIER, UNCHANGED";
      this.phase = "online";
      this.onlineAt = this.t;
      void app.loadDiagnostics();
    } catch (e) {
      const which = this.steps.find((s) => s.state === "active")?.key ?? "start";
      return this.fail(which, e);
    }
  }

  private fail(key: string, e: unknown): void {
    this.phase = "failed";
    this.error = e instanceof Error ? e.message : String(e);
    const s = this.step(key);
    s.state = "fail";
    s.detail = "FAILED";
    this.app.status.error = this.error;
  }

  draw(ui: UI, dt: number): void {
    this.t += dt;
    const app = this.app;
    const fb = ui.fb;
    if (!this.started) {
      this.started = true;
      void this.run();
    }
    if (this.phase !== this.phaseSeen) {
      this.phaseSeen = this.phase;
      this.phaseSince = this.t;
    }
    if (this.t - this.phaseSince > 0.6) app.autoShot(`boot-${this.phase}`);
    if (this.phase === "downloading") app.autoShot(`boot-downloading-${Math.floor((this.t - this.phaseSince) / 30)}`);
    // Follow live progress events for the active step.
    const st = app.status;
    if (this.phase === "downloading" || this.phase === "starting") {
      if (st.stage === "verifying") this.markActive("verify");
      if (st.stage === "starting_inference") this.markActive("start");
      if (st.stage === "optimising") this.markActive("optimise");
    }

    // backdrop: slow grid + scanning robot
    for (let y = 0; y < fb.h; y += 16) fb.rect(0, y, fb.w, 1, mix(C.void, C.panel2, 0.6));
    for (let x = (Math.floor(this.t * 8) % 16) - 16; x < fb.w; x += 16) fb.rect(x, 0, 1, fb.h, mix(C.void, C.panel2, 0.4));

    const cx = fb.w / 2;
    text(fb, BIG, "INITIALISING JEB", cx, 26, this.phase === "online" ? C.green : C.cyan, { align: "center", scale: 2 });
    text(fb, SMALL, "JEB // DEPOT  ·  LOCAL DECISION MODEL  ·  JEB-4B", cx, 48, C.steel3, { align: "center", shadow: null });
    const bob = Math.round(Math.sin(this.t * 3) * 1);
    fb.blit(robotSprite("S", Math.floor(this.t * 6) % 2, this.phase === "failed" || this.phase === "no-runtime" ? "red" : this.phase === "online" ? "green" : "cyan", mix(C.cyan3, C.white, 0.5 + 0.5 * Math.sin(this.t * 8))), cx - 8, 58 + bob);

    // step list
    const px = 96;
    const pw = 288;
    let y = 82;
    ui.panel(px, y, pw, 104, "SYSTEM CHECK", { led: this.phase === "online" ? C.green : this.phase === "failed" ? C.red : C.amber });
    y += 10;
    for (const s of this.steps) {
      const col = s.state === "done" ? C.green : s.state === "active" ? C.cyan : s.state === "fail" ? C.red : s.state === "skip" ? C.steel3 : C.steel;
      const mark = s.state === "done" ? "✓" : s.state === "fail" ? "✕" : s.state === "skip" ? "-" : s.state === "active" ? ["·", "•", "█", "•"][Math.floor(this.t * 8) % 4] ?? "•" : "·";
      text(fb, BIG, mark, px + 8, y, col, { shadow: null });
      text(fb, SMALL, s.label, px + 18, y + 1, s.state === "todo" ? C.steel : C.white, { shadow: null });
      if (s.detail) text(fb, SMALL, s.detail, px + pw - 8, y + 1, col, { align: "right", shadow: null, maxWidth: 150 });
      y += 11;
      if (s.key === "download" && s.state === "active") y = this.drawProgress(ui, px + 18, y, pw - 26);
      if (s.key === "verify" && (s.state === "active" || (st.stage === "verifying" && st.progress))) y = this.drawProgress(ui, px + 18, y, pw - 26);
    }
    if (this.phase === "online") {
      const blink = Math.floor(this.t * 4) % 2 === 0;
      text(fb, BIG, "JEB ONLINE", cx, 172, blink ? C.green : C.white, { align: "center", scale: 2 });
      if (this.t - this.onlineAt > 1.6) {
        app.go("sim");
        app.sim.onJebOnline();
        void app.backend.recordSession({ screen: "sim", bootSeconds: this.t, phase: this.phase });
        if (app.info?.autoDemo) app.sim.startDemo();
      }
    }

    if (this.phase === "consent" && this.check) this.drawConsent(ui);
    if (this.phase === "failed" || this.phase === "no-runtime") this.drawFailure(ui);
    if (this.phase === "downloading" && ui.button(cx - 30, 246, 60, 13, "CANCEL", { accent: C.amber, hotkey: "Escape" })) void app.backend.setupCancel();

    text(fb, SMALL, "NO CLOUD · NO ACCOUNT · RUNS ON THIS MAC", cx, fb.h - 8, C.steel, { align: "center", shadow: null });
  }

  private markActive(key: string): void {
    let seen = false;
    for (const s of this.steps) {
      if (s.key === key) {
        if (s.state !== "done") s.state = "active";
        seen = true;
      } else if (!seen && s.state === "active") s.state = "done";
    }
  }

  private drawProgress(ui: UI, x: number, y: number, w: number): number {
    const p = this.app.status.progress;
    const fb = ui.fb;
    const frac = p && p.total ? p.done / p.total : 0;
    ui.bar(x, y, w, 5, frac, p?.phase === "verify" ? C.amber : C.cyan, { segments: 40 });
    const eta = p && p.bytesPerSec > 0 ? (p.total - p.done) / p.bytesPerSec : null;
    const info = p ? `${fmtBytes(p.done)} / ${fmtBytes(p.total)}  ·  ${(frac * 100).toFixed(1)}%` + (p.phase === "download" && p.bytesPerSec ? `  ·  ${(p.bytesPerSec / 1e6).toFixed(1)} MB/S  ·  ETA ${eta !== null ? Math.ceil(eta) + "S" : "--"}` : "") : "CONNECTING...";
    text(fb, SMALL, info, x, y + 7, C.mist, { shadow: null });
    text(fb, SMALL, p?.file ?? "", x + w, y + 7, C.steel3, { align: "right", shadow: null });
    return y + 16;
  }

  private drawConsent(ui: UI): void {
    const c = this.check as CheckReport;
    const fb = ui.fb;
    const x = 84;
    const y = 190;
    const w = 312;
    ui.panel(x, y, w, 72, "FIRST RUN: DOWNLOAD REQUIRED", { accent: C.amber, led: C.amber });
    const gguf = c.files.find((f) => f.id === "model");
    text(fb, BIG, `JEB-4B  ${fmtBytes(c.downloadBytes)} DOWNLOAD`, x + 8, y + 10, C.white, { shadow: null });
    const free = c.freeBytes ?? 0;
    const enough = free >= c.requiredFreeBytes;
    text(fb, SMALL, `FREE SPACE REQUIRED ~${fmtBytes(c.requiredFreeBytes)}  ·  AVAILABLE ${fmtBytes(free)}`, x + 8, y + 21, enough ? C.mist : C.red, { shadow: null });
    text(fb, SMALL, `FROM HUGGING FACE: ${gguf?.repo ?? ""} (Q8_0) + szybkie-ai/jeb-4b TOKENIZER`, x + 8, y + 29, C.steel3, { shadow: null, maxWidth: w - 16 });
    text(fb, SMALL, "PINNED REVISIONS, SHA-256 CHECKED. RESUMES IF INTERRUPTED. ONLY NEEDED ONCE.", x + 8, y + 37, C.steel3, { shadow: null, maxWidth: w - 16 });
    if (ui.button(x + 8, y + 50, 150, 15, enough ? "DOWNLOAD & INSTALL" : "NOT ENOUGH DISK SPACE", { accent: C.green, disabled: !enough, pulse: enough, hotkey: "Enter" })) void this.install();
    if (ui.button(x + 164, y + 50, 140, 15, "CONTINUE WITHOUT JEB", { accent: C.steel3, tip: "RULES and MANUAL modes work without the model" })) {
      this.app.go("sim");
    }
  }

  private drawFailure(ui: UI): void {
    const fb = ui.fb;
    const x = 64;
    const y = 190;
    const w = 352;
    ui.panel(x, y, w, 74, this.phase === "no-runtime" ? "RUNTIME UNAVAILABLE" : "SETUP FAILED", { accent: C.red, led: C.red });
    wrap(fb, SMALL, (this.error ?? "unknown error").toUpperCase(), x + 8, y + 9, w - 16, C.mist, { shadow: null, maxLines: 5 });
    if (this.app.backend.inApp) {
      if (ui.button(x + 8, y + 54, 80, 14, "RETRY", { accent: C.cyan, hotkey: "Enter", pulse: true })) {
        this.phase = "checking";
        for (const s of this.steps) if (s.state === "fail") s.state = "todo";
        if (this.check && this.check.files.every((f) => f.installed)) void this.start();
        else if (this.check && this.check.runtimeOk && this.step("download").state === "fail") void this.install();
        else void this.run();
      }
      if (ui.button(x + 94, y + 54, 80, 14, "OPEN LOGS", { accent: C.steel3 })) void this.app.backend.revealLogs().catch(() => undefined);
    }
    if (ui.button(x + w - 158, y + 54, 150, 14, "CONTINUE WITHOUT JEB", { accent: C.steel3, tip: "RULES and MANUAL modes work without the model" })) this.app.go("sim");
  }
}
