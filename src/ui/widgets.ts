/** Immediate-mode pixel UI: bevelled control-room panels, keycap buttons, segmented switches, gauges. */
import type { Framebuffer } from "../render/fb";
import { BIG, SMALL, measure, text, type Font } from "../render/font";
import { C, mix, withAlpha } from "../render/palette";
import type { Input } from "./input";

export interface ButtonOpts {
  active?: boolean;
  disabled?: boolean;
  accent?: number;
  font?: Font;
  hotkey?: string | string[];
  /** Blink the label (call to action). */
  pulse?: boolean;
  tip?: string;
}

export class UI {
  pointer = false;
  tip: string | null = null;
  time = 0;

  constructor(
    readonly fb: Framebuffer,
    readonly input: Input,
  ) {}

  beginFrame(time: number): void {
    this.pointer = false;
    this.tip = null;
    this.time = time;
  }

  hover(x: number, y: number, w: number, h: number): boolean {
    return this.input.within(x, y, w, h);
  }

  /** Control-room panel: dark body, bevelled rim, corner rivets, optional title tab with a status LED. */
  panel(x: number, y: number, w: number, h: number, title?: string, opts: { accent?: number; led?: number | null; right?: string } = {}): void {
    const fb = this.fb;
    const accent = opts.accent ?? C.cyan;
    fb.rect(x, y, w, h, C.panel);
    fb.frame(x, y, w, h, C.edge);
    fb.rect(x + 1, y + 1, w - 2, 1, C.panel3);
    fb.rect(x + 1, y + 1, 1, h - 2, C.panel2);
    fb.rect(x + 1, y + h - 2, w - 2, 1, C.ink);
    for (const [px, py] of [[x + 2, y + 2], [x + w - 3, y + 2], [x + 2, y + h - 3], [x + w - 3, y + h - 3]] as const) fb.px(px, py, C.steel);
    if (title) {
      const tw = measure(SMALL, title) + 10 + (opts.led !== undefined ? 6 : 0);
      fb.rect(x + 4, y - 1, tw, 8, C.panel2);
      fb.frame(x + 4, y - 1, tw, 8, C.edge);
      fb.rect(x + 5, y + 6, tw - 2, 1, accent);
      let tx = x + 9;
      if (opts.led !== undefined) {
        const on = opts.led !== null;
        fb.rect(x + 8, y + 2, 3, 3, on ? (opts.led as number) : C.panel3);
        if (on) fb.px(x + 8, y + 2, mix(opts.led as number, C.white, 0.6));
        tx += 5;
      }
      text(fb, SMALL, title, tx, y + 1, accent, { shadow: null });
    }
    if (opts.right) text(fb, SMALL, opts.right, x + w - 6, y + 1, C.steel3, { align: "right", shadow: null });
  }

  /** Recessed display area (for charts and readouts). */
  well(x: number, y: number, w: number, h: number): void {
    this.fb.rect(x, y, w, h, C.ink);
    this.fb.rect(x, y, w, 1, C.void);
    this.fb.rect(x, y + h - 1, w, 1, C.panel3);
  }

  button(x: number, y: number, w: number, h: number, label: string, opts: ButtonOpts = {}): boolean {
    const fb = this.fb;
    const hot = !opts.disabled && this.hover(x, y, w, h);
    const accent = opts.accent ?? C.cyan;
    const held = hot && this.input.down;
    if (hot) {
      this.pointer = true;
      if (opts.tip) this.tip = opts.tip;
    }
    const face = opts.disabled ? C.panel2 : opts.active ? mix(C.panel2, accent, 0.28) : hot ? C.panel3 : C.panel2;
    fb.rect(x, y, w, h, C.ink);
    fb.rect(x + 1, y + (held ? 1 : 0), w - 2, h - 1, face);
    if (!held) {
      fb.rect(x + 1, y, w - 2, 1, opts.active ? accent : hot ? C.steel2 : C.edge);
      fb.rect(x + 1, y + h - 2, w - 2, 1, mix(face, C.ink, 0.5));
    }
    const font = opts.font ?? SMALL;
    const pulse = opts.pulse && Math.floor(this.time * 2.2) % 2 === 0;
    const color = opts.disabled ? C.steel : opts.active ? mix(accent, C.white, 0.2) : hot || pulse ? C.white : C.mist;
    text(fb, font, label, x + Math.floor(w / 2), y + Math.floor((h - font.gh) / 2) + (held ? 1 : 0), color, { align: "center", shadow: null, maxWidth: w - 4 });
    const keys = opts.hotkey === undefined ? [] : Array.isArray(opts.hotkey) ? opts.hotkey : [opts.hotkey];
    const byKey = !opts.disabled && keys.length > 0 && this.input.key(...keys);
    return (hot && this.input.pressed) || byKey;
  }

  /** Segmented switch; returns the clicked index or null. */
  segmented(x: number, y: number, w: number, h: number, items: { label: string; tip?: string; disabled?: boolean; hotkey?: string }[], selected: number, accent = C.cyan): number | null {
    const each = Math.floor(w / items.length);
    let out: number | null = null;
    items.forEach((it, i) => {
      const bw = i === items.length - 1 ? w - each * i : each;
      const opts: ButtonOpts = { active: i === selected, accent };
      if (it.disabled !== undefined) opts.disabled = it.disabled;
      if (it.tip !== undefined) opts.tip = it.tip;
      if (it.hotkey !== undefined) opts.hotkey = it.hotkey;
      if (this.button(x + each * i, y, bw + 1, h, it.label, opts)) out = i;
    });
    return out;
  }

  /** Horizontal gauge with a 1-px track; `ghost` draws a faint marker (e.g. the previous value). */
  bar(x: number, y: number, w: number, h: number, v: number, color: number, opts: { track?: number; ghost?: number; segments?: number } = {}): void {
    const fb = this.fb;
    fb.rect(x, y, w, h, opts.track ?? C.ink);
    const fw = Math.max(0, Math.min(w, Math.round(w * v)));
    if (opts.segments) {
      const seg = w / opts.segments;
      for (let i = 0; i < opts.segments; i++) {
        const sx = Math.round(x + i * seg);
        const ex = Math.round(x + (i + 1) * seg) - 1;
        if (sx >= x + fw) break;
        fb.rect(sx, y, Math.min(ex, x + fw) - sx, h, color);
      }
    } else {
      fb.rect(x, y, fw, h, color);
      if (fw > 1 && h > 2) fb.rect(x, y, fw, 1, mix(color, C.white, 0.35));
    }
    if (opts.ghost !== undefined) {
      const gx = x + Math.round(w * opts.ghost);
      fb.rect(gx, y - 1, 1, h + 2, withAlpha(C.white, 140));
    }
  }

  led(x: number, y: number, color: number | null, blink = false): void {
    const on = color !== null && (!blink || Math.floor(this.time * 3) % 2 === 0);
    this.fb.rect(x, y, 3, 3, on ? (color as number) : C.panel3);
    if (on) this.fb.px(x, y, mix(color as number, C.white, 0.6));
  }

  label(s: string, x: number, y: number, color = C.mist, font: Font = SMALL, opts: { align?: "left" | "center" | "right"; maxWidth?: number } = {}): number {
    return text(this.fb, font, s, x, y, color, { shadow: null, ...opts });
  }

  big(s: string, x: number, y: number, color = C.white, opts: { align?: "left" | "center" | "right"; scale?: number } = {}): number {
    return text(this.fb, BIG, s, x, y, color, opts);
  }

  /** Draw the pending tooltip near the pointer (call last). */
  drawTip(): void {
    if (!this.tip || this.input.mx < 0) return;
    const w = measure(SMALL, this.tip) + 6;
    const x = Math.min(this.fb.w - w - 2, this.input.mx + 6);
    const y = Math.min(this.fb.h - 11, this.input.my + 10);
    this.fb.rect(x, y, w, 9, C.ink);
    this.fb.frame(x, y, w, 9, C.steel);
    text(this.fb, SMALL, this.tip, x + 3, y + 2, C.white, { shadow: null });
  }
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "--";
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)}S`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}S`;
  return `${Math.round(ms)}MS`;
}

export function fmtBytes(b: number | null | undefined): string {
  if (b === null || b === undefined || !Number.isFinite(b)) return "--";
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${(b / 1e3).toFixed(0)} KB`;
  return `${b} B`;
}

export function pct(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "--";
  return `${(v * 100).toFixed(digits)}%`;
}
