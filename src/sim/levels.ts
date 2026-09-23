import type { Priority, Vec } from "./types";

/**
 * Map legend (20 x 11 tiles, 16 px each = the 320 x 176 play field):
 *   #  wall        S  shelving      X  crate stack      .  floor
 *   C  charger     1-3  loading dock  a-h  pickup bay     ~  oil spill      R  robot start
 */
export interface ForkliftDef {
  id: string;
  waypoints: Vec[];
  /** "pingpong" walks the waypoints forward then back; "loop" closes the polygon. */
  mode: "pingpong" | "loop";
  /** Moves once every `every` ticks (1 = every tick). */
  every: number;
}

export interface PackageDef {
  bay: string;
  dock: number;
  /** Priorities are dealt from `priorityPool` per seed unless fixed here. */
  priority?: Priority;
  release: number;
  /** Ticks after release before the package is late (null = no deadline). */
  window: number | null;
}

export interface SpillEventDef {
  tick: number;
  jitter: number;
}

export interface LevelDef {
  id: number;
  key: string;
  name: string;
  subtitle: string;
  map: string[];
  timeLimit: number;
  startBattery: number;
  /** Traffic further away than this (tiles, Manhattan) is invisible to the robot's sensors (null = no limit). */
  sensorRange: number | null;
  dark: boolean;
  forklifts: ForkliftDef[];
  packages: PackageDef[];
  priorityPool: Priority[];
  spillEvents: SpillEventDef[];
  /** Release-time jitter per seed (± ticks). */
  releaseJitter: number;
}

const v = (x: number, y: number): Vec => ({ x, y });

export const LEVELS: LevelDef[] = [
  {
    id: 1,
    key: "training-depot",
    name: "TRAINING DEPOT",
    subtitle: "Wide aisles, one slow forklift, no deadlines",
    map: [
      "####################",
      "#R......a......b..C#",
      "#..SSSS...SSSS.....#",
      "#..................#",
      "#..SSSS...SSSS..XX.#",
      "#......c......d....#",
      "#..SSSS...SSSS.....#",
      "#..................#",
      "#1.....~.........2.#",
      "#..................#",
      "####################",
    ],
    timeLimit: 320,
    startBattery: 100,
    sensorRange: null,
    dark: false,
    forklifts: [{ id: "F1", waypoints: [v(2, 3), v(15, 3), v(15, 7), v(2, 7)], mode: "loop", every: 2 }],
    packages: [
      { bay: "a", dock: 1, release: 0, window: null },
      { bay: "d", dock: 2, release: 0, window: null },
      { bay: "b", dock: 2, release: 40, window: null },
      { bay: "c", dock: 1, release: 80, window: null },
    ],
    priorityPool: ["LOW", "NORMAL", "NORMAL", "HIGH"],
    spillEvents: [],
    releaseJitter: 10,
  },
  {
    id: 2,
    key: "crowded-warehouse",
    name: "CROWDED WAREHOUSE",
    subtitle: "Narrow aisles, three forklifts, three docks",
    map: [
      "####################",
      "#R.a..SS..b..SS..c.#",
      "#.SS..SS.SS..SS.SS.#",
      "#.SS......SS.......#",
      "#....SS.d....SS.XX.#",
      "#.SS.SS.SS.e.SS....#",
      "#.SS....SS...~..SS.#",
      "#....XX....SS..f...#",
      "#C.SS..SS......SS.C#",
      "#1.....2.......3...#",
      "####################",
    ],
    timeLimit: 380,
    startBattery: 100,
    sensorRange: null,
    dark: false,
    forklifts: [
      { id: "F1", waypoints: [v(2, 9), v(17, 9)], mode: "pingpong", every: 2 },
      { id: "F2", waypoints: [v(18, 1), v(18, 7)], mode: "pingpong", every: 1 },
      { id: "F3", waypoints: [v(4, 3), v(9, 3)], mode: "pingpong", every: 2 },
    ],
    packages: [
      { bay: "a", dock: 2, release: 0, window: null },
      { bay: "e", dock: 3, release: 0, window: null },
      { bay: "c", dock: 3, release: 30, window: null },
      { bay: "d", dock: 1, release: 70, window: null },
      { bay: "f", dock: 2, release: 110, window: null },
      { bay: "b", dock: 1, release: 150, window: null },
    ],
    priorityPool: ["LOW", "NORMAL", "NORMAL", "HIGH", "HIGH", "URGENT"],
    spillEvents: [{ tick: 120, jitter: 30 }],
    releaseJitter: 12,
  },
  {
    id: 3,
    key: "night-shift",
    name: "NIGHT SHIFT",
    subtitle: "Lights down: sensors see 3 tiles, spills appear, deadlines",
    map: [
      "####################",
      "#1..SS....SS....a..#",
      "#...SS.b..SS..SSSS.#",
      "#..........~.......#",
      "#.SSSS.SS.SSSS.SS..#",
      "#R....c.........d..#",
      "#.SSSS.SS.SSSS.SS..#",
      "#.......~..........#",
      "#...SS....SS.e.SSS.#",
      "#2..SS....SS......C#",
      "####################",
    ],
    timeLimit: 360,
    startBattery: 90,
    sensorRange: 3,
    dark: true,
    forklifts: [
      { id: "F1", waypoints: [v(2, 5), v(18, 5)], mode: "pingpong", every: 2 },
      { id: "F2", waypoints: [v(1, 3), v(18, 3), v(18, 7), v(1, 7)], mode: "loop", every: 1 },
    ],
    packages: [
      { bay: "c", dock: 2, release: 0, window: 110 },
      { bay: "a", dock: 1, release: 0, window: 160 },
      { bay: "d", dock: 2, release: 60, window: 130 },
      { bay: "b", dock: 1, release: 110, window: 120 },
      { bay: "e", dock: 2, release: 160, window: 120 },
    ],
    priorityPool: ["NORMAL", "NORMAL", "HIGH", "HIGH", "URGENT"],
    spillEvents: [
      { tick: 50, jitter: 20 },
      { tick: 140, jitter: 30 },
      { tick: 230, jitter: 30 },
    ],
    releaseJitter: 10,
  },
  {
    id: 4,
    key: "hard-mode",
    name: "HARD MODE",
    subtitle: "Four forklifts, 55% battery, urgent deadlines",
    map: [
      "####################",
      "#R..a.SS.b..SS.c..C#",
      "#.SS..SS.SS.SS.SS..#",
      "#.SS.......~.......#",
      "#....SSS.SS.SSS.XX.#",
      "#.d..SSS....SSS..e.#",
      "#.SS.....SS.....SS.#",
      "#.SS.~XX.SS.f.~.SS.#",
      "#....SS......SS..g.#",
      "#1...SS..2...SS...3#",
      "####################",
    ],
    timeLimit: 320,
    startBattery: 55,
    sensorRange: null,
    dark: false,
    forklifts: [
      { id: "F1", waypoints: [v(4, 3), v(18, 3)], mode: "pingpong", every: 1 },
      { id: "F2", waypoints: [v(11, 6), v(15, 6)], mode: "pingpong", every: 1 },
      { id: "F3", waypoints: [v(18, 2), v(18, 8)], mode: "pingpong", every: 2 },
      { id: "F4", waypoints: [v(7, 8), v(12, 8)], mode: "pingpong", every: 1 },
    ],
    packages: [
      { bay: "a", dock: 1, release: 0, window: 90 },
      { bay: "e", dock: 3, release: 0, window: 120 },
      { bay: "d", dock: 2, release: 30, window: 100 },
      { bay: "c", dock: 3, release: 60, window: 100 },
      { bay: "f", dock: 1, release: 100, window: 90 },
      { bay: "g", dock: 2, release: 140, window: 90 },
      { bay: "b", dock: 1, release: 180, window: 90 },
    ],
    priorityPool: ["NORMAL", "HIGH", "HIGH", "URGENT", "URGENT", "NORMAL", "HIGH"],
    spillEvents: [
      { tick: 80, jitter: 25 },
      { tick: 190, jitter: 25 },
    ],
    releaseJitter: 8,
  },
];

export function levelById(id: number): LevelDef {
  const l = LEVELS.find((x) => x.id === id);
  if (!l) throw new Error(`unknown level ${id}`);
  return l;
}
