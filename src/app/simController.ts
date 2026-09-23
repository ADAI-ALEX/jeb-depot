/**
 * Drives one mission on screen: asks the engine for the next tick while the previous move animates, applies
 * ticks in order, spawns effects from simulation events, and keeps short histories for the telemetry strip.
 */
import type { PolicyId } from "../decision/policies";
import type { DecisionEngine, Distribution } from "../decision/types";
import { EngineUnavailableError } from "../decision/types";
import { Particles } from "../render/particles";
import { Scene, TILE, type SceneView } from "../render/scene";
import type { RobotLight } from "../render/sprites";
import { Mission, type FullTickRecord } from "../run/mission";
import type { DecisionRecord, RunRecord } from "../run/record";
import type { LevelDef } from "../sim/levels";
import { plannedPath } from "../sim/observe";
import type { Action, Dir, Vec } from "../sim/types";
import { turn } from "../sim/types";
import type { WorldSnapshot } from "../sim/world";
import { C } from "../render/palette";

export type ControllerKind = "jeb" | "rules" | "manual";

export interface TickHistory {
  tick: number;
  requestMs: number | null;
  modelMs: number | null;
  e2eMs: number | null;
  moveConf: number | null;
  riskHigh: number | null;
  score: number;
  battery: number;
}

export interface Callout {
  title: string;
  lines: { label: string; p: number; chosen: boolean }[];
  note: string;
  until: number;
  color: number;
}

export class SimController {
  readonly mission: Mission;
  readonly scene: Scene;
  readonly fx = new Particles();
  prev: WorldSnapshot;
  curr: WorldSnapshot;
  animT = 1;
  running = false;
  pending = false;
  error: string | null = null;
  speed = 1;
  lastTick: FullTickRecord | null = null;
  lastTactical: { rec: DecisionRecord; tick: number } | null = null;
  lastStrategic: { rec: DecisionRecord; tick: number } | null = null;
  history: TickHistory[] = [];
  finished: RunRecord | null = null;
  errors = 0;
  callout: Callout | null = null;
  /** Demo mode: slow down briefly to surface interesting decisions. */
  demo = false;
  private queued: FullTickRecord | null = null;
  private cooldown = 0;
  private holdUntil = 0;
  private clock = 0;
  private route: Vec[] | null = null;
  private bump: SceneView["bump"] = null;
  private manualRepeat = 0;
  onFinish: ((run: RunRecord) => void) | null = null;

  constructor(
    readonly level: LevelDef,
    readonly seed: number,
    readonly kind: ControllerKind,
    readonly policy: PolicyId,
    readonly engine: DecisionEngine | null,
    meta: { model: string | null; runtime: string | null; permutations: number; demo?: boolean },
  ) {
    this.mission = new Mission({ level, seed, engine: kind === "manual" ? null : engine, policy, permutations: meta.permutations, model: meta.model, runtime: meta.runtime, demo: !!meta.demo });
    this.demo = !!meta.demo;
    this.scene = new Scene(level, this.mission.world.forklifts.map((f) => f.path));
    this.prev = this.mission.world.snapshot();
    this.curr = this.prev;
    this.route = plannedPath(this.mission.world, this.mission.routes);
  }

  get done(): boolean {
    return this.mission.done;
  }

  get thinking(): boolean {
    return this.pending && this.kind === "jeb";
  }

  toggle(): void {
    if (this.done) return;
    this.running = !this.running;
    if (this.running) this.error = null;
  }

  /** Advance exactly one tick (paused stepping). */
  step(): void {
    if (this.done || this.pending || this.queued || this.kind === "manual") return;
    this.error = null;
    void this.request();
  }

  /** Keyboard driving: absolute direction -> relative move for the robot's heading. */
  drive(dir: Dir | "WAIT"): void {
    if (this.kind !== "manual" || this.done || this.animT < 1) return;
    const h = this.mission.world.robot.heading;
    let action: Action = "WAIT";
    if (dir !== "WAIT") {
      action = (["FORWARD", "RIGHT", "REVERSE", "LEFT"] as const).find((m) => turn(h, m) === dir) ?? "FORWARD";
    }
    this.apply(this.mission.stepManual(action));
  }

  private async request(): Promise<void> {
    this.pending = true;
    try {
      const rec = await this.mission.stepAuto();
      this.queued = rec;
    } catch (e) {
      this.errors++;
      this.running = false;
      this.error = e instanceof EngineUnavailableError ? `JEB unavailable: ${e.message}` : e instanceof Error ? e.message : String(e);
    } finally {
      this.pending = false;
    }
  }

  private apply(rec: FullTickRecord): void {
    this.prev = this.curr;
    this.curr = this.mission.world.snapshot();
    this.animT = 0;
    this.lastTick = rec;
    for (const d of rec.decisions) {
      if (d.stage === "tactical") this.lastTactical = { rec: d, tick: rec.tick };
      else this.lastStrategic = { rec: d, tick: rec.tick };
    }
    this.bump = null;
    const tactical = rec.decisions.find((d) => d.stage === "tactical");
    const riskD = tactical?.dists.find((d) => d.id === "risk");
    const moveD = tactical?.dists.find((d) => d.id === "move");
    const req = rec.decisions.reduce((s, d) => s + d.latencyMs, 0);
    const model = rec.decisions.reduce((s, d) => s + (d.timing?.modelMs ?? 0), 0);
    this.history.push({
      tick: rec.tick,
      requestMs: rec.decisions.length ? req : null,
      modelMs: rec.decisions.some((d) => d.timing) ? model : null,
      e2eMs: rec.decisions.length ? rec.endToEndMs : null,
      moveConf: moveD?.confidence ?? null,
      riskHigh: riskD ? riskD.probs.find((p) => p.key === "HIGH")?.p ?? 0 : null,
      score: this.curr.score,
      battery: this.curr.robot.battery,
    });
    if (this.history.length > 400) this.history.shift();
    this.effects(rec);
    this.route = plannedPath(this.mission.world, this.mission.routes);
    if (this.demo) this.surface(rec);
    if (this.mission.done) {
      this.running = false;
      this.finished = this.mission.record;
      this.onFinish?.(this.mission.record);
    }
  }

  private effects(rec: FullTickRecord): void {
    const c = (p: Vec): { x: number; y: number } => ({ x: p.x * TILE + 8, y: p.y * TILE + 8 });
    for (const e of rec.events) {
      const p = c(e.at);
      switch (e.kind) {
        case "collision_static":
        case "collision_forklift": {
          const r = this.curr.robot;
          this.bump = { kind: e.kind === "collision_static" ? "wall" : "forklift", dir: r.heading };
          const rp = c(r.pos);
          this.fx.sparks((rp.x + p.x) / 2, (rp.y + p.y) / 2);
          this.fx.float(rp.x, rp.y - 10, `${e.scoreDelta}`, C.red);
          break;
        }
        case "delivery":
          this.fx.confetti(p.x, p.y);
          this.fx.float(p.x, p.y - 12, `+${e.scoreDelta}`, C.green, true);
          break;
        case "pickup":
          this.fx.burst(p.x, p.y, 10, [C.yellow, C.white], { speed: 30, life: 0.4, up: true });
          break;
        case "spill":
          this.fx.burst(p.x, p.y, 12, [C.oil2, C.magenta2, C.cyan3], { speed: 35, life: 0.5 });
          this.fx.float(p.x, p.y - 10, `${e.scoreDelta}`, C.magenta);
          break;
        case "charge":
          this.fx.zap(p.x, p.y);
          break;
        case "battery_failure":
          this.fx.burst(p.x, p.y, 30, [C.red, C.amber, C.ink], { speed: 50, life: 0.9 });
          this.fx.shake = 4;
          break;
        case "mission_complete":
          this.fx.float(160, 70, `+${e.scoreDelta} BONUS`, C.cyan, true);
          break;
        case "move":
          if (Math.random() < 0.35) this.fx.dust(p.x - 4 + Math.random() * 8, p.y + 5);
          break;
        default:
          break;
      }
    }
  }

  /** Demo mode: pause briefly on decisions worth seeing and pin a callout. */
  private surface(rec: FullTickRecord): void {
    const strategic = rec.decisions.find((d) => d.stage === "strategic");
    const tactical = rec.decisions.find((d) => d.stage === "tactical");
    const pick = (d: Distribution, chosen: string): Callout["lines"] =>
      [...d.probs]
        .sort((a, b) => b.p - a.p)
        .slice(0, 3)
        .map((x) => ({ label: x.key, p: x.p, chosen: x.key === chosen }));
    let c: Omit<Callout, "until"> | null = null;
    if (strategic) {
      const d = strategic.dists[0] as Distribution;
      const sel = strategic.selection[0];
      c = { title: d.id === "target" ? "JEB CHOOSES THE NEXT JOB" : "JEB DECIDES ON A DETOUR", lines: pick(d, sel?.chosen ?? ""), note: sel ? `${d.id.toUpperCase()}: ${sel.chosen}` : "", color: C.amber };
    } else if (tactical) {
      const move = tactical.dists.find((d) => d.id === "move");
      const risk = tactical.dists.find((d) => d.id === "risk");
      const sel = tactical.selection.find((s) => s.question === "move");
      const high = risk?.probs.find((p) => p.key === "HIGH")?.p ?? 0;
      const hit = rec.events.some((e) => e.kind.startsWith("collision"));
      if (move && sel && (hit || sel.chosen === "WAIT" || high >= 0.45 || move.confidence < 0.45)) {
        const title = hit ? "COLLISION: WHAT JEB SAW" : sel.chosen === "WAIT" ? "POLICY HOLDS: TOO UNSURE FOR THE RISK" : high >= 0.45 ? "JEB FLAGS HIGH RISK" : "A CLOSE CALL FOR JEB";
        c = { title, lines: pick(move, sel.chosen), note: `RISK HIGH ${(high * 100).toFixed(0)}%  ·  ${sel.note.toUpperCase()}`, color: hit ? C.red : high >= 0.45 ? C.magenta : C.cyan };
      }
    }
    if (c) {
      this.callout = { ...c, until: this.clock + 3.2 };
      this.holdUntil = this.clock + 1.4;
    }
  }

  update(dt: number, heldDir: Dir | null): void {
    this.clock += dt;
    this.fx.update(dt);
    const animDur = (this.kind === "rules" ? 0.16 : 0.22) / this.speed;
    this.animT = Math.min(1, this.animT + dt / animDur);
    if (this.callout && this.clock > this.callout.until) this.callout = null;
    if (this.queued && this.animT >= 1 && this.clock >= this.holdUntil) {
      const q = this.queued;
      this.queued = null;
      this.apply(q);
      this.cooldown = this.kind === "rules" ? 0.1 / this.speed : 0;
    }
    this.cooldown -= dt;
    if (this.running && !this.done && !this.pending && !this.queued && this.cooldown <= 0 && this.clock >= this.holdUntil && this.kind !== "manual") void this.request();
    if (this.kind === "manual" && heldDir) {
      this.manualRepeat -= dt;
      if (this.manualRepeat <= 0 && this.animT >= 1) {
        this.drive(heldDir);
        this.manualRepeat = 0.16;
      }
    } else this.manualRepeat = 0;
  }

  view(): SceneView {
    const tactical = this.lastTactical?.rec;
    const risk = tactical?.dists.find((d) => d.id === "risk");
    let light: RobotLight = "cyan";
    if (this.curr.robot.charging) light = "green";
    else if (risk) {
      const top = [...risk.probs].sort((a, b) => b.p - a.p)[0]?.key;
      light = top === "HIGH" ? "red" : top === "MEDIUM" ? "amber" : "cyan";
    }
    if (this.kind === "manual") light = "amber";
    return {
      prev: this.prev,
      curr: this.curr,
      t: this.animT,
      action: this.lastTick?.action ?? null,
      bump: this.bump,
      route: this.animT >= 1 ? this.route : null,
      routeDetour: this.mission.world.robot.routeMode === "detour",
      light,
      thinking: this.thinking,
      targetTile: this.mission.world.targetTile(),
      night: this.level.dark,
      lanes: [],
    };
  }
}
