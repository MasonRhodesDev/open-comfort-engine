// Permutation sweep: every combination of common indoor / outdoor temperatures, seed
// bands and occupancy, run through the engine with a first-order room model and a
// thermostat acting on the engine's output. Looks for strange behaviour:
//   inverted   equipment pushing the room the wrong way (heating above the band, cooling below)
//   fighting   equipment working against the outdoor air (beyond the natureMargin + a sampling lag) while nature would have done the job
//   both       heating and cooling inside the same hour
//   flapping   the setpoints or mode changing more than a few times an hour
//   leak       a released side with its equipment running
//   stranded   the room outside the band for hours with the equipment idle and nature not helping
// Deterministic, no votes (the people are quiet): this is about the control loop, not learning.
import { init, step, type EngineEvent, type Output, type ZoneConfig } from "../../src";
import { house } from "../fixtures";

export interface SweepCase {
  tin0: number;
  out: number;
  seed: { heat: number; cool: number };
  occupied: boolean;
  asleep: boolean;
  /** outdoor swings ±swing °C around `out` over the horizon (crosses the room temperature) */
  swing?: number;
}
export interface Violation {
  kind: "inverted" | "fighting" | "both" | "flapping" | "leak" | "stranded";
  at: string;
  detail: string;
}
export interface SweepResult {
  c: SweepCase;
  violations: Violation[];
  hvacMin: number;
  staticHvacMin: number;
  heatMin: number;
  coolMin: number;
  finalTin: number;
  changes: number;
}

const fmt = (minute: number) => {
  const d = new Date(Date.UTC(2026, 6, 1, 0, 0, 0) + minute * 60000);
  return d.toISOString().slice(0, 19) + "-07:00";
};

/** One case: `hours` of 5-minute steps from 09:00 (daytime; the sleep window is 00:00–06:00 when asleep). */
export function runCase(c: SweepCase, hours = 6): SweepResult {
  const cfg: ZoneConfig = {
    ...house,
    seed: { blocks: [{ start: "00:00", heat: c.seed.heat, cool: c.seed.cool }] },
    sleep: c.asleep ? [{ start: "00:00", end: "23:59" }] : [],
  };
  let s = init(cfg);
  let out: Output | null = null;
  let tin = c.tin0;
  let staticTin = c.tin0;
  const r: SweepResult = { c, violations: [], hvacMin: 0, staticHvacMin: 0, heatMin: 0, coolMin: 0, finalTin: 0, changes: 0 };
  const start = 9 * 60;
  const feed = (e: EngineEvent) => {
    const x = step(s, e, cfg);
    s = x.state;
    out = x.output;
  };
  const outAt = (m: number) => c.out + (c.swing ?? 0) * Math.sin((m / (hours * 60)) * 2 * Math.PI);
  feed({ type: "weather", now: fmt(start - 3), out: outAt(0) });
  feed({ type: "reading", now: fmt(start - 2), tin: c.tin0, equip: "idle" });
  feed({ type: "presence", now: fmt(start - 1), users: c.occupied ? ["u1"] : [] });
  let equipPrev: "heat" | "cool" | "idle" = "idle";
  const hourly: { heat: boolean; cool: boolean; heatMin: number; coolMin: number; changes: number; key: string | null; dirHeat: number; dirCool: number }[] = [];
  for (let m = 0; m < hours * 60; m += 5) {
    const now = start + m;
    const hour = Math.floor(m / 60);
    hourly[hour] = hourly[hour] || { heat: false, cool: false, heatMin: 0, coolMin: 0, changes: 0, key: null, dirHeat: 0, dirCool: 0 };
    // room physics: leak toward outdoor (time constant ~2 h), equipment moves it 0.25 °C per 5 min
    const outNow = outAt(m);
    const leak = (x: number) => x + (outNow - x) * 0.04;
    tin = leak(tin);
    staticTin = leak(staticTin);
    const o = out!;
    let equip: "heat" | "cool" | "idle" = "idle";
    if (tin > o.cool) { tin -= 0.25; equip = "cool"; r.coolMin += 5; }
    else if (tin < o.heat) { tin += 0.25; equip = "heat"; r.heatMin += 5; }
    if (equip !== "idle") r.hvacMin += 5;
    // baseline: a programmed thermostat with the same setback when nobody is home
    const sb = c.occupied ? c.seed : { heat: cfg.setback.heat, cool: cfg.setback.cool };
    if (staticTin > sb.cool) { staticTin -= 0.25; r.staticHvacMin += 5; }
    else if (staticTin < sb.heat) { staticTin += 0.25; r.staticHvacMin += 5; }
    const at = fmt(now);
    // --- checks on this step's action against the output that caused it
    if (equip === "heat") {
      hourly[hour].heat = true;
      hourly[hour].heatMin += 5;
      if (tin - 0.25 > o.band.cool) r.violations.push({ kind: "inverted", at, detail: `heating at ${tin.toFixed(1)} above band.cool ${o.band.cool}` });
      // heating to the setback floor is the floor doing its job, not a fight
      if (outNow >= tin + 2 && o.heat > cfg.setback.heat && !o.protect && !o.reasons.includes("nudge")) r.violations.push({ kind: "fighting", at, detail: `heating at ${tin.toFixed(1)} with outdoor ${outNow.toFixed(1)} warmer (heat sp ${o.heat}, released ${o.released.heat})` });
      if (o.released.heat && o.heat > cfg.setback.heat) r.violations.push({ kind: "leak", at, detail: `heat released but heating (sp ${o.heat})` });
    }
    if (equip === "cool") {
      hourly[hour].cool = true;
      hourly[hour].coolMin += 5;
      if (tin + 0.25 < o.band.heat) r.violations.push({ kind: "inverted", at, detail: `cooling at ${tin.toFixed(1)} below band.heat ${o.band.heat}` });
      if (outNow <= tin - 2 && o.cool < cfg.setback.cool && !o.protect && !o.reasons.includes("nudge")) r.violations.push({ kind: "fighting", at, detail: `cooling at ${tin.toFixed(1)} with outdoor ${outNow.toFixed(1)} cooler (cool sp ${o.cool}, released ${o.released.cool})` });
      if (o.released.cool && o.cool < cfg.setback.cool) r.violations.push({ kind: "leak", at, detail: `cool released but cooling (sp ${o.cool})` });
    }
    equipPrev = equip;
    // flapping = a setpoint reversing direction (or the mode toggling), not a monotonic drift
    const key = `${o.heat}/${o.cool}/${o.mode}`;
    if (hourly[hour].key !== null && hourly[hour].key !== key) {
      const [ph, pc, pm] = hourly[hour].key.split("/");
      const dh = Math.sign(o.heat - Number(ph)), dc = Math.sign(o.cool - Number(pc));
      if ((dh && dh === -hourly[hour].dirHeat) || (dc && dc === -hourly[hour].dirCool) || pm !== o.mode) hourly[hour].changes++;
      if (dh) hourly[hour].dirHeat = dh;
      if (dc) hourly[hour].dirCool = dc;
    }
    hourly[hour].key = key;
    feed({ type: "reading", now: at, tin: Math.round(tin * 100) / 100, equip });
    if (m % 10 === 0) feed({ type: "weather", now: at, out: Math.round(outNow * 10) / 10 }); // hosts SHOULD send outdoor every ≤ 10 min (§4)
  }
  for (let h = 0; h < hourly.length; h++) {
    const H = hourly[h];
    if (!H) continue;
    // both: heating and cooling in one hour is a fault unless the room crossed the whole band (a plunge)
    if (H.heat && H.cool && Math.abs(c.out - c.tin0) < 20) r.violations.push({ kind: "both", at: `hour ${h}`, detail: `heated and cooled in the same hour (heat ${H.heatMin} min, cool ${H.coolMin} min)` });
    if (H.changes > 1) r.violations.push({ kind: "flapping", at: `hour ${h}`, detail: `${H.changes} setpoint reversals / mode toggles in the hour` });
    r.changes += H.changes;
  }
  // stranded: at the end, occupied, room outside the (occupied) band, equipment idle and nature not bringing it in
  const o = out!;
  const outside = tin > o.band.cool + 1.3 ? "hot" : tin < o.band.heat - 1.3 ? "cold" : null; // natureMargin + tolerance
  if (c.occupied && !c.asleep && outside && equipPrev === "idle") {
    // nature helps only if the outdoor air can actually carry the room into the band
    const outEnd = outAt(hours * 60);
    const natureHelps = outside === "hot" ? outEnd <= o.band.cool : outEnd >= o.band.heat;
    if (!natureHelps) r.violations.push({ kind: "stranded", at: fmt(start + hours * 60), detail: `room ${tin.toFixed(1)} ${outside} of band ${o.band.heat}-${o.band.cool}, idle, outdoor ${c.out}` });
  }
  r.finalTin = tin;
  return r;
}

export function grid(): SweepCase[] {
  const cases: SweepCase[] = [];
  const seeds = [{ heat: 18, cool: 22 }, { heat: 20, cool: 24.4 }, { heat: 22, cool: 26 }];
  for (const tin0 of [14, 16, 18, 20, 22, 24, 26, 28, 30, 32])
    for (const out of [-5, 0, 5, 10, 15, 20, 25, 30, 35, 40])
      for (const seed of seeds)
        for (const occupied of [true, false])
          for (const asleep of occupied ? [false, true] : [false]) cases.push({ tin0, out, seed, occupied, asleep });
  // the outdoor air crossing the room temperature during the day: the release hysteresis under test
  for (const tin0 of [18, 20, 22, 24, 26])
    for (const out of [tin0 - 2, tin0, tin0 + 2])
      for (const swing of [3, 8])
        for (const seed of seeds)
          for (const occupied of [true, false]) cases.push({ tin0, out, seed, occupied, asleep: false, swing });
  return cases;
}

export function sweep(hours = 6): SweepResult[] {
  return grid().map((c) => runCase(c, hours));
}

export function summarize(results: SweepResult[]): string {
  const lines: string[] = [];
  const kinds = ["inverted", "fighting", "both", "flapping", "leak", "stranded"] as const;
  const counts = Object.fromEntries(kinds.map((k) => [k, 0]));
  let hv = 0, st = 0, bad = 0;
  for (const r of results) {
    hv += r.hvacMin; st += r.staticHvacMin;
    const seen = new Set(r.violations.map((v) => v.kind));
    for (const k of seen) counts[k]++;
    if (seen.size) bad++;
  }
  lines.push(`${results.length} cases, ${bad} with any finding; HVAC minutes ${hv} vs static ${st} (${((1 - hv / st) * 100).toFixed(0)}% less)`);
  lines.push(kinds.map((k) => `${k}=${counts[k]}`).join("  "));
  for (const r of results.filter((x) => x.violations.length).slice(0, 40)) {
    const c = r.c;
    lines.push(`  tin ${c.tin0} out ${c.out}${c.swing ? "±" + c.swing : ""} seed ${c.seed.heat}-${c.seed.cool} ${c.occupied ? (c.asleep ? "asleep" : "occupied") : "vacant"}: ` + [...new Set(r.violations.map((v) => `${v.kind} (${v.detail})`))].slice(0, 2).join("; "));
  }
  return lines.join("\n");
}
