/**
 * Replays are re-simulations: the recorded actions and objective changes are fed back into a fresh World with
 * the same level and seed, and every tick is checked against the recorded outcome. The recorded probabilities
 * are shown as they were — nothing is re-queried.
 */
import { levelById } from "../sim/levels";
import { World, type WorldSnapshot } from "../sim/world";
import type { FullTickRecord } from "./mission";
import type { RunRecord } from "./record";

export interface ReplayFrames {
  /** frames[i] = world before tick i; frames[ticks.length] = final state. */
  frames: WorldSnapshot[];
  verified: number;
  mismatches: { tick: number; field: string; recorded: unknown; replayed: unknown }[];
}

export function rebuild(run: RunRecord): ReplayFrames {
  const level = levelById(run.meta.levelId);
  const w = new World(level, run.meta.seed, { manual: run.meta.engine === "manual" });
  const frames: WorldSnapshot[] = [w.snapshot()];
  const mismatches: ReplayFrames["mismatches"] = [];
  let verified = 0;
  for (const t of run.ticks as FullTickRecord[]) {
    if (t.pre) {
      w.robot.target = t.pre.target ? structuredClone(t.pre.target) : null;
      w.robot.routeMode = t.pre.routeMode;
    }
    if (w.tick !== t.tick) mismatches.push({ tick: t.tick, field: "tick", recorded: t.tick, replayed: w.tick });
    w.step(t.action);
    const a = t.after;
    const ok = w.robot.pos.x === a.pos.x && w.robot.pos.y === a.pos.y && w.robot.heading === a.heading && Math.abs(w.robot.battery - a.battery) < 1e-9 && w.score === a.score && w.robot.carrying === a.carrying;
    if (ok) verified++;
    else mismatches.push({ tick: t.tick, field: "after", recorded: a, replayed: { pos: w.robot.pos, heading: w.robot.heading, battery: w.robot.battery, score: w.score, carrying: w.robot.carrying } });
    frames.push(w.snapshot());
  }
  return { frames, verified, mismatches };
}
