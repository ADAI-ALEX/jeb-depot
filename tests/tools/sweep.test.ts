import { it } from "vitest";
import { RuleBasedEngine } from "../../src/decision/rulesEngine";
import { Mission, runToEnd } from "../../src/run/mission";
import { summarize } from "../../src/run/record";
import { levelById } from "../../src/sim/levels";

it.runIf(process.env.SWEEP)("rules sweep", async () => {
  for (const level of [1, 2, 3, 4]) {
    const rows = [];
    for (let seed = 1; seed <= 10; seed++) {
      const s = summarize(await runToEnd(new Mission({ level: levelById(level), seed, engine: new RuleBasedEngine(), policy: "argmax", permutations: 1 })));
      rows.push(`${s.outcome[0]}${s.delivered}/${s.total} c${s.collisions} sp${s.spills} b${Math.round(s.batteryLeft)} t${s.ticks} ${s.score}`);
    }
    console.log(`L${level}: ` + rows.join(" | "));
  }
});
