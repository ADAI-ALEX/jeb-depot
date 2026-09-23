/**
 * Benchmarks, measured on the machine they run on (nothing here is precomputed):
 *   inference     repeated real JEB requests on fixed, seeded game states (model time vs end-to-end time)
 *   gameplay      JEB and RULES on identical seeded missions
 *   reproducible  the same JEB mission twice, compared action by action and probability by probability
 */
import type { JEBEngine } from "../decision/jebEngine";
import type { PolicyId } from "../decision/policies";
import { moveQuestion, riskQuestion } from "../decision/questions";
import { RuleBasedEngine } from "../decision/rulesEngine";
import type { DecisionEngine } from "../decision/types";
import { levelById } from "../sim/levels";
import { observe, renderState, type Observation } from "../sim/observe";
import { Mission, runToEnd } from "./mission";
import { latencyStats, summarize, type LatencyStats, type RunRecord, type RunSummary } from "./record";

export interface ResourceProbe {
  sample(): Promise<{ t: number; inference: { residentBytes: number; footprintBytes: number; cpuSeconds: number } | null; gpu: { utilizationPct: number | null } }>;
}

export interface InferenceReport {
  n: number;
  questionsPerRequest: number;
  model: LatencyStats;
  endToEnd: LatencyStats;
  backend: LatencyStats;
  requestsPerSecond: number;
  questionsPerSecond: number;
  tokensPerRequest: number;
  promptTokensPerSecond: number;
  peakResidentBytes: number | null;
  peakFootprintBytes: number | null;
  cpuUtilizationPct: number | null;
  gpuUtilizationPct: number | null;
  samples: number;
  wallMs: number;
}

/** Deterministic benchmark states: observations along a RULES rollout of level 2, seed 1. */
export async function benchmarkStates(n: number): Promise<{ obs: Observation; text: string }[]> {
  const m = new Mission({ level: levelById(2), seed: 1, engine: new RuleBasedEngine(), policy: "argmax", permutations: 1 });
  const out: { obs: Observation; text: string }[] = [];
  while (!m.done && out.length < n) {
    if (m.world.robot.target) {
      const obs = observe(m.world, m.routes);
      out.push({ obs, text: renderState(obs) });
    }
    await m.stepAuto();
  }
  return out;
}

export async function inferenceBenchmark(engine: JEBEngine, probe: ResourceProbe | null, n: number, onProgress: (i: number) => void, signal?: AbortSignal): Promise<InferenceReport> {
  const states = await benchmarkStates(n);
  const qs = [moveQuestion(), riskQuestion()];
  const model: number[] = [];
  const e2e: number[] = [];
  const backend: number[] = [];
  let tokens = 0;
  const samples: Awaited<ReturnType<ResourceProbe["sample"]>>[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling && probe) {
      try {
        samples.push(await probe.sample());
      } catch {
        /* sampling is best effort */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  })();
  const t0 = performance.now();
  try {
    for (let i = 0; i < states.length; i++) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const s = states[i] as { obs: Observation; text: string };
      const res = await engine.decide(s.obs, s.text, qs);
      const t = res.timing;
      if (t) {
        model.push(t.modelMs);
        e2e.push(t.clientMs);
        backend.push(t.backendMs);
        tokens += t.tokensEvaluated;
      }
      onProgress(i + 1);
    }
  } finally {
    sampling = false;
    await sampler;
  }
  const wall = performance.now() - t0;
  const withInf = samples.filter((s) => s.inference);
  const first = withInf[0];
  const last = withInf[withInf.length - 1];
  const cpu = first && last && last.t > first.t ? (((last.inference?.cpuSeconds ?? 0) - (first.inference?.cpuSeconds ?? 0)) / ((last.t - first.t) / 1000)) * 100 : null;
  const gpus = samples.map((s) => s.gpu.utilizationPct).filter((v): v is number => v !== null);
  const busy = e2e.reduce((a, b) => a + b, 0);
  return {
    n: e2e.length,
    questionsPerRequest: qs.length,
    model: latencyStats(model),
    endToEnd: latencyStats(e2e),
    backend: latencyStats(backend),
    requestsPerSecond: e2e.length / (busy / 1000),
    questionsPerSecond: (e2e.length * qs.length) / (busy / 1000),
    tokensPerRequest: e2e.length ? tokens / e2e.length : 0,
    promptTokensPerSecond: tokens / (model.reduce((a, b) => a + b, 0) / 1000),
    peakResidentBytes: withInf.length ? Math.max(...withInf.map((s) => s.inference?.residentBytes ?? 0)) : null,
    peakFootprintBytes: withInf.length ? Math.max(...withInf.map((s) => s.inference?.footprintBytes ?? 0)) : null,
    cpuUtilizationPct: cpu,
    gpuUtilizationPct: gpus.length ? gpus.reduce((a, b) => a + b, 0) / gpus.length : null,
    samples: samples.length,
    wallMs: wall,
  };
}

export interface GameplayRow {
  levelId: number;
  seed: number;
  controller: "jeb" | "rules";
  policy: PolicyId | "rules";
  summary: RunSummary;
  runId: string;
}

export async function gameplayBenchmark(
  jeb: JEBEngine,
  opts: { levels: number[]; seeds: number[]; policy: PolicyId; model: string; runtime: string; permutations: number },
  onRun: (row: GameplayRow, run: RunRecord, done: number, total: number) => Promise<void> | void,
  onTick: (label: string, tick: number) => void,
  signal?: AbortSignal,
): Promise<GameplayRow[]> {
  const rows: GameplayRow[] = [];
  const total = opts.levels.length * opts.seeds.length * 2;
  for (const levelId of opts.levels)
    for (const seed of opts.seeds)
      for (const controller of ["rules", "jeb"] as const) {
        const engine: DecisionEngine = controller === "jeb" ? jeb : new RuleBasedEngine();
        const m = new Mission({ level: levelById(levelId), seed, engine, policy: opts.policy, permutations: opts.permutations, model: controller === "jeb" ? opts.model : null, runtime: controller === "jeb" ? opts.runtime : null });
        const label = `L${levelId} S${seed} ${controller.toUpperCase()}`;
        const run = await runToEnd(m, (t) => onTick(label, t.tick), signal);
        const row: GameplayRow = { levelId, seed, controller, policy: controller === "jeb" ? opts.policy : "rules", summary: summarize(run), runId: run.meta.id };
        rows.push(row);
        await onRun(row, run, rows.length, total);
      }
  return rows;
}

export interface ReproReport {
  levelId: number;
  seed: number;
  policy: PolicyId;
  ticksA: number;
  ticksB: number;
  actionsIdentical: boolean;
  firstDivergence: number | null;
  maxProbDelta: number;
  scoreA: number;
  scoreB: number;
  runIds: [string, string];
}

export async function reproducibility(jeb: JEBEngine, levelId: number, seed: number, policy: PolicyId, permutations: number, onTick: (label: string, tick: number) => void, signal?: AbortSignal): Promise<{ report: ReproReport; runs: [RunRecord, RunRecord] }> {
  const go = async (label: string): Promise<RunRecord> =>
    runToEnd(new Mission({ level: levelById(levelId), seed, engine: jeb, policy, permutations, model: "JEB-4B", runtime: "llama.cpp" }), (t) => onTick(label, t.tick), signal);
  const a = await go("RUN A");
  const b = await go("RUN B");
  let first: number | null = null;
  let maxDelta = 0;
  const n = Math.min(a.ticks.length, b.ticks.length);
  for (let i = 0; i < n; i++) {
    const ta = a.ticks[i];
    const tb = b.ticks[i];
    if (!ta || !tb) break;
    if (first === null && ta.action !== tb.action) first = ta.tick;
    ta.decisions.forEach((da, k) => {
      const db = tb.decisions[k];
      if (!db) return;
      da.dists.forEach((d, j) => {
        const e = db.dists[j];
        if (!e) return;
        d.probs.forEach((p, q) => (maxDelta = Math.max(maxDelta, Math.abs(p.p - (e.probs[q]?.p ?? 0)))));
      });
    });
  }
  if (first === null && a.ticks.length !== b.ticks.length) first = n;
  return {
    report: { levelId, seed, policy, ticksA: a.ticks.length, ticksB: b.ticks.length, actionsIdentical: first === null, firstDivergence: first, maxProbDelta: maxDelta, scoreA: a.finalScore, scoreB: b.finalScore, runIds: [a.meta.id, b.meta.id] },
    runs: [a, b],
  };
}
