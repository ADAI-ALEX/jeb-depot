import { describe, expect, it } from "vitest";
import { chooseMove, expectedRisk, requiredConfidence } from "../src/decision/policies";
import { moveQuestion, riskQuestion, targetQuestion, toSystemOne } from "../src/decision/questions";
import { RuleBasedEngine } from "../src/decision/rulesEngine";
import type { Distribution } from "../src/decision/types";
import { Mission, runToEnd } from "../src/run/mission";
import { summarize } from "../src/run/record";
import { rebuild } from "../src/run/replay";
import { parseMap } from "../src/sim/grid";
import { LEVELS, levelById } from "../src/sim/levels";
import { RouteCache, observe, renderState } from "../src/sim/observe";
import { Rng } from "../src/sim/rng";
import { World } from "../src/sim/world";

const rulesMission = (levelId: number, seed: number) => new Mission({ level: levelById(levelId), seed, engine: new RuleBasedEngine(), policy: "argmax", permutations: 1 });

describe("levels", () => {
  for (const level of LEVELS) {
    it(`${level.name}: every bay, dock and charger is reachable from the start`, () => {
      const w = new World(level, 1);
      const field = w.grid.distanceField(w.robot.pos);
      const reach = (p: { x: number; y: number }) => (field[w.grid.idx(p)] ?? -1) >= 0;
      for (const p of w.bays.values()) expect(reach(p)).toBe(true);
      for (const p of w.docks.values()) expect(reach(p)).toBe(true);
      for (const p of w.chargers) expect(reach(p)).toBe(true);
      const parsed = parseMap(level.map);
      expect(parsed.w).toBe(20);
      expect(parsed.h).toBe(11);
    });

    it(`${level.name}: forklifts keep moving (no deadlock) for 2000 ticks`, () => {
      const w = new World(level, 3);
      const moves = new Map(w.forklifts.map((f) => [f.id, 0]));
      // Park the robot on its start tile; only forklifts act.
      for (let i = 0; i < 2000 && w.outcome === "running"; i++) {
        const before = w.forklifts.map((f) => ({ ...f.pos }));
        w.step("WAIT");
        w.forklifts.forEach((f, k) => {
          const b = before[k] as { x: number; y: number };
          if (b.x !== f.pos.x || b.y !== f.pos.y) moves.set(f.id, (moves.get(f.id) ?? 0) + 1);
        });
      }
      for (const f of w.forklifts) expect(moves.get(f.id)).toBeGreaterThan(20);
    });
  }
});

describe("world rules", () => {
  it("bumping into shelving is a collision and the robot stays put", () => {
    const w = new World(levelById(1), 1);
    w.robot.pos = { x: 3, y: 1 };
    w.robot.heading = "S"; // (3,2) is shelving
    const { events } = w.step("FORWARD");
    expect(events.some((e) => e.kind === "collision_static")).toBe(true);
    expect(w.robot.pos).toEqual({ x: 3, y: 1 });
    expect(w.stats.collisions).toBe(1);
  });

  it("moving into the tile a forklift enters is a forklift collision", () => {
    const w = new World(levelById(1), 1);
    const f = w.forklifts[0]!;
    // Put the robot next to the forklift's next tile, facing it, on a tick where the forklift moves.
    while (!w.forkliftActive(f)) w.step("WAIT");
    const next = f.path[(f.index + 1) % f.path.length]!;
    const candidates = (["N", "E", "S", "W"] as const).map((d) => ({ d, from: w.grid.step(next, d) }));
    const spot = candidates.find(({ from }) => w.grid.walkable(from) && !(from.x === f.pos.x && from.y === f.pos.y));
    expect(spot).toBeTruthy();
    w.robot.pos = spot!.from;
    const back = { N: "S", S: "N", E: "W", W: "E" } as const;
    w.robot.heading = back[spot!.d];
    const { events } = w.step("FORWARD");
    expect(events.some((e) => e.kind === "collision_forklift")).toBe(true);
  });

  it("different seeds deal different missions; the same seed deals the same one", () => {
    const a = new World(levelById(2), 1).snapshot();
    const b = new World(levelById(2), 1).snapshot();
    const c = new World(levelById(2), 2).snapshot();
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(c));
  });
});

describe("observation", () => {
  it("renders a compact state with every direction, traffic, battery and mission lines", () => {
    const w = new World(levelById(1), 1);
    w.setTarget({ kind: "package", id: "1" });
    const obs = observe(w, new RouteCache(w));
    const text = renderState(obs);
    for (const k of ["ROBOT:", "TARGET:", "FORWARD (", "LEFT (", "RIGHT (", "REVERSE (", "TRAFFIC:", "HAZARDS:", "BATTERY:", "MISSION:"]) expect(text).toContain(k);
    expect(obs.dirs.filter((d) => d.onRoute).length).toBe(1);
    expect(text.split("\n").length).toBeLessThanOrEqual(12);
  });

  it("target options appear only when there is a real choice", () => {
    const w = new World(levelById(1), 1);
    const obs = observe(w, new RouteCache(w));
    const q = targetQuestion(obs);
    expect(q).not.toBeNull();
    expect(q!.options.length).toBeGreaterThanOrEqual(2);
    expect(toSystemOne(q!)).toMatchObject({ type: "choice" });
    expect(toSystemOne(riskQuestion())).toMatchObject({ type: "score", criteria: expect.any(Array) });
    expect(Object.keys((toSystemOne(moveQuestion()) as { criteria: object }).criteria)).toEqual(["LEFT", "FORWARD", "RIGHT", "REVERSE"]);
  });
});

describe("rules baseline", () => {
  it("completes the training depot on several seeds", async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const run = await runToEnd(rulesMission(1, seed));
      const s = summarize(run);
      expect(s.outcome, `seed ${seed}`).toBe("complete");
      expect(s.delivered).toBe(s.total);
    }
  });

  it("is deterministic: same level and seed give the identical run", async () => {
    for (const level of [1, 2, 3, 4]) {
      const a = await runToEnd(rulesMission(level, 7));
      const b = await runToEnd(rulesMission(level, 7));
      expect(a.ticks.map((t) => t.action)).toEqual(b.ticks.map((t) => t.action));
      expect(a.finalScore).toBe(b.finalScore);
    }
  });

  it("replays verify tick for tick", async () => {
    for (const level of [1, 2, 3, 4]) {
      const run = await runToEnd(rulesMission(level, 11));
      const rb = rebuild(run);
      expect(rb.mismatches).toEqual([]);
      expect(rb.verified).toBe(run.ticks.length);
      expect(rb.frames.length).toBe(run.ticks.length + 1);
    }
  });
});

describe("policies", () => {
  const dist = (id: "move" | "risk", probs: [string, number][]): Distribution => ({ id, type: id === "move" ? "choice" : "score", probs: probs.map(([key, p]) => ({ key, p })), confidence: 0, inSetMass: 1, missingLabels: 0 });
  const move = dist("move", [["LEFT", 0.1], ["FORWARD", 0.45], ["RIGHT", 0.4], ["REVERSE", 0.05]]);
  const calm = dist("risk", [["LOW", 1], ["MEDIUM", 0], ["HIGH", 0]]);
  const scary = dist("risk", [["LOW", 0], ["MEDIUM", 0.2], ["HIGH", 0.8]]);

  it("argmax takes the top option", () => {
    expect(chooseMove("argmax", move, calm, { rng: new Rng(1), heldInARow: 0 }).action).toBe("FORWARD");
  });

  it("risk-aware holds when confidence is below what the reported risk demands, at most twice", () => {
    expect(expectedRisk(scary)).toBeCloseTo(0.9);
    expect(requiredConfidence(expectedRisk(scary))).toBeGreaterThan(0.45);
    expect(chooseMove("risk", move, calm, { rng: new Rng(1), heldInARow: 0 }).action).toBe("FORWARD");
    expect(chooseMove("risk", move, scary, { rng: new Rng(1), heldInARow: 0 }).action).toBe("WAIT");
    expect(chooseMove("risk", move, scary, { rng: new Rng(1), heldInARow: 2 }).action).toBe("FORWARD");
  });

  it("sampling follows the distribution and is reproducible from the seed", () => {
    const draw = (seed: number) => {
      const rng = new Rng(seed);
      return Array.from({ length: 2000 }, () => chooseMove("sample", move, calm, { rng, heldInARow: 0 }).action);
    };
    const a = draw(5);
    expect(a).toEqual(draw(5));
    const share = a.filter((x) => x === "RIGHT").length / a.length;
    expect(share).toBeGreaterThan(0.35);
    expect(share).toBeLessThan(0.45);
  });
});
