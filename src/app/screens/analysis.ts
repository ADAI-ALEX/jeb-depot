/** Analysis of a recorded run: latency, confidence, outcome by confidence, calibration, score, model usage. */
import { SMALL, text, wrap } from "../../render/font";
import { C } from "../../render/palette";
import { analyse, type Analysis } from "../../run/metrics";
import { summarize, type RunRecord, type RunSummary } from "../../run/record";
import type { RunListItem } from "../../platform/backend";
import { binChart, legend, lineChart } from "../../ui/charts";
import { fmtMs, pct, type UI } from "../../ui/widgets";
import type { App } from "../app";

export class AnalysisScreen {
  private list: RunListItem[] = [];
  private idx = 0;
  private run: RunRecord | null = null;
  private a: Analysis | null = null;
  private s: RunSummary | null = null;
  private loading = false;

  constructor(private app: App) {}

  async refresh(): Promise<void> {
    try {
      this.list = await this.app.backend.listRuns();
      if (!this.run && this.list.length) await this.load(0);
      else if (this.run) this.idx = Math.max(0, this.list.findIndex((r) => r.meta.id === this.run?.meta.id));
    } catch (e) {
      this.app.toast(`runs: ${e instanceof Error ? e.message : e}`, C.red);
    }
  }

  select(run: RunRecord): void {
    this.setRun(run);
    void this.app.backend.listRuns().then((l) => {
      this.list = l;
      this.idx = Math.max(0, l.findIndex((r) => r.meta.id === run.meta.id));
    });
  }

  private setRun(run: RunRecord): void {
    this.run = run;
    this.a = analyse(run);
    this.s = summarize(run);
  }

  private async load(i: number): Promise<void> {
    const item = this.list[i];
    if (!item) return;
    this.idx = i;
    this.loading = true;
    try {
      this.setRun(await this.app.backend.loadRun(item.meta.id));
    } finally {
      this.loading = false;
    }
  }

  draw(ui: UI, _dt: number): void {
    const fb = ui.fb;
    // selector
    ui.panel(2, 17, 476, 15);
    if (ui.button(6, 19, 12, 11, "◀", { disabled: this.idx >= this.list.length - 1, tip: "Older run" })) void this.load(this.idx + 1);
    if (ui.button(20, 19, 12, 11, "▶", { disabled: this.idx <= 0, tip: "Newer run" })) void this.load(this.idx - 1);
    if (!this.run || !this.a || !this.s) {
      text(fb, SMALL, this.loading ? "LOADING..." : "NO RUNS YET: FINISH A MISSION IN SIM OR BENCH.", 240, 140, C.steel3, { align: "center", shadow: null });
      return;
    }
    const m = this.run.meta;
    const s = this.s;
    const a = this.a;
    const jeb = m.engine === "jeb";
    text(fb, SMALL, `L${m.levelId} ${m.levelName} · SEED ${m.seed} · ${m.engine.toUpperCase()}${jeb ? " " + m.policy.toUpperCase() : ""} · ${s.outcome.toUpperCase()} · ${s.delivered}/${s.total} PKG · ${s.collisions} HIT · SCORE ${s.score} · ${s.ticks} TICKS`, 36, 22, C.white, { shadow: null, maxWidth: 360 });
    text(fb, SMALL, `${this.idx + 1}/${this.list.length}`, 474, 22, C.steel3, { align: "right", shadow: null });

    const W = 156;
    const H = 114;
    const col = (i: number): number => 2 + i * (W + 4);
    const r0 = 37;
    const r1 = r0 + H + 4;

    // 1 latency
    ui.panel(col(0), r0, W, H, "LATENCY", { right: jeb ? `P95 ${fmtMs(s.request.p95)}` : "NO MODEL" });
    lineChart(ui, col(0) + 4, r0 + 9, W - 8, H - 22, [
      { values: a.latency.map((l) => ({ x: l.tick, y: l.e2eMs })), color: C.amber2, label: "E2E" },
      { values: a.latency.map((l) => ({ x: l.tick, y: l.modelMs })), color: C.cyan, label: "MODEL" },
    ], { yFmt: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}S` : `${Math.round(v)}`), empty: jeb ? "NO DECISIONS" : "RULES: NO INFERENCE" });
    legend(ui, col(0) + 6, r0 + H - 9, [{ label: "MODEL (LLAMA.CPP)", color: C.cyan }, { label: "END-TO-END TICK", color: C.amber2 }]);

    // 2 confidence
    ui.panel(col(1), r0, W, H, "CONFIDENCE", { right: `MEAN ${pct(s.meanMoveConfidence)}` });
    lineChart(ui, col(1) + 4, r0 + 9, W - 8, H - 22, [{ values: a.confidence.map((c) => ({ x: c.tick, y: c.conf })), color: C.green, label: "MOVE" }], { yMax: 1, yFmt: (v) => `${Math.round(v * 100)}%`, empty: "NO MOVE DECISIONS" });
    legend(ui, col(1) + 6, r0 + H - 9, [{ label: "MOVE CONFIDENCE (JEB DEFINITION)", color: C.green }]);

    // 3 outcome by confidence
    ui.panel(col(2), r0, W, H, "OUTCOME", { right: `GOOD ${pct(a.moveGoodRate)}` });
    binChart(ui, col(2) + 4, r0 + 9, W - 8, H - 30, a.byConfidence, { color: C.green, minN: 3, labels: (b) => `${Math.round(b.lo * 100)}` });
    text(fb, SMALL, "GOOD-MOVE RATE BY CONFIDENCE BUCKET", col(2) + 6, r0 + H - 17, C.steel3, { shadow: null });
    text(fb, SMALL, "(GOOD = NO COLLISION, SHORTEST SAFE STEP)", col(2) + 6, r0 + H - 10, C.steel, { shadow: null });

    // 4 calibration
    const rel = a.reliability;
    ui.panel(col(0), r1, W, H, "CALIBRATION", { right: rel.ece === null ? "--" : `ECE ${rel.ece.toFixed(3)}` });
    if (!jeb) text(fb, SMALL, "RULES ARE ONE-HOT: NOTHING TO CALIBRATE", col(0) + W / 2, r1 + H / 2, C.steel3, { align: "center", shadow: null });
    else {
      binChart(ui, col(0) + 4, r1 + 9, W - 8, H - 30, rel.bins, { color: C.cyan, diagonal: true, minN: 5, labels: (b) => (Math.round(b.lo * 10) % 2 === 0 ? `.${Math.round(b.lo * 10)}` : "") });
      const note = rel.n < 50 ? `ONLY ${rel.n} SAMPLES: TREAT AS INDICATIVE` : `${rel.n} MOVES · WHITE = PERFECT CALIBRATION`;
      text(fb, SMALL, "P(EXECUTED MOVE) VS GOOD OUTCOME", col(0) + 6, r1 + H - 17, C.steel3, { shadow: null });
      text(fb, SMALL, note, col(0) + 6, r1 + H - 10, rel.n < 50 ? C.amber : C.steel, { shadow: null, maxWidth: W - 12 });
    }

    // 5 performance
    ui.panel(col(1), r1, W, H, "PERFORMANCE", { right: `SCORE ${s.score}` });
    lineChart(ui, col(1) + 4, r1 + 9, W - 8, H - 22, [{ values: a.score.map((p) => ({ x: p.tick, y: p.score })), color: C.cyan, label: "SCORE" }], { yMax: Math.max(100, ...a.score.map((p) => p.score)) });
    legend(ui, col(1) + 6, r1 + H - 9, [{ label: "SCORE OVER TIME", color: C.cyan }]);

    // 6 model usage
    ui.panel(col(2), r1, W, H, "MODEL USAGE", { right: jeb ? `${s.decisionsPerSecond?.toFixed(2) ?? "--"} DEC/S` : "" });
    if (jeb) {
      lineChart(ui, col(2) + 4, r1 + 9, W - 8, 50, [{ values: a.dps.map((d) => ({ x: d.tick, y: d.dps })), color: C.magenta, label: "DPS" }], { yFmt: (v) => v.toFixed(1) });
      const ty = r1 + 70;
      text(fb, SMALL, `REQUESTS ${s.decisionRequests} · QUESTIONS ${s.questions} · TOKENS ${s.tokensEvaluated}`, col(2) + 6, ty, C.mist, { shadow: null, maxWidth: W - 12 });
      text(fb, SMALL, `IN-SET MASS ${pct(s.meanInSetMass, 1)} (LABEL FORMAT ADHERENCE)`, col(2) + 6, ty + 8, C.steel3, { shadow: null, maxWidth: W - 12 });
      text(fb, SMALL, "INCIDENT WITHIN 3 TICKS BY REPORTED RISK:", col(2) + 6, ty + 18, C.steel3, { shadow: null });
      a.riskLevels.forEach((r, i) => {
        const c = r.level === "LOW" ? C.green : r.level === "MEDIUM" ? C.amber : C.red;
        text(fb, SMALL, `${r.level} ${r.n ? pct(r.rate) : "--"} (${r.n})`, col(2) + 6 + i * 48, ty + 26, c, { shadow: null });
      });
    } else wrap(fb, SMALL, "THE RULES BASELINE MAKES NO MODEL CALLS. RUN THE SAME LEVEL AND SEED WITH JEB AND COMPARE THE NUMBERS IN BENCH.", col(2) + 8, r1 + 20, W - 16, C.steel3, { shadow: null });
  }
}
