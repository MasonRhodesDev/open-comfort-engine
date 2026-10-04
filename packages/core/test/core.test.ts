// Property tests of the reference implementation against the spec's rules
// (independent of the golden vectors).
import { describe, expect, it } from "vitest";
import { init, step, serialize, restore, project, phi, parseWhen, knots, params, type State, type EngineEvent, type Output } from "../src";
import { house, office } from "./fixtures";
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
/** a start: outdoor, then a reading (within the attended gap) */
const base = (tin = 24.0, out = tin, d = 1): EngineEvent[] => [
  { type: "weather", now: at(d, "09:05"), out },
  { type: "reading", now: at(d, "09:06"), tin, equip: "idle" },
];
const lastOf = <T,>(xs: T[]) => xs[xs.length - 1];
/** n quiet attended hours: a reading every 5 minutes, the outdoor temperature repeated hourly (hosts send it ≤ 10 min apart) */
function quiet(hours: number, tin: number, from = "09:06", d = 1, out?: number): EngineEvent[] {
  const [h0, m0] = from.split(":").map(Number);
  const evs: EngineEvent[] = [];
  for (let m = 5; m <= hours * 60; m += 5) {
    const mm = h0 * 60 + m0 + m;
    const now = at(d, `${String(Math.floor(mm / 60)).padStart(2, "0")}:${String(mm % 60).padStart(2, "0")}`);
    if (m % 60 === 0 && out !== undefined) evs.push({ type: "weather", now, out });
    evs.push({ type: "reading", now, tin, equip: "idle" });
  }
  return evs;
}

describe("math (Appendix A)", () => {
  it("phi matches known values", () => {
    expect(phi(0)).toBeCloseTo(0.5, 7);
    expect(phi(1)).toBeCloseTo(0.8413447, 6);
    expect(phi(-1.96)).toBeCloseTo(0.0249979, 6);
  });
  it("parses local time from the offset, no tz database", () => {
    const w = parseWhen("2026-10-02T09:15:30-07:00");
    expect(w.t).toBe(Date.UTC(2026, 9, 2, 16, 15, 30));
    expect(w.offMin).toBe(-420);
  });
  it("knots span the configured outdoor range", () => {
    expect(knots(params(house))).toEqual([-10, -5, 0, 5, 10, 15, 20, 25, 30, 35, 40, 45]);
  });
});

describe("tolerance curve (§6)", () => {
  it("cold start: the band is the seed at every outdoor temperature", () => {
    for (const out of [-5, 12.5, 20, 38]) {
      const o = lastOf(drive(base(22, out)).outs);
      expect(o.band).toEqual({ heat: 20, cool: 24.4 });
      expect(o.state).toBe("SEEDED");
      expect(o.curve.length).toBe(12);
    }
  });
  it("a vote teaches the knots around the outdoor temperature it was cast at, and no others", () => {
    const { s, outs } = drive([...base(24.2, 37), { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot" }]);
    const c = lastOf(outs).curve;
    const hot = c.find((k) => k.out === 35)!;
    const hot2 = c.find((k) => k.out === 40)!;
    const mild = c.find((k) => k.out === 20)!;
    expect(hot.cool).toBeLessThan(24.4);
    expect(hot2.cool).toBeLessThan(24.4);
    expect(mild.cool).toBe(24.4);
    expect(mild.heat).toBe(20);
    expect(s.curve.cool[9].n + s.curve.cool[10].n).toBeCloseTo(1, 9);
  });
  it("the curve bends with outdoor temperature when the population says so (derived, not defined)", () => {
    // hot-day votes say 27 is fine, cool-day votes say 23 is too hot
    const evs: EngineEvent[] = [];
    for (let d = 1; d <= 8; d++) {
      evs.push(...base(27.5, 38, d), { type: "vote", now: at(d, "09:20"), user: "a", dir: "hot" });
      evs.push({ type: "weather", now: at(d, "21:00"), out: 18 }, { type: "reading", now: at(d, "21:01"), tin: 23.2, equip: "idle" }, { type: "vote", now: at(d, "21:10"), user: "a", dir: "hot" });
    }
    const c = lastOf(drive(evs).outs).curve;
    const hot = c.find((k) => k.out === 40)!;
    const cool = c.find((k) => k.out === 20)!;
    expect(hot.cool).toBeGreaterThan(cool.cool + 2);
  });
  it("time of day is not a dimension: the same vote at 02:00 and 14:00 teaches the same thing", () => {
    const a = drive([{ type: "weather", now: at(1, "02:00"), out: 30 }, { type: "reading", now: at(1, "02:01"), tin: 24.2, equip: "idle" }, { type: "vote", now: at(1, "02:10"), user: "u", dir: "hot" }]).s;
    const b = drive([{ type: "weather", now: at(1, "14:00"), out: 30 }, { type: "reading", now: at(1, "14:01"), tin: 24.2, equip: "idle" }, { type: "vote", now: at(1, "14:10"), user: "u", dir: "hot" }]).s;
    expect(b.curve).toEqual(a.curve);
  });
  it("the engine is identity-agnostic: the voter id changes nothing but the record", () => {
    const ev = (u: string): EngineEvent[] => [...base(24.2), { type: "vote", now: at(1, "09:20"), user: u, dir: "hot" }, { type: "tick", now: at(1, "09:30") }];
    expect(drive(ev("x-9f2")).outs).toEqual(drive(ev("mason")).outs);
  });
});

describe("exploration decays with confidence (§6.3)", () => {
  it("quiet attended hours widen an uncertain edge the room is near, past the room", () => {
    const { outs } = drive([...base(24.0, 24), ...quiet(6, 25.0, "09:06", 1, 24)]);
    expect(lastOf(outs).band.cool).toBeGreaterThan(outs[1].band.cool + 0.3); // about 0.1 °C per quiet hour at the start
    expect(lastOf(outs).band.heat).toBe(outs[1].band.heat); // the room is nowhere near the heat edge: no evidence about it
    expect(lastOf(outs).reasons).not.toContain("push");
  });
  it("a gap in events breaks the quiet streak: an empty house teaches nothing", () => {
    const { s } = drive([...base(24.0, 24), { type: "reading", now: at(1, "15:00"), tin: 26, equip: "idle" }]);
    const fresh = init(house);
    expect(s.curve).toEqual(fresh.curve);
  });
  it("a confident edge is not moved by quiet: comfort persists through the night without votes", () => {
    // make the cool edge at the 20 °C knot confident with many hot votes at 23.2
    const evs: EngineEvent[] = [];
    for (let d = 1; d <= 12; d++) {
      evs.push(...base(23.2, 20, d), { type: "vote", now: at(d, "09:20"), user: "a", dir: "hot" });
      evs.push({ type: "reading", now: at(d, "12:00"), tin: 23.2, equip: "idle" }, { type: "vote", now: at(d, "12:10"), user: "a", dir: "hot" });
    }
    const { s } = drive(evs);
    const before = step(s, { type: "weather", now: at(13, "00:00"), out: 20 }, house);
    const conf = before.output.confidence.cool;
    // a quiet night: readings every 5 min, nobody votes
    let r = step(before.state, { type: "reading", now: at(13, "00:01"), tin: 23.0, equip: "idle" }, house);
    const c0 = r.output.band.cool;
    for (const e of quiet(7, 23.0, "00:01", 13, 20)) r = step(r.state, e, house);
    expect(Math.abs(r.output.band.cool - c0)).toBeLessThan(house.capabilities.setpointStep * (1 - conf) + 0.05);
  });
  it("a zone that can correct faster explores faster", () => {
    const fast = { ...house, params: { equipmentPrior: 6 } };
    const slow = { ...house, params: { equipmentPrior: 0.5 } };
    const f = lastOf(drive([...base(24.0, 24), ...quiet(4, 25.0, "09:06", 1, 24)], fast).outs).band.cool;
    const sl = lastOf(drive([...base(24.0, 24), ...quiet(4, 25.0, "09:06", 1, 24)], slow).outs).band.cool;
    expect(f).toBeGreaterThan(sl);
  });
});

describe("the felt vote (§4)", () => {
  it("a vote pushes the voted edge a step inward of the room, the other side is untouched, and the push persists", () => {
    const before = lastOf(drive(base(24.2)).outs);
    const { outs, last } = drive([...base(24.2), { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot" }, { type: "tick", now: at(1, "09:25") }]);
    const o = lastOf(outs);
    expect(last.effects.feedback).toBeUndefined();
    expect(outs[2].reasons).toContain("push");
    expect(o.cool).toBeLessThanOrEqual(24.2 - 1.0 + 1e-9);
    expect(o.heat).toBe(before.heat);
    expect(o.push.heat).toBeNull();
  });
  it("the push is absorbed once the learned edge passes it, with no reset", () => {
    // a manual push to 23.5, then votes that teach the edge below it
    const evs: EngineEvent[] = [...base(24.0, 24), { type: "manual", now: at(1, "09:10"), applied: { cool: 22.5 } }];
    for (let i = 1; i <= 6; i++) evs.push({ type: "reading", now: at(1, `${9 + i}:20`), tin: 22.0, equip: "cool" }, { type: "vote", now: at(1, `${9 + i}:30`), user: "u1", dir: "hot" });
    const { outs } = drive(evs);
    expect(outs[2].push.cool).toBe(22.5);
    expect(lastOf(outs).band.cool).toBeLessThan(22.5);
    // the manual push is gone (absorbed); what remains is the latest vote's own push, inward of the band
    expect(lastOf(outs).push.cool === null || (lastOf(outs).push.cool as number) < lastOf(outs).band.cool).toBe(true);
  });
  it("a repeat vote inside the cooldown counts only if the room is stalled", () => {
    const moving = drive([...base(24.2, 24), { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot" }, { type: "reading", now: at(1, "09:35"), tin: 23.6, equip: "cool" }, { type: "vote", now: at(1, "09:36"), user: "u1", dir: "hot" }]);
    expect(moving.last.effects.feedback).toBe("noted.cooldown");
    const stalled = drive([...base(24.2, 24), { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot" }, { type: "reading", now: at(1, "09:35"), tin: 24.2, equip: "idle" }, { type: "vote", now: at(1, "09:36"), user: "u1", dir: "hot" }]);
    expect(stalled.last.effects.feedback).toBe("nudge.cooler");
  });
  it("a manual change inward is a push to that value and a weak lesson; outward is ignored; not a complaint", () => {
    const o = lastOf(drive([...base(24.0, 24), { type: "manual", now: at(1, "09:10"), applied: { cool: 22.5, heat: 18 } }]).outs);
    expect(o.cool).toBe(22.5);
    expect(o.heat).toBe(20);
    const rel = lastOf(drive([...base(20.5, 31), { type: "manual", now: at(1, "09:10"), applied: { heat: 21.5 } }, { type: "tick", now: at(1, "09:15") }]).outs);
    expect(rel.released.heat).toBe(true);
  });
  it("a complaint un-releases its side", () => {
    const o = lastOf(drive([...base(20.5, 31), { type: "vote", now: at(1, "09:20"), user: "u1", dir: "cold" }]).outs);
    expect(o.released.heat).toBe(false);
    expect(o.heat).toBeGreaterThanOrEqual(21.5 - 1e-9);
  });
});

describe("nature (§7.4)", () => {
  it("the 09:00 furnace case: a room just below the heat edge, warming from outside, is not heated", () => {
    const o = lastOf(drive(base(19.9, 31)).outs);
    expect(o.released).toEqual({ heat: true, cool: false });
    expect(o.heat).toBe(house.setback.heat);
    expect(o.cool).toBe(24.4);
  });
  it("the mirror: cooling is never released on a hot day; it is on a cool evening", () => {
    expect(lastOf(drive(base(26, 35)).outs).released.cool).toBe(false);
    expect(lastOf(drive(base(26, 18)).outs).released).toEqual({ heat: false, cool: true });
  });
  it("hysteresis: jitter inside the margin cannot flap a side", () => {
    let r = drive(base(22, 23.5)).last;
    expect(r.state.released.heat).toBe(true);
    for (let i = 0; i < 12; i++) {
      r = step(r.state, { type: "weather", now: at(1, `10:${String(i * 4 + 1).padStart(2, "0")}`), out: i % 2 ? 22.6 : 21.4 }, house);
      expect(r.state.released.heat).toBe(true);
    }
    r = step(r.state, { type: "weather", now: at(1, "11:00"), out: 20.9 }, house);
    expect(r.state.released.heat).toBe(false);
  });
  it("nobody is stranded: when the air cannot reach the band, a room already well outside it is conditioned at once", () => {
    const cfg = { ...house, seed: { heat: 18, cool: 22 } };
    const r = drive(base(14, 15), cfg).last; // 4 °C below the edge, the air can only take it to 15
    expect(r.output.released.heat).toBe(false);
    expect(r.output.heat).toBe(18);
    // with the air just inside the edge, released; once the air falls short of the edge, taken back
    let r2 = drive(base(16.5, 18.2), cfg).last;
    expect(r2.output.released.heat).toBe(true);
    r2 = step(r2.state, { type: "weather", now: at(1, "10:00"), out: 17.9 }, cfg);
    expect(r2.output.released.heat).toBe(false);
    // with the air inside the band, the room resting at the air's temperature is fine: stays released
    let r3 = drive(base(17.4, 19), cfg).last;
    r3 = step(r3.state, { type: "reading", now: at(1, "10:00"), tin: 18.95, equip: "idle" }, cfg);
    expect(r3.output.released.heat).toBe(true);
  });
  it("release dwells: a sun-struck outdoor sensor swinging ±3 °C cannot cycle the equipment", () => {
    let r = drive(base(24, 24), house).last;
    let changes = 0;
    let prev = r.output.released.heat;
    for (let i = 1; i <= 36; i++) {
      const mm = 9 * 60 + 6 + i * 10;
      r = step(r.state, { type: "weather", now: at(1, `${String(Math.floor(mm / 60)).padStart(2, "0")}:${String(mm % 60).padStart(2, "0")}`), out: i % 2 ? 27 : 21 }, house);
      if (r.output.released.heat !== prev) { changes++; prev = r.output.released.heat; }
    }
    expect(changes).toBeLessThanOrEqual(12); // at most one change per releaseDwellMin (30 min) over 6 h
  });
  it("stale weather releases nothing", () => {
    const o = lastOf(drive([...base(19.9, 31), { type: "reading", now: at(1, "13:00"), tin: 19.9, equip: "idle" }]).outs);
    expect(o.released.heat).toBe(false);
  });
});

describe("thermal response (§2b)", () => {
  it("learns the envelope from idle intervals and the equipment rate from running ones", () => {
    const evs: EngineEvent[] = [{ type: "weather", now: at(1, "09:00"), out: 30 }];
    let tin = 20;
    let m = 0;
    for (; m < 120; m += 10) { evs.push({ type: "reading", now: at(1, `${9 + Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`), tin: Math.round(tin * 100) / 100, equip: "idle" }); tin += 0.5 * (30 - tin) * (10 / 60); }
    for (; m < 240; m += 10) { evs.push({ type: "reading", now: at(1, `${9 + Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`), tin: Math.round(tin * 100) / 100, equip: "cool" }); tin += (0.5 * (30 - tin) - 3) * (10 / 60); }
    const { s, outs } = drive(evs);
    expect(lastOf(outs).thermal.envelope).toBeGreaterThan(0.38); // at 30 °C out: moving from the 0.3 prior toward 0.5
    expect(lastOf(outs).thermal.cool).toBeGreaterThan(2.1); // moving from the 2.0 prior toward 3 at thermalForget per interval (split over two knots)
    expect(s.thermal.cool[0]).toBe(2.0); // the −10 °C knot saw nothing
  });
});

describe("protection (§7.6)", () => {
  it("an empty office in a heat wave: cooling capped at max (inward rounding), protect engages and releases with hysteresis", () => {
    const evs: EngineEvent[] = [{ type: "weather", now: at(1, "12:00"), out: 40 }, { type: "reading", now: at(1, "12:01"), tin: 29.6, equip: "idle" },
      { type: "reading", now: at(1, "12:06"), tin: 29.0, equip: "cool" }, { type: "reading", now: at(1, "12:11"), tin: 28.3, equip: "cool" }];
    const { outs } = drive(evs, office);
    for (const o of outs) expect(o.cool).toBeLessThanOrEqual(29.0 + 1e-9);
    expect(outs[1].protect).toBe("max");
    expect(outs[1].mode).toBe("cool");
    expect(outs[2].protect).toBe("max");
    expect(outs[3].protect).toBe(null);
  });
  it("protection overrides release and freeze", () => {
    const cfg = { ...house, protect: { max: 26 } };
    const o = lastOf(drive([...base(27, 20), { type: "freeze", now: at(1, "09:10"), on: true }, { type: "tick", now: at(1, "09:12") }], cfg).outs);
    expect(o.cool).toBeLessThanOrEqual(26);
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
  it("a device without auto gets the side the room is outside of, else keeps its side", () => {
    expect(lastOf(drive(base(26, 30), office).outs).mode).toBe("cool");
    expect(lastOf(drive(base(18, 10), office).outs).mode).toBe("heat");
    let r = drive(base(22, 22.1), office).last;
    const m0 = r.output.mode;
    for (let i = 0; i < 6; i++) { r = step(r.state, { type: "weather", now: at(1, `10:${String(i * 5 + 5).padStart(2, "0")}`), out: i % 2 ? 21.9 : 22.1 }, office); expect(r.output.mode).toBe(m0); }
  });
  it("freeze stops learning and exploration but votes still push (and the push fades over complaintMin of quiet)", () => {
    const { s, outs, last } = drive([...base(24.2), { type: "freeze", now: at(1, "09:10"), on: true }, { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot" }, ...quiet(2, 24.2, "09:20")]);
    expect(s.curve).toEqual(init(house).curve);
    expect(last.output.state).toBe("FROZEN");
    expect(outs[3].cool).toBeLessThanOrEqual(24.2 - 1.0 + 1e-9);
    expect(outs[outs.length - 13].cool).toBeGreaterThan(outs[3].cool); // an hour in: half way back
    expect(last.output.cool).toBe(24.4); // two hours of quiet: the push has faded into the learned edge
  });
  it("delta from ambient and the curve are reported", () => {
    const o = lastOf(drive(base(22, 35)).outs);
    expect(o.deltaFromAmbient.cool).toBeCloseTo(24.4 - 35, 9);
    expect(o.curve.find((k) => k.out === 35)!.coolSigma).toBeGreaterThan(1);
  });
});

describe("projection (§7.9)", () => {
  it("a projected day uses the same band and act as step: matching inputs give matching setpoints", () => {
    const { s } = drive([...base(24.2, 30), { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot" }, { type: "tick", now: at(1, "12:00") }]);
    const hours = Array.from({ length: 12 }, (_, i) => ({ now: at(2, `${String(8 + i).padStart(2, "0")}:00`), out: 22 + 10 * Math.sin((i / 12) * Math.PI) }));
    const rows = project(s, house, { tin: 23, hours });
    expect(rows.length).toBe(12);
    for (const row of rows) {
      const live = step({ ...s, released: row.released, push: { heat: null, cool: null }, complaintAt: { heat: null, cool: null } }, { type: "weather", now: row.now, out: row.out }, house);
      expect(live.output.band).toEqual(row.band);
      expect(row.deltaFromAmbient.cool).toBeCloseTo(row.band.cool - row.out, 9);
    }
    expect(rows.some((r) => r.equipment === "cool" && r.runMin > 0)).toBe(true);
  });
});

describe("state machine (§5, §9)", () => {
  it("snapshot round-trip is transparent", () => {
    const evs: EngineEvent[] = [...base(24.2), { type: "vote", now: at(1, "09:20"), user: "a", dir: "hot" }];
    const tail: EngineEvent[] = [...quiet(2, 23.5, "09:20"), { type: "vote", now: at(1, "11:30"), user: "b", dir: "cold" }, { type: "tick", now: at(1, "11:35") }];
    const straight = drive([...evs, ...tail]).outs.slice(-3);
    let s = drive(evs).s;
    s = restore(JSON.parse(JSON.stringify(serialize(s))));
    const resumed = tail.map((e) => { const r = step(s, e, house); s = r.state; return r.output; }).slice(-3);
    expect(resumed).toEqual(straight);
  });
  it("an older snapshot restores to a fresh curve with the room and weather carried over", () => {
    const old: any = { snapshotVersion: 2, zone: "house", reading: { tin: 23, rh: null, equip: "idle", applied: null, at: 1 }, weather: { out: 30, high: null, low: null, at: 1 }, frozen: false, protecting: null, risk: { heat: 0.5, cool: 0.5 } };
    const r = restore(old, house);
    expect(r.snapshotVersion).toBe(3);
    expect(r.reading!.tin).toBe(23);
    expect(r.curve).toEqual(init(house).curve);
    expect(() => step(r, { type: "tick", now: at(1, "10:00") }, house)).not.toThrow();
  });
  it("step() does not mutate its input state", () => {
    const s0 = init(house);
    const copy = JSON.stringify(s0);
    step(s0, base()[0], house);
    expect(JSON.stringify(s0)).toBe(copy);
  });
  it("rejects out-of-order, unknown and non-finite events without changing state", () => {
    const { s } = drive(base());
    const r1 = step(s, { type: "tick", now: at(1, "08:00") }, house);
    expect(r1.effects.records[0]).toMatchObject({ type: "rejected", reason: "time" });
    expect(r1.state).toEqual(s);
    const r2 = step(s, { type: "nope", now: at(1, "10:00") } as unknown as EngineEvent, house);
    expect(r2.effects.records[0]).toMatchObject({ type: "rejected", reason: "type" });
    const r3 = step(s, { type: "reading", now: at(1, "10:00"), tin: NaN } as any, house);
    expect(r3.effects.records[0]).toMatchObject({ type: "rejected", reason: "value" });
  });
});
