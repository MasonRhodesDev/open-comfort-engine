// Outcome tests on the household simulator: the engine must beat the static seed
// schedule on both comfort and energy once it has learned (6 simulated weeks).
import { describe, expect, it } from "vitest";
import { simulate, type DayStats } from "./sim/sim";
import { household } from "./sim/household";
import { house } from "./fixtures";

// a plain programmable thermostat: the seed schedule, nothing learned (frozen from day 0), no nudge,
// no release, no pre-conditioning, no risk
const STATIC = { riskRate: 0, nudgeMax: 0, natureMargin: 99, preconditionMaxMin: 0 };
const staticSim = (days: number, seed: number) => simulate(household(days, { seed, freezeAfterDay: 0, config: { ...house, params: STATIC } }));
const sum = (st: DayStats[], a: number, b: number, k: "votes" | "uncomfortableMin" | "hvacMin") => st.slice(a, b).reduce((x, s) => x + s[k], 0);

describe("household simulation (42 days)", () => {
  for (const seed of [7, 11]) {
    it(`seed ${seed}: less discomfort and less HVAC than the static schedule, fewer votes over time`, () => {
      const eng = simulate(household(42, { seed })).stats;
      const sta = staticSim(42, seed).stats;
      expect(sum(eng, 35, 42, "uncomfortableMin")).toBeLessThan(0.8 * sum(sta, 35, 42, "uncomfortableMin"));
      expect(sum(eng, 35, 42, "hvacMin")).toBeLessThan(0.9 * sum(sta, 35, 42, "hvacMin"));
      expect(sum(eng, 35, 42, "votes")).toBeLessThanOrEqual(1.25 * sum(eng, 0, 7, "votes")); // votes are stochastic; no upward trend
    });
  }
  it("freezing stops learning: models do not change after the freeze", () => {
    const a = simulate(household(10, { freezeAfterDay: 5 }));
    const b = simulate(household(14, { freezeAfterDay: 5 }));
    // learned limits and vote counts are untouched (frozen votes still nudge, so step/lastVote may change)
    for (const [u, blocks] of Object.entries(a.state.models)) {
      for (const [blk, m] of Object.entries(blocks)) {
        const m2 = b.state.models[u][blk];
        expect(m2.lower).toEqual(m.lower);
        expect(m2.upper).toEqual(m.upper);
        expect(m2.n).toBe(m.n);
      }
    }
  });
});
