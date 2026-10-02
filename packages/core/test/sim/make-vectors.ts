// Freezes the scenarios into spec/vectors/*.jsonl (golden outputs from the reference
// implementation). Review the diff before committing: vectors define conformance.
import { writeFileSync, mkdirSync } from "node:fs";
import { scenarios } from "../scenarios";
import { runScenario } from "../run";
import { SPEC_VERSION } from "../../src";

const dir = new URL("../../../../spec/vectors/", import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
for (const sc of scenarios) {
  const ran = runScenario(sc);
  const lines: string[] = [JSON.stringify({ vector: sc.name, specVersion: SPEC_VERSION, description: sc.description, config: sc.config, snapshot: null })];
  let i = 0;
  for (const st of sc.steps) {
    if ("roundtrip" in st) { lines.push(JSON.stringify({ roundtrip: true })); continue; }
    const r = ran[i++];
    const effects: Record<string, unknown> = {
      records: r.effects.records.map((x) => ({ type: x.type, ...(x.type === "blocks" ? { action: (x as any).action } : {}), ...(x.type === "vote" ? { user: (x as any).user, dir: (x as any).dir, updated: (x as any).updated, step: (x as any).step, nudge: (x as any).nudge } : {}) })),
    };
    if (r.effects.feedback) effects.feedback = r.effects.feedback;
    lines.push(JSON.stringify({ event: st, expect: { output: r.output, effects } }));
  }
  writeFileSync(dir + sc.name + ".jsonl", lines.join("\n") + "\n");
  console.log("wrote", sc.name, ran.length, "steps");
}
