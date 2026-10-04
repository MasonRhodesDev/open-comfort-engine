// §6 — the tolerance curve: for each side, a posterior over the indoor edge at every
// outdoor-temperature knot. One curve per zone; no identity, no time of day.
import type { CurvePoint, Knot, Params, PerSide } from "./types";
import { COOL, HEAT, type Side } from "./side";
import { clamp, forget, gaussianPrior, meanSigma, phi, phiInv, quantile, update } from "./math";

export interface Grid {
  p: Params;
  g: number[];
}

/** §6.1 the knots' outdoor temperatures */
export function knots(p: Params): number[] {
  const out: number[] = [];
  for (let x = p.knotMin; x <= p.knotMax + 1e-9; x += p.knotStep) out.push(Number(x.toFixed(6)));
  return out;
}

/** §6.1 prior for one side: its safe quantile is the seed value. */
export function prior(gr: Grid, seed: PerSide<number>, side: Side): number[] {
  const mu = seed[side.key] - side.sign * gr.p.priorSigma * phiInv(gr.p.qSafe);
  return gaussianPrior(gr.g, mu, gr.p.priorSigma);
}

export function newCurve(gr: Grid, seed: PerSide<number>): PerSide<Knot[]> {
  const make = (side: Side) => knots(gr.p).map(() => ({ w: prior(gr, seed, side), n: 0 }));
  return { heat: make(HEAT), cool: make(COOL) };
}

/** §6.1 the two knots around an outdoor temperature and their interpolation weights (clamped at the ends). */
export function around(p: Params, out: number): { i: number; w: number }[] {
  const ks = knots(p);
  if (out <= ks[0]) return [{ i: 0, w: 1 }];
  if (out >= ks[ks.length - 1]) return [{ i: ks.length - 1, w: 1 }];
  const f = (out - p.knotMin) / p.knotStep;
  const i = Math.floor(f);
  const t = f - i;
  if (t < 1e-9) return [{ i, w: 1 }];
  return [{ i, w: 1 - t }, { i: i + 1, w: t }];
}

/** §6.2 a vote on a side: the room is past this edge. Then §6.4 forgetting. */
export function observeVote(gr: Grid, curve: PerSide<Knot[]>, seed: PerSide<number>, side: Side, out: number, tin: number, weight = 1): void {
  const { p, g } = gr;
  const pr = prior(gr, seed, side);
  for (const { i, w } of around(p, out)) {
    const k = curve[side.key][i];
    const wt = weight * w;
    k.w = update(k.w, (j) => Math.pow(phi((side.sign * (tin - g[j])) / p.voteNoise), wt));
    k.w = forget(k.w, pr, p.forget * wt);
    k.n += wt;
  }
}

/** §6.3 quiet attended time: the room may be acceptable (exploration), with the given weight on a side. */
export function observeSilence(gr: Grid, curve: PerSide<Knot[]>, side: Side, out: number, tin: number, weight: number): void {
  const { p, g } = gr;
  if (weight <= 0) return;
  for (const { i, w } of around(p, out)) {
    const k = curve[side.key][i];
    const s = clamp(weight * w, 0, 1);
    k.w = update(k.w, (j) => 1 - s + s * phi((side.sign * (g[j] - tin)) / p.silenceSigma));
  }
}

/** A knot's edge at a quantile (0.5 ± toward the safe side), and its spread. */
function knotQuantile(gr: Grid, k: Knot, side: Side, q: number): number {
  return quantile(gr.g, k.w, 0.5 - side.sign * (0.5 - q));
}

/** §7.1 the curve's edge on a side at an outdoor temperature, at quantile q (default: the safe quantile). */
export function edgeAt(gr: Grid, curve: PerSide<Knot[]>, side: Side, out: number, q = gr.p.qSafe): number {
  let v = 0;
  for (const { i, w } of around(gr.p, out)) v += w * knotQuantile(gr, curve[side.key][i], side, q);
  return v;
}

export function sigmaAt(gr: Grid, curve: PerSide<Knot[]>, side: Side, out: number): number {
  let v = 0;
  for (const { i, w } of around(gr.p, out)) v += w * meanSigma(gr.g, curve[side.key][i].w).sigma;
  return v;
}

/** §6.1 confidence in an edge: 0 at the prior's spread, 1 when fully resolved. */
export function confidenceAt(gr: Grid, curve: PerSide<Knot[]>, side: Side, out: number): number {
  return clamp(1 - sigmaAt(gr, curve, side, out) / gr.p.priorSigma, 0, 1);
}

export function votesAt(gr: Grid, curve: PerSide<Knot[]>, side: Side, out: number): number {
  let v = 0;
  for (const { i, w } of around(gr.p, out)) v += w * curve[side.key][i].n;
  return v;
}

/** §7.8 the curve for graphs: the safe edge and spread at every knot. */
export function curvePoints(gr: Grid, curve: PerSide<Knot[]>): CurvePoint[] {
  return knots(gr.p).map((out, i) => ({
    out,
    heat: knotQuantile(gr, curve.heat[i], HEAT, gr.p.qSafe),
    cool: knotQuantile(gr, curve.cool[i], COOL, gr.p.qSafe),
    heatSigma: meanSigma(gr.g, curve.heat[i].w).sigma,
    coolSigma: meanSigma(gr.g, curve.cool[i].w).sigma,
  }));
}
