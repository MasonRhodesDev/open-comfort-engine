// §2b — the zone's thermal response, learned from consecutive readings:
//   idle:     dtin/dt = envelope · (out − tin)
//   running:  dtin/dt = envelope · (out − tin) − σ · equipment[side]
// envelope in 1/h, equipment rates in °C/h (net of the envelope). No configuration beyond priors.
import type { Equip, Params, Thermal } from "./types";
import { clamp } from "./math";
import { sideOf, type Side } from "./side";

export function newThermal(p: Params): Thermal {
  return { envelope: p.envelopePrior, heat: p.equipmentPrior, cool: p.equipmentPrior };
}

/** The equipment side a reading's `equip` reports, if it was running. */
export function runningSide(equip: Equip | null | undefined): Side | null {
  return equip === "heat" || equip === "cool" ? sideOf(equip) : null;
}

/** One interval between two readings: update the rates it informs. `dtH` in hours, `delta` = out − tin at the start. */
export function observeInterval(th: Thermal, p: Params, dtH: number, dT: number, delta: number, equip: Equip | null): void {
  if (!(dtH > 0)) return;
  const rate = dT / dtH;
  const side = runningSide(equip);
  const f = p.thermalForget;
  if (side === null) {
    if (Math.abs(delta) < 1) return; // too close to outdoor to tell the coupling
    const k = clamp(rate / delta, 0, 5);
    th.envelope = (1 - f) * th.envelope + f * k;
  } else {
    // the equipment's own contribution, net of what the envelope did on its own
    const r = clamp(side.sign * (th.envelope * delta - rate), 0, 20);
    th[side.key] = (1 - f) * th[side.key] + f * r;
  }
}

/** Expected change of the room over `dtH` hours. */
export function expectedChange(th: Thermal, dtH: number, delta: number, equip: Equip | null): number {
  const side = runningSide(equip);
  return (th.envelope * delta - (side ? side.sign * th[side.key] : 0)) * dtH;
}
