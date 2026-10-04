// §8 — the learned block structure: lookup, nightly split / merge / trial shifts.
import type { Block, State, UserBlockModel, ZoneConfig } from "./types";
import type { Ctx } from "./ctx";
import { mulberry32, product, quantile } from "./math";
import { MIN, parseHHMM } from "./time";
import { edgeSigma, newModel } from "./model";
import { HEAT, COOL, SIDES, type Side } from "./side";

export function seedKey(config: ZoneConfig): string {
  return JSON.stringify(config.seed.blocks.map((b) => [b.start, b.heat, b.cool]));
}

export function seedBlocks(config: ZoneConfig): Block[] {
  return config.seed.blocks.map((b, i) => ({ id: "b" + i, start: parseHHMM(b.start), heat: b.heat, cool: b.cool }));
}

/** §8.1: the block containing local minute m. */
export function blockAt(blocks: Block[], m: number): Block {
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  let cur = sorted[sorted.length - 1];
  for (const b of sorted) if (m >= b.start) cur = b;
  return cur;
}

export function sortedBlocks(s: State): Block[] {
  return [...s.blocks].sort((a, b) => a.start - b.start);
}

export function nextBlock(s: State, b: Block): Block {
  const sb = sortedBlocks(s);
  return sb[(sb.findIndex((x) => x.id === b.id) + 1) % sb.length];
}

export function blockLength(s: State, b: Block): number {
  if (s.blocks.length === 1) return 1440;
  return (nextBlock(s, b).start - b.start + 1440) % 1440 || 1440;
}

/** Minutes from local minute m until the next block boundary. */
export function minutesToNextBoundary(s: State, m: number): number {
  let best = 1440;
  for (const b of s.blocks) {
    let d = (b.start - m + 1440) % 1440;
    if (d <= 1e-9) d = 1440;
    best = Math.min(best, d);
  }
  return best;
}

/** §3.4: is local minute-of-day m inside a configured sleep window? */
export function inSleep(cfg: ZoneConfig, m: number): boolean {
  for (const w of cfg.sleep || []) {
    const a = parseHHMM(w.start);
    const e = parseHHMM(w.end);
    if (a === e) continue;
    if (a < e ? m >= a && m < e : m >= a || m < e) return true;
  }
  return false;
}

export function getModel(ctx: Ctx, uid: string, b: Block): UserBlockModel {
  const s = ctx.s;
  s.models[uid] = s.models[uid] || {};
  let m = s.models[uid][b.id];
  if (!m) {
    m = newModel(ctx, b);
    s.models[uid][b.id] = m;
  }
  return m;
}

export function blocksView(s: State) {
  return sortedBlocks(s).map((b) => ({ id: b.id, start: b.start, heat: b.heat, cool: b.cool }));
}

/** The side the outdoor air pushes the room toward (§7.4, §8.4); heat when unknown. */
export function pushedSide(ctx: Ctx): Side {
  const out = ctx.out;
  const tin = ctx.tin;
  return out !== null && tin !== null && out > tin ? COOL : HEAT;
}

function rng(ctx: Ctx): number {
  const [v, next] = mulberry32(ctx.s.structure.rng);
  ctx.s.structure.rng = next;
  return v;
}

/** §5.3 step 2 / §8: nightly maintenance. */
export function maintenance(ctx: Ctx): void {
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

/** §8.2 */
function split(ctx: Ctx): void {
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

/** §8.3 */
function merge(ctx: Ctx): void {
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
      for (const side of SIDES) {
        const e = side.edge;
        if (edgeSigma(ctx, ma[e]) >= p.mergeSigma || edgeSigma(ctx, mb[e]) >= p.mergeSigma) ok = false;
        if (Math.abs(quantile(ctx.g, ma[e], 0.5) - quantile(ctx.g, mb[e], 0.5)) >= p.mergeMedianDelta) ok = false;
      }
      if (!ok) break;
    }
    if (!ok || users === 0) continue;
    // merge b into a
    for (const uid of Object.keys(s.models)) {
      const ma = s.models[uid][a.id];
      const mb = s.models[uid][b.id];
      if (ma && mb) {
        for (const side of SIDES) ma[side.edge] = product(ma[side.edge], mb[side.edge]);
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

/** §8.4 */
function trialShift(ctx: Ctx): void {
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
  // lengthen the neighbour whose edge is looser on the side the outdoor air pushes toward; tie -> later (blk)
  const side = pushedSide(ctx);
  const lengthenPrev = side.sign * prev[side.key] > side.sign * blk[side.key];
  const newStart = (blk.start + (lengthenPrev ? delta : -delta) + 1440) % 1440;
  const lenPrev = blockLength(s, prev) + (lengthenPrev ? delta : -delta);
  const lenBlk = blockLength(s, blk) + (lengthenPrev ? -delta : delta);
  if (lenPrev < p.blockMinMin || lenBlk < p.blockMinMin) return;
  const from = blk.start;
  // §3.4: boundaries are never moved into, out of or within a sleep window
  if (inSleep(ctx.cfg, from) || inSleep(ctx.cfg, newStart)) return;
  s.structure.trials.push({ at: ctx.w.t, blockId: blk.id, from, to: newStart });
  s.blocks.find((x) => x.id === blk.id)!.start = newStart;
  ctx.dirty = true;
  ctx.rec("blocks", { action: "trial", block: blk.id, from, to: newStart, blocks: blocksView(s) });
}

/** §8.4: a vote near a trial boundary reverts it. */
export function revertTrials(ctx: Ctx, minute: number): void {
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
