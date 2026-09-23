/**
 * The compact state a decision-maker receives. Code owns geometry (routes, distances, predictions); the
 * decision-maker only judges. JEB gets `renderState(obs)`; the rules baseline reads the same `Observation`.
 */
import type { Dir, Priority, RelMove, Vec } from "./types";
import { DIR_NAME, DIR_VEC, REL_MOVES, manhattan, sameTile, turn } from "./types";
import { COST, type World } from "./world";

export const DOCK_NAMES: Record<number, string> = { 1: "RED", 2: "BLUE", 3: "GREEN" };
export const dockName = (n: number): string => DOCK_NAMES[n] ?? `#${n}`;

export type DirKind = "floor" | "wall" | "shelf" | "crate" | "charger" | "dock" | "pickup" | "spill";

export interface DirInfo {
  rel: RelMove;
  abs: Dir;
  tile: Vec;
  kind: DirKind;
  /** Static obstacle: moving there is a collision. */
  blocked: boolean;
  forkliftNow: string | null;
  forkliftNext: string | null;
  spill: boolean;
  /** Primary-route distance to the target from that tile (null: blocked / no target / unreachable). */
  steps: number | null;
  /** The next step of the active route. */
  onRoute: boolean;
  /** The next step of a route that avoids forklifts and spills (null field = no such route). */
  onDetour: boolean;
  /** A forklift standing in this tile is waiting for the robot to clear its path (it will not move first). */
  forkliftWaitingForRobot: boolean;
  text: string;
}

export interface TrafficInfo {
  id: string;
  distance: number;
  relative: string;
  motion: "coming toward the robot" | "moving away" | "crossing" | "stopped";
  inDir: RelMove | null;
  entersDir: RelMove | null;
  pos: Vec;
  next: Vec;
}

export interface TargetOption {
  key: string;
  kind: "package" | "deliver" | "charge" | "none";
  packageId?: string;
  priority?: Priority;
  pickupSteps?: number;
  dockSteps?: number;
  totalSteps?: number;
  deadlineIn?: number | null;
  chargerSteps?: number;
  /** Battery (percent) the job needs including the way from its end to the nearest charger. */
  needPct?: number;
  description: string;
}

export interface Observation {
  tick: number;
  levelName: string;
  robot: {
    pos: Vec;
    heading: Dir;
    battery: number;
    moving: boolean;
    carrying: { id: string; priority: Priority; dock: number; deadlineIn: number | null } | null;
  };
  target: {
    kind: "package" | "dock" | "charge";
    label: string;
    tile: Vec;
    steps: number | null;
    primarySteps: number | null;
    detourSteps: number | null;
    routeMode: "primary" | "detour";
  } | null;
  dirs: DirInfo[];
  traffic: TrafficInfo[];
  hazards: { relative: string; distance: number; pos: Vec }[];
  battery: { pct: number; stepsLeft: number; chargerSteps: number | null; routeNeed: number | null; enough: boolean | null };
  mission: { delivered: number; total: number; waiting: number; score: number; ticksLeft: number };
  obstruction: { what: string; distance: number; detourExtra: number | null } | null;
  targetOptions: TargetOption[];
  sensorRange: number | null;
  /** The robot is standing on its target charger. */
  atCharger: boolean;
}

const PREFER: RelMove[] = ["FORWARD", "LEFT", "RIGHT", "REVERSE"];

/** Offsets relative to heading: `ahead` > 0 in front, `right` > 0 to the right. */
function relOffset(heading: Dir, from: Vec, to: Vec): { ahead: number; right: number } {
  const f = DIR_VEC[heading];
  const r = DIR_VEC[turn(heading, "RIGHT")];
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return { ahead: dx * f.dx + dy * f.dy, right: dx * r.dx + dy * r.dy };
}

const tiles = (n: number): string => `${n} tile${n === 1 ? "" : "s"}`;

export function describeRelative(heading: Dir, from: Vec, to: Vec): string {
  const { ahead, right } = relOffset(heading, from, to);
  const parts: string[] = [];
  if (ahead > 0) parts.push(`${tiles(ahead)} ahead`);
  if (ahead < 0) parts.push(`${tiles(-ahead)} behind`);
  if (right !== 0) {
    const side = right > 0 ? "right" : "left";
    parts.push(parts.length ? `${Math.abs(right)} to the ${side}` : `${tiles(Math.abs(right))} to the ${side}`);
  }
  return parts.join(" and ") || "here";
}

export class RouteCache {
  private primary = new Map<number, Int16Array>();
  constructor(private world: World) {}
  field(goal: Vec): Int16Array {
    const k = this.world.grid.idx(goal);
    let f = this.primary.get(k);
    if (!f) {
      f = this.world.grid.distanceField(goal);
      this.primary.set(k, f);
    }
    return f;
  }
  dist(from: Vec, to: Vec): number | null {
    const d = this.field(to)[this.world.grid.idx(from)] ?? -1;
    return d < 0 ? null : d;
  }
}

/** Next tile along a distance field from `p`, preferring to keep the heading. */
function nextOnField(world: World, field: Int16Array, p: Vec, heading: Dir): Vec | null {
  const d = field[world.grid.idx(p)] ?? -1;
  if (d <= 0) return null;
  for (const m of PREFER) {
    const n = world.grid.step(p, turn(heading, m));
    if (world.grid.walkable(n) && field[world.grid.idx(n)] === d - 1) return n;
  }
  return null;
}

export function nearestCharger(world: World, routes: RouteCache, from: Vec): { tile: Vec; steps: number } | null {
  let best: { tile: Vec; steps: number } | null = null;
  for (const c of world.chargers) {
    const s = routes.dist(from, c);
    if (s !== null && (!best || s < best.steps)) best = { tile: c, steps: s };
  }
  return best;
}

export function observe(world: World, routes: RouteCache): Observation {
  const r = world.robot;
  const g = world.grid;
  const predicted = world.predictForklifts();
  const carriedPkg = r.carrying ? world.packageById(r.carrying) ?? null : null;
  const targetTile = world.targetTile();
  const moveCost = r.carrying ? COST.moveCarrying : COST.move;

  // Routes: primary = static map; detour = also avoiding forklifts (now and next tick) and spills.
  let primaryField: Int16Array | null = null;
  let detourField: Int16Array | null = null;
  let primarySteps: number | null = null;
  let detourSteps: number | null = null;
  let obstruction: Observation["obstruction"] = null;
  if (targetTile) {
    primaryField = routes.field(targetTile);
    const ps = primaryField[g.idx(r.pos)] ?? -1;
    primarySteps = ps < 0 ? null : ps;
    const blocked = new Set<number>();
    for (const f of world.forklifts) {
      blocked.add(g.idx(f.pos));
      blocked.add(g.idx(predicted.get(f.id) as Vec));
    }
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (world.isSpill({ x, y })) blocked.add(g.idx({ x, y }));
    blocked.delete(g.idx(targetTile));
    blocked.delete(g.idx(r.pos));
    detourField = g.distanceField(targetTile, blocked);
    const dsRaw = detourField[g.idx(r.pos)] ?? -1;
    detourSteps = dsRaw < 0 ? null : dsRaw;
    // Walk the primary route a few steps and report the first thing in the way.
    let p = r.pos;
    let h = r.heading;
    for (let k = 1; k <= 8; k++) {
      const n = nextOnField(world, primaryField, p, h);
      if (!n) break;
      const f = world.forklifts.find((fl) => sameTile(fl.pos, n) || sameTile(predicted.get(fl.id) as Vec, n));
      if (f && (world.level.sensorRange === null || manhattan(f.pos, r.pos) <= world.level.sensorRange)) {
        obstruction = { what: `forklift ${f.id}`, distance: k, detourExtra: null };
        break;
      }
      if (world.isSpill(n) && !sameTile(n, targetTile)) {
        obstruction = { what: "an oil spill", distance: k, detourExtra: null };
        break;
      }
      const d = (["N", "E", "S", "W"] as Dir[]).find((dd) => sameTile(g.step(p, dd), n));
      if (d) h = d;
      p = n;
    }
    if (obstruction && detourSteps !== null && primarySteps !== null) obstruction.detourExtra = detourSteps - primarySteps;
  }
  const activeField = r.routeMode === "detour" && detourField && detourSteps !== null ? detourField : primaryField;
  const routeNext = activeField ? nextOnField(world, activeField, r.pos, r.heading) : null;
  const detourNext = detourField && detourSteps !== null ? nextOnField(world, detourField, r.pos, r.heading) : null;

  const dirs: DirInfo[] = REL_MOVES.map((rel) => {
    const abs = turn(r.heading, rel);
    const tile = g.step(r.pos, abs);
    const t = g.tile(tile);
    const spill = world.isSpill(tile);
    const kind: DirKind = spill ? "spill" : t.kind === "floor" ? "floor" : (t.kind as DirKind);
    const blocked = !g.walkable(tile);
    const fNow = world.forklifts.find((f) => sameTile(f.pos, tile))?.id ?? null;
    const fNext = world.forklifts.find((f) => sameTile(predicted.get(f.id) as Vec, tile))?.id ?? null;
    const sensed = (id: string | null): string | null => {
      if (!id || world.level.sensorRange === null) return id;
      const f = world.forklifts.find((x) => x.id === id);
      return f && manhattan(f.pos, r.pos) <= world.level.sensorRange ? id : null;
    };
    const stepsRaw = !blocked && primaryField ? primaryField[g.idx(tile)] ?? -1 : -1;
    const steps = stepsRaw < 0 ? null : stepsRaw;
    const onRoute = !!routeNext && sameTile(routeNext, tile);
    const onDetour = !!detourNext && sameTile(detourNext, tile);
    // A forklift in this tile whose next patrol tile is the robot's tile yields to the robot: it is waiting.
    const fl = fNow ? world.forklifts.find((f) => f.id === fNow) : undefined;
    const waiting = !!fl && sameTile(fl.path[(fl.index + 1) % fl.path.length] as Vec, r.pos);
    return { rel, abs, tile, kind, blocked, forkliftNow: sensed(fNow), forkliftNext: sensed(fNext), spill, steps, onRoute, onDetour, forkliftWaitingForRobot: waiting && !!sensed(fNow), text: "" };
  });
  for (const d of dirs) d.text = describeDir(world, d, targetTile);

  const traffic: TrafficInfo[] = world.forklifts
    .map((f) => {
      const next = predicted.get(f.id) as Vec;
      const dist = manhattan(f.pos, r.pos);
      const nd = manhattan(next, r.pos);
      const moved = !sameTile(next, f.pos);
      const motion: TrafficInfo["motion"] = !moved ? "stopped" : nd < dist ? "coming toward the robot" : nd > dist ? "moving away" : "crossing";
      const inDir = dirs.find((d) => sameTile(d.tile, f.pos))?.rel ?? null;
      const entersDir = moved ? dirs.find((d) => sameTile(d.tile, next))?.rel ?? null : null;
      return { id: f.id, distance: dist, relative: describeRelative(r.heading, r.pos, f.pos), motion, inDir, entersDir, pos: { ...f.pos }, next: { ...next } };
    })
    .filter((t) => (world.level.sensorRange === null ? t.distance <= 6 : t.distance <= world.level.sensorRange))
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
    .slice(0, 3);

  const hazards: Observation["hazards"] = [];
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      const p = { x, y };
      const dist = manhattan(p, r.pos);
      if (dist > 0 && dist <= 3 && world.isSpill(p)) hazards.push({ relative: describeRelative(r.heading, r.pos, p), distance: dist, pos: p });
    }
  hazards.sort((a, b) => a.distance - b.distance);

  const charger = nearestCharger(world, routes, r.pos);
  let routeNeed: number | null = null;
  if (targetTile && primarySteps !== null) {
    let finalTile = targetTile;
    let need = primarySteps;
    const tgt = r.target;
    if (tgt?.kind === "package") {
      const pkg = world.packageById(tgt.id);
      const dock = pkg ? world.docks.get(pkg.dock) : undefined;
      if (pkg && dock) {
        need += routes.dist(pkg.pickup, dock) ?? 0;
        finalTile = dock;
      }
    }
    if (tgt?.kind !== "charge") need += nearestCharger(world, routes, finalTile)?.steps ?? 0;
    routeNeed = need;
  }
  const stepsLeft = Math.max(0, Math.floor(r.battery / moveCost));

  const obs: Observation = {
    tick: world.tick,
    levelName: world.level.name,
    robot: {
      pos: { ...r.pos },
      heading: r.heading,
      battery: r.battery,
      moving: r.moving,
      carrying: carriedPkg ? { id: carriedPkg.id, priority: carriedPkg.priority, dock: carriedPkg.dock, deadlineIn: carriedPkg.deadlineTick === null ? null : carriedPkg.deadlineTick - world.tick } : null,
    },
    target: targetTile && r.target
      ? {
          kind: r.target.kind,
          label: targetLabel(world, r.target),
          tile: targetTile,
          steps: r.routeMode === "detour" && detourSteps !== null ? detourSteps : primarySteps,
          primarySteps,
          detourSteps,
          routeMode: r.routeMode === "detour" && detourSteps !== null ? "detour" : "primary",
        }
      : null,
    dirs,
    traffic,
    hazards: hazards.slice(0, 2),
    battery: { pct: r.battery, stepsLeft, chargerSteps: charger?.steps ?? null, routeNeed, enough: routeNeed === null ? null : stepsLeft >= routeNeed },
    mission: {
      delivered: world.packages.filter((p) => p.status === "delivered").length,
      total: world.packages.length,
      waiting: world.waitingPackages().length,
      score: world.score,
      ticksLeft: world.level.timeLimit - world.tick,
    },
    obstruction,
    targetOptions: [],
    sensorRange: world.level.sensorRange,
    atCharger: r.target?.kind === "charge" && sameTile(r.pos, r.target.charger),
  };
  obs.targetOptions = targetOptions(world, routes, obs);
  return obs;
}

export function targetLabel(world: World, t: NonNullable<World["robot"]["target"]>): string {
  if (t.kind === "package") {
    const p = world.packageById(t.id);
    return `package ${t.id} at its pickup bay${p ? ` (${p.priority})` : ""}`;
  }
  if (t.kind === "dock") return `the ${dockName(t.dock)} dock (deliver package ${t.packageId})`;
  return "the charging station";
}

function describeDir(world: World, d: DirInfo, targetTile: Vec | null): string {
  const bits: string[] = [];
  if (d.blocked) {
    const what = d.kind === "wall" ? "wall" : d.kind === "shelf" ? "shelving" : "crate stack";
    return `${what}, blocked (moving there is a collision)`;
  }
  // A move collides exactly when some forklift occupies the tile after this tick (`forkliftNext`).
  if (d.forkliftNow && d.forkliftNext === d.forkliftNow) {
    bits.push(`forklift ${d.forkliftNow} is there${d.forkliftWaitingForRobot ? ", waiting for the robot to clear its path" : " and staying"} (moving there is a collision)`);
  } else if (d.forkliftNow && d.forkliftNext) {
    bits.push(`forklift ${d.forkliftNow} leaves it but forklift ${d.forkliftNext} enters it next tick (moving there is a collision)`);
  } else if (d.forkliftNow) {
    bits.push(`forklift ${d.forkliftNow} is there but leaves it this tick`);
  } else if (d.forkliftNext) bits.push(`forklift ${d.forkliftNext} enters it next tick (moving there is a collision)`);
  switch (d.kind) {
    case "spill":
      bits.push("oil spill (slippery, costs battery)");
      break;
    case "charger":
      bits.push("charging station");
      break;
    case "dock":
      bits.push(`${dockName(world.grid.tile(d.tile).dock ?? 0)} dock`);
      break;
    case "pickup": {
      const pkg = world.packages.find((p) => p.status === "waiting" && sameTile(p.pickup, d.tile));
      bits.push(pkg ? `pickup bay (package ${pkg.id} waiting)` : "pickup bay (empty)");
      break;
    }
    default:
      if (!d.forkliftNow && !d.forkliftNext) bits.push("open floor");
  }
  if (targetTile && sameTile(d.tile, targetTile)) bits.push("the target itself");
  else if (d.steps !== null) bits.push(`${d.onRoute ? "on route, " : d.onDetour ? "starts the clear detour, " : ""}${d.steps} steps from there`);
  return bits.join(", ");
}

function targetOptions(world: World, routes: RouteCache, obs: Observation): TargetOption[] {
  const r = world.robot;
  const out: TargetOption[] = [];
  const charger = nearestCharger(world, routes, r.pos);
  const pct = Math.round(r.battery);
  if (r.carrying) {
    const pkg = world.packageById(r.carrying);
    const dock = pkg ? world.docks.get(pkg.dock) : undefined;
    if (pkg && dock) {
      const steps = routes.dist(r.pos, dock);
      const back = nearestCharger(world, routes, dock)?.steps ?? 0;
      const needPct = Math.ceil((steps ?? 0) * COST.moveCarrying + back * COST.move);
      const due = pkg.deadlineTick === null ? "no deadline" : pkg.deadlineTick - world.tick >= 0 ? `due in ${pkg.deadlineTick - world.tick} ticks` : "already late";
      out.push({
        key: `DELIVER ${pkg.id}`,
        kind: "deliver",
        packageId: pkg.id,
        priority: pkg.priority,
        dockSteps: steps ?? undefined,
        totalSteps: steps ?? undefined,
        deadlineIn: pkg.deadlineTick === null ? null : pkg.deadlineTick - world.tick,
        needPct,
        description: `carry on to the ${dockName(pkg.dock)} dock, ${steps ?? "?"} steps, priority ${pkg.priority}, ${due}; needs about ${needPct}% battery with the way back to a charger`,
      });
    }
  } else {
    const cands = world
      .waitingPackages()
      .map((p) => {
        const pickupSteps = routes.dist(r.pos, p.pickup);
        const dockSteps = routes.dist(p.pickup, world.docks.get(p.dock) as Vec);
        return { p, pickupSteps, dockSteps };
      })
      .filter((c) => c.pickupSteps !== null && c.dockSteps !== null)
      .sort((a, b) => (a.pickupSteps as number) + (a.dockSteps as number) - ((b.pickupSteps as number) + (b.dockSteps as number)) || a.p.id.localeCompare(b.p.id))
      .slice(0, 4);
    for (const { p, pickupSteps, dockSteps } of cands) {
      const due = p.deadlineTick === null ? "no deadline" : p.deadlineTick - world.tick >= 0 ? `due in ${p.deadlineTick - world.tick} ticks` : "already late";
      const back = nearestCharger(world, routes, world.docks.get(p.dock) as Vec)?.steps ?? 0;
      const needPct = Math.ceil((pickupSteps as number) * COST.move + (dockSteps as number) * COST.moveCarrying + back * COST.move);
      out.push({
        key: `PACKAGE ${p.id}`,
        kind: "package",
        packageId: p.id,
        priority: p.priority,
        pickupSteps: pickupSteps as number,
        dockSteps: dockSteps as number,
        totalSteps: (pickupSteps as number) + (dockSteps as number),
        deadlineIn: p.deadlineTick === null ? null : p.deadlineTick - world.tick,
        needPct,
        description: `priority ${p.priority}, pickup ${pickupSteps} steps away, then ${dockSteps} steps to the ${dockName(p.dock)} dock, ${due}; needs about ${needPct}% battery`,
      });
    }
    if (cands.length === 0) out.push({ key: "NONE", kind: "none", description: "no package is ready yet: hold position and wait for new work" });
  }
  if (charger && pct < 90) {
    out.push({ key: "CHARGE", kind: "charge", chargerSteps: charger.steps, description: `go to the nearest charging station, ${charger.steps} steps away (battery ${pct}%, enough for about ${obs.battery.stepsLeft} steps)` });
  }
  return out;
}

/** The state text sent to JEB: labelled lines, cheaper in tokens than indented JSON (see README "State design"). */
export function renderState(obs: Observation): string {
  const r = obs.robot;
  const lines: string[] = [];
  const carry = r.carrying
    ? `carrying package ${r.carrying.id} (${r.carrying.priority}) for the ${dockName(r.carrying.dock)} dock${r.carrying.deadlineIn === null ? "" : r.carrying.deadlineIn >= 0 ? `, due in ${r.carrying.deadlineIn} ticks` : ", already late"}`
    : "not carrying";
  lines.push(`ROBOT: tile (${r.pos.x},${r.pos.y}), facing ${DIR_NAME[r.heading]}, ${r.moving ? "moving" : "stopped"}, battery ${Math.round(r.battery)}%, ${carry}`);
  if (obs.target) {
    const t = obs.target;
    if (t.routeMode === "detour") lines.push(`TARGET: ${t.label}, ${t.steps} steps on the detour route (direct route ${t.primarySteps} steps)`);
    else lines.push(`TARGET: ${t.label}, ${t.steps ?? "?"} steps on the planned route`);
  } else lines.push("TARGET: none yet (choosing the next objective)");
  for (const rel of ["FORWARD", "LEFT", "RIGHT", "REVERSE"] as RelMove[]) {
    const d = obs.dirs.find((x) => x.rel === rel) as DirInfo;
    lines.push(`${rel} (${DIR_NAME[d.abs]}): ${d.text}`);
  }
  if (obs.traffic.length) {
    lines.push(
      "TRAFFIC: " +
        obs.traffic
          .map((t) => {
            let s = `forklift ${t.id} ${t.relative}, ${t.motion}`;
            if (t.inDir) s += `; it is in the ${t.inDir} tile`;
            else if (t.entersDir) s += `; it enters the ${t.entersDir} tile next tick`;
            return s;
          })
          .join("; "),
    );
  } else lines.push(obs.sensorRange === null ? "TRAFFIC: none within 6 tiles" : `TRAFFIC: none detected (night sensors reach ${obs.sensorRange} tiles)`);
  if (obs.obstruction) {
    const o = obs.obstruction;
    lines.push(`ROUTE: ${o.what} is in the way ${tiles(o.distance)} along the planned route` + (o.detourExtra === null ? "; no clear detour" : `; a clear detour is ${o.detourExtra} step${o.detourExtra === 1 ? "" : "s"} longer`));
  }
  lines.push("HAZARDS: " + (obs.hazards.length ? obs.hazards.map((h) => `oil spill ${h.relative}`).join("; ") : "none nearby"));
  const b = obs.battery;
  lines.push(
    `BATTERY: enough for about ${b.stepsLeft} steps; ` +
      (b.chargerSteps === null ? "no charger reachable" : `nearest charger ${b.chargerSteps} steps away`) +
      (b.routeNeed === null ? "" : `; this job needs about ${b.routeNeed} steps including the way to a charger`),
  );
  const m = obs.mission;
  lines.push(`MISSION: ${m.delivered} of ${m.total} delivered, ${m.waiting} waiting, score ${m.score}, ${m.ticksLeft} ticks left`);
  return lines.join("\n");
}
