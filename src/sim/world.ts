import { Grid, dirBetween, parseMap, patrolPath } from "./grid";
import type { LevelDef } from "./levels";
import { Rng, hashSeed } from "./rng";
import type { Action, Dir, Forklift, Outcome, Package, Robot, SimEvent, Stats, Target, Vec } from "./types";
import { PRIORITY_VALUE, sameTile, turn } from "./types";

/** Battery model (percent of capacity). */
export const COST = {
  move: 0.45,
  moveCarrying: 0.6,
  wait: 0.05,
  bump: 1.5,
  spill: 1.2,
  chargePerTick: 6,
  chargeUntil: 95,
} as const;

/** Score model. */
export const SCORE = {
  wallCollision: -25,
  forkliftCollision: -40,
  spill: -10,
  batteryFailure: -200,
  lateFactor: 0.5,
  completionBase: 100,
} as const;

export interface WorldOptions {
  /** Manual driving: grab any package driven onto, charge whenever holding still on a charger. */
  manual?: boolean;
}

export interface StepResult {
  events: SimEvent[];
  outcome: Outcome;
}

export class World {
  readonly grid: Grid;
  readonly bays: Map<string, Vec>;
  readonly docks: Map<number, Vec>;
  readonly chargers: Vec[];
  robot: Robot;
  forklifts: Forklift[];
  packages: Package[];
  /** Tile indices of spills that appeared during the run (static spills live in the map). */
  dynamicSpills = new Set<number>();
  tick = 0;
  score = 0;
  outcome: Outcome = "running";
  stats: Stats = { deliveries: 0, onTime: 0, late: 0, collisions: 0, wallCollisions: 0, forkliftCollisions: 0, spills: 0, waits: 0, moves: 0, charges: 0, batteryFailures: 0 };
  log: SimEvent[] = [];
  private spillSchedule: { tick: number; at: Vec }[] = [];
  private deadlineReported = new Set<string>();
  private stuckWaits = new Map<string, number>();

  constructor(
    readonly level: LevelDef,
    readonly seed: number,
    readonly options: WorldOptions = {},
  ) {
    const parsed = parseMap(level.map);
    this.grid = new Grid(parsed.w, parsed.h, parsed.tiles);
    this.bays = parsed.bays;
    this.docks = parsed.docks;
    this.chargers = parsed.chargers;
    const rng = new Rng(hashSeed(level.key, seed, "setup"));

    this.robot = { pos: { ...parsed.start }, heading: "E", battery: level.startBattery, carrying: null, target: null, routeMode: "primary", moving: false, charging: false };

    const priorities = rng.shuffle([...level.priorityPool]);
    this.packages = level.packages.map((def, i) => {
      const pickup = parsed.bays.get(def.bay);
      if (!pickup) throw new Error(`${level.key}: bay ${def.bay} missing from map`);
      if (!parsed.docks.has(def.dock)) throw new Error(`${level.key}: dock ${def.dock} missing from map`);
      const jitter = def.release === 0 ? 0 : rng.int(-level.releaseJitter, level.releaseJitter);
      const release = Math.max(0, def.release + jitter);
      return {
        // Numbers, not letters: JEB's answer labels are A..Z, and "A) PACKAGE B" would invite confusion.
        id: String(i + 1),
        pickup: { ...pickup },
        dock: def.dock,
        priority: def.priority ?? priorities[i % priorities.length] ?? "NORMAL",
        releaseTick: release,
        deadlineTick: def.window === null ? null : release + def.window,
        status: "scheduled",
        deliveredTick: null,
      };
    });

    this.forklifts = level.forklifts.map((def) => {
      const path = patrolPath(this.grid, def.waypoints, def.mode);
      const index = rng.int(0, path.length - 1);
      const pos = path[index] as Vec;
      const next = path[(index + 1) % path.length] as Vec;
      return { id: def.id, path, index, pos: { ...pos }, heading: dirBetween(pos, next) ?? "E", every: def.every, phase: rng.int(0, def.every - 1), waitedLastTick: false };
    });
    // Forklifts must not start on the robot or on each other.
    for (const f of this.forklifts) {
      let guard = 0;
      while ((sameTile(f.pos, this.robot.pos) || this.forklifts.some((o) => o !== f && sameTile(o.pos, f.pos))) && guard++ < f.path.length) {
        f.index = (f.index + 1) % f.path.length;
        f.pos = { ...(f.path[f.index] as Vec) };
      }
    }

    const spillRng = new Rng(hashSeed(level.key, seed, "spills"));
    const candidates = this.spillCandidates();
    for (const ev of level.spillEvents) {
      const at = spillRng.pick(candidates);
      this.spillSchedule.push({ tick: Math.max(1, ev.tick + spillRng.int(-ev.jitter, ev.jitter)), at });
    }
    this.spillSchedule.sort((a, b) => a.tick - b.tick);
    this.processTickStart();
  }

  /** Corridor tiles where a spill may appear: plain floor, not the start, not next to the start. */
  private spillCandidates(): Vec[] {
    const out: Vec[] = [];
    for (let y = 0; y < this.grid.h; y++)
      for (let x = 0; x < this.grid.w; x++) {
        const t = this.grid.tile({ x, y });
        if (t.kind !== "floor") continue;
        if (Math.abs(x - this.robot.pos.x) + Math.abs(y - this.robot.pos.y) <= 2) continue;
        out.push({ x, y });
      }
    return out;
  }

  isSpill(p: Vec): boolean {
    return this.grid.tile(p).kind === "spill" || this.dynamicSpills.has(this.grid.idx(p));
  }

  forkliftAt(p: Vec): Forklift | undefined {
    return this.forklifts.find((f) => sameTile(f.pos, p));
  }

  packageById(id: string): Package | undefined {
    return this.packages.find((p) => p.id === id);
  }

  waitingPackages(): Package[] {
    return this.packages.filter((p) => p.status === "waiting");
  }

  /** Does forklift `f` try to move this tick (its cadence), ignoring blockers? */
  forkliftActive(f: Forklift, tick = this.tick): boolean {
    return tick % f.every === f.phase;
  }

  /**
   * Where each forklift will be after this tick, assuming the robot stays where it is. Forklifts yield to the
   * robot's current tile and to each other (in id order). This is exactly what `step` does, so it is a true
   * prediction as long as the robot does not move into a forklift's path.
   */
  predictForklifts(): Map<string, Vec> {
    const planned = new Map<string, Vec>();
    const taken = new Set<number>(this.forklifts.map((f) => this.grid.idx(f.pos)));
    for (const f of this.forklifts) {
      let dest = f.pos;
      if (this.forkliftActive(f)) {
        const next = f.path[(f.index + 1) % f.path.length] as Vec;
        const ni = this.grid.idx(next);
        if (!sameTile(next, this.robot.pos) && !taken.has(ni)) {
          dest = next;
          taken.delete(this.grid.idx(f.pos));
          taken.add(ni);
        }
      }
      planned.set(f.id, dest);
    }
    return planned;
  }

  targetTile(t: Target = this.robot.target): Vec | null {
    if (!t) return null;
    if (t.kind === "package") return this.packageById(t.id)?.pickup ?? null;
    if (t.kind === "dock") return this.docks.get(t.dock) ?? null;
    return t.charger;
  }

  setTarget(t: Target): void {
    this.robot.target = t;
    this.robot.routeMode = "primary";
  }

  step(action: Action): StepResult {
    if (this.outcome !== "running") return { events: [], outcome: this.outcome };
    const events: SimEvent[] = [];
    const r = this.robot;
    const emit = (kind: SimEvent["kind"], at: Vec, detail: string, scoreDelta = 0): void => {
      events.push({ kind, tick: this.tick, at: { ...at }, detail, scoreDelta });
      this.score += scoreDelta;
    };

    // 1. forklifts plan (they yield to the robot's current tile and to each other)
    const planned = this.predictForklifts();

    // 2. the robot acts
    r.moving = false;
    if (action === "WAIT") {
      r.battery -= COST.wait;
      this.stats.waits++;
      emit("wait", r.pos, "holding position");
    } else {
      const heading: Dir = turn(r.heading, action);
      r.heading = heading;
      const dest = this.grid.step(r.pos, heading);
      const cost = r.carrying ? COST.moveCarrying : COST.move;
      const hitForklift = this.forklifts.find((f) => {
        const after = planned.get(f.id) as Vec;
        return sameTile(after, dest);
      });
      if (!this.grid.walkable(dest)) {
        r.battery -= COST.bump;
        this.stats.collisions++;
        this.stats.wallCollisions++;
        emit("collision_static", dest, `bumped into ${this.grid.tile(dest).kind}`, SCORE.wallCollision);
      } else if (hitForklift) {
        r.battery -= COST.bump;
        this.stats.collisions++;
        this.stats.forkliftCollisions++;
        emit("collision_forklift", dest, `collided with forklift ${hitForklift.id}`, SCORE.forkliftCollision);
      } else {
        r.pos = dest;
        r.moving = true;
        r.battery -= cost;
        this.stats.moves++;
        emit("move", dest, `moved ${action.toLowerCase()}`);
        if (this.isSpill(dest)) {
          r.battery -= COST.spill;
          this.stats.spills++;
          emit("spill", dest, "skidded through an oil spill", SCORE.spill);
        }
      }
    }

    // 3. forklifts move
    for (const f of this.forklifts) {
      const dest = planned.get(f.id) as Vec;
      if (sameTile(dest, f.pos)) {
        f.waitedLastTick = this.forkliftActive(f);
        if (f.waitedLastTick) this.breakDeadlock(f);
        continue;
      }
      f.heading = dirBetween(f.pos, dest) ?? f.heading;
      f.pos = { ...dest };
      f.index = (f.index + 1) % f.path.length;
      f.waitedLastTick = false;
      this.stuckWaits.delete(f.id);
    }

    // 4. arrival effects
    const here = r.pos;
    r.charging = false;
    if (r.carrying) {
      const pkg = this.packageById(r.carrying) as Package;
      if (sameTile(here, this.docks.get(pkg.dock) as Vec)) {
        const late = pkg.deadlineTick !== null && this.tick > pkg.deadlineTick;
        const value = Math.round(PRIORITY_VALUE[pkg.priority] * (late ? SCORE.lateFactor : 1));
        pkg.status = "delivered";
        pkg.deliveredTick = this.tick;
        r.carrying = null;
        this.stats.deliveries++;
        if (late) this.stats.late++;
        else this.stats.onTime++;
        emit("delivery", here, `delivered package ${pkg.id} (${pkg.priority})${late ? " late" : ""}`, value);
        if (r.target?.kind === "dock") this.setTarget(null);
      }
    } else {
      const tgt = r.target;
      const onPkg = this.packages.find((p) => p.status === "waiting" && sameTile(p.pickup, here));
      if (onPkg && ((tgt?.kind === "package" && tgt.id === onPkg.id) || this.options.manual)) {
        onPkg.status = "carried";
        r.carrying = onPkg.id;
        this.setTarget({ kind: "dock", dock: onPkg.dock, packageId: onPkg.id });
        emit("pickup", here, `picked up package ${onPkg.id} (${onPkg.priority})`);
      }
    }
    const onCharger = this.chargers.some((c) => sameTile(c, here));
    const wantsCharge = r.target?.kind === "charge" || this.options.manual;
    if (onCharger && action === "WAIT" && wantsCharge && r.battery < 100) {
      r.battery = Math.min(100, r.battery + COST.chargePerTick);
      r.charging = true;
      this.stats.charges++;
      emit("charge", here, `charging ${Math.round(r.battery)}%`);
      if (r.battery >= COST.chargeUntil && r.target?.kind === "charge") {
        emit("charged", here, "charged, ready");
        this.setTarget(null);
      }
    }

    // 5. battery
    if (r.battery <= 0) {
      r.battery = 0;
      this.stats.batteryFailures++;
      emit("battery_failure", here, "battery depleted: robot stranded", SCORE.batteryFailure);
      this.outcome = "battery_failure";
    }

    // 6. next tick
    this.tick++;
    events.push(...this.processTickStart());
    if (this.outcome === "running") {
      if (this.packages.every((p) => p.status === "delivered")) {
        const bonus = SCORE.completionBase + (this.level.timeLimit - this.tick);
        emit("mission_complete", here, `all packages delivered, ${this.level.timeLimit - this.tick} ticks to spare`, bonus);
        this.outcome = "complete";
      } else if (this.tick >= this.level.timeLimit) {
        emit("time_up", here, "shift over: time limit reached");
        this.outcome = "time_up";
      }
    }
    this.log.push(...events);
    return { events, outcome: this.outcome };
  }

  /** A forklift blocked by another forklift for several active ticks turns back along its patrol. */
  private breakDeadlock(f: Forklift): void {
    const next = f.path[(f.index + 1) % f.path.length] as Vec;
    if (!this.forklifts.some((o) => o !== f && sameTile(o.pos, next))) return;
    const n = (this.stuckWaits.get(f.id) ?? 0) + 1;
    this.stuckWaits.set(f.id, n);
    if (n >= 4) {
      f.path = [...f.path].reverse();
      f.index = f.path.findIndex((p) => sameTile(p, f.pos));
      this.stuckWaits.delete(f.id);
    }
  }

  /** Releases, spills and deadline notices for the tick that is starting. */
  private processTickStart(): SimEvent[] {
    const out: SimEvent[] = [];
    for (const p of this.packages) {
      if (p.status === "scheduled" && p.releaseTick <= this.tick) {
        p.status = "waiting";
        out.push({ kind: "package_released", tick: this.tick, at: { ...p.pickup }, detail: `package ${p.id} (${p.priority}) ready at bay`, scoreDelta: 0 });
      }
      if (p.deadlineTick !== null && this.tick > p.deadlineTick && p.status !== "delivered" && !this.deadlineReported.has(p.id)) {
        this.deadlineReported.add(p.id);
        out.push({ kind: "deadline_missed", tick: this.tick, at: { ...p.pickup }, detail: `package ${p.id} is now late`, scoreDelta: 0 });
      }
    }
    while (this.spillSchedule.length && (this.spillSchedule[0] as { tick: number }).tick <= this.tick) {
      const s = this.spillSchedule.shift() as { tick: number; at: Vec };
      if (sameTile(s.at, this.robot.pos) || this.forkliftAt(s.at)) continue;
      this.dynamicSpills.add(this.grid.idx(s.at));
      out.push({ kind: "spill_appeared", tick: this.tick, at: { ...s.at }, detail: "oil spill reported", scoreDelta: 0 });
    }
    return out;
  }

  /** Compact, render-friendly copy of the mutable state (for replay frames and interpolation). */
  snapshot(): WorldSnapshot {
    return {
      tick: this.tick,
      robot: { ...this.robot, pos: { ...this.robot.pos }, target: this.robot.target ? structuredClone(this.robot.target) : null },
      forklifts: this.forklifts.map((f) => ({ id: f.id, pos: { ...f.pos }, heading: f.heading })),
      packages: this.packages.map((p) => ({ id: p.id, status: p.status, pickup: { ...p.pickup }, dock: p.dock, priority: p.priority, deadlineTick: p.deadlineTick })),
      spills: [...this.dynamicSpills],
      score: this.score,
      outcome: this.outcome,
      stats: { ...this.stats },
    };
  }
}

export interface WorldSnapshot {
  tick: number;
  robot: Robot;
  forklifts: { id: string; pos: Vec; heading: Dir }[];
  packages: Pick<Package, "id" | "status" | "pickup" | "dock" | "priority" | "deadlineTick">[];
  spills: number[];
  score: number;
  outcome: Outcome;
  stats: Stats;
}
