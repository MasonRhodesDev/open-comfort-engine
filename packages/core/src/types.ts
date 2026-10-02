// Types for the Open Comfort Engine. Section numbers refer to spec/SPEC.md.

export type Mode = "heat" | "cool" | "auto" | "off";
export type Dir = "hot" | "cold";
export type Equip = "heat" | "cool" | "fan" | "idle" | "off";

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
  setback: { heat: number; cool: number };
  responseMin: number;
  params?: Partial<Params> & { seed?: number };
}

export interface SeedBlock {
  start: string; // "HH:MM"
  heat: number;
  cool: number;
}

/** §3.4 */
export interface Params {
  gridMin: number;
  gridMax: number;
  gridStep: number;
  priorSigma: number;
  adaptiveSlope: number;
  adaptiveRef: number;
  adaptiveTrmMin: number;
  adaptiveTrmMax: number;
  voteNoise: number;
  silenceSigma: number;
  silenceWeight: number;
  silenceEveryMin: number;
  manualWeight: number;
  forget: number;
  trmAlpha: number;
  coolingSeasonTrm: number;
  qLow: number;
  qHigh: number;
  leashBase: number;
  leashGain: number;
  stepInit: number;
  stepMin: number;
  stepMax: number;
  stepGrow: number;
  cooldownMin: number;
  stallDelta: number;
  nudgeMax: number;
  repeatWindowMin: number;
  driftRateMax: number;
  driftRateMin: number;
  driftCapMax: number;
  driftCapMin: number;
  driftPauseMin: number;
  driftQuantile: number;
  preconditionMaxMin: number;
  vacancyRate: number;
  vacancyAccelPerHour: number;
  vacancyRateMax: number;
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
}

export const DEFAULT_PARAMS: Params = {
  gridMin: 14,
  gridMax: 32,
  gridStep: 0.1,
  priorSigma: 1.5,
  adaptiveSlope: 0.1,
  adaptiveRef: 20,
  adaptiveTrmMin: 10,
  adaptiveTrmMax: 33.5,
  voteNoise: 0.7,
  silenceSigma: 2.0,
  silenceWeight: 0.3,
  silenceEveryMin: 60,
  manualWeight: 0.5,
  forget: 0.02,
  trmAlpha: 0.8,
  coolingSeasonTrm: 18,
  qLow: 0.2,
  qHigh: 0.8,
  leashBase: 1.0,
  leashGain: 2.0,
  stepInit: 1.0,
  stepMin: 0.3,
  stepMax: 2.0,
  stepGrow: 1.25,
  cooldownMin: 30,
  stallDelta: 0.3,
  nudgeMax: 3.0,
  repeatWindowMin: 120,
  driftRateMax: 0.3,
  driftRateMin: 0.1,
  driftCapMax: 1.5,
  driftCapMin: 0.5,
  driftPauseMin: 120,
  driftQuantile: 0.3,
  preconditionMaxMin: 120,
  vacancyRate: 0.5,
  vacancyAccelPerHour: 0.5,
  vacancyRateMax: 1.0,
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

export type StateName = "SEEDED" | "LEARNING" | "CONVERGED" | "FROZEN" | "HOLD" | "VACANT" | "RECOVERING";

/** §7.10 */
export interface Output {
  heat: number;
  cool: number;
  mode: Mode;
  state: StateName;
  block: string;
  reasons: string[];
  confidence: number;
  coolShift: number;
  heatShift: number;
  adaptive: number;
  nudge: number;
  drift: number;
  vacancy: number;
}

export type FeedbackCode = "nudge.cooler" | "nudge.warmer" | "noted.cooldown" | "noted.hold" | "noted.no_reading";

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

export interface EdgeModel {
  w: number[];
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
  snapshotVersion: 1;
  zone: string;
  seedKey: string;
  blocks: Block[];
  nextBlockNo: number;
  models: Record<string, Record<string, UserBlockModel>>;
  presence: { known: boolean; users: string[]; expectedArrival: number | null; expectedUsers: string[]; since: number | null };
  lastSilenceAt: Record<string, number>;
  reading: { tin: number; rh: number | null; equip: Equip | null; applied: Applied | null; at: number } | null;
  weather: { out: number; high: number | null; low: number | null; at: number } | null;
  trm: number | null;
  day: { date: string | null; sum: number; n: number; hl: number | null };
  nudge: { delta: number; blockId: string | null };
  drift: { value: number; pausedUntil: number | null };
  vacancy: { since: number | null; value: number; recovering: boolean };
  hold: { until: number; applied: Applied } | null;
  frozen: boolean;
  responseRate: number;
  structure: { rng: number; lastRunDate: string | null; trials: Trial[]; votes: VoteHist[] };
  cost: number;
  lastShift: Record<string, { cool: number; heat: number }>;
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
