// Runs a scenario through the reference implementation, honouring {roundtrip:true} steps.
import { init, restore, step, serialize, type Output, type Effects, type State } from "../src";
import type { Scenario } from "./scenarios";

export interface Ran { event: unknown; output: Output; effects: Effects }

export function runScenario(sc: Scenario): Ran[] {
  let s: State = init(sc.config);
  const out: Ran[] = [];
  for (const st of sc.steps) {
    if ("roundtrip" in st) {
      s = restore(JSON.parse(JSON.stringify(serialize(s))));
      continue;
    }
    const r = step(s, st, sc.config);
    s = r.state;
    out.push({ event: st, output: r.output, effects: r.effects });
  }
  return out;
}
