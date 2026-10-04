// The permutation sweep (sim/sweep.ts) must find nothing strange: no inverted or
// fighting equipment, no heat+cool in one hour, no flapping, no leaks, nobody stranded.
import { describe, expect, it } from "vitest";
import { sweep, summarize } from "./sim/sweep";

describe("permutation sweep", () => {
  it("finds no strange behaviour across common indoor/outdoor/band/occupancy permutations, and saves energy", () => {
    const rs = sweep(6);
    const bad = rs.filter((r) => r.violations.length);
    expect(bad.map((r) => summarize([r])).join("\n")).toBe("");
    const hv = rs.reduce((a, r) => a + r.hvacMin, 0);
    const st = rs.reduce((a, r) => a + r.staticHvacMin, 0);
    expect(hv).toBeLessThan(0.9 * st);
  }, 120000);
});
