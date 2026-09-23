/** SHOTS=1: render each level's opening frame through the real scene renderer to .cache/shots/level-N.png. */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { it } from "vitest";
import { RuleBasedEngine } from "../../src/decision/rulesEngine";
import { Mission } from "../../src/run/mission";
import { Framebuffer } from "../../src/render/fb";
import { C } from "../../src/render/palette";
import { Particles } from "../../src/render/particles";
import { MAP_H, MAP_W, Scene } from "../../src/render/scene";
import { levelById } from "../../src/sim/levels";
import { writePng } from "../support/png";

it.runIf(process.env.SHOTS)("level frames", async () => {
  const out = path.resolve(import.meta.dirname, "../../.cache/shots");
  mkdirSync(out, { recursive: true });
  for (const id of [1, 2, 3, 4]) {
    const level = levelById(id);
    const m = new Mission({ level, seed: 1, engine: new RuleBasedEngine(), policy: "argmax", permutations: 1 });
    for (let i = 0; i < 12; i++) await m.stepAuto();
    const prev = m.world.snapshot();
    await m.stepAuto();
    const curr = m.world.snapshot();
    const scene = new Scene(level, m.world.forklifts.map((f) => f.path));
    const fb = new Framebuffer(MAP_W + 8, MAP_H + 8);
    fb.clear(C.void);
    const target = m.world.targetTile();
    scene.draw(fb, 4, 4, { prev, curr, t: 0.6, action: "FORWARD", bump: null, route: null, routeDetour: false, light: "cyan", thinking: true, targetTile: target, night: level.dark, lanes: [] }, 1.3, new Particles());
    writePng(path.join(out, `level-${id}.png`), fb.data, fb.w, fb.h, 3);
  }
});
