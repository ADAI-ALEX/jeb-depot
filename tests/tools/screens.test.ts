/**
 * SHOTS=1 JEB_LIVE=1: drive the real App (boot -> demo mission with the live model -> replay -> analysis ->
 * bench -> settings) headless, and write every screen to .cache/shots/app-*.png. Doubles as an end-to-end test.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { App } from "../../src/app/app";
import { Framebuffer } from "../../src/render/fb";
import { Input } from "../../src/ui/input";
import { UI } from "../../src/ui/widgets";
import { NodeBackend } from "../support/nodeBackend";
import { writePng } from "../support/png";

const OUT = path.resolve(import.meta.dirname, "../../.cache/shots");

it.runIf(process.env.SHOTS && process.env.JEB_LIVE)("app screens with the live model", async () => {
  mkdirSync(OUT, { recursive: true });
  (globalThis as unknown as { window: unknown }).window = { addEventListener() {} };
  const fb = new Framebuffer();
  const input = new Input({ addEventListener() {} } as unknown as HTMLElement, (x, y) => ({ x, y }));
  const ui = new UI(fb, input);
  const backend = new NodeBackend();
  const app = new App(backend);
  const frame = async (n = 1, wait = 16): Promise<void> => {
    for (let i = 0; i < n; i++) {
      app.frame(ui, 1 / 30);
      input.endFrame();
      await new Promise((r) => setTimeout(r, wait));
    }
  };
  const shot = (name: string): void => writePng(path.join(OUT, `app-${name}.png`), fb.data, fb.w, fb.h, 3);
  const until = async (cond: () => boolean, maxMs: number, wait = 16): Promise<void> => {
    const t0 = Date.now();
    while (!cond() && Date.now() - t0 < maxMs) await frame(1, wait);
  };

  await frame(3);
  shot("boot-checking");
  await until(() => app.boot.phase === "online", 240_000);
  await frame(5);
  shot("boot-online");
  await until(() => app.screen === "sim", 10_000);
  await frame(10);
  shot("sim-ready");

  app.sim.startDemo();
  const ctl = app.sim.ctl!;
  await until(() => ctl.curr.tick >= 6, 120_000);
  shot("sim-demo-early");
  let calloutShot = false;
  const t0 = Date.now();
  while (!ctl.done && Date.now() - t0 < 900_000) {
    await frame(1);
    if (!calloutShot && ctl.callout && ctl.curr.tick > 8) {
      await frame(4);
      shot("sim-demo-callout");
      calloutShot = true;
    }
    if (ctl.curr.tick === 40) shot("sim-demo-mid");
  }
  expect(ctl.done).toBe(true);
  await frame(30);
  shot("sim-summary");
  const run = ctl.mission.record;
  writeFileSync(path.join(OUT, "demo-run.json"), JSON.stringify(run));

  app.go("replay");
  await app.replay.open(run);
  for (let i = 0; i < Math.floor(run.ticks.length / 2); i++) (app.replay as unknown as { stepTo(i: number): void }).stepTo(i + 1);
  await frame(12);
  shot("replay");

  app.go("analysis");
  app.analysis.select(run);
  await frame(6);
  shot("analysis");

  app.go("settings");
  await app.loadDiagnostics();
  await frame(6);
  shot("settings");

  app.go("bench");
  const bench = app.bench as unknown as { runJob(j: string): Promise<void> };
  await Promise.all([bench.runJob("inference"), until(() => false, 1, 16)]);
  await frame(6);
  shot("bench");

  await backend.runtimeStop();
}, 1_800_000);
