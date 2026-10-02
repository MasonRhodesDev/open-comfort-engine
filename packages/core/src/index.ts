// open-comfort-engine — reference implementation of spec/SPEC.md.
export * from "./types";
export { init, step, restore, serialize, params, blockAt } from "./engine";
export { phi, erfc, mulberry32 } from "./math";
export { parseWhen } from "./time";

export const SPEC_VERSION = "0.1.1";

/** °F <-> °C helpers for hosts; the engine itself is °C only. */
export const fToC = (f: number): number => ((f - 32) * 5) / 9;
export const cToF = (c: number): number => (c * 9) / 5 + 32;
