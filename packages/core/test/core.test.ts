// Property tests of the reference implementation against the spec's rules
// (independent of the golden vectors).
import { describe, expect, it } from "vitest";
import { init, step, serialize, restore, phi, mulberry32, parseWhen, type State, type EngineEvent, type Output } from "../src";
import { house } from "./fixtures";
import { scenarios } from "./scenarios";
import { runScenario } from "./run";

const at = (d: number, hhmm: string) => `2026-07-${String(d).padStart(2, "0")}T${hhmm}:00-07:00`;
function drive(events: EngineEvent[], config = house): { s: State; outs: Output[]; last: ReturnType<typeof step> } {
  let s = init(config);
  const outs: Output[] = [];
  let last!: ReturnType<typeof step>;
  for (const e of events) {
    last = step(s, e, config);
    s = last.state;
    outs.push(last.output);
  }
  return { s, outs, last };
}
/** a mild morning: outdoor within natureMargin of the room, so nothing is released */
const base = (users = ["u1"], tin = 24.0, out = tin): EngineEvent[] => [
  { type: "weather", now: at(1, "09:05"), out },
  { type: "presence", now: at(1, "09:06"), users },
  { type: "reading", now: at(1, "09:07"), tin, equip: "idle" },
];
const lastOf = <T,>(xs: T[]) => xs[xs.length - 1];

describe("math (Appendix A, §8.5)", () => {
  it("phi matches known values", () => {
    expect(phi(0)).toBeCloseTo(0.5, 7);
    expect(phi(1)).toBeCloseTo(0.8413447, 6);
    expect(phi(-1.96)).toBeCloseTo(0.0249979, 6);
  });
  it("mulberry32 sequence for seed 1", () => {
    let st = 1;
    const xs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const [v, n] = mulberry32(st);
      xs.push(v);
      st = n;
    }
    expect(xs.map((x) => x.toFixed(10))).toEqual(["0.6270739406", "0.0027357212", "0.5274470400"]);
  });
  it("parses local time from the offset, no tz database", () => {
    const w = parseWhen("2026-10-02T09:15:30-07:00");
    expect(w.date).toBe("2026-10-02");
    expect(w.minute).toBeCloseTo(555.5, 9);
    expect(w.t).toBe(Date.UTC(2026, 9, 2, 16, 15, 30));
    expect(w.offMin).toBe(-420);
  });
});

describe("band (§7.1)", () => {
  it("cold start outputs the seed exactly (risk 0), and within one grid step a minute later", () => {
    const { outs } = drive(base());
    expect(outs[1].state).toBe("SEEDED");
    expect(outs[1].cool).toBeCloseTo(24.4, 9);
    expect(outs[1].heat).toBeCloseTo(20.0, 9);
    expect(outs[1].reasons).toContain("seed");
    const o = lastOf(outs);
    expect(o.cool).toBeLessThanOrEqual(24.5 + 1e-9);
    expect(o.heat).toBeGreaterThanOrEqual(19.9 - 1e-9);
    expect(o.released).toEqual({ heat: false, cool: false });
    expect(o.blockEnd).toBe("2026-07-01T16:00:00-07:00");
  });
  it("the engine is identity-agnostic: renaming uids changes nothing", () => {
    const ev = (u: string): EngineEvent[] => [...base([u], 24.2), { type: "vote", now: at(1, "09:20"), user: u, dir: "hot" }, { type: "tick", now: at(1, "12:00") }];
    expect(drive(ev("x-9f2")).outs).toEqual(drive(ev("mason")).outs);
  });
  it("the most sensitive present user wins each side", () => {
    const evs: EngineEvent[] = [...base(["a", "b"], 24.2), { type: "vote", now: at(1, "09:20"), user: "a", dir: "hot" }, { type: "tick", now: at(1, "15:00") }];
    const both = lastOf(drive(evs).outs);
    const aloneB = lastOf(drive([...evs, { type: "presence", now: at(1, "15:01"), users: ["b"] }]).outs);
    expect(both.band.cool).toBeLessThan(aloneB.band.cool);
    expect(both.band.heat).toBeGreaterThanOrEqual(aloneB.band.heat - 1e-9);
  });
  it("nobody present: the band is the setback", () => {
    const o = lastOf(drive([...base([]), { type: "tick", now: at(1, "12:00") }]).outs);
    expect(o.state).toBe("VACANT");
    expect(o.band).toEqual({ heat: house.setback.heat, cool: house.setback.cool });
  });
});

describe("nudge (§7.2)", () => {
  it("a vote is felt: the voted edge ends a step inward of the room, the other side is untouched", () => {
    const before = lastOf(drive(base(["u1"], 24.2)).outs);
    const { outs, last } = drive([...base(["u1"], 24.2), { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot" }]);
    const o = lastOf(outs);
    expect(last.effects.feedback).toBe("nudge.cooler");
    expect(o.cool).toBeLessThanOrEqual(24.2 - 1.0 + 1e-9);
    expect(o.heat).toBe(before.heat);
    expect(o.nudge.heat).toBe(0);
  });
  it("a second vote inside the cooldown is noted, not acted on", () => {
    const { last } = drive([...base(["u1"], 24.2), { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot" }, { type: "vote", now: at(1, "09:25"), user: "u1", dir: "hot" }]);
    expect(last.effects.feedback).toBe("noted.cooldown");
  });
  it("a manual change inward becomes a nudge to that value; outward is ignored", () => {
    const control = lastOf(drive([...base(["u1"], 24.0), { type: "tick", now: at(1, "10:00") }]).outs);
    const o = lastOf(drive([...base(["u1"], 24.0), { type: "manual", now: at(1, "10:00"), applied: { cool: 22.5, heat: 18 } }]).outs);
    expect(o.cool).toBe(22.5);
    expect(o.heat).toBe(control.heat); // 22.5 − 20 ≥ minGap 1.6: the outward heat change is ignored
    expect(o.nudge.heat).toBe(0);
    expect(o.reasons).not.toContain("gap");
  });
  it("a manual change that breaks the device gap keeps the side that was set", () => {
    const o = lastOf(drive([...base(["u1"], 24.0), { type: "manual", now: at(1, "10:00"), applied: { cool: 21.0 } }]).outs);
    expect(o.cool).toBe(21.0);
    expect(o.heat).toBeCloseTo(21.0 - house.capabilities.minGap, 9);
  });
  it("a complaint un-releases its side even when learning alone already covers the room", () => {
    const { outs } = drive([...base(["u1"], 20.5, 31), { type: "vote", now: at(1, "09:20"), user: "u1", dir: "cold" }]);
    const o = lastOf(outs);
    expect(o.released.heat).toBe(false);
    expect(o.heat).toBeGreaterThanOrEqual(20.5 + 1.0 - 1e-9);
    // two users in conflict: u2's cold vote is still felt although the heat edge is above the target
    const two = lastOf(drive([...base(["u1", "u2"], 22.5, 28), { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot" }, { type: "vote", now: at(1, "09:21"), user: "u2", dir: "cold" }]).outs);
    expect(two.released.heat).toBe(false);
    expect(two.heat).toBeGreaterThan(house.setback.heat);
  });
});

describe("risk (§7.3)", () => {
  it("grows while people are awake and quiet, widens the band, and a vote resets only its side", () => {
    const evs: EngineEvent[] = [...base(["u1"], 22.0)];
    for (const hh of ["10", "11", "12", "13"]) evs.push({ type: "tick", now: at(1, `${hh}:00`) });
    const { s, outs } = drive(evs);
    expect(s.risk.cool).toBeGreaterThan(0.95);
    expect(s.risk.heat).toBe(s.risk.cool);
    expect(lastOf(outs).band.cool).toBeGreaterThan(outs[2].band.cool);
    expect(lastOf(outs).band.heat).toBeLessThan(outs[2].band.heat);
    expect(lastOf(outs).reasons).toContain("risk");
    const r = step(s, { type: "vote", now: at(1, "13:10"), user: "u1", dir: "hot" }, house);
    expect(r.state.risk.cool).toBe(0);
    expect(r.state.risk.heat).toBeGreaterThan(0.95);
    expect(r.state.paused.cool).not.toBeNull();
    expect(r.state.paused.heat).toBeNull();
  });
  it("is frozen in place while asleep, and resumes after", () => {
    const cfg = { ...house, sleep: [{ start: "11:30", end: "13:30" }] };
    const evs: EngineEvent[] = [...base(["u1"], 22.0), { type: "tick", now: at(1, "10:00") }, { type: "tick", now: at(1, "11:00") }];
    const { s } = drive(evs, cfg);
    const r0 = s.risk.cool;
    expect(r0).toBeGreaterThan(0);
    let r = step(s, { type: "tick", now: at(1, "12:00") }, cfg);
    r = step(r.state, { type: "tick", now: at(1, "13:00") }, cfg);
    expect(r.state.risk.cool).toBe(r0);
    expect(r.output.reasons).toContain("sleep");
    r = step(r.state, { type: "tick", now: at(1, "14:00") }, cfg);
    expect(r.state.risk.cool).toBeGreaterThan(r0);
  });
  it("never passes the median: the band stops at what the person is learned to accept", () => {
    const evs: EngineEvent[] = [...base(["u1"], 23.0), { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot" }];
    for (let h = 10; h <= 15; h++) evs.push({ type: "reading", now: at(1, `${h}:00`), tin: 22.5, equip: "cool" });
    const { outs } = drive(evs);
    for (const o of outs.slice(4)) expect(o.band.cool).toBeLessThan(23.0);
  });
});

describe("nature (§7.4)", () => {
  it("the 09:00 furnace case: a room below the heat edge but warming from outside is not heated", () => {
    const o = lastOf(drive(base(["u1"], 20.5, 31)).outs);
    expect(o.released).toEqual({ heat: true, cool: false });
    expect(o.heat).toBe(house.setback.heat);
    expect(o.cool).toBeCloseTo(24.4, 9);
    expect(o.reasons).toContain("released");
  });
  it("the mirror: a warm room cooling from outside is not cooled; cooling never released on a hot day", () => {
    const o = lastOf(drive(base(["u1"], 26, 18)).outs);
    expect(o.released).toEqual({ heat: false, cool: true });
    expect(o.cool).toBe(house.setback.cool);
    const hot = lastOf(drive(base(["u1"], 26, 35)).outs);
    expect(hot.released.cool).toBe(false);
  });
  it("hysteresis: released at the margin, un-released only once the vector crosses zero", () => {
    let { s } = drive(base(["u1"], 22, 23.5));
    expect(s.released.heat).toBe(true);
    let r = step(s, { type: "weather", now: at(1, "10:00"), out: 22.5 }, house);
    expect(r.state.released.heat).toBe(true);
    r = step(r.state, { type: "weather", now: at(1, "10:30"), out: 21.9 }, house);
    expect(r.state.released.heat).toBe(false);
    r = step(r.state, { type: "weather", now: at(1, "11:00"), out: 22.5 }, house);
    expect(r.state.released.heat).toBe(false); // inside the margin: nothing changes
  });
  it("stale or missing weather releases nothing", () => {
    const o = lastOf(drive([...base(["u1"], 20.5, 31), { type: "tick", now: at(1, "13:00") }]).outs);
    expect(o.released.heat).toBe(false);
  });
});

describe("pre-conditioning (§7.5)", () => {
  it("an expected arrival pulls the vacant band in ahead of time", () => {
    const evs: EngineEvent[] = [
      { type: "weather", now: at(1, "12:00"), out: 30 },
      { type: "reading", now: at(1, "12:01"), tin: 28, equip: "idle" },
      { type: "presence", now: at(1, "12:02"), users: [], expectedArrival: at(1, "15:00"), expectedUsers: ["u1"] },
      { type: "tick", now: at(1, "12:10") },
      { type: "tick", now: at(1, "14:30") },
    ];
    const { outs } = drive(evs);
    expect(outs[3].cool).toBe(house.setback.cool);
    expect(outs[4].cool).toBeCloseTo(24.4, 9);
    expect(outs[4].reasons).toContain("precondition");
  });
});

describe("protection (§7.6)", () => {
  const office = { ...house, id: "office", capabilities: { ...house.capabilities, modes: ["heat", "cool", "off"] as const, setpointStep: 0.5 },
    seed: { blocks: [{ start: "00:00", heat: 19, cool: 24.5 }] }, setback: { heat: 15, cool: 30 }, protect: { min: 10, max: 29.4 } } as any;
  it("an empty office in a heat wave: the setback is clamped (inward rounding), protect engages and releases with hysteresis", () => {
    const evs: EngineEvent[] = [{ type: "weather", now: at(1, "12:00"), out: 40 }, { type: "presence", now: at(1, "12:01"), users: [] }];
    evs.push({ type: "reading", now: at(1, "13:00"), tin: 29.6, equip: "idle" });
    evs.push({ type: "reading", now: at(1, "13:30"), tin: 29.0, equip: "cool" });
    evs.push({ type: "reading", now: at(1, "14:00"), tin: 28.3, equip: "cool" });
    const { outs } = drive(evs, office);
    for (const o of outs) expect(o.cool).toBeLessThanOrEqual(29.0 + 1e-9);
    expect(outs[2].protect).toBe("max");
    expect(outs[2].mode).toBe("cool");
    expect(outs[3].protect).toBe("max");
    expect(outs[4].protect).toBe(null);
  });
  it("protection overrides release and freeze", () => {
    const cfg = { ...house, protect: { max: 26 } } as any;
    const o = lastOf(drive([...base(["u1"], 27, 20), { type: "freeze", now: at(1, "09:10"), on: true }, { type: "tick", now: at(1, "09:20") }], cfg).outs);
    expect(o.cool).toBeLessThanOrEqual(26);
    expect(o.reasons).toContain("protect");
    expect(o.protect).toBe("max");
  });
});

describe("output rules (§7.8)", () => {
  it("outputs are always valid for the device", () => {
    for (const sc of scenarios) {
      for (const r of runScenario(sc)) {
        const c = sc.config.capabilities;
        const o = r.output;
        expect(o.cool - o.heat, sc.name).toBeGreaterThanOrEqual(c.minGap - 1e-9);
        expect(o.heat).toBeGreaterThanOrEqual(c.heat.min - 1e-9);
        expect(o.cool).toBeLessThanOrEqual(c.cool.max + 1e-9);
        expect(Math.abs(o.cool / c.setpointStep - Math.round(o.cool / c.setpointStep))).toBeLessThan(1e-6);
      }
    }
  });
  it("a device without auto gets the side the room is outside of, else the side opposing the outdoor air", () => {
    const cfg = { ...house, capabilities: { ...house.capabilities, modes: ["heat", "cool", "off"] } } as any;
    expect(lastOf(drive(base(["u1"], 26, 30), cfg).outs).mode).toBe("cool");
    expect(lastOf(drive(base(["u1"], 18, 10), cfg).outs).mode).toBe("heat");
    expect(lastOf(drive(base(["u1"], 22, 30), cfg).outs).mode).toBe("cool");
    expect(lastOf(drive(base(["u1"], 22, 10), cfg).outs).mode).toBe("heat");
  });
  it("freeze stops learning and risk but votes still nudge", () => {
    const { s, last } = drive([...base(), { type: "freeze", now: at(1, "09:10"), on: true }, { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot" }, { type: "tick", now: at(1, "13:00") }]);
    expect(s.models.u1.b0.n).toBe(0);
    expect(s.risk.cool).toBe(0);
    expect(last.output.state).toBe("FROZEN");
    expect(last.output.nudge.cool).toBeGreaterThan(0);
  });
});

describe("state machine (§5, §9)", () => {
  it("snapshot round-trip is transparent", () => {
    const evs: EngineEvent[] = [...base(["a", "b"], 24.2), { type: "vote", now: at(1, "09:20"), user: "a", dir: "hot" }];
    const tail: EngineEvent[] = [{ type: "tick", now: at(1, "11:00") }, { type: "vote", now: at(1, "11:30"), user: "b", dir: "cold" }, { type: "tick", now: at(1, "13:00") }];
    const straight = drive([...evs, ...tail]).outs.slice(-3);
    let s = drive(evs).s;
    s = restore(JSON.parse(JSON.stringify(serialize(s))));
    const resumed = tail.map((e) => { const r = step(s, e, house); s = r.state; return r.output; });
    expect(resumed).toEqual(straight);
  });
  it("a version-1 snapshot restores: models and blocks survive, the loop's state starts fresh", () => {
    const s = drive([...base(["u1"], 24.2), { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot" }]).s;
    const v1: any = { ...JSON.parse(JSON.stringify(s)), snapshotVersion: 1, drift: { value: 0.4, pausedUntil: null }, vacancy: { since: null, value: 0, recovering: false },
      hold: null, trm: 22, day: { date: "2026-07-01", sum: 0, n: 0, hl: null }, lastShift: {}, nudge: { delta: -1, blockId: "b0" } };
    delete v1.risk; delete v1.released; delete v1.paused;
    const r = restore(v1);
    expect(r.snapshotVersion).toBe(2);
    expect(r.models.u1.b0.n).toBe(1);
    expect(r.risk).toEqual({ heat: 0, cool: 0 });
    expect(r.paused).toEqual({ heat: null, cool: null });
    expect((r as any).drift).toBeUndefined();
    expect(() => step(r, { type: "tick", now: at(1, "10:00") }, house)).not.toThrow();
  });
  it("step() does not mutate its input state", () => {
    const s0 = init(house);
    const copy = JSON.stringify(s0);
    step(s0, base()[0], house);
    expect(JSON.stringify(s0)).toBe(copy);
  });
  it("rejects out-of-order and unknown events without changing state", () => {
    const { s } = drive(base());
    const r1 = step(s, { type: "tick", now: at(1, "08:00") }, house);
    expect(r1.effects.records[0]).toMatchObject({ type: "rejected", reason: "time" });
    expect(r1.state).toEqual(s);
    const r2 = step(s, { type: "nope", now: at(1, "10:00") } as unknown as EngineEvent, house);
    expect(r2.effects.records[0]).toMatchObject({ type: "rejected", reason: "type" });
  });
  it("splits a block whose votes disagree by time of day", () => {
    const sc = scenarios.find((x) => x.name === "split")!;
    const ran = runScenario(sc);
    const splits = ran.flatMap((r) => r.effects.records).filter((x) => x.type === "blocks" && (x as any).action === "split");
    expect(splits.length).toBe(1);
    expect((splits[0] as any).blocks.map((b: any) => b.start)).toContain(11 * 60);
  });
});
