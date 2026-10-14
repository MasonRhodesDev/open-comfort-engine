// §6.5 — the zone's thermal response, learned from consecutive readings as a curve over outdoor
// temperature (the same knots as the tolerance curve), because the rate of change is variable:
//   idle:     dtin/dt = idle(out, tin) = envelope(out) · (out − tin) + gain(out)
//   running:  dtin/dt = idle(out, tin) − σ · equipment[side](out)
// envelope in 1/h, gain in °C/h (what the room makes or loses by itself), equipment rates in °C/h
// (net of the idle drift). Per knot, envelope and gain are the least-squares line of the idle rate on
// x = out − tin through the knot's statistics and a permanent prior. No configuration beyond priors.
import type { Equip, IdleStats, Params, Thermal, ThermalCurve } from "./types";
import { clamp } from "./math";
import { around, knots } from "./model";
import { sideOf, type Side } from "./side";

const ENVELOPE: readonly [number, number] = [0.02, 5];
const GAIN: readonly [number, number] = [-10, 10];
const EQUIPMENT: readonly [number, number] = [0.1, 20];

export const zeroStats = (): IdleStats => ({ n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0 });

export function newThermal(p: Params): ThermalCurve {
  const n = knots(p).length;
  return { idle: Array.from({ length: n }, zeroStats), heat: Array(n).fill(p.equipmentPrior), cool: Array(n).fill(p.equipmentPrior) };
}

/** The equipment side a reading's `equip` reports, if it was running. */
export function runningSide(equip: Equip | null | undefined): Side | null {
  return equip === "heat" || equip === "cool" ? sideOf(equip) : null;
}

/** §6.5 one knot's fitted idle line — slope (envelope) and intercept (gain) — through its statistics and the
 * prior: thermalPriorHours of pseudo-observations on rate = envelopePrior · x, half at x = +3 and half at
 * x = −3, added whenever the rates are evaluated (never stored, never forgotten). The denominator is at
 * least 9h², so a room whose x barely varies keeps a finite fit: the prior decides how the prediction splits
 * between slope and intercept. */
export function fitKnot(s: IdleStats, p: Params): { envelope: number; gain: number } {
  const h = p.thermalPriorHours;
  const N = s.n + h;
  const SXX = s.sxx + 9 * h;
  const SXY = s.sxy + 9 * h * p.envelopePrior;
  const den = N * SXX - s.sx * s.sx;
  const envelope = den > 1e-12 ? clamp((N * SXY - s.sx * s.sy) / den, ENVELOPE[0], ENVELOPE[1]) : p.envelopePrior;
  const gain = N > 0 ? clamp((s.sy - envelope * s.sx) / N, GAIN[0], GAIN[1]) : 0;
  return { envelope, gain };
}

/** The rates at an outdoor temperature: the §6.1 interpolation of the two knots' fitted values (never of
 * the statistics). */
export function thermalAt(th: ThermalCurve, p: Params, out: number): Thermal {
  const r: Thermal = { envelope: 0, gain: 0, heat: 0, cool: 0 };
  for (const { i, w } of around(p, out)) {
    const f = fitKnot(th.idle[i], p);
    r.envelope += w * f.envelope;
    r.gain += w * f.gain;
    r.heat += w * th.heat[i];
    r.cool += w * th.cool[i];
  }
  return r;
}

/** §6.5 the room's own drift at this outdoor and room temperature, °C/h (positive: warming). */
export function idleRate(th: ThermalCurve, p: Params, out: number, tin: number): number {
  const r = thermalAt(th, p, out);
  return r.envelope * (out - tin) + r.gain;
}

/** One interval between two readings: update the rates it informs, at the outdoor temperature it happened at.
 * `dtH` in hours, `x` = out − tin at the start, `equip` what the equipment did during the interval (idle, fan
 * or off teach the idle drift; heat or cool that side; none at all teaches nothing). An interval whose rate no
 * admissible line can produce is a sensor fault and teaches nothing. Each interval is as much evidence as it
 * is long (w = wt · dtH); forgetting is per hour of evidence. */
export function observeInterval(th: ThermalCurve, p: Params, out: number, dtH: number, dT: number, x: number, equip: Equip | null | undefined): void {
  if (!(dtH > 0) || equip === null || equip === undefined) return;
  const rate = dT / dtH;
  const side = runningSide(equip);
  const admissible = ENVELOPE[1] * Math.abs(x) + GAIN[1] + (side ? EQUIPMENT[1] : 0);
  if (Math.abs(rate) > admissible) return;
  for (const { i, w: wt } of around(p, out)) {
    const w = wt * dtH;
    const f = p.thermalForget * w;
    if (side === null) {
      const s = th.idle[i];
      s.n = (1 - f) * s.n + w;
      s.sx = (1 - f) * s.sx + w * x;
      s.sy = (1 - f) * s.sy + w * rate;
      s.sxx = (1 - f) * s.sxx + w * x * x;
      s.sxy = (1 - f) * s.sxy + w * x * rate;
    } else {
      // the equipment's own contribution, net of what the room does on its own (the knot's fitted idle line);
      // a floor, never zero: a mislabelled interval can pull a rate down, and it recovers
      const k = fitKnot(th.idle[i], p);
      th[side.key][i] = (1 - f) * th[side.key][i] + f * clamp(side.sign * (k.envelope * x + k.gain - rate), EQUIPMENT[0], EQUIPMENT[1]);
    }
  }
}

/** Expected change of the room over `dtH` hours at outdoor `out`, with `delta` = out − tin at the start. */
export function expectedChange(th: ThermalCurve, p: Params, out: number, dtH: number, delta: number, equip: Equip | null): number {
  const r = thermalAt(th, p, out);
  const side = runningSide(equip);
  return (r.envelope * delta + r.gain - (side ? side.sign * r[side.key] : 0)) * dtH;
}
