// Outcome tests on the household simulator (spec 0.5 definition §9.2): the engine must learn the
// population's tolerance curve and the zone's thermal response, beat a programmed thermostat on
// comfort at no more energy, and hold a confident band through the night without votes.
import { describe, expect, it } from "vitest";
import { simulate, projectDay, type DayStats } from "./sim/sim";
import { household, officeHousehold, summerOutdoor } from "./sim/household";
import { house, office } from "./fixtures";
import { thermalAt } from "../src/thermal";
import { params } from "../src";

// a plain programmed thermostat: the seed range, nothing learned (frozen from day 0), no felt votes, no release
const STATIC = { stepInit: 1e-4, stepMin: 1e-4, stepMax: 1e-4, natureMargin: 99 };
const sum = (st: DayStats[], a: number, b: number, k: "votes" | "uncomfortableMin" | "hvacMin" | "attendedMin" | "degreeHours") => st.slice(a, b).reduce((x, s) => x + s[k], 0);
const mean = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x !== null); return v.reduce((a, b) => a + b, 0) / (v.length || 1); };

describe("household simulation (42 summer days, a slow house)", () => {
  const eng = simulate(household(42, { seed: 7 }));
  const sta = simulate(household(42, { seed: 7, freezeAfterDay: 0, config: { ...house, params: STATIC } }));
  it("learns the thermal response within a week, as a function of outdoor temperature", () => {
    const p = params(house);
    const wk1 = simulate(household(7, { seed: 7 })).state.thermal;
    expect(Math.abs(thermalAt(wk1, p, 28).envelope - 0.15) / 0.15).toBeLessThan(0.3);
    expect(Math.abs(thermalAt(wk1, p, 28).cool - 2.85) / 2.85).toBeLessThan(0.3);
    const late = eng.state.thermal;
    expect(Math.abs(thermalAt(late, p, 25).cool - 3.0) / 3.0).toBeLessThan(0.12);
    expect(Math.abs(thermalAt(late, p, 30).cool - 2.75) / 2.75).toBeLessThan(0.12);
    expect(thermalAt(late, p, 30).cool).toBeLessThan(thermalAt(late, p, 25).cool); // the AC fades in the heat, and the engine sees it
  });
  it("learns a curve that bends with outdoor temperature the way the population does", () => {
    const c = eng.lastOutput!.curve;
    const at = (o: number) => c.find((k) => k.out === o)!;
    expect(at(35).cool).toBeGreaterThan(at(20).cool + 1.0); // true: 25.5 vs 23.1
    expect(Math.abs(at(35).cool - 25.5)).toBeLessThan(0.8);
    expect(Math.abs(at(25).cool - 24.1)).toBeLessThan(0.8);
    const rmsEarly = mean(eng.stats.slice(0, 7).map((s) => s.curveRms?.cool ?? null));
    const rmsLate = mean(eng.stats.slice(35, 42).map((s) => s.curveRms?.cool ?? null));
    expect(rmsLate).toBeLessThan(rmsEarly);
  });
  it("far less discomfort than the programmed thermostat at no more energy (week 3 onward)", () => {
    expect(sum(eng.stats, 14, 42, "uncomfortableMin")).toBeLessThan(0.4 * sum(sta.stats, 14, 42, "uncomfortableMin"));
    expect(sum(eng.stats, 14, 42, "hvacMin")).toBeLessThan(1.05 * sum(sta.stats, 14, 42, "hvacMin"));
  });
  it("votes per attended hour fall as the curve resolves", () => {
    const rate = (a: number, b: number) => sum(eng.stats, a, b, "votes") / (sum(eng.stats, a, b, "attendedMin") / 60);
    expect(rate(28, 42)).toBeLessThan(rate(0, 14));
  });
  it("comfort persists through the night: a confident band moves by less than a setpoint step while nobody can vote", () => {
    const late = eng.stats.slice(28, 42);
    expect(mean(late.map((s) => s.nightDrift))).toBeLessThan(house.capabilities.setpointStep + 0.05);
  });
  it("the projection of a day tracks the simulated room and uses the same band", () => {
    const rows = projectDay(eng.state, house, 42, summerOutdoor, 23);
    expect(rows.length).toBe(24);
    const afternoon = rows.find((r) => r.now.includes("T15:"))!;
    expect(afternoon.equipment).toBe("cool");
    expect(Math.abs(afternoon.band.cool - eng.lastOutput!.curve.find((k) => k.out === 30)!.cool)).toBeLessThan(1.5); // read between the 30 and 35 knots
    for (const r of rows) expect(r.deltaFromAmbient.cool).toBeCloseTo(r.band.cool - r.out, 9);
  });
});

describe("office simulation (42 summer days, a fast small room, one aggressive voter)", () => {
  const eng = simulate(officeHousehold(42, { seed: 11 }));
  const sta = simulate(officeHousehold(42, { seed: 11, freezeAfterDay: 0, config: { ...office, params: STATIC } }));
  it("learns the fast thermal response, and its fade in the heat", () => {
    const p = params(office);
    expect(Math.abs(thermalAt(eng.state.thermal, p, 28).envelope - 0.6) / 0.6).toBeLessThan(0.15);
    expect(Math.abs(thermalAt(eng.state.thermal, p, 25).cool - 8) / 8).toBeLessThan(0.15);
    expect(thermalAt(eng.state.thermal, p, 30).cool).toBeLessThan(thermalAt(eng.state.thermal, p, 25).cool - 0.3);
  });
  it("saves energy against the programmed thermostat (week 3 onward)", () => {
    expect(sum(eng.stats, 14, 42, "hvacMin")).toBeLessThan(0.95 * sum(sta.stats, 14, 42, "hvacMin"));
  });
  it("explores faster than the slow house (band wider, more votes), by the learned equipment rate alone", () => {
    const h = simulate(household(42, { seed: 11 }));
    expect(mean(eng.stats.slice(28, 42).map((s) => s.bandWidth))).toBeGreaterThan(mean(h.stats.slice(28, 42).map((s) => s.bandWidth)));
  });
});
