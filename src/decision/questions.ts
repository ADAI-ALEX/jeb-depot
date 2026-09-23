/**
 * Which typed questions to ask, and when. Questions are only asked when they are meaningful:
 *   TARGET  (choice) at decision points with at least two real options
 *   REROUTE (noul)   when the planned route is obstructed and a clear detour exists
 *   MOVE    (choice) every tick the robot is travelling
 *   RISK    (score)  with every MOVE (the risk-aware policy reads it)
 */
import type { Observation } from "../sim/observe";
import { REL_MOVES } from "../sim/types";
import type { QuestionSpec } from "./types";

export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;

export function moveQuestion(): QuestionSpec {
  return {
    id: "move",
    type: "choice",
    instructions:
      "Which way should the robot move this tick? It should follow the route to its target, but moving into a blocked tile or a forklift is a collision and spills cost battery.",
    options: REL_MOVES.map((m) => ({ key: m, description: null })),
  };
}

export function riskQuestion(): QuestionSpec {
  return {
    id: "risk",
    type: "score",
    instructions: "How risky is the robot's situation for the next few ticks (collision, skid, battery)?",
    options: [
      { key: "LOW", description: "LOW: nothing nearby threatens a collision or a failure" },
      { key: "MEDIUM", description: "MEDIUM: traffic or a hazard is close" },
      { key: "HIGH", description: "HIGH: a collision, a skid or a battery failure is likely" },
    ],
  };
}

export function rerouteQuestion(obs: Observation): QuestionSpec | null {
  const o = obs.obstruction;
  if (!o || o.detourExtra === null || obs.target?.routeMode !== "primary") return null;
  return {
    id: "reroute",
    type: "noul",
    instructions: `${o.what[0]?.toUpperCase()}${o.what.slice(1)} is in the way ${o.distance} tile${o.distance === 1 ? "" : "s"} along the planned route. A clear detour is ${o.detourExtra} step${o.detourExtra === 1 ? "" : "s"} longer. Should the robot switch to the detour?`,
    options: [
      { key: "YES", description: null },
      { key: "NO", description: null },
    ],
    noulCriteria: { true: "switch to the detour route", false: "keep the planned route" },
  };
}

export function targetQuestion(obs: Observation): QuestionSpec | null {
  if (obs.targetOptions.length < 2) return null;
  return {
    id: "target",
    type: "choice",
    instructions: obs.robot.carrying
      ? "The battery is getting low for this delivery. Should the robot carry on to the dock or charge first?"
      : "Which objective should the robot pursue next? Weigh priority, distance, deadlines and battery.",
    options: obs.targetOptions.map((o) => ({ key: o.key, description: o.description })),
  };
}

/** System One question JSON for one spec (the wire format JEB receives). */
export function toSystemOne(q: QuestionSpec): Record<string, unknown> {
  if (q.type === "noul") {
    return { type: "noul", instructions: q.instructions, ...(q.noulCriteria ? { criteria: q.noulCriteria } : {}) };
  }
  if (q.type === "score") {
    return { type: "score", instructions: q.instructions, criteria: q.options.map((o) => o.description ?? o.key) };
  }
  return { type: "choice", instructions: q.instructions, criteria: Object.fromEntries(q.options.map((o) => [o.key, o.description])) };
}
