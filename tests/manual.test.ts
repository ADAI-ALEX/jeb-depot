/** Manual mode: keyboard actions drive the same world; driving onto a package grabs it, its dock delivers it. */
import { describe, expect, it } from "vitest";
import { Mission } from "../src/run/mission";
import { rebuild } from "../src/run/replay";
import { levelById } from "../src/sim/levels";
import type { Action, Dir, Vec } from "../src/sim/types";
import { turn } from "../src/sim/types";

/** Absolute direction -> the relative move the robot needs (what SimController.drive does for a key press). */
function key(m: Mission, dir: Dir): Action {
  const h = m.world.robot.heading;
  return (["FORWARD", "RIGHT", "REVERSE", "LEFT"] as const).find((a) => turn(h, a) === dir) ?? "FORWARD";
}

function driveTo(m: Mission, goal: Vec): void {
  const path = m.world.grid.path(m.world.robot.pos, goal);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as Vec;
    const b = path[i] as Vec;
    const dir: Dir = b.x > a.x ? "E" : b.x < a.x ? "W" : b.y > a.y ? "S" : "N";
    // wait out forklifts in the way, as a player would
    let guard = 0;
    while (m.world.forklifts.some((f) => f.pos.x === b.x && f.pos.y === b.y) && guard++ < 20) m.stepManual("WAIT");
    m.stepManual(key(m, dir));
  }
}

describe("manual mode", () => {
  it("picks up and delivers a package by keyboard", () => {
    const m = new Mission({ level: levelById(1), seed: 1, engine: null, policy: "argmax", permutations: 1 });
    const pkg = m.world.packages.find((p) => p.status === "waiting")!;
    driveTo(m, pkg.pickup);
    expect(m.world.robot.carrying).toBe(pkg.id);
    driveTo(m, m.world.docks.get(pkg.dock)!);
    expect(m.world.robot.carrying).toBeNull();
    expect(m.world.stats.deliveries).toBe(1);
    expect(m.record.meta.engine).toBe("manual");
    expect(m.record.ticks.every((t) => t.actionSource === "manual")).toBe(true);
    // manual runs replay exactly too
    expect(rebuild(m.record).mismatches).toEqual([]);
  });

  it("charges when holding still on a charging pad", () => {
    const m = new Mission({ level: levelById(1), seed: 1, engine: null, policy: "argmax", permutations: 1 });
    m.world.robot.battery = 40;
    driveTo(m, m.world.chargers[0]!);
    const before = m.world.robot.battery;
    for (let i = 0; i < 5; i++) m.stepManual("WAIT");
    expect(m.world.robot.battery).toBeGreaterThan(before + 20);
  });

  it("walls stop the robot and count a collision", () => {
    const m = new Mission({ level: levelById(1), seed: 1, engine: null, policy: "argmax", permutations: 1 });
    m.stepManual(key(m, "N")); // start tile (1,1): north is the outer wall
    expect(m.world.stats.wallCollisions).toBe(1);
    expect(m.world.robot.pos).toEqual({ x: 1, y: 1 });
  });
});
