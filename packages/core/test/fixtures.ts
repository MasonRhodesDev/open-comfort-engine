import type { ZoneConfig } from "../src";
const f = (x: number) => Math.round(((x - 32) * 5) / 9 * 100) / 100;
/** A house-like zone: the home-lab seed (76/68, 72/70->66, 68/66->62 °F) on a 0.1 °C thermostat. */
export const house: ZoneConfig = {
  id: "house",
  capabilities: { modes: ["heat", "cool", "auto", "off"], minGap: 1.6, setpointStep: 0.1, heat: { min: 10, max: 30 }, cool: { min: 16, max: 32 } },
  seed: { blocks: [
    { start: "09:00", heat: f(68), cool: f(76) },
    { start: "16:00", heat: f(66), cool: f(72) },
    { start: "22:00", heat: f(62), cool: f(68) },
  ] },
  setback: { heat: 15, cool: 29 },
  responseMin: 45,
};
