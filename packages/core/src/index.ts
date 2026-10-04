// open-comfort-engine — reference implementation of spec/SPEC.md.
export * from "./types";
export { init, step, restore, serialize, params, project } from "./engine";
export type { ProjectionDay } from "./engine";
export { SIDES, HEAT, COOL } from "./side";
export { knots } from "./model";
export { phi, erfc } from "./math";
export { parseWhen, formatWhen } from "./time";

export const SPEC_VERSION = "0.5.0-rc.4";

/** °F <-> °C helpers for hosts; the engine itself is °C only. */
export const fToC = (f: number): number => ((f - 32) * 5) / 9;
export const cToF = (c: number): number => (c * 9) / 5 + 32;
