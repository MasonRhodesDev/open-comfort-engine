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
const base = (users = ["u1"], tin = 24.0): EngineEvent[] => [
  { type: "weather", now: at(1, "09:05"), out: 20 }, // trm = adaptiveRef -> A = 0
  { type: "presence", now: at(1, "09:06"), users },
  { type: "reading", now: at(1, "09:07"), tin, equip: "idle" },
];

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
  });
});

describe("engine rules", () => {
  it("cold start outputs the seed exactly (A = 0)", () => {
    const { outs } = drive(base());
    const o = outs[outs.length - 1];
    expect(o.state).toBe("SEEDED");
    expect(o.coolShift).toBe(0);
    expect(o.heatShift).toBe(0);
    expect(o.cool).toBeCloseTo(24.4, 9);
    expect(o.heat).toBeCloseTo(20.0, 9);
  });

  it("a vote is felt: the voted edge ends a step past the room", () => {
    const { outs, last } = drive([...base(["u1"], 24.2), { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot" }]);
    expect(last.effects.feedback).toBe("nudge.cooler");
    expect(outs[outs.length - 1].cool).toBeLessThanOrEqual(24.2 - 1.0 + 1e-9);
  });

  it("the engine is identity-agnostic: renaming uids changes nothing", () => {
    const ev = (u: string): EngineEvent[] => [...base([u], 24.2), { type: "vote", now: at(1, "09:20"), user: u, dir: "hot" }, { type: "tick", now: at(1, "12:00") }];
    const a = drive(ev("mason")).outs;
    const b = drive(ev("x-9f2")).outs;
    expect(b).toEqual(a);
  });

  it("drift never passes the voter's median warm limit and resets on a complaint", () => {
    const evs: EngineEvent[] = [...base(["u1"], 24.2), { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot" }];
    for (let h = 10; h <= 15; h++) evs.push({ type: "reading", now: at(1, `${h}:00`), tin: 23.0, equip: "cool" });
    const { s, outs } = drive(evs);
    // after the complaint, cooling never returns to the temperature complained about
    for (const o of outs.slice(4)) expect(o.cool).toBeLessThan(24.2);
    expect(s.drift.pausedUntil).not.toBeNull();
  });

  it("vacancy drift accelerates and stops at setback", () => {
    const evs: EngineEvent[] = [...base(), { type: "presence", now: at(1, "10:00"), users: [] }];
    for (let h = 11; h <= 23; h++) evs.push({ type: "tick", now: at(1, `${h}:00`) });
    const { outs } = drive(evs);
    const v = outs.map((o) => o.vacancy);
    expect(v[5] - v[4]).toBeGreaterThan(v[4] - v[3] - 1e-9); // non-decreasing rate
    for (const o of outs) expect(o.cool).toBeLessThanOrEqual(house.setback.cool + 1e-9);
    for (const o of outs) expect(o.heat).toBeGreaterThanOrEqual(house.setback.heat - 1e-9);
  });

  it("freeze stops learning and drift but votes still nudge", () => {
    const { s, last } = drive([...base(), { type: "freeze", now: at(1, "09:10"), on: true }, { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot" }, { type: "tick", now: at(1, "13:00") }]);
    const m = s.models.u1.b0;
    expect(m.n).toBe(0);
    expect(s.drift.value).toBe(0);
    expect(last.output.state).toBe("FROZEN");
    expect(last.output.nudge).toBeLessThan(0);
  });

  it("a hold keeps the device gap and ends at the next block", () => {
    const { outs } = drive([...base(), { type: "manual", now: at(1, "10:00"), applied: { cool: 21.0 } }, { type: "tick", now: at(1, "16:01") }]);
    const held = outs[3];
    expect(held.state).toBe("HOLD");
    expect(held.cool).toBe(21.0);
    expect(held.cool - held.heat).toBeGreaterThanOrEqual(house.capabilities.minGap - 1e-9);
    expect(outs[4].state).not.toBe("HOLD");
  });

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

  it("snapshot round-trip is transparent", () => {
    const evs: EngineEvent[] = [...base(["a", "b"], 24.2), { type: "vote", now: at(1, "09:20"), user: "a", dir: "hot" }];
    const tail: EngineEvent[] = [{ type: "tick", now: at(1, "11:00") }, { type: "vote", now: at(1, "11:30"), user: "b", dir: "cold" }, { type: "tick", now: at(1, "13:00") }];
    const straight = drive([...evs, ...tail]).outs.slice(-3);
    let s = drive(evs).s;
    s = restore(JSON.parse(JSON.stringify(serialize(s))));
    const resumed = tail.map((e) => { const r = step(s, e, house); s = r.state; return r.output; });
    expect(resumed).toEqual(straight);
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
