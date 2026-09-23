/**
 * Live tests against the real local JEB-4B (JEB_LIVE=1, model installed in .cache/dev-data or $JEB_DATA_DIR).
 * They verify that decisions come from the model, that probabilities are real distributions, and that the
 * recorded replay matches what was executed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JEBEngine } from "../../src/decision/jebEngine";
import { Mission, runToEnd } from "../../src/run/mission";
import { summarize } from "../../src/run/record";
import { rebuild } from "../../src/run/replay";
import { levelById } from "../../src/sim/levels";
import { JebdProcess, ROOT } from "../support/jebd";

const LIVE = !!process.env.JEB_LIVE;
const LEVEL = Number(process.env.JEB_LEVEL ?? 1);
const SEED = Number(process.env.JEB_SEED ?? 1);
const POLICY = (process.env.JEB_POLICY ?? "argmax") as "argmax" | "sample" | "risk";

describe.runIf(LIVE)("JEB live mission", () => {
  let jebd: JebdProcess;
  beforeAll(async () => {
    jebd = JebdProcess.serve();
    await jebd.ready;
  }, 300_000);
  afterAll(async () => {
    await jebd?.close();
  });

  it(`level ${LEVEL} seed ${SEED} policy ${POLICY}`, async () => {
    const engine = new JEBEngine(jebd, { permutations: Number(process.env.JEB_PERMS ?? 1) });
    const m = new Mission({ level: levelById(LEVEL), seed: SEED, engine, policy: POLICY, permutations: engine.options.permutations, model: "JEB-4B Q8_0" });
    const run = await runToEnd(m, (t) => {
      const d = t.decisions.map((x) => x.selection.map((s) => `${s.question}=${s.chosen}${s.p === null ? "" : `@${(s.p * 100).toFixed(0)}%`}`).join(" ")).join(" | ");
      const lat = t.decisions.map((x) => `${Math.round(x.latencyMs)}ms`).join("+");
      console.log(`t${String(t.tick).padStart(3)} ${t.action.padEnd(7)} ${lat.padEnd(12)} ${d} ${t.autoReason ?? ""} ${t.events.filter((e) => !["move", "wait"].includes(e.kind)).map((e) => e.kind).join(",")}`);
    });
    const s = summarize(run);
    console.log(JSON.stringify(s, null, 1));
    const out = path.join(ROOT, ".cache/runs");
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, `${run.meta.id}.json`), JSON.stringify(run));

    // decisions really came from the model: every JEB distribution is a proper distribution with label mass
    const dists = run.ticks.flatMap((t) => t.decisions.flatMap((d) => d.dists));
    expect(dists.length).toBeGreaterThan(0);
    for (const d of dists) {
      const sum = d.probs.reduce((a, b) => a + b.p, 0);
      expect(sum).toBeCloseTo(1, 6);
      expect(d.inSetMass).not.toBeNull();
      expect(d.inSetMass as number).toBeGreaterThan(0.5);
    }
    // every JEB decision has model timings from llama-server
    for (const d of run.ticks.flatMap((t) => t.decisions)) expect(d.timing?.modelMs ?? 0).toBeGreaterThan(0);
    // replay reproduces the executed run exactly
    const rb = rebuild(run);
    expect(rb.mismatches).toEqual([]);
  }, 3_600_000);
});
