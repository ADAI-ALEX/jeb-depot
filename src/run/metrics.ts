/**
 * Offline analysis of a recorded run. Move outcomes are scored against the recorded per-direction context:
 * a move is GOOD when it does not collide and is a shortest step (any safe step when the route tile is unsafe),
 * BAD when it collides or leaves the shortest route, HOLD when the policy waited.
 */
import type { DecisionContext, DecisionRecord, RunRecord } from "./record";

export type MoveOutcome = "good" | "bad" | "hold";

export function moveOutcome(ctx: DecisionContext, chosen: string): MoveOutcome {
  if (chosen === "WAIT") return "hold";
  const d = ctx.dirs.find((x) => x.rel === chosen);
  if (!d || d.collides) return "bad";
  const route = ctx.dirs.find((x) => x.onRoute);
  if (!route || route.collides) return "good";
  const best = Math.min(...ctx.dirs.filter((x) => !x.collides && x.steps !== null).map((x) => x.steps as number));
  return d.steps !== null && d.steps <= best ? "good" : "bad";
}

export interface MoveSample {
  tick: number;
  chosen: string;
  pChosen: number | null;
  pTop: number;
  confidence: number;
  outcome: MoveOutcome;
  riskExpected: number | null;
  riskTop: string | null;
  incidentSoon: boolean;
}

export interface Bin {
  lo: number;
  hi: number;
  n: number;
  meanP: number;
  rate: number;
}

export interface Analysis {
  engine: string;
  latency: { tick: number; modelMs: number | null; requestMs: number; e2eMs: number }[];
  confidence: { tick: number; conf: number }[];
  score: { tick: number; score: number }[];
  dps: { tick: number; dps: number }[];
  moves: MoveSample[];
  /** Success rate by JEB confidence of the executed move. */
  byConfidence: Bin[];
  /** Reliability of the executed move's probability vs a good outcome. */
  reliability: { bins: Bin[]; ece: number | null; n: number };
  /** Incident (collision or spill within 3 ticks) rate per reported risk level. */
  riskLevels: { level: string; n: number; incidents: number; rate: number }[];
  moveGoodRate: number | null;
}

function bins(samples: { p: number; ok: boolean }[], edges: number[]): Bin[] {
  const out: Bin[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const lo = edges[i] as number;
    const hi = edges[i + 1] as number;
    const s = samples.filter((x) => (x.p > lo || (i === 0 && x.p >= lo)) && x.p <= hi);
    out.push({ lo, hi, n: s.length, meanP: s.length ? s.reduce((a, b) => a + b.p, 0) / s.length : (lo + hi) / 2, rate: s.length ? s.filter((x) => x.ok).length / s.length : 0 });
  }
  return out;
}

export function analyse(run: RunRecord): Analysis {
  const latency: Analysis["latency"] = [];
  const confidence: Analysis["confidence"] = [];
  const score: Analysis["score"] = [];
  const dps: Analysis["dps"] = [];
  const moves: MoveSample[] = [];
  const window: number[] = [];
  const incidentTicks = new Set(run.ticks.filter((t) => t.events.some((e) => e.kind.startsWith("collision") || e.kind === "spill")).map((t) => t.tick));
  for (const t of run.ticks) {
    score.push({ tick: t.tick, score: t.after.score });
    if (!t.decisions.length) continue;
    const req = t.decisions.reduce((s, d) => s + d.latencyMs, 0);
    const model = t.decisions.some((d) => d.timing) ? t.decisions.reduce((s, d) => s + (d.timing?.modelMs ?? 0), 0) : null;
    latency.push({ tick: t.tick, modelMs: model, requestMs: req, e2eMs: t.endToEndMs });
    for (const d of t.decisions) {
      window.push(d.latencyMs);
      if (window.length > 10) window.shift();
      const busy = window.reduce((a, b) => a + b, 0);
      if (busy > 0) dps.push({ tick: t.tick, dps: window.length / (busy / 1000) });
    }
    const tac = t.decisions.find((d): d is DecisionRecord & { context: DecisionContext } => d.stage === "tactical" && !!d.context);
    if (!tac) continue;
    const move = tac.dists.find((d) => d.id === "move");
    const risk = tac.dists.find((d) => d.id === "risk");
    const sel = tac.selection.find((s) => s.question === "move");
    if (!move || !sel) continue;
    confidence.push({ tick: t.tick, conf: move.confidence });
    const pTop = Math.max(...move.probs.map((p) => p.p));
    const pChosen = sel.chosen === "WAIT" ? null : move.probs.find((p) => p.key === sel.chosen)?.p ?? null;
    const re = risk ? ((risk.probs.find((p) => p.key === "MEDIUM")?.p ?? 0) + 2 * (risk.probs.find((p) => p.key === "HIGH")?.p ?? 0)) / 2 : null;
    const rtop = risk ? risk.probs.reduce((a, b) => (b.p > a.p ? b : a)).key : null;
    const soon = [0, 1, 2].some((k) => incidentTicks.has(t.tick + k));
    moves.push({ tick: t.tick, chosen: sel.chosen, pChosen, pTop, confidence: move.confidence, outcome: moveOutcome(tac.context, sel.chosen), riskExpected: re, riskTop: rtop, incidentSoon: soon });
  }
  const acted = moves.filter((m) => m.outcome !== "hold");
  const byConfidence = bins(acted.map((m) => ({ p: m.confidence, ok: m.outcome === "good" })), [0, 0.2, 0.4, 0.6, 0.8, 1]);
  const relSamples = acted.filter((m) => m.pChosen !== null).map((m) => ({ p: m.pChosen as number, ok: m.outcome === "good" }));
  const relBins = bins(relSamples, [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
  const ece = relSamples.length ? relBins.reduce((s, b) => s + (b.n / relSamples.length) * Math.abs(b.rate - b.meanP), 0) : null;
  const riskLevels = ["LOW", "MEDIUM", "HIGH"].map((level) => {
    const s = moves.filter((m) => m.riskTop === level);
    const incidents = s.filter((m) => m.incidentSoon).length;
    return { level, n: s.length, incidents, rate: s.length ? incidents / s.length : 0 };
  });
  return {
    engine: run.meta.engine,
    latency,
    confidence,
    score,
    dps,
    moves,
    byConfidence,
    reliability: { bins: relBins, ece, n: relSamples.length },
    riskLevels,
    moveGoodRate: acted.length ? acted.filter((m) => m.outcome === "good").length / acted.length : null,
  };
}
