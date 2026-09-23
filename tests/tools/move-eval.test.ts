/**
 * Design check for the MOVE question (JEB_LIVE=1): how often is JEB's top answer an acceptable move, per prompt
 * variant? States are sampled from rules-driven runs on the harder levels, balanced across situations.
 * Acceptable = does not collide, and is a shortest step when the route tile is safe (any safe step otherwise).
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, it } from "vitest";
import { JEBEngine } from "../../src/decision/jebEngine";
import { moveQuestion } from "../../src/decision/questions";
import { RuleBasedEngine } from "../../src/decision/rulesEngine";
import type { QuestionSpec } from "../../src/decision/types";
import { argmaxKey } from "../../src/decision/types";
import { Mission } from "../../src/run/mission";
import { levelById } from "../../src/sim/levels";
import { observe, renderState, type Observation } from "../../src/sim/observe";
import { Rng } from "../../src/sim/rng";
import { JebdProcess, ROOT } from "../support/jebd";

type Bucket = "clear" | "turn" | "traffic" | "spill";

function bucket(o: Observation): Bucket | null {
  const route = o.dirs.find((d) => d.onRoute);
  if (!route) return null;
  if (o.dirs.some((d) => d.forkliftNow || d.forkliftNext)) return "traffic";
  if (o.dirs.some((d) => d.spill)) return "spill";
  if (route.rel !== "FORWARD") return "turn";
  return "clear";
}

export function acceptable(o: Observation, move: string): boolean {
  // Collision iff static obstacle or a forklift occupies the tile after the tick (the world's rule).
  const d = o.dirs.find((x) => x.rel === move);
  if (!d || d.blocked || d.forkliftNext) return false;
  const route = o.dirs.find((x) => x.onRoute);
  const routeSafe = route && !route.forkliftNext;
  if (!routeSafe) return true;
  const best = Math.min(...o.dirs.filter((x) => !x.blocked && x.steps !== null).map((x) => x.steps as number));
  return d.steps !== null && d.steps <= best;
}

async function sample(): Promise<{ obs: Observation; b: Bucket }[]> {
  const want: Record<Bucket, number> = { clear: 15, turn: 15, traffic: 20, spill: 10 };
  const got: { obs: Observation; b: Bucket }[] = [];
  const rng = new Rng(99);
  for (const level of [2, 3, 4])
    for (const seed of [1, 2, 3]) {
      const m = new Mission({ level: levelById(level), seed, engine: new RuleBasedEngine(), policy: "argmax", permutations: 1 });
      while (!m.done) {
        if (m.world.robot.target && rng.next() < 0.5) {
          const o = observe(m.world, m.routes);
          const b = bucket(o);
          if (b && got.filter((g) => g.b === b).length < want[b]) got.push({ obs: o, b });
        }
        await m.stepAuto();
      }
    }
  return got;
}

const rubric = (o: Observation): QuestionSpec => ({
  ...moveQuestion(),
  instructions: "Which way should the robot move this tick?",
  options: moveQuestion().options.map((opt) => ({ key: opt.key, description: o.dirs.find((d) => d.rel === opt.key)?.text ?? null })),
});
const VARIANTS: Record<string, { make: (o: Observation) => QuestionSpec; permutations: number }> = {
  long_bare: { make: () => moveQuestion(), permutations: 1 },
  short_rubric: { make: rubric, permutations: 1 },
  short_rubric_p2: { make: rubric, permutations: 2 },
  long_bare_p2: { make: () => moveQuestion(), permutations: 2 },
};

let jebd: JebdProcess;
beforeAll(async () => {
  if (!process.env.JEB_LIVE) return;
  jebd = JebdProcess.serve();
  await jebd.ready;
}, 300_000);
afterAll(async () => jebd?.close());

it.runIf(process.env.JEB_LIVE)("move prompt variants", async () => {
  const states = await sample();
  const engine = new JEBEngine(jebd, { permutations: 1 });
  const report: Record<string, unknown> = { states: states.length, byBucket: Object.fromEntries(["clear", "turn", "traffic", "spill"].map((b) => [b, states.filter((s) => s.b === b).length])) };
  for (const [name, { make, permutations }] of Object.entries(VARIANTS)) {
    let ok = 0;
    let ms = 0;
    const per: Record<string, [number, number]> = {};
    engine.options.permutations = permutations;
    for (const { obs, b } of states) {
      const res = await engine.decide(obs, renderState(obs), [make(obs)]);
      const top = argmaxKey(res.dists.move!);
      const good = acceptable(obs, top);
      ok += good ? 1 : 0;
      ms += res.timing!.modelMs;
      per[b] = [(per[b]?.[0] ?? 0) + (good ? 1 : 0), (per[b]?.[1] ?? 0) + 1];
    }
    report[name] = { acceptable: `${ok}/${states.length}`, rate: ok / states.length, meanModelMs: Math.round(ms / states.length), perBucket: per };
    console.log(name, JSON.stringify(report[name]));
  }
  writeFileSync(path.join(ROOT, "docs/benchmarks/move-prompt-eval.json"), JSON.stringify(report, null, 1));
}, 3_600_000);
