// §1.1 — a side of the band. Every per-setpoint rule in the engine is written
// once against this description and run for both sides.
import type { Dir, PerSide, SideKey } from "./types";

export interface Side {
  key: SideKey;
  /** +1: the edge is an upper limit (cool); −1: a lower limit (heat) */
  sign: 1 | -1;
  /** the posterior this side learns */
  edge: "upper" | "lower";
  /** the protection limit this side respects */
  limit: "max" | "min";
  /** the vote that says the room is past this edge */
  dir: Dir;
}

export const COOL: Side = { key: "cool", sign: 1, edge: "upper", limit: "max", dir: "hot" };
export const HEAT: Side = { key: "heat", sign: -1, edge: "lower", limit: "min", dir: "cold" };
export const SIDES: readonly Side[] = [HEAT, COOL];

export function sideOf(key: SideKey): Side {
  return key === "cool" ? COOL : HEAT;
}

export function sideForVote(dir: Dir): Side {
  return dir === "hot" ? COOL : HEAT;
}

export function perSide<T>(f: (side: Side) => T): PerSide<T> {
  return { heat: f(HEAT), cool: f(COOL) };
}

/** The innermost of two values on a side (the one closer to the middle of the band). */
export function inner(side: Side, a: number, b: number): number {
  return side.sign * Math.min(side.sign * a, side.sign * b);
}

/** How far `x` lies inward of `edge` on a side (negative: outward). */
export function inwardOf(side: Side, edge: number, x: number): number {
  return side.sign * (edge - x);
}
