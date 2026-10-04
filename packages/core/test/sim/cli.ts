// Simulation CLI: `npm run sim` — the household and office simulations, week by week, against a
// programmed thermostat, plus the learned thermal response and tolerance curve.
import { simulate } from "./sim";
import { household, officeHousehold } from "./household";
import { house, office } from "../fixtures";
const sum = (st: any[], a: number, b: number, k: string) => st.slice(a, b).reduce((x, s) => x + (s[k] ?? 0), 0);
const avg = (st: any[], a: number, b: number, k: string) => { const xs = st.slice(a, b).map((s) => s[k]).filter((x) => x != null); return xs.reduce((p, c) => p + c, 0) / (xs.length || 1); };
for (const [name, mk, cfg] of [["house", household, house], ["office", officeHousehold, office]] as const) {
  const st = simulate(mk(42, { seed: 7 })).stats;
  const sta = simulate(mk(42, { seed: 7, freezeAfterDay: 0, config: { ...cfg, params: { stepInit: 1e-4, stepMin: 1e-4, stepMax: 1e-4, natureMargin: 99 } } })).stats;
  for (const [a, b] of [[0, 7], [7, 14], [14, 21], [21, 28], [28, 35], [35, 42]]) {
    console.log(`${name} wk${a / 7 + 1} unc ${sum(st, a, b, "uncomfortableMin")} hvac ${sum(st, a, b, "hvacMin")} (static ${sum(sta, a, b, "uncomfortableMin")}/${sum(sta, a, b, "hvacMin")}) votes/attended-h ${(sum(st, a, b, "votes") / (sum(st, a, b, "attendedMin") / 60)).toFixed(3)} hvac/degH ${(sum(st, a, b, "hvacMin") / sum(st, a, b, "degreeHours")).toFixed(2)} (static ${(sum(sta, a, b, "hvacMin") / sum(sta, a, b, "degreeHours")).toFixed(2)}) band ${avg(st, a, b, "bandWidth").toFixed(2)} rms-cool ${(st.slice(a, b).map((x) => x.curveRms?.cool).filter((x) => x != null).reduce((p, c) => p + c, 0) / 7).toFixed(2)} night ${avg(st, a, b, "nightDrift").toFixed(3)}`);
  }
  const r = simulate(mk(42, { seed: 7 }));
  console.log(name, "thermal", JSON.stringify(r.state.thermal), "curve", r.lastOutput!.curve.map((k) => `${k.out}:${k.heat.toFixed(1)}-${k.cool.toFixed(1)}`).join(" "));
}
