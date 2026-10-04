// Household simulator: synthetic occupants with hidden *true* tolerance curves that bend with
// outdoor temperature, who cannot vote while asleep; a first-order room; a host that feeds the
// engine only while someone is home. Deterministic (seeded). Used by sim.test.ts and the CLI.
import { init, step, project, type EngineEvent, type Output, type State, type ZoneConfig } from "../../src";
type PerSideNum = { heat: number; cool: number };

export interface SimUser {
  uid: string;
  /** true tolerance range as a function of outdoor temperature, °C indoor */
  range: (out: number, hour: number) => [number, number];
  /** chance per hour of voting while uncomfortable and awake */
  voteRate: number;
  /** home between these hours (local), every day */
  home: [number, number][];
  /** asleep between these hours (cannot vote) */
  asleep?: [number, number];
}

export interface SimOptions {
  config: ZoneConfig;
  users: SimUser[];
  days: number;
  seed?: number;
  /** outdoor temperature at a given day/hour */
  outdoor: (day: number, hour: number) => number;
  /** true room physics: envelope coupling (1/h) and equipment rate (°C/h), the latter possibly a function of outdoor temperature */
  thermal: { envelope: number; equipment: number | ((out: number) => number) };
  freezeAfterDay?: number;
  /** the host feeds the engine only while someone is home (default true) */
  hostPresence?: boolean;
}

export interface DayStats {
  day: number;
  votes: number;
  uncomfortableMin: number; // person-minutes outside their true range while home (asleep or not: sleepers suffer too)
  asleepUncomfortableMin: number; // the part of that while asleep (nobody could vote)
  hvacMin: number; // minutes the HVAC ran
  attendedMin: number; // minutes the engine was fed
  degreeHours: number; // Σ |out − 18| per hour, a weather normaliser
  bandWidth: number; // mean cool − heat while attended
  curveRms: PerSideNum | null; // RMS error of the learned edges vs the population's true ones, at the day's outdoor temps
  nightDrift: number | null; // |Δ heat edge at a fixed outdoor temperature (the night knot)| over the night (23:00–07:00), when nobody can vote
  confidence: number; // mean cool-side confidence while attended
}

/** mulberry32: a small seeded PRNG for the simulator only (the engine has none). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function simulate(o: SimOptions): { stats: DayStats[]; state: State; lastOutput: Output | null } {
  const rnd = rng(o.seed ?? 7);
  let s = init(o.config);
  let out: Output | null = null;
  let tin = 23;
  const stats: DayStats[] = [];
  let night0: number | null = null;
  const fmt = (d: number, minute: number) => {
    const date = new Date(Date.UTC(2026, 5, 1 + d));
    return `${date.toISOString().slice(0, 10)}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00-07:00`;
  };
  const feed = (e: EngineEvent) => {
    const r = step(s, e, o.config);
    s = r.state;
    out = r.output;
  };
  // the population's true tolerance: the tightest range over everyone who is ever home
  const trueBand = (outT: number, hour: number): [number, number] => {
    let lo = -Infinity, hi = Infinity;
    for (const u of o.users) { const [a, b] = u.range(outT, hour); lo = Math.max(lo, a); hi = Math.min(hi, b); }
    return [lo, hi];
  };
  for (let d = 0; d < o.days; d++) {
    const ds: DayStats = { day: d, votes: 0, uncomfortableMin: 0, asleepUncomfortableMin: 0, hvacMin: 0, attendedMin: 0, degreeHours: 0, bandWidth: 0, curveRms: null, nightDrift: null, confidence: 0 };
    let bandSum = 0, bandN = 0, rmsH = 0, rmsC = 0, rmsN = 0, confSum = 0;
    if (o.freezeAfterDay !== undefined && d === o.freezeAfterDay) feed({ type: "freeze", now: fmt(d, 0), on: true });
    for (let minute = 0; minute < 1440; minute += 5) {
      const hour = minute / 60;
      const outT = o.outdoor(d, hour);
      if (minute % 60 === 0) ds.degreeHours += Math.abs(outT - 18);
      const home = o.users.filter((u) => u.home.some(([a, b]) => hour >= a && hour < b));
      const attended = o.hostPresence === false || home.length > 0;
      // room physics (5-min step): the engine's last output decides the equipment; the host turns it off when nobody is home
      const heat = attended && out ? out.heat : o.config.setback.heat;
      const cool = attended && out ? out.cool : o.config.setback.cool;
      let equip: "heat" | "cool" | "idle" = "idle";
      const dt = 5 / 60;
      const eq = typeof o.thermal.equipment === "function" ? o.thermal.equipment(outT) : o.thermal.equipment;
      let rate = o.thermal.envelope * (outT - tin);
      if (tin > cool) { rate -= eq; equip = "cool"; }
      else if (tin < heat) { rate += eq; equip = "heat"; }
      tin += rate * dt;
      if (equip !== "idle") ds.hvacMin += 5;
      if (attended) {
        ds.attendedMin += 5;
        if (minute % 10 === 0) feed({ type: "weather", now: fmt(d, minute), out: Math.round(outT * 10) / 10 });
        feed({ type: "reading", now: fmt(d, minute), tin: Math.round(tin * 100) / 100, equip });
        if (out) { bandSum += out.band.cool - out.band.heat; bandN++; confSum += out.confidence.cool; const [lo, hi] = trueBand(outT, hour); rmsC += (out.band.cool - hi) ** 2; rmsH += (out.band.heat - lo) ** 2; rmsN++; }
      }
      const nightKnot = () => out!.curve.find((k) => k.out === 15)!.heat; // the curve itself, at a fixed outdoor knot: not confounded by the weather moving
      if (out && hour === 23 && minute % 60 === 0) night0 = nightKnot();
      if (out && night0 !== null && hour === 7 && minute % 60 === 0) { ds.nightDrift = Math.abs(nightKnot() - night0); night0 = null; }
      for (const u of home) {
        const [lo, hi] = u.range(outT, hour);
        const dir = tin > hi ? "hot" : tin < lo ? "cold" : null;
        const asleep = u.asleep ? (u.asleep[0] > u.asleep[1] ? hour >= u.asleep[0] || hour < u.asleep[1] : hour >= u.asleep[0] && hour < u.asleep[1]) : false;
        if (!dir) continue;
        ds.uncomfortableMin += 5;
        if (asleep) ds.asleepUncomfortableMin += 5;
        if (!asleep && rnd() < u.voteRate * (5 / 60)) {
          feed({ type: "vote", now: fmt(d, minute), user: u.uid, dir, src: "sim" });
          ds.votes++;
        }
      }
    }
    ds.bandWidth = bandN ? bandSum / bandN : 0;
    ds.confidence = bandN ? confSum / bandN : 0;
    ds.curveRms = rmsN ? { heat: Math.sqrt(rmsH / rmsN), cool: Math.sqrt(rmsC / rmsN) } : null;
    stats.push(ds);
  }
  return { stats, state: s, lastOutput: out };
}

/** A projection of a sim day from the engine's state, for the projection check. */
export function projectDay(s: State, cfg: ZoneConfig, d: number, outdoor: (day: number, hour: number) => number, tin: number) {
  const date = new Date(Date.UTC(2026, 5, 1 + d)).toISOString().slice(0, 10);
  const hours = Array.from({ length: 24 }, (_, h) => ({ now: `${date}T${String(h).padStart(2, "0")}:00:00-07:00`, out: Math.round(outdoor(d, h) * 10) / 10 }));
  return project(s, cfg, { tin, hours });
}
