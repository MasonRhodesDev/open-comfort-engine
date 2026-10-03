// Named event scenarios. They drive the unit tests and are frozen into the
// spec's conformance vectors (spec/vectors/*.jsonl) by make-vectors.ts.
import type { EngineEvent, ZoneConfig } from "../src";
import { house } from "./fixtures";

export type ScenarioStep = EngineEvent | { roundtrip: true };
export interface Scenario {
  name: string;
  description: string;
  config: ZoneConfig;
  steps: ScenarioStep[];
}

const at = (day: number, hhmm: string) => `2026-07-${String(day).padStart(2, "0")}T${hhmm}:00-07:00`;

/** A quiet occupied morning: presence, reading, weather. */
function morning(day: number, users: string[], tin = 24.0, out = 26): EngineEvent[] {
  return [
    { type: "weather", now: at(day, "09:05"), out },
    { type: "presence", now: at(day, "09:06"), users },
    { type: "reading", now: at(day, "09:07"), tin, equip: "idle" },
  ];
}

export const scenarios: Scenario[] = [
  {
    name: "cold-start",
    description: "No votes: the output is the seed block (plus the adaptive term), state SEEDED.",
    config: house,
    steps: [...morning(1, ["u1"]), { type: "tick", now: at(1, "09:10") }],
  },
  {
    name: "vote-nudge-cooldown",
    description: "A hot vote moves the band about one step; a second vote within the cooldown is noted only.",
    config: house,
    steps: [
      ...morning(1, ["u1"], 24.2),
      { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot", src: "test" },
      { type: "vote", now: at(1, "09:30"), user: "u1", dir: "hot", src: "test" },
      { roundtrip: true },
      { type: "tick", now: at(1, "09:35") },
    ],
  },
  {
    name: "stall-reactuates",
    description: "Within the cooldown but after responseMin with the room not moving, a repeat vote nudges again.",
    config: { ...house, responseMin: 10, params: { cooldownMin: 30 } },
    steps: [
      ...morning(1, ["u1"], 24.2),
      { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot" },
      { type: "reading", now: at(1, "09:35"), tin: 24.1, equip: "cool" },
      { type: "vote", now: at(1, "09:36"), user: "u1", dir: "hot" },
    ],
  },
  {
    name: "reversal-halves-step",
    description: "Opposite votes from one user halve their step (see the vote records' step); each vote still ends one step past the room temperature.",
    config: { ...house, params: { cooldownMin: 0 } },
    steps: [
      ...morning(1, ["u1"], 23.0),
      { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot" },
      { type: "reading", now: at(1, "10:20"), tin: 22.0, equip: "cool" },
      { type: "vote", now: at(1, "10:21"), user: "u1", dir: "cold" },
    ],
  },
  {
    name: "two-user-conflict",
    description: "On a narrow band, one user is too hot and the other too cold at the same temperature: the ranges conflict, a conflict is recorded, and the cooling season keeps the cool side.",
    config: { ...house, seed: { blocks: [{ start: "00:00", heat: 22.0, cool: 23.8 }] }, params: { cooldownMin: 0 } },
    steps: [
      ...morning(1, ["u1", "u2"], 22.5, 28),
      { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot" },
      { type: "vote", now: at(1, "09:21"), user: "u2", dir: "cold" },
      { type: "vote", now: at(1, "09:22"), user: "u1", dir: "hot" },
      { type: "vote", now: at(1, "09:23"), user: "u2", dir: "cold" },
      { type: "tick", now: at(1, "09:30") },
    ],
  },
  {
    name: "three-users-uneven",
    description: "Three opaque users, one voting often; aggregation protects the most heat-sensitive present user.",
    config: { ...house, params: { cooldownMin: 0 } },
    steps: [
      ...morning(1, ["a", "b", "c"], 24.0),
      { type: "vote", now: at(1, "09:30"), user: "c", dir: "hot" },
      { type: "reading", now: at(1, "10:30"), tin: 23.2, equip: "cool" },
      { type: "vote", now: at(1, "10:31"), user: "c", dir: "hot" },
      { type: "presence", now: at(1, "11:00"), users: ["a", "b"] },
      { type: "tick", now: at(1, "11:05") },
    ],
  },
  {
    name: "drift-and-complaint",
    description: "Occupied drift widens the band after the pause, capped at the median limit; a complaint resets it.",
    config: house,
    steps: [
      ...morning(1, ["u1"], 23.5),
      { type: "tick", now: at(1, "10:00") },
      { type: "tick", now: at(1, "11:00") },
      { type: "tick", now: at(1, "12:00") },
      { type: "tick", now: at(1, "13:00") },
      { type: "vote", now: at(1, "13:30"), user: "u1", dir: "hot" },
      { type: "tick", now: at(1, "14:00") },
      { type: "tick", now: at(1, "15:00") },
      { type: "tick", now: at(1, "15:59") },
    ],
  },
  {
    name: "vacancy-recovery",
    description: "Vacancy drift accelerates toward setback; recovery starts before a supplied expectedArrival.",
    config: house,
    steps: [
      ...morning(1, ["u1"], 24.0),
      { type: "presence", now: at(1, "10:00"), users: [], expectedArrival: at(1, "14:00") },
      { type: "tick", now: at(1, "11:00") },
      { type: "tick", now: at(1, "12:00") },
      { type: "tick", now: at(1, "13:00") },
      { roundtrip: true },
      { type: "tick", now: at(1, "13:30") },
      { type: "tick", now: at(1, "13:45") },
      { type: "presence", now: at(1, "13:50"), users: [], expectedArrival: at(1, "14:00") },
      { type: "presence", now: at(1, "14:05"), users: ["u1"] },
    ],
  },
  {
    name: "hold-vs-vote",
    description: "A manual change holds until the next block; a vote during the hold is learned but not actuated.",
    config: house,
    steps: [
      ...morning(1, ["u1"], 24.0),
      { type: "manual", now: at(1, "10:00"), applied: { cool: 21.0 } },
      { type: "vote", now: at(1, "10:30"), user: "u1", dir: "cold" },
      { type: "tick", now: at(1, "15:59") },
      { type: "tick", now: at(1, "16:01") },
    ],
  },
  {
    name: "freeze",
    description: "Frozen: no learning, no drift; votes still nudge.",
    config: house,
    steps: [
      ...morning(1, ["u1"], 24.0),
      { type: "freeze", now: at(1, "09:10"), on: true },
      { type: "vote", now: at(1, "09:20"), user: "u1", dir: "hot" },
      { type: "tick", now: at(1, "12:00") },
      { type: "freeze", now: at(1, "12:01"), on: false },
      { type: "tick", now: at(1, "13:00") },
    ],
  },
  {
    name: "out-of-order-and-unknown",
    description: "Events older than the last one, and unknown types, are rejected without changing state.",
    config: house,
    steps: [
      ...morning(1, ["u1"], 24.0),
      { type: "tick", now: at(1, "09:00") },
      { type: "bogus", now: at(1, "09:30") } as unknown as EngineEvent,
      { type: "tick", now: at(1, "09:31") },
    ],
  },
  {
    name: "protect",
    description: "An empty zone in a heat wave: vacancy drift is capped at protect.max; when the room reaches max, output.protect is \"max\" until it falls protectHysteresis below; protection also overrides a manual hold.",
    config: { ...house, protect: { min: 12, max: 27 } },
    steps: [
      { type: "weather", now: at(1, "12:00"), out: 40, high: 40, low: 22 },
      { type: "presence", now: at(1, "12:01"), users: [] },
      { type: "reading", now: at(1, "12:02"), tin: 25.0, equip: "idle" },
      { type: "tick", now: at(1, "14:00") },
      { type: "tick", now: at(1, "15:00") },
      { type: "reading", now: at(1, "15:30"), tin: 27.2, equip: "idle" },
      { type: "reading", now: at(1, "15:45"), tin: 26.5, equip: "cool" },
      { type: "reading", now: at(1, "16:00"), tin: 25.9, equip: "cool" },
      { type: "manual", now: at(1, "16:10"), applied: { cool: 30.0 } },
    ],
  },
  splitScenario(),
];

/** Votes over many days that disagree between morning and afternoon inside the 09–16 block -> a split
 * at the earliest whole-hour boundary that separates them (11:00) once both sides have 5 votes. */
function splitScenario(): Scenario {
  const steps: ScenarioStep[] = [];
  for (let d = 1; d <= 6; d++) {
    steps.push(...morning(d, ["u1"], 23.0));
    steps.push({ type: "vote", now: at(d, "10:30"), user: "u1", dir: "cold" });
    steps.push({ type: "reading", now: at(d, "14:00"), tin: 24.5, equip: "idle" });
    steps.push({ type: "vote", now: at(d, "14:30"), user: "u1", dir: "hot" });
    steps.push({ type: "presence", now: at(d, "22:30"), users: [] });
  }
  steps.push({ type: "tick", now: at(7, "03:05") });
  steps.push({ type: "tick", now: at(7, "13:30") });
  return {
    name: "split",
    description: "Cold votes at 10:30 and hot votes at 14:30 for six days split the 09:00 block at 11:00 (earliest separating boundary) once both sides have splitMinVotes.",
    config: { ...house, params: { trialProb: 0 } },
    steps,
  };
}
