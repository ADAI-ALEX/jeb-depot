/** Node-only transport to `jebd serve` (JSON lines over stdio) — the same Rust code the app runs in-process. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { JebTransport, JebWireResult } from "../../src/decision/jebEngine";

export const ROOT = path.resolve(import.meta.dirname, "../..");
export const DEV_DATA = process.env.JEB_DATA_DIR ?? path.join(ROOT, ".cache/dev-data");
export const LLAMA_BIN = path.join(ROOT, "src-tauri/resources/llama/llama-server");
export const JEBD = path.join(ROOT, "target/release/jebd");

export class JebdProcess implements JebTransport {
  readonly name = "jebd";
  private p: ChildProcessWithoutNullStreams;
  private n = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly stderr: string[] = [];
  readonly ready: Promise<void>;

  constructor(args: string[]) {
    if (!existsSync(JEBD)) throw new Error(`build jebd first: cargo build -p jeb-core --release --bin jebd`);
    this.p = spawn(JEBD, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.ready = new Promise((resolve, reject) => {
      readline.createInterface({ input: this.p.stderr }).on("line", (line) => {
        this.stderr.push(line);
        if (line.includes("[jebd] ready")) resolve();
      });
      this.p.on("exit", (code) => reject(new Error(`jebd exited (${code}): ${this.stderr.slice(-5).join(" | ")}`)));
    });
    readline.createInterface({ input: this.p.stdout }).on("line", (line) => {
      const msg = JSON.parse(line) as { id: number; ok: boolean; result?: unknown; error?: string };
      const w = this.pending.get(msg.id);
      if (!w) return;
      this.pending.delete(msg.id);
      if (msg.ok) w.resolve(msg.result);
      else w.reject(new Error(msg.error ?? "jebd error"));
    });
  }

  static serve(dataDir = DEV_DATA): JebdProcess {
    return new JebdProcess(["serve", "--data-dir", dataDir, "--llama-bin", LLAMA_BIN]);
  }

  call<T>(op: string, extra: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.n;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.p.stdin.write(JSON.stringify({ id, op, ...extra }) + "\n");
    });
  }

  decide(body: Record<string, unknown>): Promise<JebWireResult> {
    return this.call<JebWireResult>("decide", { body, scheduling: "primed" });
  }

  async close(): Promise<void> {
    try {
      await this.call("stop");
    } catch {
      /* already gone */
    }
    this.p.kill();
  }
}
