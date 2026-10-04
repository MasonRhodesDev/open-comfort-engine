// Two households for the simulator. True tolerance bends with outdoor temperature: people accept
// a warmer room on a hot day and a cooler one on a cold day, less than 1:1 (the shape the engine
// is expected to *find*, never told). Everyone sleeps 23:00–07:00 and cannot vote then.
import { house, office } from "../fixtures";
import type { SimOptions, SimUser } from "./sim";

/** accepted range at outdoor `out`: a mild slope, saturating at the extremes */
const bend = (out: number) => Math.tanh((out - 22) / 12) * 2.5;

export function houseUsers(): SimUser[] {
  return [
    // runs warm: complains about heat sooner
    { uid: "warm", voteRate: 1.5, home: [[0, 8], [17, 24]], asleep: [23, 7], range: (out) => [19.0 + bend(out), 23.5 + bend(out)] },
    // runs cool: complains about cold sooner; home all day
    { uid: "cool", voteRate: 1.5, home: [[0, 24]], asleep: [23, 7], range: (out) => [20.5 + bend(out), 25.5 + bend(out)] },
  ];
}

/** A summer-ish month: 22 ± 8 °C diurnal swing plus a slow weather cycle. */
export const summerOutdoor = (d: number, h: number) => 22 + 8 * Math.sin(((h - 9) / 24) * 2 * Math.PI) + 4 * Math.sin(d / 5);
/** A shoulder season: cooler, with cold nights. */
export const shoulderOutdoor = (d: number, h: number) => 14 + 7 * Math.sin(((h - 9) / 24) * 2 * Math.PI) + 4 * Math.sin(d / 5);

export function household(days: number, extra: Partial<SimOptions> = {}): SimOptions {
  return {
    config: house,
    users: houseUsers(),
    days,
    outdoor: summerOutdoor,
    thermal: { envelope: 0.15, equipment: 3.0 }, // a house: slow, but the equipment can hold it on a hot day
    ...extra,
  };
}

export function officeHousehold(days: number, extra: Partial<SimOptions> = {}): SimOptions {
  return {
    config: office,
    users: [{ uid: "m", voteRate: 2, home: [[9, 16], [20, 22]], range: (out) => [18.5 + bend(out), 25.0 + bend(out)] }],
    days,
    outdoor: summerOutdoor,
    thermal: { envelope: 0.6, equipment: 8 }, // a small office: fast both ways
    ...extra,
  };
}
