/** Pixel charts drawn in game panels: line series, binned bars, reliability diagrams. */
import { SMALL, text } from "../render/font";
import { C, mix, withAlpha } from "../render/palette";
import type { Bin } from "../run/metrics";
import type { UI } from "./widgets";

export interface Series {
  values: { x: number; y: number | null }[];
  color: number;
  label: string;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export function lineChart(ui: UI, x: number, y: number, w: number, h: number, series: Series[], opts: { yMax?: number; yFmt?: (v: number) => string; xLabel?: string; empty?: string } = {}): void {
  const fb = ui.fb;
  const px = x + 22;
  const py = y + 2;
  const pw = w - 26;
  const ph = h - 12;
  ui.well(px, py, pw, ph);
  const all = series.flatMap((s) => s.values);
  const ys = all.map((v) => v.y).filter((v): v is number => v !== null);
  if (!ys.length) {
    text(fb, SMALL, opts.empty ?? "NO DATA", px + pw / 2, py + ph / 2 - 2, C.steel, { align: "center", shadow: null });
    return;
  }
  const xs = all.map((v) => v.x);
  const x0 = Math.min(...xs);
  const x1 = Math.max(x0 + 1, ...xs);
  const yMax = opts.yMax ?? niceMax(Math.max(...ys));
  const fmt = opts.yFmt ?? ((v: number) => `${Math.round(v)}`);
  for (let k = 0; k <= 4; k++) {
    const gy = py + ph - 1 - Math.round(((ph - 2) * k) / 4);
    for (let gx = px + 1; gx < px + pw - 1; gx += 3) fb.px(gx, gy, withAlpha(C.panel3, 200));
    if (k % 2 === 0) text(fb, SMALL, fmt((yMax * k) / 4), px - 2, gy - 2, C.steel3, { align: "right", shadow: null });
  }
  for (const s of series) {
    let prev: { x: number; y: number } | null = null;
    for (const v of s.values) {
      if (v.y === null) {
        prev = null;
        continue;
      }
      const cx = px + 1 + Math.round(((pw - 3) * (v.x - x0)) / (x1 - x0));
      const cy = py + ph - 2 - Math.round(((ph - 3) * Math.min(v.y, yMax)) / yMax);
      if (prev) fb.line(prev.x, prev.y, cx, cy, s.color);
      else fb.px(cx, cy, s.color);
      prev = { x: cx, y: cy };
    }
  }
  text(fb, SMALL, `${x0}`, px, py + ph + 2, C.steel, { shadow: null });
  text(fb, SMALL, opts.xLabel ?? "TICK", px + pw / 2, py + ph + 2, C.steel, { align: "center", shadow: null });
  text(fb, SMALL, `${x1}`, px + pw, py + ph + 2, C.steel, { align: "right", shadow: null });
}

export function legend(ui: UI, x: number, y: number, items: { label: string; color: number }[]): void {
  let lx = x;
  for (const it of items) {
    ui.fb.rect(lx, y + 1, 4, 3, it.color);
    lx += 6 + text(ui.fb, SMALL, it.label, lx + 6, y, C.steel3, { shadow: null }) + 4;
  }
}

/** Bars of `rate` per bin with the sample count underneath; bins with n < minN are drawn hollow. */
export function binChart(ui: UI, x: number, y: number, w: number, h: number, bs: Bin[], opts: { color: number; diagonal?: boolean; minN?: number; labels?: (b: Bin) => string } = { color: C.cyan }): void {
  const fb = ui.fb;
  const px = x + 22;
  const py = y + 2;
  const pw = w - 26;
  const ph = h - 14;
  ui.well(px, py, pw, ph);
  for (let k = 0; k <= 4; k++) {
    const gy = py + ph - 1 - Math.round(((ph - 2) * k) / 4);
    for (let gx = px + 1; gx < px + pw - 1; gx += 3) fb.px(gx, gy, withAlpha(C.panel3, 200));
    if (k % 2 === 0) text(fb, SMALL, `${k * 25}%`, px - 2, gy - 2, C.steel3, { align: "right", shadow: null });
  }
  const n = bs.length;
  const bw = Math.floor((pw - 2) / n);
  const minN = opts.minN ?? 1;
  bs.forEach((b, i) => {
    const bx = px + 1 + i * bw;
    const bh = Math.round((ph - 3) * b.rate);
    if (b.n >= minN && b.n > 0) {
      fb.rect(bx + 1, py + ph - 1 - bh, bw - 2, bh, opts.color);
      fb.rect(bx + 1, py + ph - 1 - bh, bw - 2, 1, mix(opts.color, C.white, 0.4));
    } else if (b.n > 0) fb.frame(bx + 1, py + ph - 1 - bh, bw - 2, Math.max(1, bh), mix(opts.color, C.panel, 0.4));
    if (opts.labels) text(fb, SMALL, opts.labels(b), bx + bw / 2, py + ph + 2, C.steel, { align: "center", shadow: null });
    text(fb, SMALL, `${b.n}`, bx + bw / 2, py + ph + 8, b.n >= minN ? C.steel3 : C.steel, { align: "center", shadow: null });
  });
  if (opts.diagonal) {
    // perfect calibration: accuracy == mean predicted probability
    bs.forEach((b, i) => {
      const bx = px + 1 + i * bw;
      const yy = py + ph - 1 - Math.round((ph - 3) * ((b.lo + b.hi) / 2));
      fb.rect(bx, yy, bw, 1, withAlpha(C.white, 150));
    });
  }
}
