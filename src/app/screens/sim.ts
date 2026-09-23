/** The simulator: warehouse view, live decision HUD, telemetry, controls, demo mode and the mission summary. */
import { POLICIES, type PolicyId } from "../../decision/policies";
import { RuleBasedEngine } from "../../decision/rulesEngine";
import { BIG, SMALL, text, wrap } from "../../render/font";
import { C, mix } from "../../render/palette";
import { MAP_H, MAP_W } from "../../render/scene";
import { summarize, type RunRecord, type RunSummary } from "../../run/record";
import { LEVELS, levelById } from "../../sim/levels";
import type { Dir } from "../../sim/types";
import { fmtMs, pct, type UI } from "../../ui/widgets";
import type { App } from "../app";
import { Bars, drawDecisionPanel, drawStatusStrip, sparkline } from "../hud";
import { SimController, type ControllerKind } from "../simController";

const MX = 4;
const MY = 17;
const SPEEDS = [0.5, 1, 2, 4];
/** Curated demo: busy enough to show traffic, detours and target choices, short enough to watch. */
export const DEMO = { level: 2, seed: 4, policy: "risk" as PolicyId };

export class SimScreen {
  ctl: SimController | null = null;
  levelId = 1;
  seed = 1;
  kind: ControllerKind = "jeb";
  policy: PolicyId = "argmax";
  speedIdx = 1;
  hasRun = false;
  private bars = new Bars();
  private scoreShown = 0;
  private summary: { run: RunRecord; s: RunSummary; saved: string | null } | null = null;
  private lastEvent: string | null = null;
  private rules = new RuleBasedEngine();

  constructor(private app: App) {}

  onJebOnline(): void {
    if (!this.ctl || this.ctl.kind !== "jeb") {
      this.kind = "jeb";
      this.newMission();
    }
  }

  newMission(demo = false): void {
    const app = this.app;
    if (this.kind === "jeb" && !app.status.online) this.kind = "rules";
    const engine = this.kind === "jeb" ? app.jeb : this.kind === "rules" ? this.rules : null;
    this.ctl = new SimController(levelById(this.levelId), this.seed, this.kind, this.policy, engine, {
      model: this.kind === "jeb" ? `JEB-4B ${app.info?.model.quantisation ?? "GGUF Q8_0"}` : null,
      runtime: this.kind === "jeb" ? `llama.cpp b${app.info?.runtime.llamaBuild ?? ""} Metal` : null,
      permutations: app.settings.permutations,
      demo,
    });
    this.ctl.speed = SPEEDS[this.speedIdx] ?? 1;
    this.ctl.onFinish = (run) => this.finish(run);
    this.summary = null;
    this.lastEvent = null;
    this.scoreShown = 0;
  }

  startDemo(): void {
    if (!this.app.status.online) {
      this.app.toast("DEMO NEEDS JEB ONLINE", C.red);
      return;
    }
    this.levelId = DEMO.level;
    this.seed = DEMO.seed;
    this.kind = "jeb";
    this.policy = DEMO.policy;
    this.speedIdx = 1;
    this.newMission(true);
    this.ctl?.toggle();
    this.hasRun = true;
  }

  private finish(run: RunRecord): void {
    const s = summarize(run);
    this.summary = { run, s, saved: null };
    void this.app.backend
      .saveRun(run)
      .then((p) => {
        if (this.summary?.run === run) this.summary.saved = p;
        void this.app.replay.refresh();
      })
      .catch((e) => this.app.toast(`could not save run: ${e instanceof Error ? e.message : e}`, C.red));
  }

  /** Keep a running mission going while another screen is shown. */
  tickBackground(dt: number): void {
    this.ctl?.update(dt, null);
  }

  private heldDir(ui: UI): Dir | null {
    const h = ui.input.held;
    if (h.has("ArrowUp") || h.has("KeyW")) return "N";
    if (h.has("ArrowDown") || h.has("KeyS")) return "S";
    if (h.has("ArrowLeft") || h.has("KeyA")) return "W";
    if (h.has("ArrowRight") || h.has("KeyD")) return "E";
    return null;
  }

  draw(ui: UI, dt: number): void {
    if (!this.ctl) this.newMission();
    const ctl = this.ctl as SimController;
    const fb = ui.fb;
    const app = this.app;
    const input = ui.input;

    // keyboard
    if (ctl.kind === "manual") {
      if (input.key("Space")) ctl.drive("WAIT");
    } else {
      if (input.key("Space")) this.startPause(ctl);
      if (input.key("KeyN", "Period")) ctl.step();
    }
    if (input.key("KeyR")) this.newMission();
    ctl.update(dt, ctl.kind === "manual" ? this.heldDir(ui) : null);
    this.scoreShown += (ctl.curr.score - this.scoreShown) * Math.min(1, dt * 8);
    const ev = ctl.lastTick?.events.filter((e) => !["move", "wait", "charge"].includes(e.kind)).pop();
    if (ev) this.lastEvent = `T${ev.tick} ${ev.detail}`;

    // map
    fb.rect(MX - 2, MY - 2, MAP_W + 4, MAP_H + 4, C.ink);
    fb.frame(MX - 2, MY - 2, MAP_W + 4, MAP_H + 4, C.edge);
    const view = ctl.view();
    if (!app.settings.showRoute) view.route = null;
    ctl.scene.draw(fb, MX, MY, view, app.time, ctl.fx);
    text(fb, SMALL, `L${ctl.level.id} ${ctl.level.name}  ·  SEED ${ctl.seed}`, MX + 3, MY + 3, C.white, { shadow: C.ink });
    if (ctl.level.dark) text(fb, SMALL, "NIGHT: SENSORS 3 TILES", MX + MAP_W - 3, MY + 3, C.amber, { align: "right", shadow: C.ink });

    this.overlays(ui, ctl);

    // right column
    const lastPolicy = ctl.kind === "jeb" ? `POLICY ${POLICIES.find((p) => p.id === ctl.policy)?.short}: ${POLICIES.find((p) => p.id === ctl.policy)?.label}` : ctl.kind === "rules" ? "HEURISTIC" : "KEYBOARD";
    drawDecisionPanel(ui, this.bars, dt, 328, 18, 148, 173, { engine: ctl.kind, tick: ctl.curr.tick, tactical: ctl.lastTactical, strategic: ctl.lastStrategic, thinking: ctl.thinking, policyLabel: lastPolicy });
    this.telemetry(ui, ctl);
    drawStatusStrip(ui, MX - 2, 196, MAP_W + 4, 26, ctl.curr, ctl.level.timeLimit, this.lastEvent, this.scoreShown);
    this.controls(ui, ctl);
  }

  private startPause(ctl: SimController): void {
    if (ctl.done) {
      this.newMission();
      this.ctl?.toggle();
      return;
    }
    if (ctl.kind === "jeb" && !this.app.status.online) {
      this.app.toast("JEB IS OFFLINE: START IT IN SETTINGS", C.red);
      return;
    }
    ctl.toggle();
    this.hasRun = true;
  }

  private telemetry(ui: UI, ctl: SimController): void {
    const fb = ui.fb;
    const x = 328;
    const y = 195;
    const w = 148;
    const h = 71;
    const online = this.app.status.online;
    ui.panel(x, y, w, h, "TELEMETRY", { accent: C.cyan, right: ctl.kind === "jeb" ? "LOCAL · METAL" : ctl.kind.toUpperCase() });
    const hist = ctl.history.slice(-70);
    const s = ctl.mission.record.ticks.length ? summarize(ctl.mission.record) : null;
    const ix = x + 7;
    if (ctl.kind === "jeb") {
      const last = hist[hist.length - 1];
      text(fb, SMALL, "MODEL INFERENCE", ix, y + 10, C.steel3, { shadow: null });
      text(fb, SMALL, `${fmtMs(last?.modelMs)}  AVG ${fmtMs(s?.model.mean)}`, x + w - 7, y + 10, C.cyan, { align: "right", shadow: null });
      text(fb, SMALL, "END-TO-END TICK", ix, y + 18, C.steel3, { shadow: null });
      text(fb, SMALL, `${fmtMs(last?.e2eMs)}  P95 ${fmtMs(s?.tick.p95)}`, x + w - 7, y + 18, C.amber, { align: "right", shadow: null });
      const tokReq = s && s.decisionRequests ? Math.round(s.tokensEvaluated / s.decisionRequests) : null;
      text(fb, SMALL, `DEC/S ${s?.decisionsPerSecond?.toFixed(2) ?? "--"}  Q/S ${s?.questionsPerSecond?.toFixed(1) ?? "--"}  TOK/REQ ${tokReq ?? "--"}`, ix, y + 26, C.mist, { shadow: null, maxWidth: w - 14 });
      const max = sparkline(ui, ix, y + 35, w - 14, 22, hist.map((h) => h.modelMs), hist.map((h) => h.e2eMs), C.cyan, C.amber2);
      text(fb, SMALL, fmtMs(max), ix + 2, y + 37, C.steel, { shadow: null });
      text(fb, SMALL, online ? "JEB-4B Q8_0" : "JEB OFFLINE", ix, y + 60, online ? C.green : C.red, { shadow: null });
      fb.rect(x + w - 64, y + 60, 3, 5, C.cyan);
      text(fb, SMALL, "MODEL", x + w - 59, y + 60, C.steel3, { shadow: null });
      fb.rect(x + w - 34, y + 60, 3, 5, C.amber2);
      text(fb, SMALL, "E2E TICK", x + w - 7, y + 60, C.steel3, { align: "right", shadow: null });
    } else {
      text(fb, SMALL, ctl.kind === "rules" ? "NO MODEL: DETERMINISTIC HEURISTICS" : "NO MODEL: KEYBOARD CONTROL", ix, y + 10, C.amber, { shadow: null });
      text(fb, SMALL, `TICKS ${ctl.curr.tick}  ·  SCORE ${ctl.curr.score}`, ix, y + 20, C.mist, { shadow: null });
      sparkline(ui, ix, y + 30, w - 14, 26, hist.map((h) => h.score), hist.map((h) => h.battery * 5), C.cyan, C.green2);
      text(fb, SMALL, "■SCORE ■BATTERY", ix, y + 60, C.steel3, { shadow: null });
    }
  }

  private controls(ui: UI, ctl: SimController): void {
    const fb = ui.fb;
    const x = MX - 2;
    const y = 225;
    ui.panel(x, y, MAP_W + 4, 41);
    const online = this.app.status.online;
    const rowA = y + 5;
    const kinds: ControllerKind[] = ["jeb", "rules", "manual"];
    const k = ui.segmented(x + 5, rowA, 96, 13, [
      { label: "JEB", disabled: !online, tip: online ? "JEB-4B decides every move" : "JEB offline" },
      { label: "RULES", tip: "Deterministic A* + heuristics baseline" },
      { label: "MANUAL", tip: "Drive with WASD / arrows" },
    ], kinds.indexOf(ctl.kind));
    if (k !== null && kinds[k] !== this.kind) {
      this.kind = kinds[k] as ControllerKind;
      this.newMission();
    }
    const pi = ui.segmented(x + 106, rowA, 126, 13, POLICIES.map((p) => ({ label: `${p.short} ${p.label === "RISK-AWARE" ? "RISK" : p.label}`, tip: p.blurb, disabled: ctl.kind !== "jeb" })), POLICIES.findIndex((p) => p.id === this.policy), C.cyan);
    if (pi !== null) {
      this.policy = (POLICIES[pi] as { id: PolicyId }).id;
      this.newMission();
    }
    const si = ui.segmented(x + 237, rowA, 82, 13, SPEEDS.map((s) => ({ label: s === 0.5 ? "0.5×" : `${s}×`, tip: "Animation speed (JEB still waits for each decision)" })), this.speedIdx);
    if (si !== null) {
      this.speedIdx = si;
      ctl.speed = SPEEDS[si] ?? 1;
    }
    const rowB = y + 23;
    if (ui.button(x + 5, rowB, 12, 13, "◀", { hotkey: "BracketLeft", tip: "Previous level ([)" })) {
      this.levelId = ((this.levelId + LEVELS.length - 2) % LEVELS.length) + 1;
      this.newMission();
    }
    const lvl = levelById(this.levelId);
    fb.rect(x + 18, rowB, 96, 13, C.ink);
    text(fb, SMALL, `L${lvl.id} ${lvl.name}`, x + 66, rowB + 4, C.white, { align: "center", shadow: null, maxWidth: 94 });
    if (ui.hover(x + 18, rowB, 96, 13)) ui.tip = lvl.subtitle.toUpperCase();
    if (ui.button(x + 115, rowB, 12, 13, "▶", { hotkey: "BracketRight", tip: "Next level (])" })) {
      this.levelId = (this.levelId % LEVELS.length) + 1;
      this.newMission();
    }
    if (ui.button(x + 132, rowB, 12, 13, "-", { tip: "Previous seed" })) {
      this.seed = Math.max(1, this.seed - 1);
      this.newMission();
    }
    fb.rect(x + 145, rowB, 30, 13, C.ink);
    text(fb, SMALL, `S${this.seed}`, x + 160, rowB + 4, C.white, { align: "center", shadow: null });
    if (ui.hover(x + 145, rowB, 30, 13)) ui.tip = "SEED: SAME SEED = SAME MISSION";
    if (ui.button(x + 176, rowB, 12, 13, "+", { tip: "Next seed" })) {
      this.seed += 1;
      this.newMission();
    }
    const label = ctl.done ? "▶ AGAIN" : ctl.running ? "Ⅱ PAUSE" : "▶ START";
    if (ctl.kind !== "manual") {
      if (ui.button(x + 194, rowB, 50, 13, label, { accent: C.green, pulse: !ctl.running && !ctl.done && ctl.curr.tick === 0, tip: "Start / pause (Space)" })) this.startPause(ctl);
      if (ui.button(x + 246, rowB, 32, 13, "STEP", { disabled: ctl.running || ctl.done, tip: "One tick (N)" })) ctl.step();
    } else text(fb, SMALL, "WASD/ARROWS · SPACE", x + 194, rowB + 4, C.magenta, { shadow: null });
    if (ui.button(x + 280, rowB, 39, 13, "RESET", { tip: "New mission, same level and seed (R)" })) this.newMission();
  }

  private overlays(ui: UI, ctl: SimController): void {
    const fb = ui.fb;
    const cx = MX + MAP_W / 2;
    if (ctl.demo && !ctl.done) {
      fb.rect(MX, MY + MAP_H - 13, MAP_W, 13, mix(C.ink, C.magenta2, 0.35));
      text(fb, SMALL, "★ DEMO · JEB-4B CHOOSES EVERY MOVE, LOCALLY ON THIS MAC", cx, MY + MAP_H - 9, C.white, { align: "center", shadow: null });
    }
    if (ctl.callout && !ctl.done) this.drawCallout(ui, ctl);
    if (!ctl.running && !ctl.done && ctl.curr.tick === 0 && !ctl.pending && ctl.kind !== "manual" && !ctl.error) {
      const w = 210;
      const x = cx - w / 2;
      const y = MY + 56;
      fb.rect(x, y, w, 52, withA(C.ink));
      fb.frame(x, y, w, 52, C.cyan2);
      text(fb, BIG, ctl.level.name, cx, y + 6, C.white, { align: "center" });
      text(fb, SMALL, ctl.level.subtitle.toUpperCase(), cx, y + 17, C.steel3, { align: "center", shadow: null, maxWidth: w - 8 });
      text(fb, SMALL, ctl.kind === "jeb" ? "CONTROLLER: JEB-4B (LOCAL)" : "CONTROLLER: RULES BASELINE", cx, y + 27, ctl.kind === "jeb" ? C.cyan : C.amber, { align: "center", shadow: null });
      if (Math.floor(ui.time * 2) % 2 === 0) text(fb, SMALL, "PRESS SPACE OR ▶ START", cx, y + 40, C.green, { align: "center", shadow: null });
    }
    if (ctl.kind === "manual" && ctl.curr.tick === 0) {
      text(fb, SMALL, "MANUAL: DRIVE WITH WASD / ARROWS · SPACE WAITS (CHARGES ON A PAD)", cx, MY + MAP_H - 9, C.magenta, { align: "center" });
    }
    if (ctl.error) {
      const w = 280;
      const x = cx - w / 2;
      const y = MY + 60;
      fb.rect(x, y, w, 50, withA(C.ink));
      fb.frame(x, y, w, 50, C.red);
      text(fb, BIG, "JEB OFFLINE", cx, y + 5, C.red, { align: "center" });
      wrap(fb, SMALL, ctl.error.toUpperCase(), x + 6, y + 16, w - 12, C.mist, { shadow: null, maxLines: 2 });
      text(fb, SMALL, "THE ROBOT IS PAUSED. NO OTHER MODEL WAS SUBSTITUTED.", cx, y + 31, C.steel3, { align: "center", shadow: null });
      if (ui.button(x + 6, y + 36, 64, 11, "RETRY", { accent: C.cyan })) ctl.toggle();
      if (ui.button(x + 76, y + 36, 90, 11, "RESTART JEB", { accent: C.amber })) {
        void this.app.restartJeb().then((ok) => {
          if (ok) ctl.error = null;
        });
      }
    }
    if (this.summary && ctl.done) this.drawSummary(ui, ctl);
  }

  private drawCallout(ui: UI, ctl: SimController): void {
    const c = ctl.callout;
    if (!c) return;
    const fb = ui.fb;
    const r = ctl.curr.robot.pos;
    const w = 150;
    const h = 20 + c.lines.length * 8;
    let x = MX + r.x * 16 + 22;
    if (x + w > MX + MAP_W - 2) x = MX + r.x * 16 - w - 6;
    let y = MY + r.y * 16 - h / 2;
    y = Math.max(MY + 12, Math.min(MY + MAP_H - h - 16, y));
    fb.rect(x, y, w, h, withA(C.ink, 235));
    fb.frame(x, y, w, h, c.color);
    text(fb, SMALL, c.title, x + 4, y + 3, c.color, { shadow: null, maxWidth: w - 8 });
    let ly = y + 11;
    for (const l of c.lines) {
      text(fb, SMALL, l.label.replace("PACKAGE ", "PKG "), x + 4, ly, l.chosen ? C.white : C.steel3, { shadow: null, maxWidth: 48 });
      ui.bar(x + 54, ly, 66, 5, l.p, l.chosen ? c.color : mix(c.color, C.panel, 0.5), { track: C.panel2 });
      text(fb, SMALL, `${Math.round(l.p * 100)}%`, x + w - 4, ly, C.white, { align: "right", shadow: null });
      ly += 8;
    }
    text(fb, SMALL, c.note, x + 4, ly + 1, C.steel3, { shadow: null, maxWidth: w - 8 });
  }

  private drawSummary(ui: UI, ctl: SimController): void {
    const { s, run, saved } = this.summary as NonNullable<SimScreen["summary"]>;
    const fb = ui.fb;
    const w = 244;
    const h = 170;
    const x = MX + (MAP_W - w) / 2;
    const y = MY + 3;
    fb.rect(x, y, w, h, withA(C.ink, 238));
    const title = s.outcome === "complete" ? "MISSION COMPLETE" : s.outcome === "battery_failure" ? "BATTERY FAILURE" : "SHIFT OVER";
    const tc = s.outcome === "complete" ? C.green : s.outcome === "battery_failure" ? C.red : C.amber;
    fb.frame(x, y, w, h, tc);
    text(fb, BIG, title, x + w / 2, y + 6, tc, { align: "center", scale: 2 });
    const jeb = run.meta.engine === "jeb";
    const lines: [string, string][] = [
      ["PACKAGES DELIVERED", `${s.delivered} / ${s.total}`],
      ["FAILED DELIVERIES", `${s.failedDeliveries}`],
      ["LATE DELIVERIES", `${s.late}`],
      ["COLLISIONS", `${s.collisions}`],
      ["SPILLS HIT", `${s.spills}`],
      ["BATTERY REMAINING", `${Math.round(s.batteryLeft)}%`],
      ["SCORE", `${s.score}`],
      ["TICKS", `${s.ticks}`],
    ];
    if (jeb)
      lines.push(
        ["DECISIONS (REQUESTS / QUESTIONS)", `${s.decisionRequests} / ${s.questions}`],
        ["AVG MODEL INFERENCE / REQUEST", fmtMs(s.model.mean)],
        ["AVG END-TO-END / TICK", fmtMs(s.tick.mean)],
        ["P95 END-TO-END / TICK", fmtMs(s.tick.p95)],
        ["AVG MOVE CONFIDENCE", pct(s.meanMoveConfidence)],
      );
    let ly = y + 26;
    for (const [k, v] of lines) {
      text(fb, SMALL, k, x + 10, ly, C.steel3, { shadow: null });
      text(fb, SMALL, v, x + w - 10, ly, C.white, { align: "right", shadow: null });
      ly += 7;
    }
    const foot = jeb
      ? ctl.errors === 0
        ? `JEB STAYED OPERATIONAL LOCALLY: ALL ${s.decisionRequests} DECISIONS FROM JEB-4B ON ${(this.app.status.device ?? "THIS MAC").toUpperCase()}.`
        : `${ctl.errors} DECISION ERRORS DURING THIS RUN (SEE SETTINGS > DIAGNOSTICS).`
      : run.meta.engine === "rules"
        ? "RULES BASELINE: NO MODEL INVOLVED."
        : "DRIVEN BY HAND: NO MODEL INVOLVED.";
    wrap(fb, SMALL, foot, x + 10, ly + 2, w - 20, jeb ? C.green : C.amber, { shadow: null, maxLines: 2 });
    text(fb, SMALL, saved ? "RUN SAVED · OPEN IT IN REPLAY OR ANALYSIS" : "SAVING RUN...", x + w / 2, y + h - 21, C.steel, { align: "center", shadow: null });
    const by = y + h - 14;
    if (ui.button(x + 8, by, 54, 11, "REPLAY", { accent: C.cyan })) {
      this.app.go("replay");
      void this.app.replay.open(run);
    }
    if (ui.button(x + 66, by, 58, 11, "ANALYSIS", { accent: C.cyan })) {
      this.app.go("analysis");
      this.app.analysis.select(run);
    }
    if (ui.button(x + 128, by, 50, 11, "AGAIN", { accent: C.green })) {
      this.newMission(ctl.demo);
      this.ctl?.toggle();
    }
    if (ui.button(x + 182, by, 54, 11, "NEXT LVL", { accent: C.green })) {
      this.levelId = (this.levelId % LEVELS.length) + 1;
      this.newMission();
    }
  }
}

function withA(c: number, a = 225): number {
  return ((c & 0x00ffffff) | (a << 24)) >>> 0;
}
