/** In-game HUD pieces shared by the simulator and the replay viewer. */
import type { Distribution } from "../decision/types";
import { SMALL, text } from "../render/font";
import { C, DOCK_COLOR, PRIORITY_COLOR, mix } from "../render/palette";
import { ICONS } from "../render/sprites";
import type { DecisionRecord } from "../run/record";
import type { WorldSnapshot } from "../sim/world";
import { fmtMs, type UI } from "../ui/widgets";

/** Smoothly animated bar values, keyed by question/option. */
export class Bars {
  private v = new Map<string, number>();
  get(key: string, target: number, dt: number): number {
    const cur = this.v.get(key) ?? 0;
    const next = cur + (target - cur) * Math.min(1, dt * 12);
    this.v.set(key, next);
    return next;
  }
}

const ARROW: Record<string, string> = { LEFT: "←", FORWARD: "↑", RIGHT: "→", REVERSE: "↓" };
const RISK_COLOR: Record<string, number> = { LOW: C.green, MEDIUM: C.amber, HIGH: C.red };

export interface DecisionPanelData {
  engine: "jeb" | "rules" | "manual";
  tick: number;
  tactical: { rec: DecisionRecord; tick: number } | null;
  strategic: { rec: DecisionRecord; tick: number } | null;
  thinking: boolean;
  policyLabel: string;
  replay?: boolean;
}

function dist(rec: DecisionRecord | undefined, id: string): Distribution | undefined {
  return rec?.dists.find((d) => d.id === id);
}

function rows(ui: UI, bars: Bars, dt: number, x: number, y: number, w: number, d: Distribution, chosen: string | null, opts: { label: (k: string) => string; color: (k: string) => number; rowH?: number; max?: number }): number {
  const fb = ui.fb;
  const rowH = opts.rowH ?? 8;
  const probs = opts.max ? [...d.probs].sort((a, b) => b.p - a.p).slice(0, opts.max) : d.probs;
  const top = d.probs.reduce((a, b) => (b.p > a.p ? b : a)).key;
  const labelW = 44;
  const barW = w - labelW - 24;
  for (const p of probs) {
    const isChosen = p.key === chosen;
    if (isChosen) fb.rect(x - 2, y - 1, w + 3, rowH - 1, mix(C.panel, opts.color(p.key), 0.18));
    text(fb, SMALL, opts.label(p.key), x, y, isChosen ? C.white : p.key === top ? C.mist : C.steel3, { shadow: null, maxWidth: labelW - 2 });
    const v = bars.get(`${d.id}:${p.key}`, p.p, dt);
    ui.bar(x + labelW, y, barW, 5, v, isChosen ? opts.color(p.key) : mix(opts.color(p.key), C.panel, 0.45), { track: C.panel2 });
    text(fb, SMALL, `${Math.round(p.p * 100)}%`, x + w, y, isChosen ? C.white : C.steel3, { align: "right", shadow: null });
    if (p.key === top && !isChosen && chosen !== null) text(fb, SMALL, "▶", x + labelW - 5, y, C.amber, { shadow: null });
    y += rowH;
  }
  return y;
}

export function drawDecisionPanel(ui: UI, bars: Bars, dt: number, x: number, y: number, w: number, h: number, data: DecisionPanelData): void {
  const fb = ui.fb;
  const title = data.engine === "jeb" ? (data.replay ? "JEB // RECORDED DECISION" : "JEB // LIVE DECISION") : data.engine === "rules" ? "RULES // BASELINE" : "MANUAL // YOU DRIVE";
  const accent = data.engine === "jeb" ? C.cyan : data.engine === "rules" ? C.amber : C.magenta;
  ui.panel(x, y, w, h, title, { accent, led: data.thinking ? (Math.floor(ui.time * 6) % 2 ? C.cyan : null) : data.engine === "jeb" ? C.green : accent });
  const ix = x + 7;
  const iw = w - 14;
  let cy = y + 10;
  text(fb, SMALL, `TICK ${String(data.tick).padStart(3, "0")}`, ix, cy, C.steel3, { shadow: null });
  text(fb, SMALL, data.policyLabel, ix + iw, cy, accent, { align: "right", shadow: null });
  cy += 9;
  if (data.engine === "manual") {
    text(fb, SMALL, "NO MODEL IN THE LOOP.", ix, cy + 4, C.mist, { shadow: null });
    text(fb, SMALL, "DRIVE: WASD OR ARROW KEYS", ix, cy + 16, C.white, { shadow: null });
    text(fb, SMALL, "SPACE: WAIT / CHARGE ON A PAD", ix, cy + 24, C.white, { shadow: null });
    text(fb, SMALL, "DRIVE ONTO A PACKAGE TO GRAB IT,", ix, cy + 36, C.steel3, { shadow: null });
    text(fb, SMALL, "THEN TO ITS COLOURED DOCK.", ix, cy + 44, C.steel3, { shadow: null });
    text(fb, SMALL, "SWITCH TO JEB TO SEE IT DECIDE.", ix, cy + 58, C.cyan, { shadow: null });
    return;
  }
  const tac = data.tactical?.rec;
  const move = dist(tac, "move");
  const risk = dist(tac, "risk");
  const moveSel = tac?.selection.find((s) => s.question === "move");
  // MOVE
  text(fb, SMALL, "MOVE", ix, cy, accent, { shadow: null });
  if (moveSel) {
    const a = moveSel.chosen;
    text(fb, SMALL, a === "WAIT" ? "■ HOLD" : `${ARROW[a] ?? ""} ${a}`, ix + iw, cy, a === "WAIT" ? C.amber : C.white, { align: "right", shadow: null });
  }
  cy += 9;
  if (move) cy = rows(ui, bars, dt, ix, cy, iw, move, moveSel?.chosen ?? null, { label: (k) => `${ARROW[k] ?? ""} ${k}`, color: () => accent });
  else {
    text(fb, SMALL, data.thinking ? "ASKING JEB..." : "WAITING FOR FIRST DECISION", ix, cy + 12, C.steel3, { shadow: null });
    cy += 32;
  }
  cy += 3;
  // RISK
  text(fb, SMALL, "RISK", ix, cy, accent, { shadow: null });
  if (risk) {
    const top = risk.probs.reduce((a, b) => (b.p > a.p ? b : a)).key;
    const warn = top === "HIGH";
    if (warn && Math.floor(ui.time * 4) % 2) fb.blit(ICONS.warn, ix + 20, cy - 1);
    text(fb, SMALL, top, ix + iw, cy, RISK_COLOR[top] ?? C.white, { align: "right", shadow: null });
    cy += 9;
    cy = rows(ui, bars, dt, ix, cy, iw, risk, top, { label: (k) => k, color: (k) => RISK_COLOR[k] ?? C.cyan, rowH: 7 });
  } else cy += 30;
  cy += 3;
  // strategic (last TARGET / REROUTE)
  const str = data.strategic;
  const sd = str?.rec.dists[0];
  fb.rect(ix - 2, cy - 2, iw + 4, 1, C.panel3);
  if (str && sd) {
    const age = data.tick - str.tick;
    const fresh = age <= 1;
    const sel = str.rec.selection[0];
    text(fb, SMALL, sd.id === "target" ? "TARGET" : "REROUTE", ix, cy, fresh ? C.amber : C.steel3, { shadow: null });
    text(fb, SMALL, fresh ? `→ ${sel?.chosen ?? ""}` : `${age} TICKS AGO`, ix + iw, cy, fresh ? C.white : C.steel, { align: "right", shadow: null, maxWidth: 70 });
    cy += 9;
    cy = rows(ui, bars, dt, ix, cy, iw, sd, sel?.chosen ?? null, { label: (k) => k.replace("PACKAGE ", "PKG ").replace("DELIVER ", "DLV "), color: () => C.amber, rowH: 7, max: 4 });
  } else {
    text(fb, SMALL, "TARGET / REROUTE: ASKED ONLY", ix, cy, C.steel, { shadow: null });
    text(fb, SMALL, "WHEN THERE IS A REAL CHOICE", ix, cy + 7, C.steel, { shadow: null });
    cy += 16;
  }
  // footer
  const fy = y + h - 26;
  fb.rect(ix - 2, fy - 2, iw + 4, 1, C.panel3);
  const conf = move?.confidence ?? null;
  text(fb, SMALL, "CONFIDENCE", ix, fy, C.steel3, { shadow: null });
  ui.bar(ix + 42, fy, iw - 66, 5, conf ?? 0, conf === null ? C.panel3 : conf > 0.7 ? C.green : conf > 0.4 ? C.amber : C.red, { track: C.panel2, segments: 10 });
  text(fb, SMALL, conf === null ? "--" : `${Math.round(conf * 100)}%`, ix + iw, fy, C.white, { align: "right", shadow: null });
  const t = tac?.timing;
  if (data.engine === "jeb") {
    text(fb, SMALL, `MODEL ${fmtMs(t?.modelMs)}`, ix, fy + 8, C.cyan, { shadow: null });
    text(fb, SMALL, `REQUEST ${fmtMs(tac?.latencyMs)}`, ix + iw, fy + 8, C.mist, { align: "right", shadow: null });
  } else text(fb, SMALL, "DETERMINISTIC · ONE-HOT, NO PROBABILITIES", ix, fy + 8, C.amber, { shadow: null, maxWidth: iw });
  if (moveSel) text(fb, SMALL, moveSel.note.toUpperCase(), ix, fy + 16, C.steel3, { shadow: null, maxWidth: iw });
}

/** Battery, packages, score, time, collisions and the last event: the strip under the map. */
export function drawStatusStrip(ui: UI, x: number, y: number, w: number, h: number, snap: WorldSnapshot, timeLimit: number, lastEvent: string | null, scoreShown: number): void {
  const fb = ui.fb;
  ui.panel(x, y, w, h);
  const r = snap.robot;
  const bat = r.battery / 100;
  const cx = x + 6;
  fb.blit(ICONS.bolt, cx, y + 4);
  const col = bat > 0.5 ? C.green : bat > 0.25 ? C.amber : C.red;
  ui.bar(cx + 8, y + 5, 46, 5, bat, col, { segments: 10, track: C.ink });
  text(fb, SMALL, `${Math.round(r.battery)}%`, cx + 58, y + 5, bat < 0.2 && Math.floor(ui.time * 4) % 2 ? C.red : C.white, { shadow: null });
  // packages
  let px = cx + 80;
  text(fb, SMALL, "PKG", px, y + 5, C.steel3, { shadow: null });
  px += 14;
  for (const p of snap.packages) {
    const c = p.status === "delivered" ? C.green : p.status === "carried" ? C.amber : p.status === "waiting" ? PRIORITY_COLOR[p.priority] : C.panel3;
    fb.rect(px, y + 4, 5, 6, C.ink);
    fb.rect(px + 1, y + 5, 3, 4, c);
    const dc = DOCK_COLOR[p.dock]?.[0];
    if (dc && p.status !== "delivered") fb.rect(px + 1, y + 10, 3, 1, dc);
    px += 6;
  }
  const delivered = snap.packages.filter((p) => p.status === "delivered").length;
  text(fb, SMALL, `${delivered}/${snap.packages.length}`, px + 2, y + 5, C.white, { shadow: null });
  text(fb, SMALL, `SCORE ${Math.round(scoreShown)}`, x + 196, y + 5, C.cyan, { shadow: null });
  text(fb, SMALL, `T ${String(snap.tick).padStart(3, "0")}/${timeLimit}`, x + 246, y + 5, C.mist, { shadow: null });
  text(fb, SMALL, `HIT ${snap.stats.collisions}`, x + w - 6, y + 5, snap.stats.collisions ? C.red : C.steel3, { align: "right", shadow: null });
  fb.rect(x + 4, y + 13, w - 8, 1, C.panel3);
  text(fb, SMALL, lastEvent ? `▶ ${lastEvent.toUpperCase()}` : "▶ READY", x + 6, y + 16, lastEvent ? C.mist : C.steel, { shadow: null, maxWidth: w - 12 });
}

/** Tiny line chart of recent values (two series), autoscaled. */
export function sparkline(ui: UI, x: number, y: number, w: number, h: number, a: (number | null)[], b: (number | null)[], ca: number, cb: number): number {
  ui.well(x, y, w, h);
  const vals = [...a, ...b].filter((v): v is number => v !== null);
  const max = Math.max(1, ...vals);
  const plot = (s: (number | null)[], c: number): void => {
    const n = s.length;
    let prev: { x: number; y: number } | null = null;
    s.forEach((v, i) => {
      if (v === null) {
        prev = null;
        return;
      }
      const px = x + 1 + Math.round(((w - 3) * i) / Math.max(1, n - 1));
      const py = y + h - 2 - Math.round(((h - 3) * v) / max);
      if (prev) ui.fb.line(prev.x, prev.y, px, py, c);
      else ui.fb.px(px, py, c);
      prev = { x: px, y: py };
    });
  };
  plot(b, cb);
  plot(a, ca);
  return max;
}
