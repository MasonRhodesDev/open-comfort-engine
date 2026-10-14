// Runs a scenario through the reference implementation, honouring {roundtrip:true} steps and a starting
// snapshot (restored with the config, as CONFORMANCE.md's runner does).
import { init, restore, step, serialize, type Output, type Effects, type State, type Snapshot } from "../src";
import type { Scenario } from "./scenarios";

export interface Ran { event: unknown; output: Output; effects: Effects }

export function runScenario(sc: Scenario): Ran[] {
  let s: State = sc.snapshot ? restore(sc.snapshot as Snapshot, sc.config) : init(sc.config);
  const out: Ran[] = [];
  for (const st of sc.steps) {
    if ("roundtrip" in st) {
      s = restore(JSON.parse(JSON.stringify(serialize(s))), sc.config);
      continue;
    }
    const r = step(s, st, sc.config);
    s = r.state;
    out.push({ event: st, output: r.output, effects: r.effects });
  }
  return out;
}
