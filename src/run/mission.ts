/**
 * One mission: the tick loop that turns observations into questions, questions into distributions (via a
 * DecisionEngine), distributions into actions (via a policy), and actions into simulated outcomes.
 *
 * Each tick has up to two decision stages, so every decision takes effect in the tick it was made:
 *   strategic  TARGET (at decision points) and REROUTE (when obstructed)  -> may change target / route
 *   tactical   MOVE + RISK, on the state after the strategic stage          -> the action executed
 */
import { chooseKey, chooseMove, chooseReroute, type PolicyId } from "../decision/policies";
import { moveQuestion, rerouteQuestion, riskQuestion, targetQuestion } from "../decision/questions";
import type { DecisionEngine, DecisionResponse, Distribution, QuestionSpec } from "../decision/types";
import type { LevelDef } from "../sim/levels";
import { RouteCache, nearestCharger, observe, renderState, type Observation } from "../sim/observe";
import { Rng, hashSeed } from "../sim/rng";
import type { Action, Target } from "../sim/types";
import { sameTile } from "../sim/types";
import { COST, World } from "../sim/world";
import { RECORD_VERSION, type DecisionRecord, type RunRecord, type TickRecord } from "./record";

export interface MissionConfig {
  level: LevelDef;
  seed: number;
  /** null = manual driving. */
  engine: DecisionEngine | null;
  policy: PolicyId;
  permutations: number;
  demo?: boolean;
  model?: string | null;
  runtime?: string | null;
}

export interface TickPre {
  target: Target;
  routeMode: "primary" | "detour";
}

export type FullTickRecord = TickRecord & { pre: TickPre };

export class Mission {
  readonly world: World;
  readonly routes: RouteCache;
  readonly record: RunRecord & { ticks: FullTickRecord[] };
  private readonly rng: Rng;
  private heldInARow = 0;
  private lastIdleSig: string | null = null;
  private lastIdleAsk = -999;
  private lastWaitingSig = "";
  private rerouteQuietUntil = -1;
  private batteryAskTick = -999;
  private lastRisk: Distribution | undefined;
  private readonly t0 = performance.now();
  /** The most recent observation, for the HUD. */
  lastObservation: Observation;

  constructor(readonly cfg: MissionConfig) {
    this.world = new World(cfg.level, cfg.seed, { manual: cfg.engine === null });
    this.routes = new RouteCache(this.world);
    this.rng = new Rng(hashSeed(cfg.level.key, cfg.seed, "policy", cfg.policy));
    this.lastWaitingSig = this.waitingSig();
    const engineId = cfg.engine?.id ?? "manual";
    this.record = {
      meta: {
        version: RECORD_VERSION,
        id: `${cfg.level.key}-s${cfg.seed}-${engineId}-${engineId === "jeb" ? cfg.policy : engineId}-${Date.now().toString(36)}`,
        levelId: cfg.level.id,
        levelName: cfg.level.name,
        seed: cfg.seed,
        engine: engineId,
        policy: engineId === "jeb" ? cfg.policy : engineId === "rules" ? "rules" : "manual",
        permutations: cfg.permutations,
        startedAt: new Date().toISOString(),
        model: cfg.model ?? null,
        runtime: cfg.runtime ?? null,
        demo: !!cfg.demo,
      },
      ticks: [],
      outcome: "running",
      finalScore: 0,
      stats: { ...this.world.stats },
      packagesTotal: this.world.packages.length,
      wallMs: 0,
    };
    this.lastObservation = observe(this.world, this.routes);
  }

  get done(): boolean {
    return this.world.outcome !== "running";
  }

  private waitingSig(): string {
    return this.world
      .waitingPackages()
      .map((p) => p.id)
      .join(",");
  }

  private applyTargetKey(key: string): void {
    const w = this.world;
    // A chosen objective ends any idle spell: the next time the target clears (delivery, charged) is a fresh
    // decision point.
    if (key !== "NONE") this.lastIdleSig = null;
    if (key.startsWith("PACKAGE ")) w.setTarget({ kind: "package", id: key.slice(8) });
    else if (key.startsWith("DELIVER ")) {
      const pkg = w.packageById(key.slice(8));
      if (pkg) w.setTarget({ kind: "dock", dock: pkg.dock, packageId: pkg.id });
    } else if (key === "CHARGE") {
      const c = nearestCharger(w, this.routes, w.robot.pos);
      if (c) w.setTarget({ kind: "charge", charger: c.tile });
    } else if (key === "NONE") {
      w.setTarget(null);
      this.lastIdleSig = this.waitingSig();
      this.lastIdleAsk = w.tick;
    }
  }

  private onChargerForTarget(): boolean {
    const r = this.world.robot;
    return r.target?.kind === "charge" && sameTile(r.pos, r.target.charger) && r.battery < COST.chargeUntil;
  }

  private async ask(stage: DecisionRecord["stage"], obs: Observation, qs: QuestionSpec[]): Promise<{ res: DecisionResponse; rec: DecisionRecord }> {
    const engine = this.cfg.engine as DecisionEngine;
    const stateText = renderState(obs);
    const t = performance.now();
    const res = await engine.decide(obs, stateText, qs);
    const rec: DecisionRecord = {
      stage,
      stateText,
      questions: qs,
      dists: qs.map((q) => res.dists[q.id]).filter((d): d is Distribution => !!d),
      selection: [],
      timing: res.timing,
      latencyMs: performance.now() - t,
      ...(res.notes ? { notes: res.notes } : {}),
    };
    if (stage === "tactical")
      rec.context = {
        dirs: obs.dirs.map((d) => ({ rel: d.rel, blocked: d.blocked, collides: d.blocked || !!d.forkliftNext, spill: d.spill, steps: d.steps, onRoute: d.onRoute })),
        adjacentTraffic: obs.dirs.some((d) => d.forkliftNow || d.forkliftNext),
        nearTraffic: obs.traffic.some((t) => t.distance <= 3),
        nearHazard: obs.hazards.some((h) => h.distance <= 1),
      };
    return { res, rec };
  }

  /** One engine-driven tick. */
  async stepAuto(): Promise<FullTickRecord> {
    if (!this.cfg.engine) throw new Error("manual mission: use stepManual");
    const engine = this.cfg.engine;
    const w = this.world;
    const r = w.robot;
    const tStart = performance.now();
    const decisions: DecisionRecord[] = [];
    let action: Action = "WAIT";
    let source: TickRecord["actionSource"] = engine.id;
    let autoReason: string | undefined;
    const ctx = { rng: this.rng, heldInARow: this.heldInARow };
    const isRules = engine.id === "rules";

    if (this.onChargerForTarget()) {
      source = "auto";
      autoReason = "charging";
    } else {
      let obs = observe(w, this.routes);
      const strategic: QuestionSpec[] = [];
      const sig = this.waitingSig();
      const idleRecheck = r.target === null && (this.lastIdleSig === null || this.lastIdleSig !== sig || w.tick - this.lastIdleAsk >= 10);
      const newWork = !r.carrying && r.target?.kind === "package" && sig !== this.lastWaitingSig && sig.split(",").length > 1;
      const batteryDoubt = !!r.carrying && r.target?.kind === "dock" && obs.battery.enough === false && w.tick - this.batteryAskTick >= 15 && obs.targetOptions.some((o) => o.kind === "charge");
      if (idleRecheck || newWork || batteryDoubt) {
        if (batteryDoubt) this.batteryAskTick = w.tick;
        const tq = targetQuestion(obs);
        if (tq) strategic.push(tq);
        else if (obs.targetOptions.length === 1 && r.target === null) {
          const only = obs.targetOptions[0] as { key: string };
          this.applyTargetKey(only.key);
          autoReason = `only option: ${only.key}`;
        } else if (r.target === null) {
          this.lastIdleSig = sig;
          this.lastIdleAsk = w.tick;
        }
      }
      this.lastWaitingSig = sig;
      if (!strategic.length && w.tick >= this.rerouteQuietUntil) {
        if (autoReason) obs = observe(w, this.routes);
        const rq = rerouteQuestion(obs);
        if (rq) strategic.push(rq);
      }
      if (strategic.length) {
        const { res, rec } = await this.ask("strategic", obs, strategic);
        for (const q of strategic) {
          if (q.id === "target") {
            const d = res.dists.target as Distribution;
            const pick = isRules ? { key: res.directTarget ?? "NONE", note: res.notes?.find((n) => n.startsWith("target"))?.slice(8) ?? "rules" } : chooseKey(this.cfg.policy, d, ctx);
            this.applyTargetKey(pick.key);
            rec.selection.push({ question: "target", chosen: pick.key, p: d.probs.find((x) => x.key === pick.key)?.p ?? null, note: pick.note });
          } else if (q.id === "reroute") {
            const d = res.dists.reroute as Distribution;
            const pick = isRules ? { take: !!res.directReroute, note: "rules" } : chooseReroute(this.cfg.policy, d, this.lastRisk, ctx);
            if (pick.take) r.routeMode = "detour";
            else this.rerouteQuietUntil = w.tick + 3;
            rec.selection.push({ question: "reroute", chosen: pick.take ? "YES" : "NO", p: d.probs.find((x) => x.key === (pick.take ? "YES" : "NO"))?.p ?? null, note: pick.note });
          }
        }
        decisions.push(rec);
        obs = observe(w, this.routes);
      } else if (autoReason) obs = observe(w, this.routes);

      if (r.target === null) {
        source = "auto";
        autoReason = autoReason ?? "idle: no objective";
      } else if (this.onChargerForTarget()) {
        source = "auto";
        autoReason = "charging";
      } else {
        const { res, rec } = await this.ask("tactical", obs, [moveQuestion(), riskQuestion()]);
        const move = res.dists.move as Distribution;
        if (isRules) {
          action = res.directAction ?? "WAIT";
          rec.selection.push({ question: "move", chosen: action, p: action === "WAIT" ? null : 1, note: res.notes?.find((n) => n.startsWith("move"))?.slice(6) ?? "rules" });
        } else {
          const mc = chooseMove(this.cfg.policy, move, res.dists.risk, ctx);
          action = mc.action;
          rec.selection.push({ question: "move", chosen: mc.action, p: mc.p, note: mc.note });
        }
        const risk = res.dists.risk as Distribution;
        rec.selection.push({ question: "risk", chosen: risk.probs.reduce((a, b) => (b.p > a.p ? b : a)).key, p: null, note: "reported" });
        this.lastRisk = risk;
        decisions.push(rec);
        this.lastObservation = obs;
      }
    }
    this.heldInARow = action === "WAIT" && source !== "auto" ? this.heldInARow + 1 : 0;
    return this.finishTick(tStart, decisions, action, source, autoReason);
  }

  /** One manually driven tick (keyboard). */
  stepManual(action: Action): FullTickRecord {
    return this.finishTick(performance.now(), [], action, "manual", undefined);
  }

  private finishTick(tStart: number, decisions: DecisionRecord[], action: Action, source: TickRecord["actionSource"], autoReason: string | undefined): FullTickRecord {
    const w = this.world;
    const pre: TickPre = { target: w.robot.target ? structuredClone(w.robot.target) : null, routeMode: w.robot.routeMode };
    const tick = w.tick;
    const { events } = w.step(action);
    const rec: FullTickRecord = {
      tick,
      t: tStart - this.t0,
      decisions,
      action,
      actionSource: source,
      ...(autoReason ? { autoReason } : {}),
      endToEndMs: performance.now() - tStart,
      events,
      after: { pos: { ...w.robot.pos }, heading: w.robot.heading, battery: w.robot.battery, score: w.score, carrying: w.robot.carrying },
      pre,
    };
    this.record.ticks.push(rec);
    this.record.outcome = w.outcome;
    this.record.finalScore = w.score;
    this.record.stats = { ...w.stats };
    this.record.wallMs = performance.now() - this.t0;
    if (!decisions.length) this.lastObservation = observe(w, this.routes);
    return rec;
  }
}

/** Run a whole mission as fast as the engine answers (benchmarks, tests). */
export async function runToEnd(m: Mission, onTick?: (t: FullTickRecord) => void, signal?: AbortSignal): Promise<RunRecord> {
  while (!m.done) {
    if (signal?.aborted) throw new DOMException("run aborted", "AbortError");
    const t = await m.stepAuto();
    onTick?.(t);
  }
  return m.record;
}
