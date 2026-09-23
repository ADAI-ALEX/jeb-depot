import type { Dir, Tile, Vec } from "./types";
import { DIRS, DIR_VEC, blocksMovement } from "./types";

export interface ParsedMap {
  w: number;
  h: number;
  tiles: Tile[][];
  start: Vec;
  bays: Map<string, Vec>;
  docks: Map<number, Vec>;
  chargers: Vec[];
}

export function parseMap(rows: string[]): ParsedMap {
  const h = rows.length;
  const w = rows[0]?.length ?? 0;
  const tiles: Tile[][] = [];
  const bays = new Map<string, Vec>();
  const docks = new Map<number, Vec>();
  const chargers: Vec[] = [];
  let start: Vec = { x: 1, y: 1 };
  rows.forEach((row, y) => {
    if (row.length !== w) throw new Error(`map row ${y} has ${row.length} columns, expected ${w}`);
    const line: Tile[] = [];
    [...row].forEach((ch, x) => {
      if (ch === "#") line.push({ kind: "wall" });
      else if (ch === "S") line.push({ kind: "shelf" });
      else if (ch === "X") line.push({ kind: "crate" });
      else if (ch === "C") {
        line.push({ kind: "charger" });
        chargers.push({ x, y });
      } else if (ch >= "1" && ch <= "9") {
        line.push({ kind: "dock", dock: Number(ch) });
        docks.set(Number(ch), { x, y });
      } else if (ch >= "a" && ch <= "h") {
        line.push({ kind: "pickup", bay: ch });
        bays.set(ch, { x, y });
      } else if (ch === "~") line.push({ kind: "spill" });
      else if (ch === "R") {
        line.push({ kind: "floor" });
        start = { x, y };
      } else line.push({ kind: "floor" });
    });
    tiles.push(line);
  });
  return { w, h, tiles, start, bays, docks, chargers };
}

export class Grid {
  constructor(
    readonly w: number,
    readonly h: number,
    readonly tiles: Tile[][],
  ) {}

  inside(p: Vec): boolean {
    return p.x >= 0 && p.y >= 0 && p.x < this.w && p.y < this.h;
  }

  tile(p: Vec): Tile {
    return this.tiles[p.y]?.[p.x] ?? { kind: "wall" };
  }

  walkable(p: Vec): boolean {
    return this.inside(p) && !blocksMovement(this.tile(p).kind);
  }

  step(p: Vec, d: Dir): Vec {
    const { dx, dy } = DIR_VEC[d];
    return { x: p.x + dx, y: p.y + dy };
  }

  idx(p: Vec): number {
    return p.y * this.w + p.x;
  }

  /**
   * BFS distance (in moves) from every tile to `goal` over walkable tiles, treating `blocked` tile indices as
   * walls (the goal itself is never blocked). -1 = unreachable.
   */
  distanceField(goal: Vec, blocked?: ReadonlySet<number>): Int16Array {
    const dist = new Int16Array(this.w * this.h).fill(-1);
    if (!this.walkable(goal)) return dist;
    const q: Vec[] = [goal];
    dist[this.idx(goal)] = 0;
    for (let head = 0; head < q.length; head++) {
      const p = q[head] as Vec;
      const d = dist[this.idx(p)] as number;
      for (const dir of DIRS) {
        const n = this.step(p, dir);
        if (!this.walkable(n)) continue;
        const ni = this.idx(n);
        if (dist[ni] !== -1 || blocked?.has(ni)) continue;
        dist[ni] = d + 1;
        q.push(n);
      }
    }
    return dist;
  }

  /** Shortest walkable path from a to b (inclusive), deterministic tie-breaks (N, E, S, W). */
  path(a: Vec, b: Vec): Vec[] {
    const field = this.distanceField(b);
    if ((field[this.idx(a)] ?? -1) < 0) throw new Error(`no path from ${a.x},${a.y} to ${b.x},${b.y}`);
    const out: Vec[] = [a];
    let p = a;
    while (!(p.x === b.x && p.y === b.y)) {
      const d = field[this.idx(p)] as number;
      let next: Vec | null = null;
      for (const dir of DIRS) {
        const n = this.step(p, dir);
        if (this.walkable(n) && field[this.idx(n)] === d - 1) {
          next = n;
          break;
        }
      }
      if (!next) throw new Error("broken distance field");
      out.push(next);
      p = next;
    }
    return out;
  }
}

export function dirBetween(a: Vec, b: Vec): Dir | null {
  for (const d of DIRS) {
    const { dx, dy } = DIR_VEC[d];
    if (a.x + dx === b.x && a.y + dy === b.y) return d;
  }
  return null;
}

/** Expand patrol waypoints into the cyclic tile path a forklift follows. */
export function patrolPath(grid: Grid, waypoints: Vec[], mode: "pingpong" | "loop"): Vec[] {
  const legs: Vec[] = [];
  const pts = mode === "loop" ? [...waypoints, waypoints[0] as Vec] : [...waypoints, ...waypoints.slice(0, -1).reverse()];
  for (let i = 0; i + 1 < pts.length; i++) {
    const seg = grid.path(pts[i] as Vec, pts[i + 1] as Vec);
    legs.push(...seg.slice(0, -1));
  }
  return legs;
}
