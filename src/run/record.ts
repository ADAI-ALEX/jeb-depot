/** What a run records: enough to replay it tick by tick and to compute every benchmark number from it. */
import type { Distribution, EngineId, EngineTiming, QuestionSpec } from "../decision/types";
import type { PolicyId } from "../decision/policies";
import type { Action, Dir, Outcome, SimEvent, Stats, Vec } from "../sim/types";

export const RECORD_VERSION = 1;

export interface DecisionRecord {
  stage: "strategic" | "tactical";
  stateText: string;
  questions: QuestionSpec[];
  dists: Distribution[];
  /** What the policy did with the distributions. */
  selection: { question: string; chosen: string; p: number | null; note: string }[];
  timing: EngineTiming | null;
  /** Wall time of this stage seen from the game loop (request built -> answer back). */
  latencyMs: number;
  notes?: string[];
  /** Tactical decisions: what each direction held, so outcomes can be scored offline. */
  context?: DecisionContext;
}

export interface DecisionContext {
  dirs: { rel: string; blocked: boolean; collides: boolean; spill: boolean; steps: number | null; onRoute: boolean }[];
  adjacentTraffic: boolean;
  nearTraffic: boolean;
  nearHazard: boolean;
}

export interface TickRecord {
  tick: number;
  /** ms since run start (wall clock) when the tick began. */
  t: number;
  decisions: DecisionRecord[];
  action: Action;
  actionSource: "jeb" | "rules" | "manual" | "auto";
  autoReason?: string;
  /** Observe + decide + policy + simulate, excluding render pacing. */
  endToEndMs: number;
  events: SimEvent[];
  after: { pos: Vec; heading: Dir; battery: number; score: number; carrying: string | null };
}

export interface RunMeta {
  version: number;
  id: string;
  levelId: number;
  levelName: string;
  seed: number;
  engine: EngineId | "manual";
  policy: PolicyId | "rules" | "manual";
  permutations: number;
  startedAt: string;
  model: string | null;
  runtime: string | null;
  demo: boolean;
}

export interface RunRecord {
  meta: RunMeta;
  ticks: TickRecord[];
  outcome: Outcome;
  finalScore: number;
  stats: Stats;
  packagesTotal: number;
  wallMs: number;
}

export function percentile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
}

export interface LatencyStats {
  n: number;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  min: number | null;
  max: number | null;
}

export function latencyStats(xs: number[]): LatencyStats {
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length,
    mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : null,
    p50: percentile(s, 0.5),
    p95: percentile(s, 0.95),
    p99: percentile(s, 0.99),
    min: s[0] ?? null,
    max: s[s.length - 1] ?? null,
  };
}

export interface RunSummary {
  outcome: Outcome;
  delivered: number;
  total: number;
  failedDeliveries: number;
  late: number;
  collisions: number;
  spills: number;
  batteryFailures: number;
  batteryLeft: number;
  score: number;
  ticks: number;
  decisionRequests: number;
  questions: number;
  completionRate: number;
  /** Per request: model compute only (llama-server timings). */
  model: LatencyStats;
  /** Per request: game loop's view (invoke round trip). */
  request: LatencyStats;
  /** Per tick: observe -> decide (all stages) -> policy -> simulate. */
  tick: LatencyStats;
  /** Mean JEB confidence over MOVE decisions. */
  meanMoveConfidence: number | null;
  meanConfidence: number | null;
  decisionsPerSecond: number | null;
  questionsPerSecond: number | null;
  meanInSetMass: number | null;
  tokensEvaluated: number;
  wallMs: number;
}

export function summarize(run: RunRecord): RunSummary {
  const decisions = run.ticks.flatMap((t) => t.decisions);
  const timed = decisions.filter((d) => d.timing);
  const dists = decisions.flatMap((d) => d.dists);
  const moveConf = dists.filter((d) => d.id === "move").map((d) => d.confidence);
  const conf = dists.map((d) => d.confidence);
  const inSet = dists.map((d) => d.inSetMass).filter((x): x is number => x !== null);
  const decidedTicks = run.ticks.filter((t) => t.decisions.length > 0);
  const busyMs = timed.reduce((s, d) => s + d.latencyMs, 0);
  const questions = decisions.reduce((s, d) => s + d.questions.length, 0);
  const last = run.ticks[run.ticks.length - 1];
  return {
    outcome: run.outcome,
    delivered: run.stats.deliveries,
    total: run.packagesTotal,
    failedDeliveries: run.packagesTotal - run.stats.deliveries,
    late: run.stats.late,
    collisions: run.stats.collisions,
    spills: run.stats.spills,
    batteryFailures: run.stats.batteryFailures,
    batteryLeft: last ? last.after.battery : 0,
    score: run.finalScore,
    ticks: run.ticks.length,
    decisionRequests: decisions.length,
    questions,
    completionRate: run.packagesTotal ? run.stats.deliveries / run.packagesTotal : 0,
    model: latencyStats(timed.map((d) => (d.timing as EngineTiming).modelMs)),
    request: latencyStats(timed.map((d) => d.latencyMs)),
    tick: latencyStats(decidedTicks.map((t) => t.endToEndMs)),
    meanMoveConfidence: moveConf.length ? moveConf.reduce((a, b) => a + b, 0) / moveConf.length : null,
    meanConfidence: conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : null,
    decisionsPerSecond: busyMs > 0 ? timed.length / (busyMs / 1000) : null,
    questionsPerSecond: busyMs > 0 ? timed.reduce((s, d) => s + d.questions.length, 0) / (busyMs / 1000) : null,
    meanInSetMass: inSet.length ? inSet.reduce((a, b) => a + b, 0) / inSet.length : null,
    tokensEvaluated: timed.reduce((s, d) => s + (d.timing as EngineTiming).tokensEvaluated, 0),
    wallMs: run.wallMs,
  };
}
