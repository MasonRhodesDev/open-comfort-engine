import type { ZoneConfig } from "../src";
/** A house-like zone: a 0.1 °C auto thermostat with a 1.6 °C minimum gap, seeded 20–24.4 °C. */
export const house: ZoneConfig = {
  id: "house",
  capabilities: { modes: ["heat", "cool", "auto", "off"], minGap: 1.6, setpointStep: 0.1, heat: { min: 10, max: 30 }, cool: { min: 16, max: 32 } },
  seed: { heat: 20, cool: 24.4 },
  setback: { heat: 15, cool: 29 },
};
/** An office-like zone: a heat/cool/off unit with 0.5 °C steps, protected 10–29.4 °C. */
export const office: ZoneConfig = {
  id: "office",
  capabilities: { modes: ["heat", "cool", "off"], minGap: 1.0, setpointStep: 0.5, heat: { min: 17, max: 30 }, cool: { min: 17, max: 30 } },
  seed: { heat: 19, cool: 24.5 },
  setback: { heat: 15, cool: 30 },
  protect: { min: 10, max: 29.4 },
};
