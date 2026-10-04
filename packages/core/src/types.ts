// Types for the Open Comfort Engine. Section numbers refer to spec/SPEC.md.

export type Mode = "heat" | "cool" | "auto" | "off";
export type Dir = "hot" | "cold";
export type Equip = "heat" | "cool" | "fan" | "idle" | "off";

/** §1.1 — a side of the band. Everything per-setpoint is keyed by this. */
export type SideKey = "heat" | "cool";
/** A value per side. */
export type PerSide<T> = { heat: T; cool: T };

/** §3 */
export interface ZoneConfig {
  id: string;
  capabilities: {
    modes: Mode[];
    minGap: number;
    setpointStep: number;
    heat: { min: number; max: number };
    cool: { min: number; max: number };
  };
  /** §3.2 where the tolerance curve starts: one range, flat over outdoor temperature */
  seed: PerSide<number>;
  /** §3.3 what a released side is set to */
  setback: PerSide<number>;
  /** §3.3 absolute indoor range that must never be crossed */
  protect?: { min?: number; max?: number };
  params?: Partial<Params>;
}

/** §3.4 */
export interface Params {
  gridMin: number;
  gridMax: number;
  gridStep: number;
  knotMin: number;
  knotMax: number;
  knotStep: number;
  priorSigma: number;
  voteNoise: number;
  silenceSigma: number;
  silenceWeight: number;
  silenceEveryMin: number;
  attendedGapMin: number;
  manualWeight: number;
  forget: number;
  qSafe: number;
  stepInit: number;
  stepMin: number;
  stepMax: number;
  stepGrow: number;
  cooldownMin: number;
  repeatWindowMin: number;
  natureMargin: number;
  releaseDwellMin: number;
  complaintMin: number;
  envelopePrior: number;
  equipmentPrior: number;
  thermalForget: number;
  convergedSigma: number;
  convergedVotes: number;
  protectHysteresis: number;
  snapshotEveryMin: number;
}

export const DEFAULT_PARAMS: Params = {
  gridMin: 14,
  gridMax: 32,
  gridStep: 0.1,
  knotMin: -10,
  knotMax: 45,
  knotStep: 5,
  priorSigma: 1.5,
  voteNoise: 0.7,
  silenceSigma: 2.0,
  silenceWeight: 0.3,
  silenceEveryMin: 60,
  attendedGapMin: 10,
  manualWeight: 0.5,
  forget: 0.02,
  qSafe: 0.2,
  stepInit: 1.0,
  stepMin: 0.3,
  stepMax: 2.0,
  stepGrow: 1.25,
  cooldownMin: 30,
  repeatWindowMin: 120,
  natureMargin: 1.0,
  releaseDwellMin: 30,
  complaintMin: 120,
  envelopePrior: 0.3,
  equipmentPrior: 2.0,
  thermalForget: 0.1,
  convergedSigma: 0.6,
  convergedVotes: 20,
  protectHysteresis: 1.0,
  snapshotEveryMin: 60,
};

/** §4 */
export type EngineEvent =
  | { type: "vote"; now: string; user: string; dir: Dir; src?: string }
  | { type: "reading"; now: string; tin: number; rh?: number; equip?: Equip; applied?: Applied }
  | { type: "weather"; now: string; out: number; high?: number; low?: number }
  | { type: "manual"; now: string; applied: Applied }
  | { type: "freeze"; now: string; on: boolean }
  | { type: "tick"; now: string }
  | { type: "restore"; now: string; snapshot: Snapshot };

export interface Applied {
  heat?: number;
  cool?: number;
  mode?: Mode;
}

export type StateName = "SEEDED" | "LEARNING" | "CONVERGED" | "FROZEN";

/** §6.1 one point of the tolerance curve, for graphs */
export interface CurvePoint {
  out: number;
  heat: number;
  cool: number;
  heatSigma: number;
  coolSigma: number;
  /** the thermal response at this knot */
  thermal: Thermal;
}

/** §6.5 the thermal response at one outdoor temperature */
export interface Thermal {
  /** 1/h: idle rate of change per °C of (out − tin) */
  envelope: number;
  /** °C/h the equipment adds on each side, net of the envelope */
  heat: number;
  cool: number;
}

/** §6.5 the learned thermal response: one value per outdoor-temperature knot (the curve's knots) */
export interface ThermalCurve {
  envelope: number[];
  heat: number[];
  cool: number[];
}

/** §7.8 */
export interface Output {
  heat: number;
  cool: number;
  mode: Mode;
  state: StateName;
  /** the learned band at the current outdoor temperature, before release and protection */
  band: PerSide<number>;
  released: PerSide<boolean>;
  /** the felt edge a vote pushed to, while it is still inward of the learned edge; else null */
  push: PerSide<number | null>;
  reasons: string[];
  confidence: PerSide<number>;
  /** band − out; null without an outdoor temperature */
  deltaFromAmbient: PerSide<number | null>;
  /** the thermal response at the current outdoor temperature */
  thermal: Thermal;
  curve: CurvePoint[];
  /** §7.6: the room is beyond a protection limit; hosts MUST actuate toward the output */
  protect: "max" | "min" | null;
}

/** §7.9 one hour of a projected day */
export interface ProjectedHour {
  now: string;
  out: number;
  tin: number;
  band: PerSide<number>;
  heat: number;
  cool: number;
  released: PerSide<boolean>;
  equipment: "heat" | "cool" | "idle";
  runMin: number;
  deltaFromAmbient: PerSide<number>;
}

export type FeedbackCode = "nudge.cooler" | "nudge.warmer" | "noted.cooldown" | "noted.no_reading";

export interface EngineRecord {
  type: "vote" | "decision" | "rejected";
  at: string;
  zone: string;
  [k: string]: unknown;
}

/** §10 */
export interface Effects {
  records: EngineRecord[];
  snapshot?: Snapshot;
  feedback?: FeedbackCode;
}

/** §6.1 one knot of one side: a posterior over the indoor edge, and the vote weight it has seen */
export interface Knot {
  w: number[];
  n: number;
}

export interface Voter {
  step: number;
  lastVote: { at: number; dir: Dir; tin: number; equip: Equip | null } | null;
}

/** §5.1 / §9 — the complete engine state, JSON-serialisable. */
export interface Snapshot {
  snapshotVersion: 3;
  zone: string;
  /** the seed and the grid/knot parameters the curve was built with; a change restarts it (§3.2, §9) */
  seedKey: string;
  /** §6.1 the tolerance curve: one knot per outdoor temperature, per side */
  curve: PerSide<Knot[]>;
  voters: Record<string, Voter>;
  reading: { tin: number; rh: number | null; equip: Equip | null; applied: Applied | null; at: number } | null;
  weather: { out: number; high: number | null; low: number | null; at: number } | null;
  /** §6.3 the attended quiet streak: when silence was last counted */
  quiet: { lastAt: number | null };
  /** §4 the felt edge a push set, and when; it fades back into the learned edge over complaintMin of quiet */
  push: PerSide<{ at: number; edge: number } | null>;
  complaintAt: PerSide<number | null>;
  released: PerSide<boolean>;
  /** §7.4 when each side's release state last changed (dwell) */
  releasedAt: PerSide<number | null>;
  frozen: boolean;
  protecting: "max" | "min" | null;
  thermal: ThermalCurve;
  lastOutput: Output | null;
  lastEventAt: number | null;
  lastSnapshotAt: number | null;
}

export type State = Snapshot;

export interface StepResult {
  state: State;
  output: Output;
  effects: Effects;
}
