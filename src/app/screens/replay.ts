/** Replay: pick a saved run; it is re-simulated from its seed and recorded actions, verified tick by tick, and
 * played back with the model's original distributions. */
import { SMALL, text } from "../../render/font";
import { C, mix } from "../../render/palette";
import { Particles } from "../../render/particles";
import { MAP_H, MAP_W, Scene, TILE } from "../../render/scene";
import type { FullTickRecord } from "../../run/mission";
import type { DecisionRecord, RunRecord } from "../../run/record";
import { rebuild, type ReplayFrames } from "../../run/replay";
import type { RunListItem } from "../../platform/backend";
import { levelById } from "../../sim/levels";
import { World } from "../../sim/world";
import { fmtMs, type UI } from "../../ui/widgets";
import type { App } from "../app";
import { Bars, drawDecisionPanel, drawStatusStrip } from "../hud";

const SPEEDS = [0.25, 0.5, 1, 2, 4];

export class ReplayScreen {
  private list: RunListItem[] = [];
  private loading = false;
  private run: RunRecord | null = null;
  private frames: ReplayFrames | null = null;
  private scene: Scene | null = null;
  private fx = new Particles();
  private i = 0;
  private t = 1;
  private playing = false;
  private speedIdx = 2;
  private bars = new Bars();
  private scroll = 0;
  private error: string | null = null;

  constructor(private app: App) {}

  async refresh(): Promise<void> {
    this.loading = true;
    try {
      this.list = await this.app.backend.listRuns();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  async openId(id: string): Promise<void> {
    try {
      await this.open(await this.app.backend.loadRun(id));
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  async open(run: RunRecord): Promise<void> {
    this.run = run;
    this.frames = rebuild(run);
    const level = levelById(run.meta.levelId);
    // Forklift lanes: the patrol paths of a fresh world of the same level and seed.
    this.scene = new Scene(level, new World(level, run.meta.seed).forklifts.map((f) => f.path));
    this.i = 0;
    this.t = 1;
    this.playing = false;
    this.fx.clear();
    this.error = null;
  }

  private tickDuration(): number {
    const run = this.run as RunRecord;
    const a = run.ticks[this.i];
    const b = run.ticks[this.i + 1];
    const recorded = a && b ? (b.t - a.t) / 1000 : 0.25;
    return Math.max(0.25, recorded) / (SPEEDS[this.speedIdx] ?? 1);
  }

  private stepTo(i: number): void {
    const run = this.run as RunRecord;
    this.i = Math.max(0, Math.min(run.ticks.length, i));
    this.t = 0;
    const tick = run.ticks[this.i - 1];
    if (tick)
      for (const e of tick.events) {
        const p = { x: e.at.x * TILE + 8, y: e.at.y * TILE + 8 };
        if (e.kind.startsWith("collision")) this.fx.sparks(p.x, p.y);
        if (e.kind === "delivery") this.fx.confetti(p.x, p.y);
      }
  }

  private recent(stage: DecisionRecord["stage"]): { rec: DecisionRecord; tick: number } | null {
    const run = this.run as RunRecord;
    for (let k = this.i - 1; k >= 0; k--) {
      const d = run.ticks[k]?.decisions.find((x) => x.stage === stage);
      if (d) return { rec: d, tick: run.ticks[k]?.tick ?? 0 };
    }
    return null;
  }

  draw(ui: UI, dt: number): void {
    const fb = ui.fb;
    if (this.error) text(fb, SMALL, this.error.toUpperCase(), 240, 258, C.red, { align: "center", shadow: null });
    if (!this.run || !this.frames || !this.scene) return this.drawList(ui, 4, 18, 472, 248, true);
    const run = this.run;
    const frames = this.frames;
    const input = ui.input;
    if (input.key("Space")) this.playing = !this.playing;
    if (input.key("ArrowRight", "KeyN")) this.stepTo(this.i + 1);
    if (input.key("ArrowLeft")) this.stepTo(this.i - 1);
    if (input.key("Home", "KeyR")) this.stepTo(0);
    this.fx.update(dt);
    this.t = Math.min(1, this.t + dt / 0.2);
    if (this.playing && this.t >= 1) {
      this.wait = (this.wait ?? 0) + dt;
      if (this.wait >= this.tickDuration() - 0.2) {
        this.wait = 0;
        if (this.i < run.ticks.length) this.stepTo(this.i + 1);
        else this.playing = false;
      }
    }
    // map
    const MX = 4;
    const MY = 17;
    fb.rect(MX - 2, MY - 2, MAP_W + 4, MAP_H + 4, C.ink);
    fb.frame(MX - 2, MY - 2, MAP_W + 4, MAP_H + 4, C.edge);
    const prev = frames.frames[Math.max(0, this.i - 1)] ?? frames.frames[0];
    const curr = frames.frames[this.i] ?? frames.frames[frames.frames.length - 1];
    if (!prev || !curr) return;
    const tick = run.ticks[this.i - 1] as FullTickRecord | undefined;
    const tac = this.recent("tactical");
    const risk = tac?.rec.dists.find((d) => d.id === "risk");
    const top = risk ? risk.probs.reduce((a, b) => (b.p > a.p ? b : a)).key : "LOW";
    const bumpEv = tick?.events.find((e) => e.kind.startsWith("collision"));
    const target = tick?.pre?.target;
    const level = levelById(run.meta.levelId);
    this.scene.draw(
      fb,
      MX,
      MY,
      {
        prev,
        curr,
        t: this.t,
        action: tick?.action ?? null,
        bump: bumpEv ? { kind: bumpEv.kind === "collision_static" ? "wall" : "forklift", dir: curr.robot.heading } : null,
        route: null,
        routeDetour: false,
        light: curr.robot.charging ? "green" : top === "HIGH" ? "red" : top === "MEDIUM" ? "amber" : "cyan",
        thinking: false,
        targetTile: target ? (target.kind === "charge" ? target.charger : target.kind === "package" ? (curr.packages.find((p) => p.id === target.id)?.pickup ?? null) : null) : null,
        night: level.dark,
        lanes: [],
      },
      this.app.time,
      this.fx,
    );
    text(fb, SMALL, `REPLAY · L${level.id} ${level.name} · SEED ${run.meta.seed} · ${run.meta.engine.toUpperCase()} ${run.meta.engine === "jeb" ? run.meta.policy.toUpperCase() : ""}`, MX + 3, MY + 3, C.white, { shadow: C.ink });
    const ok = frames.mismatches.length === 0;
    const vText = ok ? `✓ VERIFIED ${frames.verified}/${run.ticks.length} TICKS` : `✕ ${frames.mismatches.length} TICKS DIFFER FROM THE RECORDING`;
    text(fb, SMALL, vText, MX + MAP_W - 3, MY + 3, ok ? C.green : C.red, { align: "right", shadow: C.ink });
    const ev = tick?.events.filter((e) => !["move", "wait", "charge"].includes(e.kind)).pop();
    drawStatusStrip(ui, MX - 2, 196, MAP_W + 4, 26, curr, level.timeLimit, ev ? `T${ev.tick} ${ev.detail}` : tick ? `T${tick.tick} ${tick.action}${tick.autoReason ? " (" + tick.autoReason + ")" : ""}` : null, curr.score);
    const eng = run.meta.engine === "jeb" ? "jeb" : run.meta.engine === "rules" ? "rules" : "manual";
    drawDecisionPanel(ui, this.bars, dt, 328, 18, 148, 173, { engine: eng, tick: tick?.tick ?? 0, tactical: tac, strategic: this.recent("strategic"), thinking: false, policyLabel: `RECORDED ${fmtMs(tick?.decisions.reduce((s, d) => s + d.latencyMs, 0))}`, replay: true });
    this.transport(ui, run);
    this.drawList(ui, 328, 195, 148, 71, false);
  }

  private wait = 0;

  private transport(ui: UI, run: RunRecord): void {
    const fb = ui.fb;
    const x = 2;
    const y = 225;
    const w = MAP_W + 4;
    ui.panel(x, y, w, 41);
    // scrubber
    const sx = x + 6;
    const sw = w - 12;
    ui.well(sx, y + 5, sw, 9);
    const n = Math.max(1, run.ticks.length);
    for (const t of run.ticks) {
      const px = sx + Math.round((sw * t.tick) / n);
      if (t.events.some((e) => e.kind.startsWith("collision"))) fb.rect(px, y + 6, 1, 7, C.red);
      else if (t.events.some((e) => e.kind === "delivery")) fb.rect(px, y + 6, 1, 7, C.green);
      else if (t.decisions.some((d) => d.stage === "strategic")) fb.rect(px, y + 11, 1, 2, C.amber);
    }
    const hx = sx + Math.round((sw * this.i) / n);
    fb.rect(hx - 1, y + 4, 3, 11, C.cyan);
    if (ui.hover(sx, y + 4, sw, 11)) {
      ui.pointer = true;
      ui.tip = "CLICK TO SEEK (RED = COLLISION, GREEN = DELIVERY, AMBER = TARGET/REROUTE)";
      if (ui.input.down) this.stepTo(Math.round(((ui.input.mx - sx) / sw) * n));
    }
    const by = y + 22;
    if (ui.button(x + 6, by, 22, 13, "|◀", { tip: "Restart (Home / R)" })) this.stepTo(0);
    if (ui.button(x + 30, by, 40, 13, this.playing ? "Ⅱ PAUSE" : "▶ PLAY", { accent: C.green, tip: "Play / pause (Space)" })) this.playing = !this.playing;
    if (ui.button(x + 72, by, 30, 13, "STEP", { tip: "One tick (→)" })) this.stepTo(this.i + 1);
    const si = ui.segmented(x + 108, by, 110, 13, SPEEDS.map((s) => ({ label: s === 0.25 ? ".25×" : s === 0.5 ? "0.5×" : `${s}×` })), this.speedIdx);
    if (si !== null) this.speedIdx = si;
    text(fb, SMALL, `TICK ${this.i}/${run.ticks.length}`, x + 224, by + 4, C.white, { shadow: null });
    if (ui.button(x + w - 44, by, 38, 13, "CLOSE", { tip: "Back to the run list" })) {
      this.run = null;
      this.frames = null;
    }
  }

  private drawList(ui: UI, x: number, y: number, w: number, h: number, full: boolean): void {
    const fb = ui.fb;
    ui.panel(x, y, w, h, "SAVED RUNS", { right: this.loading ? "LOADING" : `${this.list.length}` });
    if (!this.list.length) {
      text(fb, SMALL, "NO RUNS YET: FINISH A MISSION IN SIM OR BENCH.", x + w / 2, y + h / 2, C.steel3, { align: "center", shadow: null });
      return;
    }
    const rowH = 9;
    const rowsVisible = Math.floor((h - 14) / rowH);
    if (ui.hover(x, y, w, h)) this.scroll = Math.max(0, Math.min(this.list.length - rowsVisible, this.scroll + ui.input.wheel));
    let ry = y + 10;
    for (const r of this.list.slice(this.scroll, this.scroll + rowsVisible)) {
      const hot = ui.hover(x + 3, ry - 1, w - 6, rowH);
      const sel = this.run?.meta.id === r.meta.id;
      if (hot || sel) fb.rect(x + 3, ry - 1, w - 6, rowH, sel ? mix(C.panel, C.cyan, 0.2) : C.panel2);
      if (hot) ui.pointer = true;
      const oc = r.outcome === "complete" ? C.green : r.outcome === "battery_failure" ? C.red : C.amber;
      const eng = r.meta.engine === "jeb" ? `JEB ${r.meta.policy.toUpperCase()}` : r.meta.engine.toUpperCase();
      const label = full
        ? `L${r.meta.levelId} S${r.meta.seed}  ${eng.padEnd(11)} ${r.stats.deliveries}/${r.packagesTotal} PKG  ${String(r.stats.collisions).padStart(2)} HIT  SCORE ${String(r.finalScore).padStart(5)}  ${r.ticks} TICKS  ${r.meta.startedAt.slice(5, 16).replace("T", " ")}${r.meta.demo ? "  DEMO" : ""}`
        : `L${r.meta.levelId} S${r.meta.seed} ${eng} ${r.finalScore}`;
      fb.rect(x + 6, ry + 1, 3, 3, oc);
      text(fb, SMALL, label, x + 12, ry, sel ? C.white : C.mist, { shadow: null, maxWidth: w - 18 });
      if (hot && ui.input.pressed) void this.openId(r.meta.id);
      ry += rowH;
    }
  }
}
