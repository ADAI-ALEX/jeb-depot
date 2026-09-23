/** Core simulation types. Coordinates are tile units: x grows east, y grows south. */

export type Dir = "N" | "E" | "S" | "W";
export const DIRS: readonly Dir[] = ["N", "E", "S", "W"];
export const DIR_NAME: Record<Dir, string> = { N: "north", E: "east", S: "south", W: "west" };
export const DIR_VEC: Record<Dir, { dx: number; dy: number }> = { N: { dx: 0, dy: -1 }, E: { dx: 1, dy: 0 }, S: { dx: 0, dy: 1 }, W: { dx: -1, dy: 0 } };

/** Movement relative to the robot's heading — the MOVE decision's options. */
export type RelMove = "LEFT" | "FORWARD" | "RIGHT" | "REVERSE";
export const REL_MOVES: readonly RelMove[] = ["LEFT", "FORWARD", "RIGHT", "REVERSE"];
/** What the robot does in a tick: a move, or hold position (policy / rules / manual / charging). */
export type Action = RelMove | "WAIT";

export function turn(d: Dir, m: RelMove): Dir {
  const i = DIRS.indexOf(d);
  const k = m === "FORWARD" ? 0 : m === "RIGHT" ? 1 : m === "REVERSE" ? 2 : 3;
  return DIRS[(i + k) % 4] as Dir;
}

/** The relative move that heads in absolute direction `to` from heading `from`. */
export function relFor(from: Dir, to: Dir): RelMove {
  const k = (DIRS.indexOf(to) - DIRS.indexOf(from) + 4) % 4;
  return (["FORWARD", "RIGHT", "REVERSE", "LEFT"] as const)[k] as RelMove;
}

export interface Vec {
  x: number;
  y: number;
}

export const vecKey = (p: Vec): number => p.y * 64 + p.x;
export const sameTile = (a: Vec, b: Vec): boolean => a.x === b.x && a.y === b.y;
export const manhattan = (a: Vec, b: Vec): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

export type TileKind = "wall" | "shelf" | "crate" | "floor" | "charger" | "dock" | "pickup" | "spill";

export interface Tile {
  kind: TileKind;
  /** Dock number (1-based) for docks. */
  dock?: number;
  /** Pickup bay letter for pickups. */
  bay?: string;
}

export const blocksMovement = (k: TileKind): boolean => k === "wall" || k === "shelf" || k === "crate";

export type Priority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export const PRIORITY_VALUE: Record<Priority, number> = { LOW: 60, NORMAL: 100, HIGH: 150, URGENT: 220 };

export type PackageStatus = "scheduled" | "waiting" | "carried" | "delivered";

export interface Package {
  id: string;
  pickup: Vec;
  dock: number;
  priority: Priority;
  releaseTick: number;
  /** Deliver before this tick for the on-time bonus. */
  deadlineTick: number | null;
  status: PackageStatus;
  deliveredTick: number | null;
}

export interface Forklift {
  id: string;
  /** Cyclic tile path the forklift patrols. */
  path: Vec[];
  index: number;
  pos: Vec;
  heading: Dir;
  /** Moves once every `every` ticks. */
  every: number;
  phase: number;
  /** Tiles it will occupy after the next tick (for prediction). */
  waitedLastTick: boolean;
}

export type Target =
  | { kind: "package"; id: string }
  | { kind: "dock"; dock: number; packageId: string }
  | { kind: "charge"; charger: Vec }
  | null;

export interface Robot {
  pos: Vec;
  heading: Dir;
  battery: number;
  carrying: string | null;
  target: Target;
  /** Planned route mode for the current target ("detour" after an accepted reroute). */
  routeMode: "primary" | "detour";
  moving: boolean;
  charging: boolean;
}

export type EventKind =
  | "move"
  | "wait"
  | "turn"
  | "collision_static"
  | "collision_forklift"
  | "spill"
  | "pickup"
  | "delivery"
  | "charge"
  | "charged"
  | "battery_failure"
  | "package_released"
  | "spill_appeared"
  | "deadline_missed"
  | "time_up"
  | "mission_complete";

export interface SimEvent {
  kind: EventKind;
  tick: number;
  at: Vec;
  detail: string;
  scoreDelta: number;
}

export type Outcome = "running" | "complete" | "time_up" | "battery_failure";

export interface Stats {
  deliveries: number;
  onTime: number;
  late: number;
  collisions: number;
  wallCollisions: number;
  forkliftCollisions: number;
  spills: number;
  waits: number;
  moves: number;
  charges: number;
  batteryFailures: number;
}
