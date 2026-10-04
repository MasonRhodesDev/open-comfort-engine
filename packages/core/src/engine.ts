// The Open Comfort Engine: step(state, event, config). One loop on every event —
// sense → band → act → learn (spec §1, §5.3, §7). Every rule is written once per
// side (§1.1) and cites its spec section.

import {
  Block,
  EngineEvent,
  Effects,
  Mode,
  Output,
  PerSide,
  Snapshot,
  State,
  StateName,
  StepResult,
  ZoneConfig,
} from "./types";
import { clamp, roundInward } from "./math";
import { MIN, formatWhen, parseWhen, When } from "./time";
import { Ctx, params } from "./ctx";
import { SIDES, Side, inner, inwardOf, perSide, sideForVote, sideOf } from "./side";
import { edgeAt, modelConfidence, modelSigma, observeSilence, observeVote } from "./model";
import {
  blockAt,
  blocksView,
  getModel,
  inSleep,
  maintenance,
  minutesToNextBoundary,
  nextBlock,
  pushedSide,
  revertTrials,
  seedBlocks,
  seedKey,
} from "./blocks";

export { params, blockAt };

const EVENT_TYPES = new Set(["vote", "presence", "reading", "weather", "cost", "manual", "freeze", "tick", "restore"]);

/** A fresh state for a zone (no events processed yet). */
export function init(config: ZoneConfig): State {
  const p = params(config);
  return {
    snapshotVersion: 2,
    zone: config.id,
    seedKey: seedKey(config),
    blocks: seedBlocks(config),
    nextBlockNo: config.seed.blocks.length,
    models: {},
    presence: { known: false, users: [], expectedArrival: null, expectedUsers: [], since: null },
    lastSilenceAt: {},
    reading: null,
    weather: null,
    risk: { heat: 0, cool: 0 },
    paused: { heat: null, cool: null },
    nudge: { heat: null, cool: null },
    released: { heat: false, cool: false },
    frozen: false,
    protecting: null,
    responseRate: p.responseRateDefault,
    structure: { rng: (config.params?.seed ?? 1) >>> 0, lastRunDate: null, trials: [], votes: [] },
    cost: 0,
    conflictDay: {},
    lastOutput: null,
    lastBlockId: null,
    lastEventAt: null,
    lastSnapshotAt: null,
  };
}

/** §9: accept any snapshot version <= ours and migrate it; reject newer. */
export function restore(snapshot: Snapshot): State {
  if (!snapshot || typeof snapshot !== "object") throw new Error("bad snapshot");
  const v = (snapshot as { snapshotVersion?: number }).snapshotVersion;
  if (v !== 1 && v !== 2) throw new Error("unsupported snapshotVersion " + v);
  const s = JSON.parse(JSON.stringify(snapshot)) as State & Record<string, unknown>;
  if (v === 1) {
    // §9: keep what is still meaningful, start the loop's own state fresh
    s.snapshotVersion = 2;
    s.risk = { heat: 0, cool: 0 };
    s.paused = { heat: null, cool: null };
    s.nudge = { heat: null, cool: null };
    s.released = { heat: false, cool: false };
    s.lastOutput = null;
    for (const k of ["drift", "vacancy", "hold", "trm", "day", "lastShift"]) delete s[k];
  }
  if (s.protecting === undefined) s.protecting = null;
  if (!s.conflictDay) s.conflictDay = {};
  if (s.nudge && "blockId" in s.nudge) s.nudge = { heat: null, cool: null };
  return s;
}

export function serialize(state: State): Snapshot {
  return JSON.parse(JSON.stringify(state));
}

// ---------------------------------------------------------------- sense

function asleep(ctx: Ctx): boolean {
  return ctx.present.length > 0 && inSleep(ctx.cfg, ctx.w.minute);
}

/** §5.2 */
function stateName(ctx: Ctx, b: Block): StateName {
  const s = ctx.s;
  if (s.frozen) return "FROZEN";
  if (s.presence.known && s.presence.users.length === 0) return "VACANT";
  const present = ctx.present;
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

function confidence(ctx: Ctx, b: Block): number {
  const present = ctx.present;
  if (!present.length) return 0;
  return Math.min(...present.map((u) => modelConfidence(ctx, getModel(ctx, u, b))));
}

// ---------------------------------------------------------------- band

/** §7.1: one edge of the band for a set of users in a block at the current risk; setback with nobody. */
function bandEdge(ctx: Ctx, b: Block, side: Side, users: string[]): number {
  if (users.length === 0) return ctx.cfg.setback[side.key];
  const r = ctx.s.risk[side.key];
  let edge = side.sign * Infinity;
  for (const u of users) edge = inner(side, edge, edgeAt(ctx, getModel(ctx, u, b), side, r));
  return edge;
}

function band(ctx: Ctx, b: Block, users: string[]): PerSide<number> {
  return perSide((side) => bandEdge(ctx, b, side, users));
}

// ---------------------------------------------------------------- act

/** §7.8: band → setpoints. */
function computeOutput(ctx: Ctx, b: Block): Output {
  const s = ctx.s;
  const p = ctx.p;
  const cap = ctx.cfg.capabilities;
  const t = ctx.w.t;
  const st = stateName(ctx, b);
  const present = ctx.present;
  const tin = ctx.tin;
  const out = ctx.out;
  const reasons: string[] = [];

  // §7.1 band, §7.2 nudge
  const base = band(ctx, b, present);
  const edge = perSide((side) => (s.nudge[side.key] === null ? base[side.key] : inner(side, base[side.key], s.nudge[side.key] as number)));

  // §7.5 pre-conditioning: toward the next block, and toward an expected arrival
  const rate = Math.max(s.responseRate, 1e-6);
  let precond = false;
  const tighten = (next: PerSide<number>, minutesAhead: number) => {
    for (const side of SIDES) {
      const need = inwardOf(side, edge[side.key], next[side.key]);
      if (need > 0 && minutesAhead <= Math.min(p.preconditionMaxMin, need / rate)) {
        edge[side.key] = next[side.key];
        precond = true;
      }
    }
  };
  if (s.blocks.length > 1 && present.length > 0) tighten(band(ctx, nextBlock(s, b), present), minutesToNextBoundary(s, ctx.w.minute));
  const exp = s.presence.expectedArrival;
  const extra = (s.presence.expectedUsers || []).filter((u) => !present.includes(u));
  if (exp !== null && exp > t && extra.length) tighten(band(ctx, b, [...present, ...extra]), (exp - t) / MIN);

  // §7.4 nature: a side is released to setback while the outdoor air pushes the room away from it. It is
  // taken back when the air pushes the other way (beyond natureMargin, so jitter cannot flap it), or when
  // the room has caught up with the air (within half the margin: it only ever approaches it) and the air
  // could not take it inside the edge (nobody is left stranded); never while a complaint is fresh (§7.3)
  const paused = (side: Side) => s.paused[side.key] !== null && t < (s.paused[side.key] as number);
  for (const side of SIDES) {
    if (out === null || tin === null || paused(side)) { s.released[side.key] = false; continue; }
    const push = side.sign * (out - tin); // < 0: the air pushes the room away from this edge
    const reach = inwardOf(side, edge[side.key], out); // < 0: the outdoor temperature is outside this edge
    if (push >= p.natureMargin || (push >= -p.natureMargin / 2 && reach < 0)) s.released[side.key] = false;
    else if (push <= -p.natureMargin) s.released[side.key] = true;
  }
  const wanted = perSide((side) => (s.released[side.key] ? ctx.cfg.setback[side.key] : edge[side.key]));
  const sp = perSide((side) => roundInward(clamp(wanted[side.key], cap[side.key].min, cap[side.key].max), cap.setpointStep, side.sign));
  const limited = SIDES.some((side) => Math.abs(sp[side.key] - wanted[side.key]) >= cap.setpointStep - 1e-9);

  // device minimum gap: `keep` stays, the other side moves outward (rounded outward) to restore it
  let gapped = false;
  const fixGap = (keep: Side) => {
    if (sp.cool - sp.heat >= cap.minGap - 1e-9) return;
    gapped = true;
    const give = sideOf(keep.key === "cool" ? "heat" : "cool");
    sp[give.key] = clamp(roundInward(sp[keep.key] + give.sign * cap.minGap, cap.setpointStep, keep.sign), cap[give.key].min, cap[give.key].max);
  };
  // a side someone just asked for is kept; otherwise the side the room is pushed toward
  const asked = SIDES.filter((side) => s.nudge[side.key] !== null);
  fixGap(asked.length === 1 ? asked[0] : pushedSide(ctx));

  // §7.6 protection: clamp (the other side gives way again), and track whether the room is beyond a limit
  const prot = ctx.cfg.protect || {};
  let protectedClamp = false;
  for (const side of SIDES) {
    const limit = prot[side.limit];
    if (limit === undefined) continue;
    if (inwardOf(side, sp[side.key], limit) > 1e-9) {
      sp[side.key] = roundInward(limit, cap.setpointStep, side.sign);
      protectedClamp = true;
      fixGap(side);
    }
    if (tin !== null) {
      const past = side.sign * (tin - limit);
      if (past >= 0) s.protecting = side.limit;
      else if (s.protecting === side.limit && past <= -p.protectHysteresis) s.protecting = null;
    }
  }

  // mode
  // mode: auto if the device has it; else the side the room is outside of; else keep the side it was
  // running (hysteresis); else the side opposing the outdoor air
  let mode: Mode;
  if (cap.modes.includes("auto")) mode = "auto";
  else {
    const outside = tin === null ? null : SIDES.find((side) => !s.released[side.key] && inwardOf(side, sp[side.key], tin) < 0) ?? null;
    const prev = s.lastOutput && SIDES.find((side) => side.key === s.lastOutput!.mode && !s.released[side.key]);
    const want: Mode = outside ? outside.key : prev ? prev.key : pushedSide(ctx).key;
    mode = cap.modes.includes(want) ? want : cap.modes[0];
  }

  // reasons, conflict
  const occupied = present.length > 0;
  const conflict = occupied && base.cool - base.heat < cap.minGap - 1e-9;
  if (st === "SEEDED") reasons.push("seed");
  if (st === "LEARNING" || st === "CONVERGED") reasons.push("learned");
  if (conflict) reasons.push("conflict");
  if (SIDES.some((side) => s.nudge[side.key] !== null)) reasons.push("nudge");
  if (occupied && SIDES.some((side) => s.risk[side.key] > 0)) reasons.push("risk");
  if (st === "VACANT") reasons.push("vacant");
  if (SIDES.some((side) => s.released[side.key])) reasons.push("released");
  if (precond) reasons.push("precondition");
  if (st === "FROZEN") reasons.push("frozen");
  if (asleep(ctx)) reasons.push("sleep");
  if (protectedClamp || s.protecting) reasons.push("protect");
  if (limited) reasons.push("limit");
  if (gapped) reasons.push("gap");
  if (conflict && s.conflictDay[b.id] !== ctx.w.date) {
    s.conflictDay[b.id] = ctx.w.date;
    ctx.rec("conflict", { block: b.id, present: [...present], band: base });
  }
  return {
    heat: sp.heat,
    cool: sp.cool,
    mode,
    state: st,
    block: b.id,
    blockEnd: formatWhen(t + minutesToNextBoundary(s, ctx.w.minute) * MIN, ctx.w.offMin),
    band: base,
    released: { ...s.released },
    risk: { ...s.risk },
    nudge: { ...s.nudge },
    reasons,
    confidence: confidence(ctx, b),
    protect: s.protecting,
  };
}

// ---------------------------------------------------------------- learn

/** §7.2: the edge is pinned at `target` for the rest of the block (never outward of an earlier pin,
 * never more than nudgeMax inward of the band). */
function nudgeTo(ctx: Ctx, b: Block, side: Side, target: number) {
  const s = ctx.s;
  const edge = bandEdge(ctx, b, side, ctx.present);
  const prev = s.nudge[side.key];
  let pin = prev === null ? target : inner(side, prev, target);
  if (inwardOf(side, edge, pin) > ctx.p.nudgeMax) pin = edge - side.sign * ctx.p.nudgeMax;
  s.nudge[side.key] = pin;
}

/** §7.2 / §7.3: a vote on one side from a present user — learned, felt (unless in cooldown), and a complaint. */
function vote(ctx: Ctx, b: Block, user: string, side: Side): boolean {
  const s = ctx.s;
  const p = ctx.p;
  const t = ctx.w.t;
  const r = s.reading!;
  const m = getModel(ctx, user, b);
  s.lastSilenceAt[user] = t;
  if (!s.frozen) observeVote(ctx, m, b, side, r.tin);
  // §7.3 a complaint: risk on this side starts over and the side stays conservative (and un-released) for a while
  s.risk[side.key] = 0;
  s.paused[side.key] = t + p.riskPauseMin * MIN;
  const last = m.lastVote;
  let nudge = true;
  if (last && t - last.at < p.cooldownMin * MIN) {
    const stalled = t - last.at >= ctx.cfg.responseMin * MIN && Math.abs(r.tin - last.tin) < p.stallDelta;
    if (!stalled) nudge = false;
  }
  if (nudge) {
    if (last && last.dir !== side.dir) m.step = Math.max(p.stepMin, m.step / 2);
    else if (last && last.dir === side.dir && t - last.at < p.repeatWindowMin * MIN) m.step = Math.min(p.stepMax, m.step * p.stepGrow);
    nudgeTo(ctx, b, side, r.tin - side.sign * m.step);
  }
  m.lastVote = { at: t, dir: side.dir, tin: r.tin };
  ctx.dirty = true;
  return nudge;
}

function onVote(ctx: Ctx, b: Block, ev: Extract<EngineEvent, { type: "vote" }>) {
  const s = ctx.s;
  const side = sideForVote(ev.dir);
  s.structure.votes.push({ at: ctx.w.t, minute: ctx.w.minute, blockId: b.id, dir: ev.dir });
  revertTrials(ctx, ctx.w.minute);
  let updated = false;
  if (!s.reading) ctx.feedback = "noted.no_reading";
  else if (!ctx.present.includes(ev.user)) {
    // the host says this user is not here: learn, but the room is not theirs to move (§7.2)
    if (!s.frozen) { observeVote(ctx, getModel(ctx, ev.user, b), b, side, s.reading.tin); updated = true; ctx.dirty = true; }
    ctx.feedback = "noted.absent";
  } else {
    const nudged = vote(ctx, b, ev.user, side);
    updated = !s.frozen;
    ctx.feedback = nudged ? (side.key === "cool" ? "nudge.cooler" : "nudge.warmer") : "noted.cooldown";
  }
  const m = s.models[ev.user]?.[b.id];
  ctx.rec("vote", {
    user: ev.user,
    dir: ev.dir,
    src: ev.src ?? null,
    block: b.id,
    tin: s.reading?.tin ?? null,
    rh: s.reading?.rh ?? null,
    out: s.weather?.out ?? null,
    present: s.presence.known ? [...s.presence.users] : null,
    applied: s.reading?.applied ?? null,
    step: m?.step ?? ctx.p.stepInit,
    nudge: { ...s.nudge },
    state: stateName(ctx, b),
    updated,
  });
}

/** §7.2: a manual change inward is a weak vote from everyone present on that side, felt at the applied
 * value; not a complaint (no cooldown, no step, no risk reset, no un-release). */
function onManual(ctx: Ctx, b: Block, ev: Extract<EngineEvent, { type: "manual" }>) {
  const s = ctx.s;
  const lo = s.lastOutput;
  if (!lo || !s.reading) return;
  for (const side of SIDES) {
    const applied = ev.applied[side.key];
    if (applied === undefined || inwardOf(side, lo[side.key], applied) <= 1e-9) continue;
    if (!s.frozen) for (const u of ctx.present) observeVote(ctx, getModel(ctx, u, b), b, side, s.reading.tin, ctx.p.manualWeight);
    nudgeTo(ctx, b, side, applied);
    ctx.dirty = true;
  }
}

function onPresence(ctx: Ctx, ev: Extract<EngineEvent, { type: "presence" }>) {
  const s = ctx.s;
  const t = ctx.w.t;
  const users = [...new Set(ev.users.map(String))].sort();
  const before = new Set(s.presence.users);
  for (const u of users) if (!before.has(u)) s.lastSilenceAt[u] = t;
  for (const u of Object.keys(s.lastSilenceAt)) if (!users.includes(u)) delete s.lastSilenceAt[u];
  const changed = !s.presence.known || users.join("\u0000") !== [...s.presence.users].sort().join("\u0000");
  if (changed) s.nudge = { heat: null, cool: null }; // §7.2: a nudge belongs to the people who asked for it
  const exp = ev.expectedArrival ? parseWhen(ev.expectedArrival).t : null;
  const expUsers = ev.expectedUsers ? [...new Set(ev.expectedUsers.map(String))].sort() : [];
  s.presence = { known: true, users, expectedArrival: exp, expectedUsers: expUsers, since: changed ? t : s.presence.since };
}

function onReading(ctx: Ctx, ev: Extract<EngineEvent, { type: "reading" }>) {
  const s = ctx.s;
  const t = ctx.w.t;
  const prev = s.reading;
  // §7.5 response rate
  if (prev && (ev.equip === "heat" || ev.equip === "cool")) {
    const side = sideOf(ev.equip);
    const dmin = (t - prev.at) / MIN;
    const dT = -side.sign * (ev.tin - prev.tin); // positive when the room moved the way the equipment pushes
    if (dmin >= 1 && dmin <= 30 && dT > 0) s.responseRate = 0.8 * s.responseRate + 0.2 * (dT / dmin);
  }
  s.reading = { tin: ev.tin, rh: ev.rh ?? null, equip: ev.equip ?? null, applied: ev.applied ?? null, at: t };
}

function onWeather(ctx: Ctx, ev: Extract<EngineEvent, { type: "weather" }>) {
  ctx.s.weather = { out: ev.out, high: ev.high ?? null, low: ev.low ?? null, at: ctx.w.t };
}

/** §5.3 step 5: silence (§6.3) and risk (§7.3) for the elapsed time. */
function learn(ctx: Ctx, b: Block, prevT: number | null) {
  const s = ctx.s;
  const p = ctx.p;
  const t = ctx.w.t;
  // elapsed time counts only while someone has been present (§7.3)
  const from = prevT === null ? null : Math.max(prevT, s.presence.since ?? prevT);
  const dtMin = from === null ? 0 : Math.min(Math.max(0, (t - from) / MIN), 60);
  const present = ctx.present;
  if (s.frozen || present.length === 0 || asleep(ctx)) return;
  if (s.reading) {
    for (const u of present) {
      const last = s.lastSilenceAt[u];
      if (last !== undefined && t - last >= p.silenceEveryMin * MIN) {
        observeSilence(ctx, getModel(ctx, u, b), SIDES, s.reading.tin);
        s.lastSilenceAt[u] = t;
        ctx.dirty = true;
      }
    }
  }
  const rate = p.riskRate * (1 + p.costWeight * s.cost);
  for (const side of SIDES) {
    const until = s.paused[side.key];
    if (until === null || t >= until) s.risk[side.key] = Math.min(1, s.risk[side.key] + (rate * dtMin) / 60);
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
  if ((event.type === "reading" && !Number.isFinite(event.tin)) || (event.type === "weather" && !Number.isFinite(event.out))) return reject(state, config, nowStr, "value", event.type);

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
  if (s.lastBlockId !== null && s.lastBlockId !== b.id) s.nudge = { heat: null, cool: null };

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
      break;
    case "tick":
      break;
  }
  b = blockAt(s.blocks, w.minute);

  // §5.3 step 5: learn
  learn(ctx, b, prevT);

  // §5.3 step 6–7: band, act, effects
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

/** §10: a decision record whenever what the host should do changed. */
function finishOutput(ctx: Ctx, out: Output) {
  const lo = ctx.s.lastOutput;
  const same =
    lo &&
    lo.heat === out.heat &&
    lo.cool === out.cool &&
    lo.mode === out.mode &&
    lo.state === out.state &&
    (lo.protect ?? null) === out.protect &&
    SIDES.every((side) => !!lo.released?.[side.key] === out.released[side.key]);
  if (!same) ctx.rec("decision", { ...out });
  ctx.s.lastOutput = out;
}

function reject(state: State, config: ZoneConfig, nowStr: string, reason: string, type: unknown): StepResult {
  const out = state.lastOutput ?? emptyOutput(state, config, nowStr);
  return {
    state,
    output: out,
    effects: { records: [{ type: "rejected", at: nowStr, zone: config.id, reason, event: type ?? null }] },
  };
}

function emptyOutput(state: State, config: ZoneConfig, nowStr: string): Output {
  const b = state.blocks[0];
  return {
    heat: b.heat,
    cool: b.cool,
    mode: config.capabilities.modes.includes("auto") ? "auto" : config.capabilities.modes[0],
    state: "SEEDED",
    block: b.id,
    blockEnd: nowStr,
    band: { heat: b.heat, cool: b.cool },
    released: { heat: false, cool: false },
    risk: { heat: 0, cool: 0 },
    nudge: { heat: null, cool: null },
    reasons: ["seed"],
    confidence: 0,
    protect: null,
  };
}
