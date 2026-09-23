/**
 * Decision policies: how the controller turns JEB's distributions into the action the software executes.
 *
 *   ARGMAX      take the most probable option of every question
 *   SAMPLE      draw every decision from its distribution (seeded, so runs still reproduce)
 *   RISK-AWARE  act only when the move is confident enough for the risk JEB itself reports; otherwise hold
 *               position for a tick (at most twice in a row). Detours are accepted more readily when risky.
 *
 * The risk-aware policy is where calibration matters: a threshold on a probability only means something if
 * the probability is honest.
 */
import type { Rng } from "../sim/rng";
import type { Action, RelMove } from "../sim/types";
import type { Distribution } from "./types";
import { argmaxKey, probOf } from "./types";

export type PolicyId = "argmax" | "sample" | "risk";

export const POLICIES: { id: PolicyId; label: string; short: string; blurb: string }[] = [
  { id: "argmax", label: "ARGMAX", short: "A", blurb: "Take the most probable option." },
  { id: "sample", label: "SAMPLE", short: "B", blurb: "Draw from the distribution (seeded)." },
  { id: "risk", label: "RISK-AWARE", short: "C", blurb: "Act when confident for the risk; else hold." },
];

export interface PolicyContext {
  rng: Rng;
  /** Consecutive ticks this policy already held position. */
  heldInARow: number;
}

export interface MoveChoice {
  action: Action;
  note: string;
  /** Probability of the executed option (null for a hold). */
  p: number | null;
}

/** Expected risk in [0, 1] from a LOW / MEDIUM / HIGH distribution. */
export function expectedRisk(risk: Distribution | undefined): number {
  if (!risk) return 0;
  return (probOf(risk, "MEDIUM") * 1 + probOf(risk, "HIGH") * 2) / 2;
}

/** Confidence the risk-aware policy requires before moving, given expected risk e in [0, 1]. */
export function requiredConfidence(e: number): number {
  return 0.4 + 0.35 * e;
}

function sampleKey(d: Distribution, rng: Rng): string {
  return (d.probs[rng.weighted(d.probs.map((x) => x.p))] as { key: string }).key;
}

export function chooseMove(policy: PolicyId, move: Distribution, risk: Distribution | undefined, ctx: PolicyContext): MoveChoice {
  const top = argmaxKey(move) as RelMove;
  const pTop = probOf(move, top);
  if (policy === "sample") {
    const k = sampleKey(move, ctx.rng) as RelMove;
    return { action: k, note: `sampled ${k} (p=${probOf(move, k).toFixed(2)})`, p: probOf(move, k) };
  }
  if (policy === "risk") {
    const e = expectedRisk(risk);
    const need = requiredConfidence(e);
    if (pTop < need && ctx.heldInARow < 2) {
      return { action: "WAIT", note: `hold: ${top} ${(pTop * 100).toFixed(0)}% < ${(need * 100).toFixed(0)}% needed at risk ${e.toFixed(2)}`, p: null };
    }
    return { action: top, note: pTop < need ? `${top} after holding twice` : `${top} ${(pTop * 100).toFixed(0)}% >= ${(need * 100).toFixed(0)}%`, p: pTop };
  }
  return { action: top, note: `argmax ${top}`, p: pTop };
}

export function chooseKey(policy: PolicyId, d: Distribution, ctx: PolicyContext): { key: string; note: string } {
  if (policy === "sample") {
    const k = sampleKey(d, ctx.rng);
    return { key: k, note: `sampled ${k} (p=${probOf(d, k).toFixed(2)})` };
  }
  const k = argmaxKey(d);
  return { key: k, note: `argmax ${k}` };
}

export function chooseReroute(policy: PolicyId, d: Distribution, risk: Distribution | undefined, ctx: PolicyContext): { take: boolean; note: string } {
  const pYes = probOf(d, "YES");
  if (policy === "sample") {
    const take = ctx.rng.next() < pYes;
    return { take, note: `sampled ${take ? "YES" : "NO"} (P(yes)=${pYes.toFixed(2)})` };
  }
  if (policy === "risk") {
    const threshold = 0.5 - 0.2 * expectedRisk(risk);
    return { take: pYes >= threshold, note: `P(yes)=${pYes.toFixed(2)} vs ${threshold.toFixed(2)}` };
  }
  return { take: pYes >= 0.5, note: `P(yes)=${pYes.toFixed(2)}` };
}
