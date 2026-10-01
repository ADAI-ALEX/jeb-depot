/**
 * Failure handling of the local runtime (JEB_LIVE=1), through the same Rust code the app runs:
 * a runtime that crashes at startup, a missing runtime, and a model process that dies mid-session and is
 * restarted. JEB is never silently replaced: every failure surfaces as an error.
 */
import { execFile } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DEV_DATA, JEBD, JebdProcess } from "../support/jebd";

const run = promisify(execFile);
const LIVE = !!process.env.JEB_LIVE;

/** A data dir that shares the installed model files (symlinks) and their verification record. */
function dataDirWithModel(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "jeb-depot-fail-"));
  mkdirSync(path.join(dir, "models"), { recursive: true });
  for (const f of ["jeb-4b.Q8_0.gguf", "tokenizer.json"]) symlinkSync(path.join(DEV_DATA, "models", f), path.join(dir, "models", f));
  if (existsSync(path.join(DEV_DATA, "models/installed.json"))) copyFileSync(path.join(DEV_DATA, "models/installed.json"), path.join(dir, "models/installed.json"));
  return dir;
}

const request = {
  model: "jeb-4b",
  state: "ROBOT: tile (3,4), facing east\nFORWARD (east): open floor, on route, 5 steps from there\nLEFT (north): wall, blocked (moving there is a collision)",
  questions: { move: { type: "choice", instructions: "Which way should the robot move?", criteria: { LEFT: null, FORWARD: null } } },
};

describe.runIf(LIVE)("runtime failures", () => {
  it("a runtime that crashes during startup is reported with its log, not hidden", async () => {
    const dir = dataDirWithModel();
    const fake = path.join(dir, "fake-llama-server");
    writeFileSync(fake, "#!/bin/sh\necho 'llama_model_load: error loading model: simulated failure for the test' >&2\nexit 1\n");
    chmodSync(fake, 0o755);
    const err = await run(JEBD, ["serve", "--data-dir", dir, "--llama-bin", fake]).then(() => null, (e: { code: number; stderr: string }) => e);
    expect(err).not.toBeNull();
    expect(err?.code).toBe(2);
    expect(err?.stderr).toContain("exited during startup");
    expect(err?.stderr).toContain("simulated failure for the test");
  }, 120_000);

  it("a missing runtime is reported as missing", async () => {
    const dir = dataDirWithModel();
    const err = await run(JEBD, ["serve", "--data-dir", dir, "--llama-bin", path.join(dir, "no-such-binary")]).then(() => null, (e: { stderr: string }) => e);
    expect(err?.stderr).toContain("runtime is missing");
    const check = JSON.parse((await run(JEBD, ["check", "--data-dir", dir, "--llama-bin", path.join(dir, "no-such-binary")])).stdout) as { runtimeOk: boolean; runtimeError: string };
    expect(check.runtimeOk).toBe(false);
  }, 120_000);

  it("a model process that dies is detected, and a restart brings JEB back", async () => {
    const jebd = JebdProcess.serve(dataDirWithModel());
    await jebd.ready;
    try {
      const ok = await jebd.decide(request);
      expect(ok.answers.move).toBeTruthy();
      const status = await jebd.call<{ process: { pid: number } }>("status");
      process.kill(status.process.pid, "SIGKILL");
      await new Promise((r) => setTimeout(r, 500));
      await expect(jebd.decide(request)).rejects.toThrow(/stopped|unreachable/);
      const alive = await jebd.call<{ alive: boolean }>("status");
      expect(alive.alive).toBe(false);
      await jebd.call("restart");
      const again = await jebd.decide(request);
      expect(again.answers.move).toBeTruthy();
      expect(again.telemetry.engine.model_ms).toBeGreaterThan(0);
    } finally {
      await jebd.close();
    }
  }, 300_000);
});
