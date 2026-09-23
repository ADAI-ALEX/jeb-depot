/** App shell: top bar, screen routing, JEB status, settings persistence, toasts. */
import { JEBEngine } from "../decision/jebEngine";
import { SMALL, text } from "../render/font";
import { C, mix } from "../render/palette";
import type { AppInfo, Backend, CheckReport, Diagnostics, Progress, SetupEvent, Stage, StartupMetrics } from "../platform/backend";
import type { UI } from "../ui/widgets";
import { AnalysisScreen } from "./screens/analysis";
import { BenchScreen } from "./screens/bench";
import { BootScreen } from "./screens/boot";
import { ReplayScreen } from "./screens/replay";
import { SettingsScreen } from "./screens/settings";
import { SimScreen } from "./screens/sim";

export type ScreenId = "boot" | "sim" | "replay" | "analysis" | "bench" | "settings";

export interface Settings {
  crt: boolean;
  permutations: 1 | 2;
  showRoute: boolean;
}

export interface JebStatus {
  online: boolean;
  stage: Stage;
  message: string;
  error: string | null;
  progress: Progress | null;
  check: CheckReport | null;
  startup: StartupMetrics | null;
  appToOnlineMs: number | null;
  device: string | null;
}

const SETTINGS_KEY = "jeb-depot.settings.v1";

export class App {
  screen: ScreenId = "boot";
  readonly jeb: JEBEngine;
  settings: Settings;
  info: AppInfo | null = null;
  diag: Diagnostics | null = null;
  status: JebStatus = { online: false, stage: "checking_runtime", message: "INITIALISING JEB", error: null, progress: null, check: null, startup: null, appToOnlineMs: null, device: null };
  private toasts: { text: string; color: number; until: number }[] = [];
  time = 0;

  readonly boot: BootScreen;
  readonly sim: SimScreen;
  readonly replay: ReplayScreen;
  readonly analysis: AnalysisScreen;
  readonly bench: BenchScreen;
  readonly settingsScreen: SettingsScreen;

  constructor(readonly backend: Backend) {
    this.settings = { crt: true, permutations: 1, showRoute: true, ...this.loadSettings() };
    this.jeb = new JEBEngine(backend, { permutations: this.settings.permutations });
    this.boot = new BootScreen(this);
    this.sim = new SimScreen(this);
    this.replay = new ReplayScreen(this);
    this.analysis = new AnalysisScreen(this);
    this.bench = new BenchScreen(this);
    this.settingsScreen = new SettingsScreen(this);
    backend.onSetup((ev) => this.onSetupEvent(ev));
    void backend.appInfo().then((i) => (this.info = i)).catch(() => undefined);
    this.applyCrt();
  }

  private loadSettings(): Partial<Settings> {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<Settings>;
    } catch {
      return {};
    }
  }

  saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* private mode: settings stay for this session */
    }
    this.jeb.options.permutations = this.settings.permutations;
    this.applyCrt();
  }

  private applyCrt(): void {
    if (typeof document !== "undefined") document.getElementById("crt")?.classList.toggle("on", this.settings.crt);
  }

  onSetupEvent(ev: SetupEvent): void {
    this.status.stage = ev.stage;
    this.status.message = ev.message;
    this.status.progress = ev.progress ?? null;
    if (ev.error) this.status.error = ev.error;
    if (ev.stage === "online") {
      this.status.online = true;
      this.status.error = null;
    }
    if (ev.stage === "failed" || ev.stage === "stopped") this.status.online = false;
  }

  /** Re-read runtime status (after restarts, failures). */
  async refreshStatus(): Promise<void> {
    try {
      const s = await this.backend.runtimeStatus();
      this.status.online = s.online && s.alive;
      this.status.startup = s.startup;
      this.status.appToOnlineMs = s.appToOnlineMs;
    } catch {
      this.status.online = false;
    }
  }

  async loadDiagnostics(): Promise<void> {
    try {
      this.diag = await this.backend.diagnostics();
      const dev = this.diag?.loadReport?.device ?? (this.diag?.runtime?.devices as string[] | undefined)?.[0] ?? null;
      this.status.device = dev;
    } catch (e) {
      this.toast(`diagnostics: ${e instanceof Error ? e.message : String(e)}`, C.red);
    }
  }

  /** Restart the local inference process (Settings, error banner). */
  async restartJeb(): Promise<boolean> {
    this.status.online = false;
    this.status.error = null;
    this.status.stage = "starting_inference";
    this.status.message = "Starting local inference...";
    try {
      const r = await this.backend.runtimeStart();
      this.status.startup = r.startup;
      this.status.online = true;
      await this.loadDiagnostics();
      this.toast("JEB ONLINE", C.green);
      return true;
    } catch (e) {
      this.status.error = e instanceof Error ? e.message : String(e);
      this.status.stage = "failed";
      this.toast("JEB FAILED TO START", C.red);
      return false;
    }
  }

  toast(s: string, color = C.cyan): void {
    this.toasts.push({ text: s.toUpperCase(), color, until: this.time + 3.5 });
    if (this.toasts.length > 4) this.toasts.shift();
  }

  go(s: ScreenId): void {
    if (s === this.screen) return;
    this.screen = s;
    if (s === "replay") void this.replay.refresh();
    if (s === "analysis") void this.analysis.refresh();
    if (s === "settings") void this.loadDiagnostics();
  }

  frame(ui: UI, dt: number): void {
    this.time += dt;
    ui.beginFrame(this.time);
    const fb = ui.fb;
    fb.clear(C.void);
    if (this.screen === "boot") this.boot.draw(ui, dt);
    else {
      this.topBar(ui);
      if (this.screen === "sim") this.sim.draw(ui, dt);
      else if (this.screen === "replay") this.replay.draw(ui, dt);
      else if (this.screen === "analysis") this.analysis.draw(ui, dt);
      else if (this.screen === "bench") this.bench.draw(ui, dt);
      else if (this.screen === "settings") this.settingsScreen.draw(ui, dt);
      if (this.screen !== "sim") this.sim.tickBackground(dt);
    }
    this.drawToasts(ui);
    ui.drawTip();
  }

  private topBar(ui: UI): void {
    const fb = ui.fb;
    fb.rect(0, 0, fb.w, 14, C.ink);
    fb.rect(0, 14, fb.w, 1, C.edge);
    // logo
    ui.big("JEB", 5, 4, C.cyan);
    text(fb, SMALL, "//", 25, 5, C.steel3, { shadow: null });
    ui.big("DEPOT", 34, 4, C.white);
    const tabs: { id: ScreenId; label: string; key: string }[] = [
      { id: "sim", label: "SIM", key: "Digit1" },
      { id: "replay", label: "REPLAY", key: "Digit2" },
      { id: "analysis", label: "ANALYSIS", key: "Digit3" },
      { id: "bench", label: "BENCH", key: "Digit4" },
      { id: "settings", label: "SETTINGS", key: "Digit5" },
    ];
    let x = 70;
    for (const t of tabs) {
      const w = t.label.length * 4 + 10;
      if (ui.button(x, 2, w, 11, t.label, { active: this.screen === t.id, hotkey: t.key, tip: `${t.label} (${t.key.slice(5)})` })) this.go(t.id);
      x += w + 2;
    }
    if (ui.button(x + 4, 2, 34, 11, "★ DEMO", { accent: C.magenta, pulse: !this.sim.hasRun, disabled: !this.status.online, tip: this.status.online ? "One-click demo: JEB runs a curated mission" : "Demo needs JEB online" })) {
      this.go("sim");
      this.sim.startDemo();
    }
    // status, right side
    const online = this.status.online;
    const busy = !online && ["starting_inference", "optimising", "verifying"].includes(this.status.stage);
    const label = online ? "JEB ONLINE" : busy ? "JEB STARTING" : "JEB OFFLINE";
    const col = online ? C.green : busy ? C.amber : C.red;
    const bx = fb.w - 4;
    const badge = online ? "LOCAL / OFFLINE" : this.backend.inApp ? "NO MODEL" : "PREVIEW";
    const bw = badge.length * 4 + 7;
    fb.rect(bx - bw, 2, bw, 11, online ? mix(C.ink, C.green2, 0.35) : C.panel2);
    fb.frame(bx - bw, 2, bw, 11, online ? C.green2 : C.edge);
    text(fb, SMALL, badge, bx - bw + 4, 5, online ? C.green : C.steel3, { shadow: null });
    const lx = bx - bw - 6 - label.length * 4;
    ui.led(lx - 6, 6, col, busy);
    text(fb, SMALL, label, lx, 5, col, { shadow: null });
  }

  private drawToasts(ui: UI): void {
    this.toasts = this.toasts.filter((t) => t.until > this.time);
    let y = 20;
    for (const t of this.toasts) {
      const w = t.text.length * 4 + 10;
      const x = Math.floor((ui.fb.w - w) / 2);
      ui.fb.rect(x, y, w, 11, C.ink);
      ui.fb.frame(x, y, w, 11, t.color);
      text(ui.fb, SMALL, t.text, x + 5, y + 3, t.color, { shadow: null });
      y += 13;
    }
  }
}
