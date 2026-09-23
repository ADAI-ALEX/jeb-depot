import type { Observation } from "../sim/observe";
import type { Action } from "../sim/types";

export type QuestionId = "move" | "risk" | "reroute" | "target";
export type QuestionType = "choice" | "score" | "noul";

export interface QuestionOption {
  key: string;
  description: string | null;
}

/** One typed question, engine-agnostic. JEB receives it as a System One question; the rules engine reads the id. */
export interface QuestionSpec {
  id: QuestionId;
  type: QuestionType;
  instructions: string;
  /** choice: options; score: ordered levels, lowest first (key = level name); noul: [YES, NO]. */
  options: QuestionOption[];
  noulCriteria?: { true: string; false: string };
}

export interface Distribution {
  id: QuestionId;
  type: QuestionType;
  /** In option order (score: level order; noul: YES then NO). Sums to 1. */
  probs: { key: string; p: number }[];
  /** JEB's confidence definition per primitive (choice: rescaled peak; score: concentration; noul: |2p-1|). */
  confidence: number;
  /** Share of probability the label tokens held before renormalising (JEB only). */
  inSetMass: number | null;
  missingLabels: number | null;
}

export interface EngineCall {
  what: string;
  promptN: number;
  cacheN: number;
  modelMs: number;
  wallMs: number;
}

export interface EngineTiming {
  /** llama-server's own compute time for all calls of the request: pure model inference. */
  modelMs: number;
  /** HTTP round trips to llama-server (model + transport + JSON). */
  engineWallMs: number;
  /** Rust side end to end: validation, tokenization, engine, answer assembly. */
  backendMs: number;
  /** Seen from the game: invoke() round trip (backend + IPC + serialisation). */
  clientMs: number;
  tokensEvaluated: number;
  tokensReused: number;
  prompts: number;
  prefixTokens: number;
  calls: EngineCall[];
}

export interface DecisionResponse {
  engine: EngineId;
  dists: Partial<Record<QuestionId, Distribution>>;
  timing: EngineTiming | null;
  /** Rules may hold position; JEB never answers with an action outside the question's options. */
  directAction?: Action;
  directTarget?: string;
  directReroute?: boolean;
  /** Human-readable reasons (rules engine). */
  notes?: string[];
}

export type EngineId = "jeb" | "rules";

/**
 * Anything that can answer the simulator's typed questions. The simulator never knows which one it talks to,
 * so another model can be added by implementing this interface.
 */
export interface DecisionEngine {
  readonly id: EngineId;
  readonly label: string;
  decide(obs: Observation, stateText: string, questions: QuestionSpec[]): Promise<DecisionResponse>;
}

export class EngineUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineUnavailableError";
  }
}

export function argmaxKey(d: Distribution): string {
  let best = d.probs[0] as { key: string; p: number };
  for (const x of d.probs) if (x.p > best.p) best = x;
  return best.key;
}

export function probOf(d: Distribution | undefined, key: string): number {
  return d?.probs.find((x) => x.key === key)?.p ?? 0;
}
