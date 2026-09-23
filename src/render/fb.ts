/**
 * A software framebuffer: every pixel of the 480 x 270 screen is written here and then blitted to the canvas
 * (nearest-neighbour scaled). Pixel-exact, deterministic, and renderable in Node for screenshots.
 */
import { C } from "./palette";

export const SCREEN_W = 480;
export const SCREEN_H = 270;

export interface Sprite {
  w: number;
  h: number;
  /** Packed colours, 0 = transparent. */
  data: Uint32Array;
}

export class Framebuffer {
  readonly data: Uint32Array;
  /** Clip rectangle. */
  private cx0 = 0;
  private cy0 = 0;
  private cx1: number;
  private cy1: number;
  /** Translation applied to every primitive (screen shake, panels). */
  ox = 0;
  oy = 0;

  constructor(
    readonly w = SCREEN_W,
    readonly h = SCREEN_H,
  ) {
    this.data = new Uint32Array(w * h);
    this.cx1 = w;
    this.cy1 = h;
  }

  clip(x: number, y: number, w: number, h: number): void {
    this.cx0 = Math.max(0, x);
    this.cy0 = Math.max(0, y);
    this.cx1 = Math.min(this.w, x + w);
    this.cy1 = Math.min(this.h, y + h);
  }

  unclip(): void {
    this.cx0 = 0;
    this.cy0 = 0;
    this.cx1 = this.w;
    this.cy1 = this.h;
  }

  clear(c: number): void {
    this.data.fill(c);
  }

  px(x: number, y: number, c: number): void {
    x = Math.floor(x + this.ox);
    y = Math.floor(y + this.oy);
    if (x < this.cx0 || y < this.cy0 || x >= this.cx1 || y >= this.cy1) return;
    const a = c >>> 24;
    if (a === 255) this.data[y * this.w + x] = c;
    else if (a > 0) this.data[y * this.w + x] = blend(this.data[y * this.w + x] as number, c);
  }

  rect(x: number, y: number, w: number, h: number, c: number): void {
    const x0 = Math.max(this.cx0, Math.floor(x + this.ox));
    const y0 = Math.max(this.cy0, Math.floor(y + this.oy));
    const x1 = Math.min(this.cx1, Math.floor(x + this.ox + w));
    const y1 = Math.min(this.cy1, Math.floor(y + this.oy + h));
    if (x1 <= x0 || y1 <= y0) return;
    const a = c >>> 24;
    for (let yy = y0; yy < y1; yy++) {
      const row = yy * this.w;
      if (a === 255) this.data.fill(c, row + x0, row + x1);
      else for (let xx = x0; xx < x1; xx++) this.data[row + xx] = blend(this.data[row + xx] as number, c);
    }
  }

  /** 1-px outline. */
  frame(x: number, y: number, w: number, h: number, c: number): void {
    this.rect(x, y, w, 1, c);
    this.rect(x, y + h - 1, w, 1, c);
    this.rect(x, y, 1, h, c);
    this.rect(x + w - 1, y, 1, h, c);
  }

  line(x0: number, y0: number, x1: number, y1: number, c: number): void {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.px(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  /** Ordered-dither fill: `level` 0..16 of the 4x4 Bayer matrix set. */
  dither(x: number, y: number, w: number, h: number, c: number, level: number): void {
    for (let yy = 0; yy < h; yy++)
      for (let xx = 0; xx < w; xx++) {
        const gx = Math.floor(x + xx + this.ox) & 3;
        const gy = Math.floor(y + yy + this.oy) & 3;
        if ((BAYER[gy * 4 + gx] as number) < level) this.px(x + xx, y + yy, c);
      }
  }

  blit(s: Sprite, x: number, y: number, opts: { tint?: number; alpha?: number; flash?: number } = {}): void {
    const bx = Math.floor(x + this.ox);
    const by = Math.floor(y + this.oy);
    const alpha = opts.alpha ?? 1;
    for (let sy = 0; sy < s.h; sy++) {
      const yy = by + sy;
      if (yy < this.cy0 || yy >= this.cy1) continue;
      for (let sx = 0; sx < s.w; sx++) {
        const xx = bx + sx;
        if (xx < this.cx0 || xx >= this.cx1) continue;
        let c = s.data[sy * s.w + sx] as number;
        if (!c) continue;
        if (opts.flash) c = opts.flash;
        else if (opts.tint) c = blend(c, opts.tint);
        if (alpha < 1) c = ((c & 0x00ffffff) | (Math.round(((c >>> 24) * alpha)) << 24)) >>> 0;
        const i = yy * this.w + xx;
        this.data[i] = (c >>> 24) === 255 ? c : blend(this.data[i] as number, c);
      }
    }
  }

  /** Multiply a region toward black (0 = unchanged, 1 = black). */
  darken(x: number, y: number, w: number, h: number, amount: number): void {
    this.rect(x, y, w, h, ((Math.round(amount * 255) << 24) | 0) >>> 0);
  }
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Source-over blend of packed colour `src` (with alpha) onto opaque `dst`. */
export function blend(dst: number, src: number): number {
  const a = (src >>> 24) / 255;
  if (a >= 1) return src;
  const u = 1 - a;
  const r = (src & 255) * a + (dst & 255) * u;
  const g = ((src >> 8) & 255) * a + ((dst >> 8) & 255) * u;
  const b = ((src >> 16) & 255) * a + ((dst >> 16) & 255) * u;
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** Build a sprite from ASCII art rows; `key` maps characters to packed colours ('.' and ' ' = transparent). */
export function spriteFrom(rows: string[], key: Record<string, number>): Sprite {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const data = new Uint32Array(w * h);
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === "." || ch === " ") return;
      const c = key[ch];
      if (c === undefined) throw new Error(`sprite key has no colour for '${ch}'`);
      data[y * w + x] = c;
    });
  });
  return { w, h, data };
}

/** Rotate 90 degrees clockwise `times` times (top-down sprites face north by default). */
export function rotate(s: Sprite, times: number): Sprite {
  let cur = s;
  for (let t = 0; t < ((times % 4) + 4) % 4; t++) {
    const out = new Uint32Array(cur.w * cur.h);
    for (let y = 0; y < cur.h; y++) for (let x = 0; x < cur.w; x++) out[x * cur.h + (cur.h - 1 - y)] = cur.data[y * cur.w + x] as number;
    cur = { w: cur.h, h: cur.w, data: out };
  }
  return cur;
}

export function flipX(s: Sprite): Sprite {
  const out = new Uint32Array(s.w * s.h);
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) out[y * s.w + (s.w - 1 - x)] = s.data[y * s.w + x] as number;
  return { w: s.w, h: s.h, data: out };
}

export function solidShadow(s: Sprite, c = C.ink): Sprite {
  const out = new Uint32Array(s.w * s.h);
  for (let i = 0; i < s.data.length; i++) if (s.data[i]) out[i] = c;
  return { w: s.w, h: s.h, data: out };
}
