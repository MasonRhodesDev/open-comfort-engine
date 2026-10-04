// §6.5 — the zone's thermal response, learned from consecutive readings as a curve over outdoor
// temperature (the same knots as the tolerance curve), because the rate of change is variable:
//   idle:     dtin/dt = envelope(out) · (out − tin)
//   running:  dtin/dt = envelope(out) · (out − tin) − σ · equipment[side](out)
// envelope in 1/h, equipment rates in °C/h (net of the envelope). No configuration beyond priors.
import type { Equip, Params, Thermal, ThermalCurve } from "./types";
import { clamp } from "./math";
import { around, knots } from "./model";
import { sideOf, type Side } from "./side";

export function newThermal(p: Params): ThermalCurve {
  const n = knots(p).length;
  return { envelope: Array(n).fill(p.envelopePrior), heat: Array(n).fill(p.equipmentPrior), cool: Array(n).fill(p.equipmentPrior) };
}

/** The equipment side a reading's `equip` reports, if it was running. */
export function runningSide(equip: Equip | null | undefined): Side | null {
  return equip === "heat" || equip === "cool" ? sideOf(equip) : null;
}

/** The rates at an outdoor temperature (interpolated between knots). */
export function thermalAt(th: ThermalCurve, p: Params, out: number): Thermal {
  const r: Thermal = { envelope: 0, heat: 0, cool: 0 };
  for (const { i, w } of around(p, out)) {
    r.envelope += w * th.envelope[i];
    r.heat += w * th.heat[i];
    r.cool += w * th.cool[i];
  }
  return r;
}

/** One interval between two readings: update the rates it informs, at the outdoor temperature it happened at.
 * `dtH` in hours, `delta` = out − tin at the start, `equip` what the equipment did during the interval. */
export function observeInterval(th: ThermalCurve, p: Params, out: number, dtH: number, dT: number, delta: number, equip: Equip | null): void {
  if (!(dtH > 0)) return;
  const rate = dT / dtH;
  const side = runningSide(equip);
  for (const { i, w } of around(p, out)) {
    const f = p.thermalForget * w;
    if (side === null) {
      if (Math.abs(delta) < 1) continue; // too close to outdoor to tell the coupling
      th.envelope[i] = (1 - f) * th.envelope[i] + f * clamp(rate / delta, 0, 5);
    } else {
      // the equipment's own contribution, net of what the envelope did on its own
      th[side.key][i] = (1 - f) * th[side.key][i] + f * clamp(side.sign * (th.envelope[i] * delta - rate), 0, 20);
    }
  }
}

/** Expected change of the room over `dtH` hours at outdoor `out`. */
export function expectedChange(th: ThermalCurve, p: Params, out: number, dtH: number, delta: number, equip: Equip | null): number {
  const r = thermalAt(th, p, out);
  const side = runningSide(equip);
  return (r.envelope * delta - (side ? side.sign * r[side.key] : 0)) * dtH;
}
