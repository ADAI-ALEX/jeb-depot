/**
 * Original pixel art for JEB // DEPOT. Characters are hand-drawn as ASCII (top-down, facing north) and rotated;
 * tiles are generated procedurally with deterministic per-tile variation so the floor never looks stamped.
 */
import type { Dir, Priority } from "../sim/types";
import { rotate, spriteFrom, type Sprite } from "./fb";
import { C, DOCK_COLOR, PRIORITY_COLOR, mix, rgba } from "./palette";

const K: Record<string, number> = {
  "0": C.ink,
  "1": C.panel,
  "2": C.edge,
  "3": C.steel,
  "4": C.steel2,
  "5": C.steel3,
  "6": C.mist,
  "7": C.white,
  c: C.cyan,
  d: C.cyan2,
  e: C.cyan3,
  a: C.amber,
  b: C.amber2,
  y: C.yellow,
  r: C.red,
  s: C.red2,
  g: C.green,
  h: C.green2,
  m: C.magenta,
  j: C.floor3,
  w: C.wood0,
  x: C.wood1,
  z: C.wood2,
  q: C.wood3,
  o: C.rack,
  p: C.rack2,
};

// ---------------------------------------------------------------- robot

// White shell, dark treads, a visor with two eyes at the front (top), JEB's core light in the lid, tail lights.
const ROBOT_SHELL = [
  "0556666550",
  "0567777650",
  "0567777650",
  "0566336650",
  "0563CC3650",
  "0563CC3650",
  "0566336650",
  "0566666650",
  "0455555540",
  "04a4444a40",
  "0000000000",
];

function robotRows(frame: number): string[] {
  const rows = ["................", "....00000000....", "...0dccddccd0..."];
  ROBOT_SHELL.forEach((shell, i) => {
    const t = (i + frame) % 2 === 0 ? "j" : "1";
    rows.push(`.0${t}${shell}${t}0.`);
  });
  rows.push("................", "................", "................");
  return rows.slice(0, 16);
}

export type RobotLight = "cyan" | "red" | "amber" | "green";
const LIGHT: Record<RobotLight, [number, number]> = { cyan: [C.cyan, C.cyan2], red: [C.red, C.red2], amber: [C.amber, C.amber2], green: [C.green, C.green2] };

const DIR_ROT: Record<Dir, number> = { N: 0, E: 1, S: 2, W: 3 };

const robotCache = new Map<string, Sprite>();
export function robotSprite(heading: Dir, frame: number, light: RobotLight = "cyan", core = C.cyan): Sprite {
  const key = `${heading}${frame}${light}${core}`;
  let s = robotCache.get(key);
  if (!s) {
    const [l1, l2] = LIGHT[light];
    s = rotate(spriteFrom(robotRows(frame), { ...K, c: l1, d: l2, C: core }), DIR_ROT[heading]);
    robotCache.set(key, s);
  }
  return s;
}

// ---------------------------------------------------------------- forklift

const FORKLIFT = (beacon: string): string[] => [
  "....5......5....",
  "....5......5....",
  "....4......4....",
  "...0444444440...",
  "..0yyyyyyyyyy0..",
  ".00ybbbbbbbby00.",
  ".00yb000000by00.",
  "..0yb0d33d0by0..",
  "..0yb033330by0..",
  "..0yb000000by0..",
  ".00ybbbbbbbby00.",
  ".00yyyyyyyyyy00.",
  "..033333333330..",
  `...0000${beacon}${beacon}0000...`,
  "................",
  "................",
];

const forkCache = new Map<string, Sprite>();
export function forkliftSprite(heading: Dir, beaconOn: boolean): Sprite {
  const key = `${heading}${beaconOn}`;
  let s = forkCache.get(key);
  if (!s) {
    s = rotate(spriteFrom(FORKLIFT(beaconOn ? "a" : "b"), K), DIR_ROT[heading]);
    forkCache.set(key, s);
  }
  return s;
}

// ---------------------------------------------------------------- packages

const pkgCache = new Map<string, Sprite>();
export function packageSprite(priority: Priority, small = false): Sprite {
  const key = `${priority}${small}`;
  let s = pkgCache.get(key);
  if (!s) {
    const rows = small
      ? ["000000", "0qPPq0", "0zPPz0", "0xPPx0", "000000"]
      : ["00000000", "0qqPPqq0", "0qqPPqq0", "0zzPPzz0", "0zzPPzz0", "0xxPPxx0", "00000000"];
    s = spriteFrom(rows, { ...K, P: PRIORITY_COLOR[priority] });
    pkgCache.set(key, s);
  }
  return s;
}

// ---------------------------------------------------------------- icons (HUD)

export const ICONS = {
  bolt: spriteFrom(["...a.", "..aa.", ".aaa.", "aaaaa", ".aaa.", ".aa..", ".a..."], K),
  warn: spriteFrom(["...a...", "..aaa..", "..a0a..", ".aa0aa.", ".aaaaa.", "aaa0aaa", "aaaaaaa"], K),
  clock: spriteFrom([".555.", "5.5.5", "5.55.", "5...5", ".555."], K),
  box: spriteFrom(["00000", "0qzq0", "0zxz0", "0qzq0", "00000"], K),
  hit: spriteFrom(["r...r", ".r.r.", "..r..", ".r.r.", "r...r"], K),
  chip: spriteFrom([".0.0.0.", "0000000", ".0ccc0.", "00cec00", ".0ccc0.", "0000000", ".0.0.0."], K),
};

// ---------------------------------------------------------------- tiles (procedural)

function hash(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2147483647) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function blank(): Sprite {
  return { w: 16, h: 16, data: new Uint32Array(256) };
}

function put(s: Sprite, x: number, y: number, c: number): void {
  if (x >= 0 && y >= 0 && x < s.w && y < s.h) s.data[y * s.w + x] = c;
}

function fill(s: Sprite, x: number, y: number, w: number, h: number, c: number): void {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(s, xx, yy, c);
}

export function floorTile(tx: number, ty: number): Sprite {
  const s = blank();
  const base = (tx + ty) % 2 === 0 ? C.floor1 : mix(C.floor1, C.floor0, 0.35);
  s.data.fill(base);
  // speckle: aggregate in the concrete
  for (let i = 0; i < 10; i++) {
    const h = hash(tx, ty, i);
    put(s, h % 16, (h >>> 8) % 16, (h >>> 16) % 3 === 0 ? C.floor2 : C.floor0);
  }
  // expansion joints on tile seams
  for (let i = 0; i < 16; i++) {
    put(s, i, 15, C.floor0);
    put(s, 15, i, C.floor0);
  }
  // an occasional stain or scuff
  const h = hash(tx, ty, 99);
  if (h % 7 === 0) {
    const cx = 3 + (h >>> 4) % 9;
    const cy = 3 + (h >>> 9) % 9;
    fill(s, cx, cy, 3, 2, mix(base, C.floor0, 0.6));
    put(s, cx + 1, cy + 2, mix(base, C.floor0, 0.6));
  }
  return s;
}

/** Walls: riveted steel panels; a hazard-striped kick plate where the wall meets the floor below. */
export function wallTile(tx: number, ty: number, floorBelow: boolean, floorAbove: boolean): Sprite {
  const s = blank();
  s.data.fill(C.panel2);
  fill(s, 0, 0, 16, 1, floorAbove ? C.steel : C.panel3);
  fill(s, 0, 1, 16, 1, C.panel3);
  fill(s, 0, 15, 16, 1, C.ink);
  fill(s, 15, 0, 1, 16, C.panel);
  fill(s, 7, 2, 1, 12, C.panel);
  for (const [x, y] of [[2, 3], [12, 3], [2, 12], [12, 12]] as const) put(s, x, y, C.steel2);
  if (hash(tx, ty, 5) % 5 === 0) fill(s, 3, 6, 3, 2, C.edge);
  if (floorBelow) {
    for (let x = 0; x < 16; x++) for (let y = 12; y < 15; y++) put(s, x, y, ((x + y) >> 1) % 2 === 0 ? C.yellow : C.ink);
    fill(s, 0, 11, 16, 1, C.ink);
  }
  return s;
}

/** Pallet racking seen from above: orange uprights, grey decking, stock on pallets. */
export function shelfTile(tx: number, ty: number, n: { N: boolean; E: boolean; S: boolean; W: boolean }): Sprite {
  const s = blank();
  s.data.fill(C.ink);
  fill(s, 1, 1, 14, 14, C.panel3);
  for (let y = 3; y < 15; y += 4) fill(s, 1, y, 14, 1, C.edge);
  // uprights on outer edges
  if (!n.W) fill(s, 0, 0, 2, 16, C.rack);
  if (!n.E) fill(s, 14, 0, 2, 16, C.rack);
  if (!n.N) fill(s, 0, 0, 16, 2, C.rack2);
  if (!n.S) fill(s, 0, 14, 16, 2, C.rack);
  if (n.N) fill(s, 2, 0, 12, 1, C.panel3);
  if (n.S) fill(s, 2, 15, 12, 1, C.panel3);
  // stock
  const palettes = [
    [C.wood2, C.wood1, C.wood3],
    [C.steel2, C.steel, C.steel3],
    [C.blue2, C.panel3, C.blue],
    [C.wood1, C.wood0, C.wood2],
    [C.green2, C.panel3, C.green],
  ];
  for (let i = 0; i < 2; i++) {
    const h = hash(tx, ty, 20 + i);
    if (h % 5 === 0) continue;
    const [mid, dark, light] = palettes[h % palettes.length] as number[];
    const bx = 3 + i * 6 + ((h >>> 5) % 2);
    const by = 3 + ((h >>> 8) % 5);
    fill(s, bx, by, 5, 5, mid as number);
    fill(s, bx, by, 5, 1, light as number);
    fill(s, bx + 4, by, 1, 5, dark as number);
    fill(s, bx, by + 4, 5, 1, dark as number);
    if ((h >>> 12) % 2) fill(s, bx + 2, by, 1, 5, mix(mid as number, C.white, 0.35));
  }
  return s;
}

export function crateTile(tx: number, ty: number): Sprite {
  const s = blank();
  s.data.fill(C.floor1);
  const crate = (x: number, y: number, w: number, h: number): void => {
    fill(s, x, y, w, h, C.wood1);
    fill(s, x, y, w, 1, C.wood3);
    fill(s, x, y + h - 1, w, 1, C.wood0);
    fill(s, x + w - 1, y, 1, h, C.wood0);
    for (let i = 1; i < h - 1; i += 2) fill(s, x + 1, y + i, w - 2, 1, C.wood2);
    for (let i = 0; i < Math.min(w, h); i++) put(s, x + i, y + Math.round((i * (h - 1)) / (w - 1)), C.wood0);
  };
  const h = hash(tx, ty, 3);
  crate(1, 1, 7, 7);
  crate(8, 2, 7, 6);
  crate(2, 8, 6, 7);
  if (h % 2) crate(8, 8, 7, 7);
  return s;
}

export function chargerTile(tx: number, ty: number, glow: number): Sprite {
  const s = floorTile(tx, ty);
  const edge = mix(C.cyan3, C.cyan, glow);
  fill(s, 1, 1, 14, 14, C.ink);
  fill(s, 2, 2, 12, 12, C.panel2);
  for (let i = 1; i < 15; i++) {
    put(s, i, 1, edge);
    put(s, i, 14, edge);
    put(s, 1, i, edge);
    put(s, 14, i, edge);
  }
  const bolt = ["...cc", "..cc.", ".cccc", "..cc.", ".cc..", "cc..."];
  bolt.forEach((row, y) => [...row].forEach((ch, x) => ch === "c" && put(s, 5 + x, 5 + y, mix(C.cyan2, C.white, glow * 0.6))));
  for (const [x, y] of [[3, 3], [12, 3], [3, 12], [12, 12]] as const) put(s, x, y, C.amber);
  return s;
}

export function dockTile(tx: number, ty: number, dock: number, phase: number): Sprite {
  const s = floorTile(tx, ty);
  const [c1, c2] = DOCK_COLOR[dock] ?? [C.steel3, C.steel];
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      if (x === 0 || y === 0 || x === 15 || y === 15) put(s, x, y, ((x + y) >> 1) % 2 ? c1 : C.ink);
      else if ((x + y + phase) % 8 < 2) put(s, x, y, mix(C.floor1, c2, 0.55));
    }
  // centre chevron
  const chev = ["c...c", ".c.c.", "..c.."];
  chev.forEach((row, y) => [...row].forEach((ch, x) => ch === "c" && put(s, 6 + x, 6 + y, c1)));
  chev.forEach((row, y) => [...row].forEach((ch, x) => ch === "c" && put(s, 6 + x, 9 + y, c2)));
  return s;
}

export function pickupTile(tx: number, ty: number): Sprite {
  const s = floorTile(tx, ty);
  const c = C.yellow;
  for (const [x0, y0, dx, dy] of [[1, 1, 1, 1], [14, 1, -1, 1], [1, 14, 1, -1], [14, 14, -1, -1]] as const) {
    for (let i = 0; i < 4; i++) {
      put(s, x0 + dx * i, y0, c);
      put(s, x0, y0 + dy * i, c);
    }
  }
  return s;
}

export function spillTile(tx: number, ty: number, shimmer: number, onFloorOf: Sprite | null = null): Sprite {
  const s = onFloorOf ? { ...onFloorOf, data: onFloorOf.data.slice() } : floorTile(tx, ty);
  // R = wet rim, K = oil, M = dull sheen, N = bright rainbow sheen (moves with `shimmer`)
  const blob = [
    "....RRRRRR......",
    "..RRKKKKKKRR....",
    ".RKKMMMKKKKKRR..",
    ".RKMNNMKKKKKKKR.",
    "RKKKMMKKKKKKKKR.",
    "RKKKKKKKKMMKKKR.",
    ".RKKKKKKMNNMKR..",
    "..RKKKKKKMMKR...",
    "...RRKKKKKRR....",
    ".....RRRRR......",
  ];
  const sheen = [C.magenta2, C.oil2, C.cyan3];
  blob.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === ".") return;
      let c: number;
      if (ch === "R") c = mix(C.floor0, C.oil2, 0.5);
      else if (ch === "K") c = (x * 3 + y * 5 + shimmer) % 17 === 0 ? C.oil2 : C.oil0;
      else if (ch === "M") c = C.oil1;
      else c = sheen[(x + y + shimmer) % 3] as number;
      put(s, x, y + 3, c);
    }),
  );
  return s;
}

export const DOCK_LETTER: Record<number, string> = { 1: "R", 2: "B", 3: "G" };

export const COLORS = { sparks: [C.yellow, C.amber, C.white], confetti: [C.cyan, C.magenta, C.yellow, C.green, C.amber], dust: [C.floor3, C.line] };

export const NIGHT_DARK = rgba("#03040a");
