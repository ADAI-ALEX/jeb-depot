/**
 * Draws the warehouse: a pre-baked static tile layer, animated tiles (chargers, docks, spills), entities with
 * tick-to-tick interpolation, route overlays, effects and the night-shift lighting.
 */
import { parseMap, type ParsedMap } from "../sim/grid";
import type { LevelDef } from "../sim/levels";
import type { Action, Dir, TileKind, Vec } from "../sim/types";
import { DIR_VEC, blocksMovement } from "../sim/types";
import type { WorldSnapshot } from "../sim/world";
import type { Framebuffer, Sprite } from "./fb";
import { SMALL, text } from "./font";
import { C, DOCK_COLOR, PRIORITY_COLOR, mix, withAlpha } from "./palette";
import type { Particles } from "./particles";
import * as S from "./sprites";

export const TILE = 16;
export const MAP_W = 320;
export const MAP_H = 176;

export interface SceneView {
  prev: WorldSnapshot;
  curr: WorldSnapshot;
  /** Progress of the current tick's animation, 0..1. */
  t: number;
  action: Action | null;
  bump: { kind: "wall" | "forklift"; dir: Dir } | null;
  route: Vec[] | null;
  routeDetour: boolean;
  light: S.RobotLight;
  thinking: boolean;
  targetTile: Vec | null;
  night: boolean;
  /** Forklift lanes painted on the floor. */
  lanes: Vec[][];
}

const ease = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t));

export class Scene {
  readonly map: ParsedMap;
  private base: Sprite;

  constructor(
    readonly level: LevelDef,
    lanes: Vec[][] = [],
  ) {
    this.map = parseMap(level.map);
    this.base = this.bake(lanes);
  }

  private kind(x: number, y: number): string {
    return this.map.tiles[y]?.[x]?.kind ?? "wall";
  }

  private bake(lanes: Vec[][]): Sprite {
    const data = new Uint32Array(MAP_W * MAP_H);
    const layer: Sprite = { w: MAP_W, h: MAP_H, data };
    const stamp = (s: Sprite, x: number, y: number): void => {
      for (let yy = 0; yy < s.h; yy++)
        for (let xx = 0; xx < s.w; xx++) {
          const c = s.data[yy * s.w + xx] as number;
          if (c) data[(y + yy) * MAP_W + x + xx] = c;
        }
    };
    for (let y = 0; y < this.map.h; y++)
      for (let x = 0; x < this.map.w; x++) {
        const t = this.map.tiles[y]?.[x];
        const px = x * TILE;
        const py = y * TILE;
        const k = t?.kind ?? "wall";
        if (k === "wall") stamp(S.wallTile(x, y, !blocksMovement(this.kind(x, y + 1) as TileKind), !blocksMovement(this.kind(x, y - 1) as TileKind)), px, py);
        else if (k === "shelf") stamp(S.shelfTile(x, y, { N: this.kind(x, y - 1) === "shelf", E: this.kind(x + 1, y) === "shelf", S: this.kind(x, y + 1) === "shelf", W: this.kind(x - 1, y) === "shelf" }), px, py);
        else if (k === "crate") stamp(S.crateTile(x, y), px, py);
        else if (k === "pickup") stamp(S.pickupTile(x, y), px, py);
        else stamp(S.floorTile(x, y), px, py);
      }
    // Painted forklift lanes: dashed amber centre marks along each patrol.
    for (const lane of lanes)
      lane.forEach((p, i) => {
        if (this.kind(p.x, p.y) !== "floor") return;
        const next = lane[(i + 1) % lane.length] as Vec;
        const dx = Math.sign(next.x - p.x);
        const dy = Math.sign(next.y - p.y);
        const cx = p.x * TILE + 7;
        const cy = p.y * TILE + 7;
        for (let k = -6; k <= 7; k++) {
          if ((k + 8) % 6 >= 3) continue;
          const x = cx + dx * k;
          const y = cy + dy * k;
          if (x >= 0 && y >= 0 && x < MAP_W && y < MAP_H) data[y * MAP_W + x] = mix(data[y * MAP_W + x] as number, C.amber2, 0.45);
        }
      });
    // Roller doors on the wall behind each dock.
    for (const [n, p] of this.map.docks) {
      for (const d of ["N", "E", "S", "W"] as Dir[]) {
        const w = { x: p.x + DIR_VEC[d].dx, y: p.y + DIR_VEC[d].dy };
        if (this.kind(w.x, w.y) !== "wall") continue;
        const [c1] = DOCK_COLOR[n] ?? [C.steel3];
        const x0 = w.x * TILE;
        const y0 = w.y * TILE;
        for (let yy = 1; yy < 15; yy++)
          for (let xx = 1; xx < 15; xx++) {
            const edge = xx === 1 || xx === 14 || yy === 1;
            data[(y0 + yy) * MAP_W + x0 + xx] = edge ? (c1 as number) : yy % 3 === 0 ? C.steel : C.steel2;
          }
      }
    }
    return layer;
  }

  private centre(p: Vec): { x: number; y: number } {
    return { x: p.x * TILE + 8, y: p.y * TILE + 8 };
  }

  draw(fb: Framebuffer, ox: number, oy: number, v: SceneView, time: number, fx: Particles): void {
    const shakeX = fx.shake > 0 ? Math.round(Math.sin(time * 90) * fx.shake) : 0;
    const shakeY = fx.shake > 0 ? Math.round(Math.cos(time * 77) * fx.shake * 0.6) : 0;
    const X = ox + shakeX;
    const Y = oy + shakeY;
    fb.clip(ox, oy, MAP_W, MAP_H);
    fb.blit(this.base, X, Y);

    // animated tiles
    const glow = 0.5 + 0.5 * Math.sin(time * 4);
    for (const c of this.map.chargers) fb.blit(S.chargerTile(c.x, c.y, glow), X + c.x * TILE, Y + c.y * TILE);
    for (const [n, p] of this.map.docks) fb.blit(S.dockTile(p.x, p.y, n, Math.floor(time * 6) % 8), X + p.x * TILE, Y + p.y * TILE);
    const shimmer = Math.floor(time * 5);
    for (let y = 0; y < this.map.h; y++)
      for (let x = 0; x < this.map.w; x++) if (this.kind(x, y) === "spill") fb.blit(S.spillTile(x, y, shimmer), X + x * TILE, Y + y * TILE);
    for (const idx of v.curr.spills) {
      const x = idx % this.map.w;
      const y = Math.floor(idx / this.map.w);
      const appear = v.prev.spills.includes(idx) ? 1 : ease(v.t * 2);
      if (appear < 1 && Math.floor(time * 16) % 2) continue;
      fb.blit(S.spillTile(x, y, shimmer), X + x * TILE, Y + y * TILE);
    }

    // route overlay
    if (v.route && v.route.length > 1) {
      const col = v.routeDetour ? C.amber : C.cyan;
      const march = Math.floor(time * 8);
      for (let i = 0; i + 1 < v.route.length; i++) {
        const a = this.centre(v.route[i] as Vec);
        const b = this.centre(v.route[i + 1] as Vec);
        for (let k = 0; k < 16; k++) {
          if ((k + i * 16 - march) % 4 !== 0) continue;
          const x = a.x + ((b.x - a.x) * k) / 16;
          const y = a.y + ((b.y - a.y) * k) / 16;
          fb.px(X + x, Y + y, withAlpha(col, 170));
        }
      }
    }

    // target marker
    if (v.targetTile) {
      const p = this.centre(v.targetTile);
      const r = 7 + Math.round(Math.sin(time * 6));
      const col = Math.floor(time * 3) % 2 ? C.cyan : C.white;
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        fb.rect(X + p.x + sx * r - (sx > 0 ? 2 : 0), Y + p.y + sy * r - (sy > 0 ? 0 : 0), 3, 1, col);
        fb.rect(X + p.x + sx * r - (sx > 0 ? 0 : 0), Y + p.y + sy * r - (sy > 0 ? 2 : 0), 1, 3, col);
      }
    }

    // packages waiting at bays
    for (const pk of v.curr.packages) {
      if (pk.status !== "waiting") continue;
      const p = this.centre(pk.pickup);
      const targeted = v.targetTile && v.targetTile.x === pk.pickup.x && v.targetTile.y === pk.pickup.y;
      const bob = Math.round(Math.sin(time * 3 + pk.pickup.x) * 0.6);
      const spr = S.packageSprite(pk.priority);
      fb.blit(spr, X + p.x - 4, Y + p.y - 4 + bob, targeted && Math.floor(time * 6) % 2 ? { flash: C.white } : {});
      if (pk.priority === "URGENT" && Math.floor(time * 4) % 2) fb.rect(X + p.x + 3, Y + p.y - 6, 2, 2, C.magenta);
      text(fb, SMALL, pk.id, X + p.x - 1, Y + p.y - 11 + bob, PRIORITY_COLOR[pk.priority], { shadow: C.ink });
    }

    // forklifts (interpolated)
    const beacon = Math.floor(time * 4) % 2 === 0;
    for (const f of v.curr.forklifts) {
      const before = v.prev.forklifts.find((x) => x.id === f.id) ?? f;
      const k = ease(v.t);
      const px = (before.pos.x + (f.pos.x - before.pos.x) * k) * TILE;
      const py = (before.pos.y + (f.pos.y - before.pos.y) * k) * TILE;
      fb.blit(S.forkliftSprite(f.heading, beacon), X + px, Y + py);
      if (beacon) fb.rect(X + px + 7, Y + py + 7, 2, 2, withAlpha(C.amber, 120));
      text(fb, SMALL, f.id, X + px + 5, Y + py - 5, C.yellow, { shadow: C.ink });
    }

    // robot
    const r0 = v.prev.robot;
    const r1 = v.curr.robot;
    const k = ease(v.t);
    let rx = (r0.pos.x + (r1.pos.x - r0.pos.x) * k) * TILE;
    let ry = (r0.pos.y + (r1.pos.y - r0.pos.y) * k) * TILE;
    if (v.bump) {
      const lunge = Math.sin(Math.min(1, v.t) * Math.PI) * 5;
      rx += DIR_VEC[v.bump.dir].dx * lunge;
      ry += DIR_VEC[v.bump.dir].dy * lunge;
    }
    const moving = v.t < 1 && (r0.pos.x !== r1.pos.x || r0.pos.y !== r1.pos.y);
    const frame = moving ? Math.floor(time * 14) % 2 : 0;
    const core = v.thinking ? mix(C.cyan3, C.white, 0.5 + 0.5 * Math.sin(time * 12)) : C.cyan;
    const robot = S.robotSprite(r1.heading, frame, v.light, core);
    fb.blit(robot, X + rx + 1, Y + ry + 2, { flash: C.ink, alpha: 0.35 });
    fb.blit(robot, X + rx, Y + ry, v.bump && v.t < 0.5 && Math.floor(time * 30) % 2 ? { flash: C.red } : {});
    if (r1.carrying) {
      const pk = v.curr.packages.find((p) => p.id === r1.carrying);
      if (pk) fb.blit(S.packageSprite(pk.priority, true), X + rx + 5, Y + ry + 6);
    }
    if (r1.charging) {
      for (let i = 0; i < 3; i++) if (Math.floor(time * 10 + i) % 3 === 0) fb.px(X + rx + 3 + i * 5, Y + ry + 1 + (i % 2) * 13, C.cyan);
    }
    if (v.thinking) {
      // JEB is deciding: a small readout above the robot
      const bx = X + rx + 1;
      const by = Y + ry - 8;
      fb.rect(bx, by, 14, 6, C.ink);
      fb.frame(bx, by, 14, 6, C.cyan2);
      for (let i = 0; i < 3; i++) fb.rect(bx + 3 + i * 3, by + 2, 2, 2, Math.floor(time * 6) % 3 === i ? C.cyan : C.cyan3);
    }

    fx.draw(fb, X, Y);

    if (v.night) this.darkness(fb, X, Y, rx + 8, ry + 8, v, time);
    fb.unclip();
  }

  /** Night shift: dithered darkness everywhere except pools of light (robot, forklift headlights, chargers, docks). */
  private darkness(fb: Framebuffer, X: number, Y: number, rcx: number, rcy: number, v: SceneView, time: number): void {
    const lights: { x: number; y: number; r: number }[] = [{ x: rcx, y: rcy, r: 46 + Math.sin(time * 2) }];
    for (const f of v.curr.forklifts) {
      const before = v.prev.forklifts.find((x) => x.id === f.id) ?? f;
      const k = ease(v.t);
      const fx = (before.pos.x + (f.pos.x - before.pos.x) * k) * TILE + 8 + DIR_VEC[f.heading].dx * 10;
      const fy = (before.pos.y + (f.pos.y - before.pos.y) * k) * TILE + 8 + DIR_VEC[f.heading].dy * 10;
      lights.push({ x: fx, y: fy, r: 20 });
    }
    for (const c of this.map.chargers) lights.push({ x: c.x * TILE + 8, y: c.y * TILE + 8, r: 16 });
    for (const [, d] of this.map.docks) lights.push({ x: d.x * TILE + 8, y: d.y * TILE + 8, r: 12 });
    const dark = S.NIGHT_DARK;
    for (let y = 0; y < MAP_H; y++)
      for (let x = 0; x < MAP_W; x++) {
        let lit = 0;
        for (const l of lights) {
          const dx = x - l.x;
          const dy = y - l.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          const q = 1 - d / l.r;
          if (q > lit) lit = q;
        }
        // 5 dithered levels between full dark and lit
        const level = Math.max(0, Math.min(1, 1 - lit * 1.6));
        const b = BAYER4[(y & 3) * 4 + (x & 3)] as number;
        const a = level * 0.86 + (b / 16 - 0.5) * 0.12;
        if (a > 0.02) fb.px(X + x, Y + y, withAlpha(dark, Math.min(0.88, Math.max(0, a)) * 255));
      }
  }
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
