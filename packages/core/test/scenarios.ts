// Named event scenarios. They drive the unit tests and are frozen into the
// spec's conformance vectors (spec/vectors/*.jsonl) by make-vectors.ts.
import { init, knots, params, type EngineEvent, type ZoneConfig } from "../src";
import { house, office } from "./fixtures";

export type ScenarioStep = EngineEvent | { roundtrip: true };
export interface Scenario {
  name: string;
  description: string;
  config: ZoneConfig;
  /** a starting snapshot (restored with the config) instead of a fresh state */
  snapshot?: unknown;
  steps: ScenarioStep[];
}

const at = (day: number, hhmm: string) => `2026-07-${String(day).padStart(2, "0")}T${hhmm}:00-07:00`;
const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/** A start: outdoor, then the room. */
function start(day: number, tin: number, out: number, time = "09:05"): EngineEvent[] {
  const [h, m] = time.split(":").map(Number);
  return [
    { type: "weather", now: at(day, time), out },
    { type: "reading", now: at(day, hhmm(h * 60 + m + 1)), tin, equip: "idle" },
  ];
}

/** Quiet attended time: a reading every 10 minutes. */
function quiet(day: number, from: string, minutes: number, tin: number, equip: "idle" | "heat" | "cool" = "idle"): EngineEvent[] {
  const [h, m] = from.split(":").map(Number);
  const evs: EngineEvent[] = [];
  for (let x = 10; x <= minutes; x += 10) evs.push({ type: "reading", now: at(day, hhmm(h * 60 + m + x)), tin, equip });
  return evs;
}

export const scenarios: Scenario[] = [
  {
    name: "cold-start",
    description: "No votes: the band is the seed at any outdoor temperature, state SEEDED, the curve flat.",
    config: house,
    steps: [...start(1, 24.0, 24.5), { type: "tick", now: at(1, "09:10") }, { type: "weather", now: at(1, "09:15"), out: 38 }],
  },
  {
    name: "vote-push-cooldown",
    description: "A hot vote teaches the knots at the current outdoor temperature and pushes the cool edge a step inward of the room; a second vote inside the cooldown while the room is moving is noted; a round-trip is transparent.",
    config: house,
    steps: [
      ...start(1, 24.2, 24.5),
      { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot" },
      { type: "reading", now: at(1, "09:30"), tin: 23.7, equip: "cool" },
      { type: "vote", now: at(1, "09:31"), user: "u1", dir: "hot" },
      { roundtrip: true },
      { type: "tick", now: at(1, "09:35") },
    ],
  },
  {
    name: "stall-reactuates",
    description: "A repeat vote inside the cooldown is acted on when the room has not moved as the equipment should have moved it.",
    config: house,
    steps: [
      ...start(1, 24.2, 24.5),
      { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot" },
      { type: "reading", now: at(1, "09:35"), tin: 24.2, equip: "idle" },
      { type: "vote", now: at(1, "09:36"), user: "u1", dir: "hot" },
    ],
  },
  {
    name: "reversal-halves-step",
    description: "A vote in the opposite direction halves the voter's step; the push on the other side is independent.",
    config: house,
    steps: [
      ...start(1, 23.0, 24.5),
      { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot" },
      { type: "reading", now: at(1, "10:20"), tin: 22.0, equip: "cool" },
      { type: "vote", now: at(1, "10:21"), user: "u1", dir: "cold" },
    ],
  },
  {
    name: "two-voters-conflict",
    description: "Two people vote opposite ways at the same outdoor temperature: both edges are pushed, the safe band narrows past the device gap (conflict), the side the air pushes toward is kept.",
    config: house,
    steps: [
      ...start(1, 22.5, 28),
      { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot" },
      { type: "vote", now: at(1, "09:21"), user: "u2", dir: "cold" },
      { type: "vote", now: at(1, "09:52"), user: "u1", dir: "hot" },
      { type: "vote", now: at(1, "09:53"), user: "u2", dir: "cold" },
      { type: "tick", now: at(1, "10:00") },
    ],
  },
  {
    name: "exploration",
    description: "Quiet attended time widens an uncertain band past the room (exploration), a gap in events breaks the streak (an empty house teaches nothing), and a vote pushes one edge back without touching the other.",
    config: house,
    steps: [
      ...start(1, 25.0, 25),
      ...quiet(1, "09:06", 240, 25.0),
      { type: "reading", now: at(1, "16:00"), tin: 25.5, equip: "idle" },
      ...quiet(1, "16:00", 60, 25.5),
      { type: "vote", now: at(1, "17:05"), user: "u1", dir: "hot" },
      { type: "tick", now: at(1, "17:10") },
    ],
  },
  {
    name: "nature-release",
    description: "The outdoor air pushes the room along out − tin. A side the room is pushed away from is released to setback (heating on a hot morning, cooling on a cool evening) with hysteresis; a cold vote un-releases heating at once; a room that caught up with the air short of the band is conditioned; stale weather releases nothing.",
    config: house,
    steps: [
      ...start(1, 19.9, 31),
      { type: "weather", now: at(1, "10:00"), out: 21.2 },
      { type: "weather", now: at(1, "10:05"), out: 20.4 },
      { type: "weather", now: at(1, "10:10"), out: 18.5 },
      { type: "weather", now: at(1, "10:15"), out: 31 },
      { type: "vote", now: at(1, "10:20"), user: "u1", dir: "cold" },
      { type: "reading", now: at(1, "17:00"), tin: 26.0, equip: "idle" },
      { type: "weather", now: at(1, "17:01"), out: 18 },
      { type: "reading", now: at(1, "17:05"), tin: 14.0, equip: "idle" },
      { type: "weather", now: at(1, "17:06"), out: 15 },
      { type: "reading", now: at(1, "17:11"), tin: 14.95, equip: "idle" },
      { type: "reading", now: at(1, "21:30"), tin: 20, equip: "idle" },
    ],
  },
  {
    name: "manual",
    description: "A manual change inward of the output is learned as a weak vote and pushes the edge to the applied value; an outward change is ignored; it is not a complaint, so a released side stays released.",
    config: house,
    steps: [
      ...start(1, 24.0, 24),
      { type: "manual", now: at(1, "09:10"), applied: { cool: 21.0 } },
      { type: "manual", now: at(1, "09:12"), applied: { cool: 27.0, heat: 15 } },
      { type: "weather", now: at(1, "09:14"), out: 31 },
      { type: "reading", now: at(1, "09:15"), tin: 19.9, equip: "idle" },
      { type: "manual", now: at(1, "09:16"), applied: { heat: 21.5 } },
    ],
  },
  {
    name: "protect",
    description: "A heat wave in a protected zone: the cooling setpoint is capped at protect.max (rounded inward); when the room reaches max, output.protect is \"max\" until it falls protectHysteresis below; protection overrides release and freeze.",
    config: office,
    steps: [
      { type: "weather", now: at(1, "12:00"), out: 40 },
      { type: "reading", now: at(1, "12:01"), tin: 25.0, equip: "idle" },
      { type: "reading", now: at(1, "12:06"), tin: 29.6, equip: "idle" },
      { type: "reading", now: at(1, "12:11"), tin: 29.0, equip: "cool" },
      { type: "reading", now: at(1, "12:16"), tin: 28.3, equip: "cool" },
      { type: "freeze", now: at(1, "12:17"), on: true },
      { type: "weather", now: at(1, "12:18"), out: 20 },
      { type: "reading", now: at(1, "12:19"), tin: 29.5, equip: "idle" },
    ],
  },
  {
    name: "thermal",
    description: "Idle intervals teach the envelope coupling; running intervals teach the equipment rate; the model is reported in the output.",
    config: house,
    steps: [
      { type: "weather", now: at(1, "09:00"), out: 30 },
      { type: "reading", now: at(1, "09:00"), tin: 20.0, equip: "idle" },
      { type: "reading", now: at(1, "09:10"), tin: 20.83, equip: "idle" },
      { type: "reading", now: at(1, "09:20"), tin: 21.6, equip: "idle" },
      { type: "reading", now: at(1, "09:30"), tin: 22.3, equip: "cool" },
      { type: "reading", now: at(1, "09:40"), tin: 22.44, equip: "cool" },
      { type: "reading", now: at(1, "09:50"), tin: 22.57, equip: "cool" },
    ],
  },
  {
    name: "out-of-order-and-unknown",
    description: "Events older than the last one, unknown types, and non-finite readings are rejected without changing state.",
    config: house,
    steps: [
      ...start(1, 24.0, 24.5),
      { type: "tick", now: at(1, "09:00") },
      { type: "bogus", now: at(1, "09:30") } as unknown as EngineEvent,
      { type: "reading", now: at(1, "09:31"), tin: Number.NaN, equip: "idle" },
      { type: "tick", now: at(1, "09:32") },
    ],
  },
  {
    name: "freeze",
    description: "Frozen: no learning, no exploration (the thermal model included); votes still push.",
    config: house,
    steps: [
      ...start(1, 24.2, 24.5),
      { type: "freeze", now: at(1, "09:10"), on: true },
      { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot" },
      ...quiet(1, "09:20", 120, 24.2),
      { type: "freeze", now: at(1, "11:21"), on: false },
      { type: "tick", now: at(1, "11:25") },
    ],
  },
  {
    name: "idle-gain",
    description: "A room that warms by itself with cooler air outside (people, machines, sun): cooling is released at priors as rc.6 did, taken back once the learned drift says the air cannot close the gap (after the dwell), and — the gain learned — not released again while the room sits a step past the edge; the act is published, and an off-capable device is off while idle.",
    config: office,
    steps: [
      { type: "weather", now: at(1, "09:00"), out: 23.5 },
      { type: "reading", now: at(1, "09:00"), tin: 24.9, equip: "idle" },
      { type: "reading", now: at(1, "09:10"), tin: 25.4, equip: "idle" },
      { type: "reading", now: at(1, "09:20"), tin: 25.9, equip: "idle" },
      { type: "reading", now: at(1, "09:30"), tin: 26.4, equip: "idle" },
      { type: "reading", now: at(1, "09:40"), tin: 25.9, equip: "cool" },
      { roundtrip: true },
      { type: "reading", now: at(1, "09:50"), tin: 25.4, equip: "cool" },
      { type: "reading", now: at(1, "10:00"), tin: 24.9, equip: "cool" },
      { type: "reading", now: at(1, "10:10"), tin: 24.4, equip: "cool" },
    ],
  },
  {
    name: "migrate-v3",
    description: "A version-3 snapshot (0.5.0-rc.6) restores into version 4: the curve and the equipment rates are kept, the idle statistics start at zero (envelope at its prior, gain 0), the act is published; the next idle interval teaches the new statistics.",
    config: office,
    snapshot: v3Snapshot(office),
    steps: [
      { type: "weather", now: at(1, "09:00"), out: 20 },
      { type: "reading", now: at(1, "09:00"), tin: 23.0, equip: "idle" },
      { type: "reading", now: at(1, "09:10"), tin: 23.3, equip: "idle" },
    ],
  },
];

/** A version-3 snapshot as 0.5.0-rc.6 wrote it: a fresh curve, the thermal model as three per-knot arrays with
 * a learned cooling rate. */
function v3Snapshot(config: ZoneConfig): unknown {
  const s = init(config) as unknown as Record<string, unknown>;
  const n = knots(params(config)).length;
  return { ...s, snapshotVersion: 3, thermal: { envelope: Array(n).fill(0.3), heat: Array(n).fill(2), cool: Array(n).fill(3.2) } };
}
