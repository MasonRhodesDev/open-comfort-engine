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
  seed: { blocks: SeedBlock[] };
  /** §3.3 the band when nobody is present, and what a released side is set to */
  setback: PerSide<number>;
  /** §3.3 absolute indoor range that must never be crossed */
  protect?: { min?: number; max?: number };
  /** §3.4 times of day when present users are asleep */
  sleep?: { start: string; end: string }[];
  responseMin: number;
  params?: Partial<Params> & { seed?: number };
}

export interface SeedBlock {
  start: string; // "HH:MM"
  heat: number;
  cool: number;
}

/** §3.5 */
export interface Params {
  gridMin: number;
  gridMax: number;
  gridStep: number;
  priorSigma: number;
  voteNoise: number;
  silenceSigma: number;
  silenceWeight: number;
  silenceEveryMin: number;
  manualWeight: number;
  forget: number;
  qSafe: number;
  qRisk: number;
  riskRate: number;
  riskPauseMin: number;
  stepInit: number;
  stepMin: number;
  stepMax: number;
  stepGrow: number;
  cooldownMin: number;
  stallDelta: number;
  nudgeMax: number;
  repeatWindowMin: number;
  natureMargin: number;
  preconditionMaxMin: number;
  responseRateDefault: number;
  costWeight: number;
  convergedSigma: number;
  convergedVotes: number;
  structureHour: number;
  splitMinVotes: number;
  splitMinGap: number;
  mergeMedianDelta: number;
  mergeSigma: number;
  blockMinMin: number;
  blocksMax: number;
  trialProb: number;
  trialShiftsMin: number[];
  trialRevertWindowMin: number;
  trialRevertDays: number;
  structureVotesFull: number;
  voteHistoryDays: number;
  snapshotEveryMin: number;
  protectHysteresis: number;
}

export const DEFAULT_PARAMS: Params = {
  gridMin: 14,
  gridMax: 32,
  gridStep: 0.1,
  priorSigma: 1.5,
  voteNoise: 0.7,
  silenceSigma: 2.0,
  silenceWeight: 0.3,
  silenceEveryMin: 60,
  manualWeight: 0.5,
  forget: 0.02,
  qSafe: 0.2,
  qRisk: 0.35,
  riskRate: 0.25,
  riskPauseMin: 120,
  stepInit: 1.0,
  stepMin: 0.3,
  stepMax: 2.0,
  stepGrow: 1.25,
  cooldownMin: 30,
  stallDelta: 0.3,
  nudgeMax: 3.0,
  repeatWindowMin: 120,
  natureMargin: 1.0,
  preconditionMaxMin: 120,
  responseRateDefault: 0.05,
  costWeight: 0.5,
  convergedSigma: 0.6,
  convergedVotes: 20,
  structureHour: 3,
  splitMinVotes: 5,
  splitMinGap: 1.0,
  mergeMedianDelta: 0.3,
  mergeSigma: 0.6,
  blockMinMin: 120,
  blocksMax: 8,
  trialProb: 0.2,
  trialShiftsMin: [15, 30],
  trialRevertWindowMin: 60,
  trialRevertDays: 3,
  structureVotesFull: 100,
  voteHistoryDays: 30,
  snapshotEveryMin: 60,
  protectHysteresis: 1.0,
};

/** §4 */
export type EngineEvent =
  | { type: "vote"; now: string; user: string; dir: Dir; src?: string }
  | { type: "presence"; now: string; users: string[]; expectedArrival?: string | null; expectedUsers?: string[] }
  | { type: "reading"; now: string; tin: number; rh?: number; equip?: Equip; applied?: Applied }
  | { type: "weather"; now: string; out: number; high?: number; low?: number }
  | { type: "cost"; now: string; level: number }
  | { type: "manual"; now: string; applied: Applied }
  | { type: "freeze"; now: string; on: boolean }
  | { type: "tick"; now: string }
  | { type: "restore"; now: string; snapshot: Snapshot };

export interface Applied {
  heat?: number;
  cool?: number;
  mode?: Mode;
}

export type StateName = "SEEDED" | "LEARNING" | "CONVERGED" | "FROZEN" | "VACANT";

/** §7.8 */
export interface Output {
  heat: number;
  cool: number;
  mode: Mode;
  state: StateName;
  block: string;
  /** RFC 3339 start of the next block (hosts that hold "until the next block" use it) */
  blockEnd: string;
  /** the band before release and protection */
  band: PerSide<number>;
  released: PerSide<boolean>;
  risk: PerSide<number>;
  nudge: PerSide<number>;
  reasons: string[];
  confidence: number;
  /** §7.6: the room is beyond a protection limit; hosts MUST actuate toward the output */
  protect: "max" | "min" | null;
}

export type FeedbackCode = "nudge.cooler" | "nudge.warmer" | "noted.cooldown" | "noted.no_reading";

export interface EngineRecord {
  type: "vote" | "decision" | "conflict" | "blocks" | "rejected";
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

export interface Block {
  id: string;
  start: number; // local minute of day
  heat: number;
  cool: number;
}

export interface UserBlockModel {
  lower: number[];
  upper: number[];
  n: number;
  step: number;
  lastVote: { at: number; dir: Dir; tin: number } | null;
}

export interface Trial {
  at: number;
  blockId: string;
  from: number;
  to: number;
}

export interface VoteHist {
  at: number;
  minute: number;
  blockId: string;
  dir: Dir;
}

/** §5.1 / §9 — the complete engine state, JSON-serialisable. */
export interface Snapshot {
  snapshotVersion: 2;
  zone: string;
  seedKey: string;
  blocks: Block[];
  nextBlockNo: number;
  models: Record<string, Record<string, UserBlockModel>>;
  presence: { known: boolean; users: string[]; expectedArrival: number | null; expectedUsers: string[]; since: number | null };
  lastSilenceAt: Record<string, number>;
  reading: { tin: number; rh: number | null; equip: Equip | null; applied: Applied | null; at: number } | null;
  weather: { out: number; high: number | null; low: number | null; at: number } | null;
  risk: PerSide<number>;
  /** §7.3 per side: until when a complaint keeps the side conservative and un-released */
  paused: PerSide<number | null>;
  nudge: PerSide<number> & { blockId: string | null };
  released: PerSide<boolean>;
  frozen: boolean;
  protecting: "max" | "min" | null;
  responseRate: number;
  structure: { rng: number; lastRunDate: string | null; trials: Trial[]; votes: VoteHist[] };
  cost: number;
  conflictDay: Record<string, string>;
  lastOutput: Output | null;
  lastBlockId: string | null;
  lastEventAt: number | null;
  lastSnapshotAt: number | null;
}

export type State = Snapshot;

export interface StepResult {
  state: State;
  output: Output;
  effects: Effects;
}
