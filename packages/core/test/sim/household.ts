// A two-person household in a warm month: one runs warm, one runs cool; both
// home evenings and nights, one also home during the day.
import { house } from "../fixtures";
import type { SimOptions } from "./sim";

export function household(days: number, extra: Partial<SimOptions> = {}): SimOptions {
  return {
    config: house,
    days,
    users: [
      { uid: "warm", voteRate: 1.5, home: [[0, 8], [9, 24]], range: (h) => (h >= 22 || h < 7 ? [19.5, 23.0] : [21.0, 25.0]) },
      { uid: "cool", voteRate: 1.5, home: [[0, 8], [17, 24]], range: (h) => (h >= 22 || h < 7 ? [18.5, 21.5] : [20.0, 23.5]) },
    ],
    outdoor: (d, h) => 24 + 6 * Math.sin(((h - 9) / 24) * 2 * Math.PI) + 2 * Math.sin(d / 3),
    ...extra,
  };
}
