// §6 — one person's comfort range in one block: a posterior per side.
import type { Block, Params, UserBlockModel } from "./types";
import { COOL, HEAT, type Side } from "./side";
import { clamp, forget, gaussianPrior, meanSigma, phi, phiInv, quantile, update } from "./math";

export interface Grid {
  p: Params;
  g: number[];
}

/** §6.1 prior for one side of a block: its safe quantile is the seed value. */
export function prior(gr: Grid, b: Block, side: Side): number[] {
  const mu = b[side.key] - side.sign * gr.p.priorSigma * phiInv(gr.p.qSafe);
  return gaussianPrior(gr.g, mu, gr.p.priorSigma);
}

export function newModel(gr: Grid, b: Block): UserBlockModel {
  return { lower: prior(gr, b, HEAT), upper: prior(gr, b, COOL), n: 0, step: gr.p.stepInit, lastVote: null };
}

/** §7.1 the edge this person accepts on a side at risk r: slides from the safe quantile (r = 0) to the risky one (r = 1). */
export function edgeAt(gr: Grid, m: UserBlockModel, side: Side, r: number): number {
  const w = m[side.edge];
  const q = (x: number) => quantile(gr.g, w, 0.5 - side.sign * (0.5 - x));
  const safe = q(gr.p.qSafe);
  return safe + r * (q(gr.p.qRisk) - safe);
}

export function edgeSigma(gr: Grid, w: number[]): number {
  return meanSigma(gr.g, w).sigma;
}

export function modelSigma(gr: Grid, m: UserBlockModel): number {
  return Math.max(edgeSigma(gr, m.lower), edgeSigma(gr, m.upper));
}

export function modelConfidence(gr: Grid, m: UserBlockModel): number {
  return clamp(1 - modelSigma(gr, m) / gr.p.priorSigma, 0, 1);
}

/** §6.2 a vote on a side: the room is past this edge. Then §6.4 forgetting. */
export function observeVote(gr: Grid, m: UserBlockModel, b: Block, side: Side, tin: number, weight = 1): void {
  const { p, g } = gr;
  m[side.edge] = update(m[side.edge], (i) => Math.pow(phi((side.sign * (tin - g[i])) / p.voteNoise), weight));
  m[side.edge] = forget(m[side.edge], prior(gr, b, side), p.forget);
  m.n += weight;
}

/** §6.2 silence: the room is inside the range (both sides). */
export function observeSilence(gr: Grid, m: UserBlockModel, sides: readonly Side[], tin: number): void {
  const { p, g } = gr;
  for (const side of sides) {
    m[side.edge] = update(m[side.edge], (i) => 1 - p.silenceWeight + p.silenceWeight * phi((side.sign * (g[i] - tin)) / p.silenceSigma));
  }
}
