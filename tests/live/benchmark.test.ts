/**
 * JEB_LIVE=1 JEB_BENCH=1: the benchmark numbers reported in the README, measured on this machine through the
 * same code paths as the app's BENCH screen. Writes docs/benchmarks/<host>-<date>.{json,md} and the run records.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { JEBEngine } from "../../src/decision/jebEngine";
import type { PolicyId } from "../../src/decision/policies";
import { gameplayBenchmark, inferenceBenchmark, reproducibility, type GameplayRow } from "../../src/run/benchmark";
import { JebdProcess, ROOT } from "../support/jebd";

const fmt = (v: number | null | undefined, d = 0): string => (v === null || v === undefined ? "-" : v.toFixed(d));

it.runIf(process.env.JEB_LIVE && process.env.JEB_BENCH)("benchmark suite", async () => {
  const jebd = JebdProcess.serve();
  await jebd.ready;
  const status = await jebd.call<Record<string, unknown>>("status");
  const engine = new JEBEngine(jebd, { permutations: 1 });
  const probe = {
    sample: async () => {
      const s = await jebd.call<{ sample: { residentBytes: number; footprintBytes: number; cpuSeconds: number } | null; gpu: { utilizationPct: number | null } }>("status");
      return { t: performance.now(), inference: s.sample, gpu: s.gpu };
    },
  };
  const out = path.join(ROOT, "docs/benchmarks");
  const runsDir = path.join(ROOT, ".cache/runs");
  mkdirSync(out, { recursive: true });
  mkdirSync(runsDir, { recursive: true });

  console.log("inference x40 ...");
  const inference = await inferenceBenchmark(engine, probe, 40, () => undefined);

  const gameplay: Record<string, GameplayRow[]> = {};
  for (const policy of ["argmax", "risk"] as PolicyId[]) {
    gameplay[policy] = await gameplayBenchmark(
      engine,
      { levels: [1, 2, 3, 4], seeds: [1], policy, model: "JEB-4B GGUF Q8_0", runtime: "llama.cpp b11149 Metal", permutations: 1 },
      (row, run) => {
        writeFileSync(path.join(runsDir, `${run.meta.id}.json`), JSON.stringify(run));
        console.log(`${policy} L${row.levelId} S${row.seed} ${row.controller}: ${row.summary.outcome} ${row.summary.delivered}/${row.summary.total} hits ${row.summary.collisions} score ${row.summary.score}`);
      },
      () => undefined,
    );
  }
  console.log("reproducibility ...");
  const repro = await reproducibility(engine, 1, 1, "argmax", 1, () => undefined);
  await jebd.close();

  const date = new Date().toISOString().slice(0, 10);
  const hw = status.hardware as { macModel: string; cpu: string; memoryBytes: number; gpuCores: number; osVersion: string };
  const report = { date, hardware: hw, startup: status.startup, loadReport: status.loadReport, inference, gameplay, reproducibility: repro.report };
  const base = `${hw.cpu.replace(/\s+/g, "-").toLowerCase()}-${date}`;
  writeFileSync(path.join(out, `${base}.json`), JSON.stringify(report, null, 1));

  const st = status.startup as { modelLoadMs: number; firstInferenceMs: number; warmInferenceMs: number };
  const lr = status.loadReport as { device: string; layersOffloaded: string };
  const i = inference;
  const lines: string[] = [];
  lines.push(`# Benchmark: ${hw.cpu}, ${Math.round(hw.memoryBytes / 2 ** 30)} GB, macOS ${hw.osVersion} (${date})`, "");
  lines.push(`Model JEB-4B GGUF Q8_0 on llama.cpp b11149, ${lr.device}, ${lr.layersOffloaded}.`, "");
  lines.push("## Startup", "", "| step | time |", "|---|---|");
  lines.push(`| model load (spawn to ready) | ${fmt(st.modelLoadMs)} ms |`, `| first inference (Metal warm-up) | ${fmt(st.firstInferenceMs)} ms |`, `| warm inference | ${fmt(st.warmInferenceMs)} ms |`, "");
  lines.push(`## Inference: ${i.n} requests x ${i.questionsPerRequest} questions (MOVE + RISK) on fixed seeded states`, "", "| ms per request | mean | p50 | p95 | p99 |", "|---|---|---|---|---|");
  for (const [k, s] of [["model inference (llama-server timings)", i.model], ["backend (Rust, incl. tokenization)", i.backend], ["end-to-end (game loop)", i.endToEnd]] as const)
    lines.push(`| ${k} | ${fmt(s.mean)} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.p99)} |`);
  lines.push("", `Decisions per second ${fmt(i.requestsPerSecond, 2)} (${fmt(i.questionsPerSecond, 2)} questions/s); ${fmt(i.tokensPerRequest)} prompt tokens evaluated per request; ${fmt(i.promptTokensPerSecond)} prompt tokens/s of model time.`);
  lines.push(`llama-server peak memory footprint ${fmt((i.peakFootprintBytes ?? 0) / 1e9, 2)} GB (RSS ${fmt((i.peakResidentBytes ?? 0) / 1e9, 2)} GB); CPU ${fmt(i.cpuUtilizationPct)}% of one core; GPU utilisation ${fmt(i.gpuUtilizationPct)}% (IOKit, ${i.samples} samples). Power not measured.`, "");
  for (const [policy, rows] of Object.entries(gameplay)) {
    lines.push(`## Gameplay: JEB (${policy}) vs RULES, seed 1`, "", "| level | controller | outcome | delivered | collisions | spills | battery left | score | ticks | mean move conf. | mean tick |", "|---|---|---|---|---|---|---|---|---|---|---|");
    for (const r of rows) {
      const s = r.summary;
      lines.push(`| L${r.levelId} | ${r.controller === "jeb" ? `JEB ${policy}` : "RULES"} | ${s.outcome} | ${s.delivered}/${s.total} | ${s.collisions} | ${s.spills} | ${fmt(s.batteryLeft)}% | ${s.score} | ${s.ticks} | ${r.controller === "jeb" ? fmt((s.meanMoveConfidence ?? 0) * 100) + "%" : "-"} | ${r.controller === "jeb" ? fmt(s.tick.mean) + " ms" : "-"} |`);
    }
    lines.push("");
  }
  const r = repro.report;
  lines.push("## Reproducibility", "", `Level ${r.levelId} seed ${r.seed} (${r.policy}) twice: ${r.actionsIdentical ? "identical action sequences" : `diverged at tick ${r.firstDivergence}`}, ${r.ticksA}/${r.ticksB} ticks, largest probability difference ${r.maxProbDelta.toFixed(6)}.`, "");
  writeFileSync(path.join(out, `${base}.md`), lines.join("\n"));
  console.log(lines.join("\n"));
  expect(inference.n).toBe(40);
}, 7_200_000);
