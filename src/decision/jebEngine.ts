/**
 * JEB: every question goes to the local JEB-4B through the System One protocol; the distributions shown in the
 * HUD and recorded in replays are the model's own (full precision, from the backend's telemetry).
 */
import type { Observation } from "../sim/observe";
import { toSystemOne } from "./questions";
import type { DecisionEngine, DecisionResponse, Distribution, EngineTiming, QuestionSpec } from "./types";
import { EngineUnavailableError } from "./types";

/** Shape of jeb-core's `DecideOutput` (System One response + telemetry extension). */
export interface JebWireResult {
  model: string;
  answers: Record<string, Record<string, unknown>>;
  usage: { input_tokens: number; output_tokens: number };
  telemetry: {
    engine: {
      calls: { what: string; prompt_n: number; cache_n: number; model_ms: number; wall_ms: number }[];
      model_ms: number;
      wall_ms: number;
      tokens_evaluated: number;
      tokens_reused: number;
    };
    prepare_ms: number;
    total_ms: number;
    prompts: number;
    prefix_tokens: number;
    permutations: number;
    scheduling: string;
    questions: [string, { kind: string; probabilities: [string, number][]; confidence: number; in_set_mass: number; missing_labels: number }][];
  };
}

export interface JebTransport {
  readonly name: string;
  decide(body: Record<string, unknown>): Promise<JebWireResult>;
}

export interface JebEngineOptions {
  /** Option orderings averaged per choice/score question (JEB's presentation averaging). */
  permutations: number;
}

export class JEBEngine implements DecisionEngine {
  readonly id = "jeb" as const;
  readonly label = "JEB-4B (local)";
  /** The last System One request sent, for the debug view. */
  lastRequest: Record<string, unknown> | null = null;

  constructor(
    private transport: JebTransport,
    public options: JebEngineOptions = { permutations: 1 },
  ) {}

  async decide(_obs: Observation, stateText: string, questions: QuestionSpec[]): Promise<DecisionResponse> {
    const body = {
      model: "jeb-4b",
      state: stateText,
      questions: Object.fromEntries(questions.map((q) => [q.id, toSystemOne(q)])),
      options: { permutations: this.options.permutations },
    };
    this.lastRequest = body;
    const t0 = performance.now();
    let res: JebWireResult;
    try {
      res = await this.transport.decide(body);
    } catch (e) {
      throw new EngineUnavailableError(e instanceof Error ? e.message : String(e));
    }
    const clientMs = performance.now() - t0;
    const details = new Map(res.telemetry.questions);
    const dists: DecisionResponse["dists"] = {};
    for (const q of questions) {
      const det = details.get(q.id);
      if (!det) throw new Error(`JEB returned no answer for question ${q.id}`);
      dists[q.id] = toDistribution(q, det);
    }
    const t = res.telemetry;
    const timing: EngineTiming = {
      modelMs: t.engine.model_ms,
      engineWallMs: t.engine.wall_ms,
      backendMs: t.total_ms,
      clientMs,
      tokensEvaluated: t.engine.tokens_evaluated,
      tokensReused: t.engine.tokens_reused,
      prompts: t.prompts,
      prefixTokens: t.prefix_tokens,
      calls: t.engine.calls.map((c) => ({ what: c.what, promptN: c.prompt_n, cacheN: c.cache_n, modelMs: c.model_ms, wallMs: c.wall_ms })),
    };
    return { engine: "jeb", dists, timing };
  }
}

function toDistribution(q: QuestionSpec, det: JebWireResult["telemetry"]["questions"][number][1]): Distribution {
  const by = new Map(det.probabilities);
  let probs: { key: string; p: number }[];
  if (q.type === "noul") probs = [{ key: "YES", p: by.get("yes") ?? 0 }, { key: "NO", p: by.get("no") ?? 0 }];
  else if (q.type === "score") probs = q.options.map((o, i) => ({ key: o.key, p: by.get(String(i)) ?? 0 }));
  else probs = q.options.map((o) => ({ key: o.key, p: by.get(o.key) ?? 0 }));
  return { id: q.id, type: q.type, probs, confidence: det.confidence, inSetMass: det.in_set_mass, missingLabels: det.missing_labels };
}
