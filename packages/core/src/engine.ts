// The Open Comfort Engine state machine: step(state, event, config).
// Every rule here is specified in spec/SPEC.md; section numbers are cited inline.

import {
  Block,
  DEFAULT_PARAMS,
  Dir,
  EngineEvent,
  EngineRecord,
  Effects,
  FeedbackCode,
  Mode,
  Output,
  Params,
  Snapshot,
  State,
  StateName,
  StepResult,
  UserBlockModel,
  ZoneConfig,
} from "./types";
import {
  clamp,
  forget,
  gaussianPrior,
  grid,
  meanSigma,
  mulberry32,
  phi,
  phiInv,
  product,
  quantile,
  roundStep,
  update,
} from "./math";
import { MIN, parseHHMM, parseWhen, When } from "./time";

const EVENT_TYPES = new Set(["vote", "presence", "reading", "weather", "cost", "manual", "freeze", "tick", "restore"]);

export function params(config: ZoneConfig): Params {
  return { ...DEFAULT_PARAMS, ...(config.params || {}) };
}

function seedKey(config: ZoneConfig): string {
  return JSON.stringify(config.seed.blocks.map((b) => [b.start, b.heat, b.cool]));
}

function seedBlocks(config: ZoneConfig): Block[] {
  return config.seed.blocks.map((b, i) => ({ id: "b" + i, start: parseHHMM(b.start), heat: b.heat, cool: b.cool }));
}

/** A fresh state for a zone (no events processed yet). */
export function init(config: ZoneConfig): State {
  const p = params(config);
  return {
    snapshotVersion: 1,
    zone: config.id,
    seedKey: seedKey(config),
    blocks: seedBlocks(config),
    nextBlockNo: config.seed.blocks.length,
    models: {},
    presence: { known: false, users: [], expectedArrival: null, expectedUsers: [], since: null },
    lastSilenceAt: {},
    reading: null,
    weather: null,
    trm: null,
    day: { date: null, sum: 0, n: 0, hl: null },
    nudge: { delta: 0, blockId: null },
    drift: { value: 0, pausedUntil: null },
    vacancy: { since: null, value: 0, recovering: false },
    hold: null,
    frozen: false,
    protecting: null,
    responseRate: p.responseRateDefault,
    structure: { rng: (config.params?.seed ?? 1) >>> 0, lastRunDate: null, trials: [], votes: [] },
    cost: 0,
    lastShift: {},
    conflictDay: {},
    lastOutput: null,
    lastBlockId: null,
    lastEventAt: null,
    lastSnapshotAt: null,
  };
}

/** §9: accept any snapshot version <= ours; reject newer. */
export function restore(snapshot: Snapshot): State {
  if (!snapshot || typeof snapshot !== "object") throw new Error("bad snapshot");
  if (snapshot.snapshotVersion !== 1) throw new Error("unsupported snapshotVersion " + snapshot.snapshotVersion);
  const s = JSON.parse(JSON.stringify(snapshot));
  if (s.day && s.day.hl === undefined) s.day.hl = null; // 0.1.0 snapshots
  if (s.protecting === undefined) s.protecting = null; // < 0.2.0 snapshots
  return s;
}

export function serialize(state: State): Snapshot {
  return JSON.parse(JSON.stringify(state));
}

// ---------------------------------------------------------------- helpers

class Ctx {
  p: Params;
  g: number[];
  dirty = false;
  records: EngineRecord[] = [];
  feedback?: FeedbackCode;
  constructor(public s: State, public cfg: ZoneConfig, public w: When, public nowStr: string) {
    this.p = params(cfg);
    this.g = grid(this.p.gridMin, this.p.gridMax, this.p.gridStep);
  }
  rec(type: EngineRecord["type"], fields: Record<string, unknown>) {
    this.records.push({ type, at: this.nowStr, zone: this.cfg.id, ...fields });
  }
}

/** §8.1: the block containing local minute m. */
export function blockAt(blocks: Block[], m: number): Block {
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  let cur = sorted[sorted.length - 1];
  for (const b of sorted) if (b.start <= m) cur = b;
  return cur;
}

function sortedBlocks(s: State): Block[] {
  return [...s.blocks].sort((a, b) => a.start - b.start);
}

function blockLength(s: State, b: Block): number {
  const sb = sortedBlocks(s);
  if (sb.length === 1) return 1440;
  const i = sb.findIndex((x) => x.id === b.id);
  const next = sb[(i + 1) % sb.length];
  return (next.start - b.start + 1440) % 1440 || 1440;
}

/** Minutes from local minute m until the next block boundary. */
function minutesToNextBoundary(s: State, m: number): number {
  let best = 1440;
  for (const b of s.blocks) {
    let d = (b.start - m + 1440) % 1440;
    if (d <= 1e-9) d = 1440;
    best = Math.min(best, d);
  }
  return best;
}

function priors(ctx: Ctx, b: Block): { lower: number[]; upper: number[] } {
  const { p, g } = ctx;
  const muU = b.cool - p.priorSigma * phiInv(p.qLow);
  const muL = b.heat - p.priorSigma * phiInv(p.qHigh);
  return { lower: gaussianPrior(g, muL, p.priorSigma), upper: gaussianPrior(g, muU, p.priorSigma) };
}

function getModel(ctx: Ctx, uid: string, b: Block): UserBlockModel {
  const s = ctx.s;
  s.models[uid] = s.models[uid] || {};
  let m = s.models[uid][b.id];
  if (!m) {
    const pr = priors(ctx, b);
    m = { lower: pr.lower, upper: pr.upper, n: 0, step: ctx.p.stepInit, lastVote: null };
    s.models[uid][b.id] = m;
  }
  return m;
}

function edgeSigma(ctx: Ctx, w: number[]): number {
  return meanSigma(ctx.g, w).sigma;
}

function modelSigma(ctx: Ctx, m: UserBlockModel): number {
  return Math.max(edgeSigma(ctx, m.lower), edgeSigma(ctx, m.upper));
}

function edgeConfidence(ctx: Ctx, w: number[]): number {
  return clamp(1 - edgeSigma(ctx, w) / ctx.p.priorSigma, 0, 1);
}

function modelConfidence(ctx: Ctx, m: UserBlockModel): number {
  return clamp(1 - modelSigma(ctx, m) / ctx.p.priorSigma, 0, 1);
}

/** §6.5: a day's mean outdoor temperature — (high+low)/2 from the forecast when known, else the samples' mean. */
function dayMean(s: State): number {
  if (s.day.hl !== null && s.day.hl !== undefined) return s.day.hl;
  return s.day.sum / s.day.n;
}

function trm(ctx: Ctx): number {
  const s = ctx.s;
  if (s.trm !== null) return s.trm;
  if (s.day.n > 0 || (s.day.hl !== null && s.day.hl !== undefined)) return dayMean(s);
  return ctx.p.adaptiveRef;
}

/** §7.2a: the adaptive term, with trm clamped to the adaptive model's valid range. */
function adaptive(ctx: Ctx): number {
  const p = ctx.p;
  return p.adaptiveSlope * (clamp(trm(ctx), p.adaptiveTrmMin, p.adaptiveTrmMax) - p.adaptiveRef);
}

function coolingSeason(ctx: Ctx): boolean {
  return trm(ctx) >= ctx.p.coolingSeasonTrm;
}

/** §6.2 likelihood update on one edge. */
function observe(ctx: Ctx, m: UserBlockModel, b: Block, kind: "hot" | "cold" | "silence", tin: number, weight = 1) {
  const { p, g } = ctx;
  const A = adaptive(ctx);
  const T = (i: number) => g[i] + A;
  const pr = priors(ctx, b);
  if (kind === "hot") {
    m.upper = update(m.upper, (i) => Math.pow(phi((tin - T(i)) / p.voteNoise), weight));
  } else if (kind === "cold") {
    m.lower = update(m.lower, (i) => Math.pow(phi((T(i) - tin) / p.voteNoise), weight));
  } else {
    m.upper = update(m.upper, (i) => 1 - p.silenceWeight + p.silenceWeight * phi((T(i) - tin) / p.silenceSigma));
    m.lower = update(m.lower, (i) => 1 - p.silenceWeight + p.silenceWeight * phi((tin - T(i)) / p.silenceSigma));
    return;
  }
  // §6.4 forgetting on the updated edge
  if (kind === "hot") m.upper = forget(m.upper, pr.upper, p.forget);
  else m.lower = forget(m.lower, pr.lower, p.forget);
  m.n += weight;
  ctx.dirty = true;
}

/** §5.2 */
function stateName(ctx: Ctx, b: Block, t: number): StateName {
  const s = ctx.s;
  if (s.frozen) return "FROZEN";
  if (s.hold && t < s.hold.until) return "HOLD";
  if (s.presence.known && s.presence.users.length === 0) return s.vacancy.recovering ? "RECOVERING" : "VACANT";
  const present = s.presence.known ? s.presence.users : [];
  if (present.length === 0) return "SEEDED";
  const anyVote = present.some((u) => {
    const m = s.models[u]?.[b.id];
    return !!m && (m.n > 0 || m.lastVote !== null);
  });
  if (!anyVote) return "SEEDED";
  const all = present.map((u) => getModel(ctx, u, b));
  if (all.every((m) => modelSigma(ctx, m) < ctx.p.convergedSigma && m.n >= ctx.p.convergedVotes)) return "CONVERGED";
  return "LEARNING";
}

// ---------------------------------------------------------------- §8 structure

function rng(ctx: Ctx): number {
  const [v, next] = mulberry32(ctx.s.structure.rng);
  ctx.s.structure.rng = next;
  return v;
}

function maintenance(ctx: Ctx) {
  const s = ctx.s;
  const { p, w } = ctx;
  // §8.6 drop old votes; §8.4 trials past their revert window become permanent
  s.structure.votes = s.structure.votes.filter((v) => w.t - v.at < p.voteHistoryDays * 1440 * MIN);
  s.structure.trials = s.structure.trials.filter((tr) => w.t - tr.at < p.trialRevertDays * 1440 * MIN);
  if (s.frozen) return;
  split(ctx);
  merge(ctx);
  trialShift(ctx);
}

function split(ctx: Ctx) {
  const s = ctx.s;
  const p = ctx.p;
  if (s.blocks.length >= p.blocksMax) return;
  let best: { b: Block; boundary: number; diff: number } | null = null;
  for (const b of sortedBlocks(s)) {
    const len = blockLength(s, b);
    const votes = s.structure.votes.filter((v) => v.blockId === b.id);
    for (let h = 0; h < 24; h++) {
      const bm = h * 60;
      const off = (bm - b.start + 1440) % 1440;
      if (off <= 0 || off >= len) continue;
      if (off < p.blockMinMin || len - off < p.blockMinMin) continue;
      const A: number[] = [];
      const B: number[] = [];
      for (const v of votes) {
        const vo = (v.minute - b.start + 1440) % 1440;
        (vo < off ? A : B).push(v.dir === "hot" ? 1 : -1);
      }
      if (A.length < p.splitMinVotes || B.length < p.splitMinVotes) continue;
      const mean = (xs: number[]) => xs.reduce((a, c) => a + c, 0) / xs.length;
      const diff = Math.abs(mean(A) - mean(B));
      if (diff < p.splitMinGap) continue;
      if (!best || diff > best.diff + 1e-12) best = { b, boundary: bm, diff };
    }
  }
  if (!best) return;
  const nb: Block = { id: "b" + s.nextBlockNo++, start: best.boundary, heat: best.b.heat, cool: best.b.cool };
  s.blocks.push(nb);
  for (const uid of Object.keys(s.models)) {
    const m = s.models[uid][best.b.id];
    if (m) s.models[uid][nb.id] = JSON.parse(JSON.stringify(m));
  }
  const len = (best.boundary - best.b.start + 1440) % 1440;
  for (const v of s.structure.votes) {
    if (v.blockId === best.b.id && (v.minute - best.b.start + 1440) % 1440 >= len) v.blockId = nb.id;
  }
  ctx.dirty = true;
  ctx.rec("blocks", { action: "split", parent: best.b.id, block: nb.id, blocks: blocksView(s) });
}

function medianOf(ctx: Ctx, w: number[]) {
  return quantile(ctx.g, w, 0.5);
}

function merge(ctx: Ctx) {
  const s = ctx.s;
  const p = ctx.p;
  const sb = sortedBlocks(s);
  if (sb.length < 2) return;
  for (let i = 0; i < sb.length; i++) {
    const a = sb[i];
    const b = sb[(i + 1) % sb.length];
    if (a.id === b.id) continue;
    let users = 0;
    let ok = true;
    for (const uid of Object.keys(s.models)) {
      const ma = s.models[uid][a.id];
      const mb = s.models[uid][b.id];
      if (!ma && !mb) continue;
      if (!ma || !mb) { ok = false; break; }
      users++;
      for (const e of ["lower", "upper"] as const) {
        if (edgeSigma(ctx, ma[e]) >= p.mergeSigma || edgeSigma(ctx, mb[e]) >= p.mergeSigma) ok = false;
        if (Math.abs(medianOf(ctx, ma[e]) - medianOf(ctx, mb[e])) >= p.mergeMedianDelta) ok = false;
      }
      if (!ok) break;
    }
    if (!ok || users === 0) continue;
    // merge b into a
    for (const uid of Object.keys(s.models)) {
      const ma = s.models[uid][a.id];
      const mb = s.models[uid][b.id];
      if (ma && mb) {
        ma.lower = product(ma.lower, mb.lower);
        ma.upper = product(ma.upper, mb.upper);
        ma.n += mb.n;
        ma.step = Math.min(ma.step, mb.step);
        if (mb.lastVote && (!ma.lastVote || mb.lastVote.at > ma.lastVote.at)) ma.lastVote = mb.lastVote;
      }
      delete s.models[uid][b.id];
    }
    for (const v of s.structure.votes) if (v.blockId === b.id) v.blockId = a.id;
    s.blocks = s.blocks.filter((x) => x.id !== b.id);
    ctx.dirty = true;
    ctx.rec("blocks", { action: "merge", into: a.id, removed: b.id, blocks: blocksView(s) });
    return;
  }
}

function trialShift(ctx: Ctx) {
  const s = ctx.s;
  const p = ctx.p;
  const structConf = Math.min(1, s.structure.votes.length / p.structureVotesFull);
  const prob = p.trialProb * (1 - structConf);
  const u = rng(ctx);
  if (!(u < prob)) return;
  const sb = sortedBlocks(s);
  const j = Math.floor(rng(ctx) * sb.length);
  const delta = p.trialShiftsMin[Math.floor(rng(ctx) * p.trialShiftsMin.length)];
  if (sb.length < 2) return;
  const blk = sb[j];
  const prev = sb[(j - 1 + sb.length) % sb.length];
  const cooling = coolingSeason(ctx);
  // lengthen the neighbour with lower energy use: higher cool (cooling) / lower heat (heating); tie -> later (blk)
  let lengthenPrev: boolean;
  if (cooling) lengthenPrev = prev.cool > blk.cool;
  else lengthenPrev = prev.heat < blk.heat;
  const newStart = (blk.start + (lengthenPrev ? delta : -delta) + 1440) % 1440;
  const lenPrev = blockLength(s, prev) + (lengthenPrev ? delta : -delta);
  const lenBlk = blockLength(s, blk) + (lengthenPrev ? -delta : delta);
  if (lenPrev < p.blockMinMin || lenBlk < p.blockMinMin) return;
  const from = blk.start;
  s.structure.trials.push({ at: ctx.w.t, blockId: blk.id, from, to: newStart });
  s.blocks.find((x) => x.id === blk.id)!.start = newStart;
  ctx.dirty = true;
  ctx.rec("blocks", { action: "trial", block: blk.id, from, to: newStart, blocks: blocksView(s) });
}

function revertTrials(ctx: Ctx, minute: number) {
  const s = ctx.s;
  const p = ctx.p;
  const keep = [];
  for (const tr of s.structure.trials) {
    const within = ctx.w.t - tr.at < p.trialRevertDays * 1440 * MIN;
    const dist = Math.min(Math.abs(minute - tr.to), 1440 - Math.abs(minute - tr.to));
    const blk = s.blocks.find((b) => b.id === tr.blockId);
    if (within && blk && dist <= p.trialRevertWindowMin && !s.frozen) {
      blk.start = tr.from;
      ctx.dirty = true;
      ctx.rec("blocks", { action: "revert", block: tr.blockId, to: tr.from, blocks: blocksView(s) });
    } else keep.push(tr);
  }
  s.structure.trials = keep;
}

function blocksView(s: State) {
  return sortedBlocks(s).map((b) => ({ id: b.id, start: b.start, heat: b.heat, cool: b.cool }));
}

// ---------------------------------------------------------------- §7 control

function shifts(ctx: Ctx, b: Block, users?: string[]): { cool: number; heat: number; conf: number } {
  const s = ctx.s;
  const p = ctx.p;
  const record = users === undefined;
  const present = users ?? (s.presence.known ? s.presence.users : []);
  if (present.length === 0) {
    const last = s.lastShift[b.id];
    return { cool: last?.cool ?? 0, heat: last?.heat ?? 0, conf: 0 };
  }
  const pr = priors(ctx, b);
  const qU0 = quantile(ctx.g, pr.upper, p.qLow);
  const qL0 = quantile(ctx.g, pr.lower, p.qHigh);
  let cool = Infinity;
  let heat = -Infinity;
  let confU = 1;
  let confL = 1;
  for (const u of present) {
    const m = getModel(ctx, u, b);
    cool = Math.min(cool, quantile(ctx.g, m.upper, p.qLow) - qU0);
    heat = Math.max(heat, quantile(ctx.g, m.lower, p.qHigh) - qL0);
    confU = Math.min(confU, edgeConfidence(ctx, m.upper));
    confL = Math.min(confL, edgeConfidence(ctx, m.lower));
  }
  // §7.2: each side is leashed by confidence in the limit it follows
  const leashCool = p.leashBase + p.leashGain * confU;
  const leashHeat = p.leashBase + p.leashGain * confL;
  cool = clamp(cool, -leashCool, leashCool);
  heat = clamp(heat, -leashHeat, leashHeat);
  if (record) s.lastShift[b.id] = { cool, heat };
  return { cool, heat, conf: Math.min(confU, confL) };
}

/** Aggregate shifts without recording them (used to measure one vote's learned effect). */
function shiftsPeek(ctx: Ctx, b: Block): { cool: number; heat: number } {
  const saved = ctx.s.lastShift[b.id];
  const r = shifts(ctx, b);
  if (saved === undefined) delete ctx.s.lastShift[b.id];
  else ctx.s.lastShift[b.id] = saved;
  return { cool: r.cool, heat: r.heat };
}

/** §7.4: room left for drift on each side, measured from where the (leashed) band sits now. */
function driftSideCaps(ctx: Ctx, b: Block, sh: { cool: number; heat: number }): { cool: number; heat: number } {
  const p = ctx.p;
  const present = ctx.s.presence.known ? ctx.s.presence.users : [];
  const pr = priors(ctx, b);
  const qU0 = quantile(ctx.g, pr.upper, p.qLow);
  const qL0 = quantile(ctx.g, pr.lower, p.qHigh);
  let coolCeil = Infinity; // as a shift relative to the seed
  let heatFloor = -Infinity;
  for (const u of present) {
    const m = getModel(ctx, u, b);
    coolCeil = Math.min(coolCeil, quantile(ctx.g, m.upper, p.driftQuantile) - qU0);
    heatFloor = Math.max(heatFloor, quantile(ctx.g, m.lower, 1 - p.driftQuantile) - qL0);
  }
  return { cool: Math.max(0, coolCeil - sh.cool), heat: Math.max(0, sh.heat - heatFloor) };
}

function minConfidence(ctx: Ctx, b: Block): number {
  const s = ctx.s;
  const present = s.presence.known ? s.presence.users : [];
  if (!present.length) return 0;
  return Math.min(...present.map((u) => modelConfidence(ctx, getModel(ctx, u, b))));
}

function computeOutput(ctx: Ctx, b: Block): Output {
  const s = ctx.s;
  const p = ctx.p;
  const cap = ctx.cfg.capabilities;
  const t = ctx.w.t;
  const st = stateName(ctx, b, t);
  const sh = shifts(ctx, b);
  const A = adaptive(ctx);
  const reasons: string[] = [];
  const present = s.presence.known ? s.presence.users : [];
  let heat = b.heat + sh.heat + A + s.nudge.delta;
  let cool = b.cool + sh.cool + A + s.nudge.delta;
  const occupied = present.length > 0;
  const vacantKnown = s.presence.known && !occupied;
  let driftCool = 0;
  let driftHeat = 0;
  if (occupied) {
    // §7.4: drift never passes the most sensitive present user's median limit on either side
    const cap2 = driftSideCaps(ctx, b, sh);
    driftCool = Math.min(s.drift.value, cap2.cool);
    driftHeat = Math.min(s.drift.value, cap2.heat);
    heat -= driftHeat;
    cool += driftCool;
  } else if (vacantKnown) {
    const eu = s.presence.expectedUsers || [];
    if (st === "RECOVERING" && eu.length) {
      const es = shifts(ctx, b, eu);
      heat = b.heat + es.heat + A + s.nudge.delta;
      cool = b.cool + es.cool + A + s.nudge.delta;
    }
    heat = Math.max(ctx.cfg.setback.heat, heat - s.vacancy.value);
    cool = Math.min(ctx.cfg.setback.cool, cool + s.vacancy.value);
  }
  // §7.11 pre-conditioning: tighten early so the room is there in time
  let precond = false;
  if (occupied && st !== "HOLD") {
    const rate = Math.max(s.responseRate, 1e-6);
    const tighten = (nCool: number, nHeat: number, minutesAhead: number) => {
      const need = Math.max(0, cool - nCool, nHeat - heat);
      if (need > 0 && minutesAhead <= Math.min(p.preconditionMaxMin, need / rate)) {
        cool = Math.min(cool, nCool);
        heat = Math.max(heat, nHeat);
        precond = true;
      }
    };
    const sb = sortedBlocks(s);
    if (sb.length > 1) {
      const next = sb[(sb.findIndex((x) => x.id === b.id) + 1) % sb.length];
      const ns = shifts(ctx, next, present);
      tighten(next.cool + ns.cool + A, next.heat + ns.heat + A, minutesToNextBoundary(s, ctx.w.minute));
    }
    const exp = s.presence.expectedArrival;
    const extra = (s.presence.expectedUsers || []).filter((u) => !present.includes(u));
    if (exp !== null && exp > t && extra.length) {
      const es = shifts(ctx, b, [...present, ...extra]);
      tighten(b.cool + es.cool + A + s.nudge.delta, b.heat + es.heat + A + s.nudge.delta, (exp - t) / MIN);
    }
  }
  let limited = false;
  const ch = clamp(heat, cap.heat.min, cap.heat.max);
  const cc = clamp(cool, cap.cool.min, cap.cool.max);
  if (ch !== heat || cc !== cool) limited = true;
  heat = ch;
  cool = cc;
  let gapped = false;
  if (cool - heat < cap.minGap - 1e-9) {
    gapped = true;
    if (coolingSeason(ctx)) heat = cool - cap.minGap;
    else cool = heat + cap.minGap;
    const h2 = clamp(heat, cap.heat.min, cap.heat.max);
    const c2 = clamp(cool, cap.cool.min, cap.cool.max);
    if (h2 !== heat) { heat = h2; cool = Math.max(cool, heat + cap.minGap); }
    if (c2 !== cool) { cool = c2; heat = Math.min(heat, cool - cap.minGap); }
    heat = clamp(heat, cap.heat.min, cap.heat.max);
    cool = clamp(cool, cap.cool.min, cap.cool.max);
  }
  heat = roundStep(heat, cap.setpointStep);
  cool = roundStep(cool, cap.setpointStep);
  let mode: Mode;
  if (cap.modes.includes("auto")) mode = "auto";
  else {
    const want: Mode = coolingSeason(ctx) ? "cool" : "heat";
    mode = cap.modes.includes(want) ? want : cap.modes[0];
  }
  // a manual hold applies whatever the state name (FROZEN outranks HOLD in naming, not in effect)
  if (s.hold && t < s.hold.until) {
    const ha = s.hold.applied;
    if (ha.heat !== undefined) heat = ha.heat;
    if (ha.cool !== undefined) cool = ha.cool;
    if (ha.mode !== undefined) mode = ha.mode;
    // the held side wins; the other side keeps the device's minimum gap
    if (cool - heat < cap.minGap - 1e-9) {
      if (ha.cool !== undefined && ha.heat === undefined) heat = roundStep(Math.max(cap.heat.min, cool - cap.minGap), cap.setpointStep);
      else if (ha.heat !== undefined && ha.cool === undefined) cool = roundStep(Math.min(cap.cool.max, heat + cap.minGap), cap.setpointStep);
    }
  }
  // §7.12 protection: an absolute indoor range, applied last (over holds and freeze)
  const prot = ctx.cfg.protect || {};
  const tin = s.reading ? s.reading.tin : null;
  if (tin !== null) {
    const hy = p.protectHysteresis;
    if (prot.max !== undefined && tin >= prot.max) s.protecting = "max";
    else if (prot.min !== undefined && tin <= prot.min) s.protecting = "min";
    else if (s.protecting === "max" && (prot.max === undefined || tin <= prot.max - hy)) s.protecting = null;
    else if (s.protecting === "min" && (prot.min === undefined || tin >= prot.min + hy)) s.protecting = null;
  }
  let protectedClamp = false;
  if (prot.max !== undefined && cool > prot.max) { cool = roundStep(prot.max, cap.setpointStep); protectedClamp = true; if (cool - heat < cap.minGap - 1e-9) heat = roundStep(cool - cap.minGap, cap.setpointStep); }
  if (prot.min !== undefined && heat < prot.min) { heat = roundStep(prot.min, cap.setpointStep); protectedClamp = true; if (cool - heat < cap.minGap - 1e-9) cool = roundStep(heat + cap.minGap, cap.setpointStep); }
  if (s.protecting && !cap.modes.includes("auto")) {
    const want: Mode = s.protecting === "max" ? "cool" : "heat";
    if (cap.modes.includes(want)) mode = want;
  }
  const conflict = occupied && b.cool + sh.cool - (b.heat + sh.heat) < cap.minGap - 1e-9;
  if (sh.cool === 0 && sh.heat === 0) reasons.push("seed");
  if (Math.abs(A) > 1e-9) reasons.push("adaptive");
  if (sh.cool !== 0 || sh.heat !== 0) reasons.push("learned");
  if (conflict) reasons.push("conflict");
  if (s.nudge.delta !== 0) reasons.push("nudge");
  if (occupied && (driftCool > 0 || driftHeat > 0)) reasons.push("drift");
  if (vacantKnown && s.vacancy.value > 0) reasons.push("vacancy");
  if (precond) reasons.push("precondition");
  if (st === "RECOVERING") reasons.push("recovering");
  if (st === "HOLD") reasons.push("hold");
  if (st === "FROZEN") reasons.push("frozen");
  if (protectedClamp || s.protecting) reasons.push("protect");
  if (limited) reasons.push("limit");
  if (gapped) reasons.push("gap");
  if (conflict) {
    const today = ctx.w.date;
    if (s.conflictDay[b.id] !== today) {
      s.conflictDay[b.id] = today;
      ctx.rec("conflict", { block: b.id, present: [...present], coolShift: sh.cool, heatShift: sh.heat });
    }
  }
  return {
    heat,
    cool,
    mode,
    state: st,
    block: b.id,
    reasons,
    confidence: occupied ? minConfidence(ctx, b) : 0,
    coolShift: sh.cool,
    heatShift: sh.heat,
    adaptive: A,
    nudge: s.nudge.delta,
    drift: occupied ? Math.max(driftCool, driftHeat) : 0,
    vacancy: vacantKnown ? s.vacancy.value : 0,
    protect: s.protecting,
  };
}

// ---------------------------------------------------------------- events

function onVote(ctx: Ctx, b: Block, ev: Extract<EngineEvent, { type: "vote" }>) {
  const s = ctx.s;
  const p = ctx.p;
  const t = ctx.w.t;
  const r = s.reading;
  const dir: Dir = ev.dir;
  // §8.6 history; §8.4 revert trials near this minute
  s.structure.votes.push({ at: t, minute: ctx.w.minute, blockId: b.id, dir });
  revertTrials(ctx, ctx.w.minute);
  // §7.5 complaint response (drift)
  s.drift.value = 0;
  s.drift.pausedUntil = t + p.driftPauseMin * MIN;
  s.lastSilenceAt[ev.user] = t;
  const m = getModel(ctx, ev.user, b);
  let updated = false;
  if (!r) {
    ctx.feedback = "noted.no_reading";
    recordVote(ctx, ev, b, m, false);
    return;
  }
  if (!s.frozen) {
    observe(ctx, m, b, dir, r.tin);
    updated = true;
  }
  // §7.3 nudge
  const last = m.lastVote;
  const holdActive = !!(s.hold && t < s.hold.until);
  if (holdActive) {
    ctx.feedback = "noted.hold";
  } else {
    let nudge = true;
    if (last && t - last.at < p.cooldownMin * MIN) {
      const stalled = t - last.at >= ctx.cfg.responseMin * MIN && Math.abs(r.tin - last.tin) < p.stallDelta;
      if (!stalled) nudge = false;
    }
    if (!nudge) ctx.feedback = "noted.cooldown";
    else {
      if (last && last.dir !== dir) m.step = Math.max(p.stepMin, m.step / 2);
      else if (last && last.dir === dir && t - last.at < p.repeatWindowMin * MIN) m.step = Math.min(p.stepMax, m.step * p.stepGrow);
      // §7.3: the voted edge must end at least one step past the room temperature, so the vote is felt;
      // whatever the learned shift already moved counts toward it
      const after = shiftsPeek(ctx, b);
      const A = adaptive(ctx);
      let delta: number;
      if (dir === "hot") delta = Math.min(0, r.tin - m.step - (b.cool + after.cool + A + s.nudge.delta));
      else delta = Math.max(0, r.tin + m.step - (b.heat + after.heat + A + s.nudge.delta));
      s.nudge.delta = clamp(s.nudge.delta + delta, -p.nudgeMax, p.nudgeMax);
      s.nudge.blockId = b.id;
      ctx.feedback = dir === "hot" ? "nudge.cooler" : "nudge.warmer";
    }
  }
  m.lastVote = { at: t, dir, tin: r.tin };
  ctx.dirty = true;
  recordVote(ctx, ev, b, m, updated);
}

function recordVote(ctx: Ctx, ev: Extract<EngineEvent, { type: "vote" }>, b: Block, m: UserBlockModel, updated: boolean) {
  const s = ctx.s;
  ctx.rec("vote", {
    user: ev.user,
    dir: ev.dir,
    src: ev.src ?? null,
    block: b.id,
    tin: s.reading?.tin ?? null,
    rh: s.reading?.rh ?? null,
    out: s.weather?.out ?? null,
    trm: trm(ctx),
    present: s.presence.known ? [...s.presence.users] : null,
    applied: s.reading?.applied ?? null,
    step: m.step,
    nudge: s.nudge.delta,
    state: stateName(ctx, b, ctx.w.t),
    updated,
  });
}

function onPresence(ctx: Ctx, ev: Extract<EngineEvent, { type: "presence" }>) {
  const s = ctx.s;
  const t = ctx.w.t;
  const users = [...new Set(ev.users.map(String))].sort();
  const wasEmpty = !s.presence.known || s.presence.users.length === 0;
  const before = new Set(s.presence.users);
  for (const u of users) if (!before.has(u)) s.lastSilenceAt[u] = t;
  for (const u of Object.keys(s.lastSilenceAt)) if (!users.includes(u)) delete s.lastSilenceAt[u];
  if (!s.presence.known || users.join("\u0000") !== [...s.presence.users].sort().join("\u0000")) s.drift.value = 0;
  const exp = ev.expectedArrival ? parseWhen(ev.expectedArrival).t : null;
  if (exp !== s.presence.expectedArrival) s.vacancy.recovering = false;
  if (users.length > 0) {
    s.vacancy = { since: null, value: 0, recovering: false };
  } else if (!wasEmpty || !s.presence.known) {
    s.vacancy = { since: t, value: 0, recovering: false };
  } else if (s.vacancy.since === null) {
    s.vacancy.since = t;
  }
  const changed = !s.presence.known || users.join("\u0000") !== [...s.presence.users].sort().join("\u0000");
  const expUsers = ev.expectedUsers ? [...new Set(ev.expectedUsers.map(String))].sort() : [];
  s.presence = { known: true, users, expectedArrival: exp, expectedUsers: expUsers, since: changed ? t : s.presence.since };
}

function onReading(ctx: Ctx, ev: Extract<EngineEvent, { type: "reading" }>) {
  const s = ctx.s;
  const t = ctx.w.t;
  const prev = s.reading;
  // §7.7 response rate
  if (prev && ev.equip && (ev.equip === "heat" || ev.equip === "cool")) {
    const dmin = (t - prev.at) / MIN;
    const dT = ev.tin - prev.tin;
    const toward = ev.equip === "heat" ? dT > 0 : dT < 0;
    if (dmin >= 1 && dmin <= 30 && toward) {
      s.responseRate = 0.8 * s.responseRate + 0.2 * (Math.abs(dT) / dmin);
    }
  }
  s.reading = { tin: ev.tin, rh: ev.rh ?? null, equip: ev.equip ?? null, applied: ev.applied ?? null, at: t };
}

function onWeather(ctx: Ctx, ev: Extract<EngineEvent, { type: "weather" }>) {
  const s = ctx.s;
  const p = ctx.p;
  const date = ctx.w.date;
  if (s.day.date !== null && s.day.date !== date && (s.day.n > 0 || s.day.hl !== null)) {
    const d = dayMean(s);
    s.trm = s.trm === null ? d : (1 - p.trmAlpha) * d + p.trmAlpha * s.trm;
    s.day = { date, sum: 0, n: 0, hl: null };
  }
  if (s.day.date === null) s.day.date = date;
  s.day.sum += ev.out;
  s.day.n += 1;
  if (typeof ev.high === "number" && typeof ev.low === "number") s.day.hl = (ev.high + ev.low) / 2;
  s.weather = { out: ev.out, high: ev.high ?? null, low: ev.low ?? null, at: ctx.w.t };
}

function onManual(ctx: Ctx, b: Block, ev: Extract<EngineEvent, { type: "manual" }>) {
  const s = ctx.s;
  const p = ctx.p;
  const t = ctx.w.t;
  s.hold = { until: t + minutesToNextBoundary(s, ctx.w.minute) * MIN, applied: ev.applied };
  const lo = s.lastOutput;
  if (!lo || s.frozen || !s.reading) return;
  const dirs = new Set<Dir>();
  if (ev.applied.cool !== undefined) {
    if (ev.applied.cool < lo.cool - 1e-9) dirs.add("hot");
    if (ev.applied.cool > lo.cool + 1e-9) dirs.add("cold");
  }
  if (ev.applied.heat !== undefined) {
    if (ev.applied.heat > lo.heat + 1e-9) dirs.add("cold");
    if (ev.applied.heat < lo.heat - 1e-9) dirs.add("hot");
  }
  if (dirs.size !== 1) return;
  const dir = [...dirs][0];
  const present = s.presence.known ? s.presence.users : [];
  for (const u of present) observe(ctx, getModel(ctx, u, b), b, dir, s.reading.tin, p.manualWeight);
}

// ---------------------------------------------------------------- time processes (§5.3 step 5)

function advance(ctx: Ctx, b: Block, prevT: number | null) {
  const s = ctx.s;
  const p = ctx.p;
  const t = ctx.w.t;
  const dtMin = prevT === null ? 0 : Math.min(Math.max(0, (t - prevT) / MIN), 60);
  const dtH = dtMin / 60;
  const st = stateName(ctx, b, t);
  const present = s.presence.known ? s.presence.users : [];
  // §6.3 silence
  if (s.reading && !s.frozen && st !== "HOLD") {
    for (const u of present) {
      const last = s.lastSilenceAt[u];
      if (last !== undefined && t - last >= p.silenceEveryMin * MIN) {
        observe(ctx, getModel(ctx, u, b), b, "silence", s.reading.tin);
        s.lastSilenceAt[u] = t;
        ctx.dirty = true;
      }
    }
  }
  if (s.frozen) {
    s.drift.value = 0;
    s.vacancy.value = 0;
    return;
  }
  // §7.4 occupied drift (elapsed time counted only within the current block)
  const sinceBlockStart = (ctx.w.minute - b.start + 1440) % 1440;
  const sincePresence = s.presence.since === null ? dtMin : (t - s.presence.since) / MIN;
  const dtBlockH = Math.min(dtMin, sinceBlockStart, sincePresence) / 60;
  if (present.length > 0 && (st === "SEEDED" || st === "LEARNING" || st === "CONVERGED") && (s.drift.pausedUntil === null || t >= s.drift.pausedUntil)) {
    const conf = minConfidence(ctx, b);
    const rate = (p.driftRateMax - (p.driftRateMax - p.driftRateMin) * conf) * (1 + p.costWeight * s.cost);
    const cap = p.driftCapMax - (p.driftCapMax - p.driftCapMin) * conf;
    s.drift.value = Math.min(cap, s.drift.value + rate * dtBlockH);
  }
  // §7.6 vacancy drift and §7.7 recovery
  if (s.presence.known && present.length === 0) {
    if (s.vacancy.since === null) s.vacancy.since = t;
    const exp = s.presence.expectedArrival;
    if (s.vacancy.recovering) {
      if (exp !== null && t - exp > 60 * MIN) {
        s.vacancy = { since: t, value: 0, recovering: false };
      }
    } else {
      const h = (t - s.vacancy.since) / (60 * MIN);
      const rate = Math.min(p.vacancyRateMax, p.vacancyRate * (1 + p.vacancyAccelPerHour * h)) * (1 + p.costWeight * s.cost);
      s.vacancy.value += rate * (Math.min(dtMin, (t - s.vacancy.since) / MIN) / 60);
      if (exp !== null) {
        const need = s.vacancy.value / Math.max(s.responseRate, 1e-6);
        if (exp - t <= need * MIN) {
          s.vacancy.recovering = true;
          s.vacancy.value = 0;
        }
      }
    }
  }
}

// ---------------------------------------------------------------- step

/** One engine step (spec §5.3). Pure: returns a new state; the input state is not mutated. */
export function step(state: State, event: EngineEvent, config: ZoneConfig): StepResult {
  const s: State = JSON.parse(JSON.stringify(state));
  const nowStr = (event as { now?: string }).now as string;
  let w: When;
  try {
    w = parseWhen(nowStr);
  } catch {
    return reject(state, config, nowStr ?? "", "time", (event as { type?: string }).type);
  }
  if (!EVENT_TYPES.has((event as { type?: string }).type as string)) return reject(state, config, nowStr, "type", (event as { type?: string }).type);
  if (event.type !== "restore" && s.lastEventAt !== null && w.t < s.lastEventAt) return reject(state, config, nowStr, "time", event.type);

  if (event.type === "restore") {
    const r = restore(event.snapshot);
    const ctx = new Ctx(r, config, w, nowStr);
    const b = blockAt(r.blocks, w.minute);
    const out = computeOutput(ctx, b);
    finishOutput(ctx, out);
    return { state: ctx.s, output: out, effects: { records: ctx.records } };
  }

  const ctx = new Ctx(s, config, w, nowStr);
  const p = ctx.p;
  const prevT = s.lastEventAt;

  // §8.7 reseed
  if (s.seedKey !== seedKey(config)) {
    s.seedKey = seedKey(config);
    s.blocks = seedBlocks(config);
    s.nextBlockNo = config.seed.blocks.length;
    s.models = {};
    s.lastShift = {};
    s.structure.votes = [];
    s.structure.trials = [];
    ctx.dirty = true;
    ctx.rec("blocks", { action: "reseed", blocks: blocksView(s) });
  }
  // §5.3 step 2: daily maintenance
  if (s.structure.lastRunDate === null) s.structure.lastRunDate = w.date;
  else if (w.date > s.structure.lastRunDate && w.minute >= p.structureHour * 60) {
    s.structure.lastRunDate = w.date;
    maintenance(ctx);
  }
  // §5.3 step 3: block change
  let b = blockAt(s.blocks, w.minute);
  if (s.lastBlockId !== null && s.lastBlockId !== b.id) {
    s.nudge = { delta: 0, blockId: null };
    s.hold = null;
    s.drift.value = 0;
  }
  if (s.hold && w.t >= s.hold.until) s.hold = null;

  // §5.3 step 4: apply event
  switch (event.type) {
    case "vote":
      onVote(ctx, b, event);
      break;
    case "presence":
      onPresence(ctx, event);
      break;
    case "reading":
      onReading(ctx, event);
      break;
    case "weather":
      onWeather(ctx, event);
      break;
    case "cost":
      s.cost = clamp(Number(event.level) || 0, 0, 1);
      break;
    case "manual":
      onManual(ctx, b, event);
      break;
    case "freeze":
      if (s.frozen !== !!event.on) ctx.dirty = true;
      s.frozen = !!event.on;
      if (s.frozen) {
        s.drift.value = 0;
        s.vacancy.value = 0;
      }
      break;
    case "tick":
      break;
  }
  b = blockAt(s.blocks, w.minute);

  // §5.3 step 5
  advance(ctx, b, prevT);

  // §5.3 step 6–7
  const out = computeOutput(ctx, b);
  s.lastBlockId = b.id;
  s.lastEventAt = w.t;
  finishOutput(ctx, out);
  const effects: Effects = { records: ctx.records };
  if (ctx.feedback) effects.feedback = ctx.feedback;
  const decided = ctx.records.some((r) => r.type === "decision");
  if (ctx.dirty || decided || s.lastSnapshotAt === null || w.t - s.lastSnapshotAt >= p.snapshotEveryMin * MIN) {
    s.lastSnapshotAt = w.t;
    effects.snapshot = serialize(s);
  }
  return { state: s, output: out, effects };
}

function finishOutput(ctx: Ctx, out: Output) {
  const lo = ctx.s.lastOutput;
  if (!lo || lo.heat !== out.heat || lo.cool !== out.cool || lo.mode !== out.mode || lo.state !== out.state || (lo.protect ?? null) !== out.protect) {
    ctx.rec("decision", { ...out });
  }
  ctx.s.lastOutput = out;
}

function reject(state: State, config: ZoneConfig, nowStr: string, reason: string, type: unknown): StepResult {
  const out = state.lastOutput ?? emptyOutput(state, config);
  return {
    state,
    output: out,
    effects: { records: [{ type: "rejected", at: nowStr, zone: config.id, reason, event: type ?? null }] },
  };
}

function emptyOutput(state: State, config: ZoneConfig): Output {
  const b = state.blocks[0];
  return {
    heat: b.heat,
    cool: b.cool,
    mode: config.capabilities.modes.includes("auto") ? "auto" : config.capabilities.modes[0],
    state: "SEEDED",
    block: b.id,
    reasons: ["seed"],
    confidence: 0,
    coolShift: 0,
    heatShift: 0,
    adaptive: 0,
    nudge: 0,
    drift: 0,
    vacancy: 0,
    protect: null,
  };
}
