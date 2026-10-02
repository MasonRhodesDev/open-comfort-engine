// Household simulator: synthetic occupants with hidden "true" comfort ranges, a
// first-order room model, and stochastic votes when someone is actually
// uncomfortable. Deterministic (seeded). Used by sim.test.ts and the CLI.
import { init, step, mulberry32, type EngineEvent, type Output, type State, type ZoneConfig } from "../../src";

export interface SimUser {
  uid: string;
  /** true comfort range per hour of day, °C (indoor) */
  range: (hour: number) => [number, number];
  /** chance per hour of voting while uncomfortable */
  voteRate: number;
  /** home between these hours (local), every day */
  home: [number, number][];
}

export interface SimOptions {
  config: ZoneConfig;
  users: SimUser[];
  days: number;
  seed?: number;
  /** outdoor temperature at a given day/hour */
  outdoor: (day: number, hour: number) => number;
  freezeAfterDay?: number;
  /** whether the simulated integration supplies expectedArrival/expectedUsers (default true) */
  predictArrivals?: boolean;
}

export interface DayStats {
  day: number;
  votes: number;
  hot: number;
  cold: number;
  uncomfortableMin: number; // person-minutes outside their true range while home
  hvacMin: number; // minutes the HVAC ran (energy proxy)
  meanBand: number; // mean cool − heat while occupied
  byHour: Record<string, number>; // uncomfortable person-minutes by `${uid}:${hour}:${dir}`
}

export function simulate(o: SimOptions): { stats: DayStats[]; state: State; lastOutput: Output | null } {
  let rngState = (o.seed ?? 7) >>> 0;
  const rnd = () => {
    const [v, n] = mulberry32(rngState);
    rngState = n;
    return v;
  };
  let s = init(o.config);
  let out: Output | null = null;
  let tin = 23;
  const stats: DayStats[] = [];
  const fmt = (d: number, minute: number) => {
    const date = new Date(Date.UTC(2026, 5, 1 + d));
    const hh = String(Math.floor(minute / 60)).padStart(2, "0");
    const mm = String(minute % 60).padStart(2, "0");
    return `${date.toISOString().slice(0, 10)}T${hh}:${mm}:00-07:00`;
  };
  const feed = (e: EngineEvent) => {
    const r = step(s, e, o.config);
    s = r.state;
    out = r.output;
  };
  for (let d = 0; d < o.days; d++) {
    const ds: DayStats = { day: d, votes: 0, hot: 0, cold: 0, uncomfortableMin: 0, hvacMin: 0, meanBand: 0, byHour: {} };
    let bandSum = 0;
    let bandN = 0;
    if (o.freezeAfterDay !== undefined && d === o.freezeAfterDay) feed({ type: "freeze", now: fmt(d, 0), on: true });
    let lastPresent = "";
    for (let minute = 0; minute < 1440; minute += 5) {
      const hour = minute / 60;
      const out_ = o.outdoor(d, hour);
      const present = o.users.filter((u) => u.home.some(([a, b]) => hour >= a && hour < b)).map((u) => u.uid);
      const key = present.join(",");
      if (key !== lastPresent) {
        // the integration's job in real life: predict who arrives next, and when (here: from the schedule)
        let next: { at: number; users: string[] } | null = null;
        for (const u of o.users) {
          if (present.includes(u.uid)) continue;
          for (let ahead = 5; ahead <= 1440; ahead += 5) {
            const hh = ((minute + ahead) % 1440) / 60;
            if (u.home.some(([a, b]) => hh >= a && hh < b)) {
              if (!next || ahead < next.at) next = { at: ahead, users: [u.uid] };
              else if (ahead === next.at) next.users.push(u.uid);
              break;
            }
          }
        }
        const expectedArrival = next && o.predictArrivals !== false ? fmt(d + Math.floor((minute + next.at) / 1440), (minute + next.at) % 1440) : null;
        feed({ type: "presence", now: fmt(d, minute), users: present, expectedArrival, expectedUsers: expectedArrival ? next!.users : [] });
        lastPresent = key;
      }
      if (minute % 30 === 0) feed({ type: "weather", now: fmt(d, minute), out: out_ });
      // room physics (5-min step): leak toward outdoor-ish, HVAC pushes back inside the band
      const heat = out?.heat ?? 20;
      const cool = out?.cool ?? 24;
      let equip: "heat" | "cool" | "idle" = "idle";
      tin += (0.6 * out_ + 0.4 * 24 - tin) * 0.02;
      if (tin > cool) { tin -= 0.25; equip = "cool"; ds.hvacMin += 5; }
      else if (tin < heat) { tin += 0.25; equip = "heat"; ds.hvacMin += 5; }
      feed({ type: "reading", now: fmt(d, minute), tin: Math.round(tin * 100) / 100, equip });
      if (present.length) { bandSum += cool - heat; bandN++; }
      for (const u of o.users) {
        if (!present.includes(u.uid)) continue;
        const [lo, hi] = u.range(hour);
        const dir = tin > hi ? "hot" : tin < lo ? "cold" : null;
        if (!dir) continue;
        ds.uncomfortableMin += 5;
        const k = `${u.uid}:${Math.floor(hour)}:${dir}`;
        ds.byHour[k] = (ds.byHour[k] || 0) + 5;
        if (rnd() < u.voteRate * (5 / 60)) {
          feed({ type: "vote", now: fmt(d, minute), user: u.uid, dir, src: "sim" });
          ds.votes++;
          if (dir === "hot") ds.hot++; else ds.cold++;
        }
      }
    }
    ds.meanBand = bandN ? bandSum / bandN : 0;
    stats.push(ds);
  }
  return { stats, state: s, lastOutput: out };
}
