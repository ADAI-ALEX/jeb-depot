/**
 * RULES: a deterministic baseline built from conventional heuristics on the same Observation JEB sees.
 * Shortest-path following, yield to forklifts, avoid spills when it costs nothing, value-per-step target choice
 * with a battery reserve. Its "distributions" are one-hot: it has no probabilities to offer.
 */
import type { Observation } from "../sim/observe";
import type { Action, RelMove } from "../sim/types";
import { PRIORITY_VALUE } from "../sim/types";
import { RISK_LEVELS } from "./questions";
import type { DecisionEngine, DecisionResponse, Distribution, QuestionSpec } from "./types";

/** Battery reserve (percent) the rules keep on top of a job's estimated need. */
const RESERVE_PCT = 5;
/** Longest detour (extra steps) the rules accept instead of waiting for an obstruction to clear. */
const MAX_DETOUR = 6;

function oneHot(q: QuestionSpec, key: string | null): Distribution {
  return {
    id: q.id,
    type: q.type,
    probs: q.options.map((o) => ({ key: o.key, p: o.key === key ? 1 : 0 })),
    confidence: key === null ? 0 : 1,
    inSetMass: null,
    missingLabels: null,
  };
}

export function rulesMove(obs: Observation): { action: Action; why: string } {
  const walk = obs.dirs.filter((d) => !d.blocked);
  const route = obs.dirs.find((d) => d.onRoute) ?? [...walk].filter((d) => d.steps !== null).sort((a, b) => (a.steps as number) - (b.steps as number))[0];
  if (!route) return { action: "WAIT", why: "no route to the target" };
  if (route.forkliftNow || route.forkliftNext) {
    // A forklift that is waiting for us will never move first: yielding would deadlock. Go around.
    if (route.forkliftWaitingForRobot) {
      const free = walk.filter((d) => !d.forkliftNow && !d.forkliftNext);
      const alt = free.find((d) => d.onDetour) ?? [...free].sort((a, b) => (a.steps ?? 999) - (b.steps ?? 999))[0];
      if (alt) return { action: alt.rel, why: `forklift ${route.forkliftNow} is waiting for us: step ${alt.rel.toLowerCase()} to clear its path` };
    }
    return { action: "WAIT", why: `yield: forklift ${route.forkliftNow ?? route.forkliftNext} on the next tile` };
  }
  if (route.spill) {
    const alt = walk.find((d) => d !== route && !d.spill && !d.forkliftNow && !d.forkliftNext && d.steps !== null && d.steps === route.steps);
    if (alt) return { action: alt.rel, why: "equal-length step that avoids the spill" };
  }
  return { action: route.rel, why: "next step of the route" };
}

export function rulesTarget(obs: Observation): { key: string | null; why: string } {
  const opts = obs.targetOptions;
  if (!opts.length) return { key: null, why: "nothing to choose" };
  const charge = opts.find((o) => o.kind === "charge");
  const pct = obs.battery.pct;
  const deliver = opts.find((o) => o.kind === "deliver");
  if (deliver) {
    if (charge && pct < (deliver.needPct ?? 0) + RESERVE_PCT) return { key: charge.key, why: "battery reserve too low for the delivery" };
    return { key: deliver.key, why: "enough battery to deliver" };
  }
  const pkgs = opts.filter((o) => o.kind === "package");
  if (!pkgs.length) return charge ? { key: charge.key, why: "idle: top up the battery" } : { key: "NONE", why: "no work yet" };
  const scored = pkgs
    .map((o) => {
      const urgency = o.deadlineIn === null || o.deadlineIn === undefined ? 1 : o.deadlineIn < (o.totalSteps ?? 0) + 5 ? 0.6 : o.deadlineIn < 60 ? 1.6 : 1.2;
      return { o, value: (PRIORITY_VALUE[o.priority ?? "NORMAL"] * urgency) / ((o.totalSteps ?? 0) + 5) };
    })
    .sort((a, b) => b.value - a.value || a.o.key.localeCompare(b.o.key));
  const affordable = scored.filter((s) => pct >= (s.o.needPct ?? 0) + RESERVE_PCT);
  const best = (affordable[0] ?? scored[0])?.o;
  if (!best) return { key: null, why: "nothing reachable" };
  if (charge && !affordable.length) return { key: charge.key, why: "charge before the next job" };
  return { key: best.key, why: `best affordable value per step (${best.priority}, ${best.totalSteps} steps, ~${best.needPct}%)` };
}

export function rulesRisk(obs: Observation): { level: (typeof RISK_LEVELS)[number]; why: string } {
  const adjacentTraffic = obs.dirs.some((d) => d.forkliftNow || d.forkliftNext);
  const lowBattery = obs.battery.chargerSteps !== null && obs.battery.stepsLeft < obs.battery.chargerSteps + 3;
  if (adjacentTraffic) return { level: "HIGH", why: "forklift in or entering an adjacent tile" };
  if (lowBattery) return { level: "HIGH", why: "battery barely reaches a charger" };
  if (obs.traffic.some((t) => t.distance <= 3) || obs.hazards.some((h) => h.distance <= 1) || obs.battery.pct < 25) return { level: "MEDIUM", why: "traffic, a hazard or low battery nearby" };
  return { level: "LOW", why: "clear surroundings" };
}

export class RuleBasedEngine implements DecisionEngine {
  readonly id = "rules" as const;
  readonly label = "RULES (A* + heuristics)";

  async decide(obs: Observation, _stateText: string, questions: QuestionSpec[]): Promise<DecisionResponse> {
    const res: DecisionResponse = { engine: "rules", dists: {}, timing: null, notes: [] };
    for (const q of questions) {
      if (q.id === "move") {
        const m = rulesMove(obs);
        res.directAction = m.action;
        res.dists.move = oneHot(q, m.action === "WAIT" ? null : (m.action as RelMove));
        res.notes?.push(`move: ${m.why}`);
      } else if (q.id === "risk") {
        const r = rulesRisk(obs);
        res.dists.risk = oneHot(q, r.level);
        res.notes?.push(`risk: ${r.why}`);
      } else if (q.id === "reroute") {
        const take = obs.obstruction?.detourExtra !== null && obs.obstruction?.detourExtra !== undefined && obs.obstruction.detourExtra <= MAX_DETOUR;
        res.directReroute = take;
        res.dists.reroute = oneHot(q, take ? "YES" : "NO");
        res.notes?.push(`reroute: ${take ? "detour is short" : "detour too long, wait"}`);
      } else if (q.id === "target") {
        const t = rulesTarget(obs);
        res.directTarget = t.key ?? undefined;
        res.dists.target = oneHot(q, t.key);
        res.notes?.push(`target: ${t.why}`);
      }
    }
    return res;
  }
}
