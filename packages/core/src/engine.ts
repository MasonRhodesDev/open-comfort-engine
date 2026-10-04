// The Open Comfort Engine: step(state, event, config). One loop on every event —
// sense → band → act → learn (spec §1, §5.3, §7). Every rule is written once per
// side (§1.1) and cites its spec section. No presence, no time of day, no identity
// beyond the per-voter step search.

import {
  EngineEvent,
  Effects,
  Equip,
  Mode,
  Output,
  PerSide,
  ProjectedHour,
  Snapshot,
  State,
  StateName,
  StepResult,
  ZoneConfig,
} from "./types";
import { clamp, grid, roundInward } from "./math";
import { MIN, parseWhen, When } from "./time";
import { Ctx, params } from "./ctx";
import { COOL, HEAT, SIDES, Side, inner, inwardOf, perSide, sideForVote, sideOf } from "./side";
import { confidenceAt, curvePoints, edgeAt, newCurve, observeSilence, observeVote, sigmaAt, votesAt, type Grid } from "./model";
import { expectedChange, newThermal, observeInterval, thermalAt } from "./thermal";

export { params };

const EVENT_TYPES = new Set(["vote", "reading", "weather", "manual", "freeze", "tick", "restore"]);

function seedKey(config: ZoneConfig): string {
  const p = params(config);
  return JSON.stringify([config.seed.heat, config.seed.cool, p.gridMin, p.gridMax, p.gridStep, p.knotMin, p.knotMax, p.knotStep]);
}

function gridOf(config: ZoneConfig): Grid {
  const p = params(config);
  return { p, g: grid(p.gridMin, p.gridMax, p.gridStep) };
}

/** A fresh state for a zone (no events processed yet). */
export function init(config: ZoneConfig): State {
  const gr = gridOf(config);
  return {
    snapshotVersion: 3,
    zone: config.id,
    seedKey: seedKey(config),
    curve: newCurve(gr, config.seed),
    voters: {},
    reading: null,
    weather: null,
    quiet: { lastAt: null },
    push: { heat: null, cool: null },
    complaintAt: { heat: null, cool: null },
    released: { heat: false, cool: false },
    releasedAt: { heat: null, cool: null },
    frozen: false,
    protecting: null,
    thermal: newThermal(gr.p),
    lastOutput: null,
    lastEventAt: null,
    lastSnapshotAt: null,
  };
}

/** §9: accept any snapshot version ≤ ours; older designs keep only what still means something. A v3
 * snapshot built with other grid/knot parameters restarts the curve and thermal model the same way. */
export function restore(snapshot: Snapshot, config?: ZoneConfig): State {
  if (!snapshot || typeof snapshot !== "object") throw new Error("bad snapshot");
  const v = (snapshot as { snapshotVersion?: number }).snapshotVersion;
  if (v !== 1 && v !== 2 && v !== 3) throw new Error("unsupported snapshotVersion " + v);
  if (v === 3 && (!config || (snapshot as Snapshot).seedKey === seedKey(config))) {
    const s = JSON.parse(JSON.stringify(snapshot)) as State;
    if (!s.releasedAt) s.releasedAt = { heat: null, cool: null };
    if (!s.quiet || !("lastAt" in s.quiet)) s.quiet = { lastAt: null };
    // a curve that has never learned a vote is as good as fresh: history (a vote replay) is accepted (§9)
    const taught = SIDES.some((side) => s.curve[side.key].some((k) => k.n > 0));
    if (!taught) s.lastEventAt = null;
    return s;
  }
  // 0.1–0.4 snapshots: the tolerance curve starts fresh (hosts replay their vote records, §9);
  // the room, the weather and the switches carry over
  if (!config) throw new Error("restoring a version " + v + " snapshot needs the zone config");
  const old = snapshot as unknown as Record<string, unknown>;
  const s = init(config);
  for (const k of ["reading", "weather", "frozen", "protecting", "voters"] as const) {
    if (old[k] !== undefined) (s as unknown as Record<string, unknown>)[k] = JSON.parse(JSON.stringify(old[k]));
  }
  // a restarted curve accepts history again: hosts replay their vote records at their original times (§9)
  s.lastEventAt = null;
  return s;
}

export function serialize(state: State): Snapshot {
  return JSON.parse(JSON.stringify(state));
}

// ---------------------------------------------------------------- band → act (pure, shared by step and project)

interface ActInput {
  t: number;
  tin: number | null;
  /** outdoor for release (recent) and for the band (last known) */
  out: number | null;
  outBand: number | null;
  released: PerSide<boolean>;
  releasedAt: PerSide<number | null>;
  push: PerSide<{ at: number; edge: number } | null>;
  fresh: PerSide<boolean>;
  protecting: "max" | "min" | null;
  lastMode: Mode | null;
  /** the setpoints the host currently has (hysteresis on the output) */
  last: PerSide<number> | null;
}

interface Act {
  heat: number;
  cool: number;
  mode: Mode;
  band: PerSide<number>;
  released: PerSide<boolean>;
  releasedAt: PerSide<number | null>;
  push: PerSide<number | null>;
  protecting: "max" | "min" | null;
  /** the side the equipment runs on now (the room is outside its setpoint and the side is in the device's hands) */
  equipment: Side | null;
  reasons: string[];
}

/** §7.1–7.8 for one moment: the learned band at this outdoor temperature, then the setpoints. */
function act(gr: Grid, cfg: ZoneConfig, state: Pick<State, "curve">, inp: ActInput): Act {
  const p = gr.p;
  const cap = cfg.capabilities;
  const reasons: string[] = [];
  const outBand = inp.outBand ?? (p.knotMin + p.knotMax) / 2;
  const band = perSide((side) => edgeAt(gr, state.curve, side, outBand));

  // §4 a felt push holds while the learned edge is outward of it, fading back into the learned edge over
  // complaintMin of quiet (linearly, so nothing snaps); absorbed once the learned edge passes it
  const push = perSide((side) => {
    const v = inp.push[side.key];
    if (v === null) return null;
    const faded = v.edge + (band[side.key] - v.edge) * clamp((inp.t - v.at) / (p.complaintMin * MIN), 0, 1);
    return inwardOf(side, band[side.key], faded) > 1e-9 ? faded : null;
  });
  const edge = perSide((side) => (push[side.key] === null ? band[side.key] : (push[side.key] as number)));

  // §7.4 nature: a side is released to setback while the outdoor air pushes the room away from it AND can
  // bring the room inside that edge on its own. It is taken back when the air pushes the other way
  // (beyond natureMargin, so jitter cannot flap it) or can no longer reach the edge (nobody is left
  // stranded); never while a complaint is fresh (§7.3). A side keeps its state for releaseDwellMin after
  // a change (a sun-struck outdoor sensor cannot cycle the equipment).
  const released = { ...inp.released };
  const releasedAt = { ...inp.releasedAt };
  for (const side of SIDES) {
    let want = released[side.key];
    const known = inp.out !== null && inp.tin !== null;
    if (!known || inp.fresh[side.key]) want = false;
    else {
      const pushAir = side.sign * ((inp.out as number) - (inp.tin as number)); // < 0: the air pushes the room away from this edge
      const reach = inwardOf(side, edge[side.key], inp.out as number); // < 0: the outdoor temperature is outside this edge
      if (pushAir >= p.natureMargin || reach < 0) want = false;
      else if (pushAir <= -p.natureMargin) want = true;
    }
    if (want !== released[side.key]) {
      const since = releasedAt[side.key];
      const dwell = known && !inp.fresh[side.key] && since !== null && inp.t - since < p.releaseDwellMin * MIN;
      if (!dwell) { released[side.key] = want; releasedAt[side.key] = inp.t; }
    }
  }
  const unclamped = perSide((side) => (released[side.key] ? cfg.setback[side.key] : edge[side.key]));
  const wanted = perSide((side) => clamp(unclamped[side.key], cap[side.key].min, cap[side.key].max));
  const limited = SIDES.some((side) => Math.abs(wanted[side.key] - unclamped[side.key]) > 1e-9);
  // §7.8 a trigger band on the output: a setpoint changes only once the wanted value is a full step away
  // from the engine's last output, so a band sliding by hundredths does not rewrite the device
  const sp = perSide((side) => {
    const prev = inp.last ? inp.last[side.key] : null;
    if (prev !== null && Math.abs(wanted[side.key] - prev) < cap.setpointStep - 1e-9) return prev;
    return roundInward(wanted[side.key], cap.setpointStep, side.sign);
  });

  // device minimum gap: `keep` stays, the other side moves outward (rounded outward) to restore it
  let gapped = false;
  const pushedSide = (): Side => (inp.out !== null && inp.tin !== null && inp.out > inp.tin ? COOL : HEAT);
  const fixGap = (keep: Side) => {
    if (sp.cool - sp.heat >= cap.minGap - 1e-9) return;
    gapped = true;
    const give = sideOf(keep.key === "cool" ? "heat" : "cool");
    sp[give.key] = clamp(roundInward(sp[keep.key] + give.sign * cap.minGap, cap.setpointStep, keep.sign), cap[give.key].min, cap[give.key].max);
  };
  // a side someone just asked for (a fresh complaint) is kept; otherwise the side the room is pushed toward
  const asked = SIDES.filter((side) => inp.fresh[side.key]);
  fixGap(asked.length === 1 ? asked[0] : pushedSide());

  // §7.6 protection: clamp (the other side gives way again), and track whether the room is beyond a limit
  const prot = cfg.protect || {};
  let protecting = inp.protecting;
  let protectedClamp = false;
  if (protecting !== null && prot[protecting] === undefined) protecting = null; // the limit is gone from the config
  for (const side of SIDES) {
    const limit = prot[side.limit];
    if (limit === undefined) continue;
    if (inwardOf(side, sp[side.key], limit) > 1e-9) {
      sp[side.key] = roundInward(limit, cap.setpointStep, side.sign);
      protectedClamp = true;
      fixGap(side);
    }
    if (inp.tin !== null) {
      const past = side.sign * (inp.tin - limit);
      if (past >= 0) protecting = side.limit;
      else if (protecting === side.limit && past <= -p.protectHysteresis) protecting = null;
    }
  }

  // mode: auto if the device has it; else the side the room is outside of; else keep the side it was
  // running (hysteresis); else the side opposing the outdoor air
  let mode: Mode;
  if (cap.modes.includes("auto")) mode = "auto";
  else {
    const outside = inp.tin === null ? null : SIDES.find((side) => !released[side.key] && inwardOf(side, sp[side.key], inp.tin as number) < 0) ?? null;
    const prev = SIDES.find((side) => side.key === inp.lastMode && !released[side.key]);
    const want: Mode = outside ? outside.key : prev ? prev.key : pushedSide().key;
    mode = cap.modes.includes(want) ? want : cap.modes[0];
  }

  // act: the equipment runs on the side the room is outside of, if that side is in the device's hands
  // (not released, or protection is clamping it: hosts MUST actuate then) and the mode allows it
  const equipment = inp.tin === null ? null : SIDES.find((side) => (!released[side.key] || protecting === side.limit) && inwardOf(side, sp[side.key], inp.tin as number) < 0 && (mode === "auto" || mode === side.key)) ?? null;

  if (band.cool - band.heat < cap.minGap - 1e-9) reasons.push("conflict");
  if (SIDES.some((side) => push[side.key] !== null)) reasons.push("push");
  if (SIDES.some((side) => released[side.key])) reasons.push("released");
  if (protectedClamp || protecting) reasons.push("protect");
  if (limited) reasons.push("limit");
  if (gapped) reasons.push("gap");
  return { heat: sp.heat, cool: sp.cool, mode, band, released, releasedAt, push, protecting, equipment, reasons };
}

// ---------------------------------------------------------------- sense

/** §5.2 */
function stateName(ctx: Ctx, out: number): StateName {
  const s = ctx.s;
  if (s.frozen) return "FROZEN";
  const votes = s.curve.heat.reduce((a, k) => a + k.n, 0) + s.curve.cool.reduce((a, k) => a + k.n, 0);
  if (votes === 0) return "SEEDED";
  // converged: both edges resolved here (sigma), and the population has spoken here (votes on either side)
  const converged = SIDES.every((side) => sigmaAt(ctx, s.curve, side, out) < ctx.p.convergedSigma) && SIDES.reduce((a, side) => a + votesAt(ctx, s.curve, side, out), 0) >= ctx.p.convergedVotes;
  return converged ? "CONVERGED" : "LEARNING";
}

function freshComplaints(ctx: Ctx): PerSide<boolean> {
  const s = ctx.s;
  return perSide((side) => s.complaintAt[side.key] !== null && ctx.w.t - (s.complaintAt[side.key] as number) < ctx.p.complaintMin * MIN);
}

function computeOutput(ctx: Ctx): Output {
  const s = ctx.s;
  const outBand = ctx.outForBand ?? (ctx.p.knotMin + ctx.p.knotMax) / 2;
  const a = act(ctx, ctx.cfg, s, {
    t: ctx.w.t,
    tin: ctx.tin,
    out: ctx.out,
    outBand: ctx.outForBand,
    released: s.released,
    releasedAt: s.releasedAt,
    push: s.push,
    fresh: freshComplaints(ctx),
    protecting: s.protecting,
    lastMode: s.lastOutput ? s.lastOutput.mode : null,
    last: s.lastOutput ? { heat: s.lastOutput.heat, cool: s.lastOutput.cool } : null,
  });
  s.released = a.released;
  s.releasedAt = a.releasedAt;
  for (const side of SIDES) if (a.push[side.key] === null) s.push[side.key] = null; // absorbed or faded away
  s.protecting = a.protecting;
  const st = stateName(ctx, outBand);
  const reasons = [st === "SEEDED" ? "seed" : st === "FROZEN" ? "frozen" : "learned", ...a.reasons];
  const o = ctx.outForBand;
  return {
    heat: a.heat,
    cool: a.cool,
    mode: a.mode,
    state: st,
    band: a.band,
    released: { ...a.released },
    push: { ...a.push },
    reasons,
    confidence: perSide((side) => confidenceAt(ctx, s.curve, side, outBand)),
    deltaFromAmbient: perSide((side) => (o === null ? null : a.band[side.key] - o)),
    thermal: thermalAt(s.thermal, ctx.p, outBand),
    curve: curvePoints(ctx, s.curve, s.thermal),
    protect: a.protecting,
  };
}

// ---------------------------------------------------------------- learn

/** §4: a push moves the felt edge inward to `target` (never outward of an earlier, unfaded push) and restarts its fade. */
function pushTo(ctx: Ctx, side: Side, target: number) {
  const s = ctx.s;
  const prev = s.push[side.key];
  const lo = s.lastOutput ? s.lastOutput.push[side.key] : null; // the earlier push as it stands now (faded)
  s.push[side.key] = { at: ctx.w.t, edge: prev === null || lo === null ? target : inner(side, lo, target) };
}

/** §6.3 exploration weight for a side right now: decays with confidence, scales with the zone's ability to correct. */
function explorationWeight(ctx: Ctx, side: Side, out: number): number {
  const p = ctx.p;
  const canCorrect = clamp((thermalAt(ctx.s.thermal, p, out)[side.key] * (p.silenceEveryMin / 60)) / p.silenceSigma, 0, 1);
  return p.silenceWeight * (1 - confidenceAt(ctx, ctx.s.curve, side, out)) * canCorrect;
}

/** §5.3 step 4: the quiet attended streak over the time before this event. */
function learn(ctx: Ctx, prevT: number | null) {
  const s = ctx.s;
  const p = ctx.p;
  const t = ctx.w.t;
  if (prevT === null || t - prevT > p.attendedGapMin * MIN) {
    s.quiet = { lastAt: t }; // a gap: nobody was being asked, the streak starts over
    return;
  }
  if (s.quiet.lastAt === null) s.quiet.lastAt = t;
  const out = ctx.out;
  if (s.frozen || !s.reading || out === null) { s.quiet.lastAt = t; return; } // not evidence: frozen, or nothing to judge against
  while (t - s.quiet.lastAt >= p.silenceEveryMin * MIN) {
    for (const side of SIDES) observeSilence(ctx, s.curve, side, out, s.reading.tin, explorationWeight(ctx, side, out));
    s.quiet.lastAt += p.silenceEveryMin * MIN;
    ctx.dirty = true;
  }
}

function onVote(ctx: Ctx, ev: Extract<EngineEvent, { type: "vote" }>) {
  const s = ctx.s;
  const p = ctx.p;
  const t = ctx.w.t;
  const side = sideForVote(ev.dir);
  const r = s.reading;
  const out = ctx.out; // learning needs a current outdoor temperature (≤ 3 h): a dead feed must not teach the wrong knot
  let updated = false;
  let pushed = false;
  if (!r || out === null) ctx.feedback = "noted.no_reading";
  else {
    const voter = (s.voters[ev.user] = s.voters[ev.user] || { step: p.stepInit, lastVote: null });
    if (!s.frozen) { observeVote(ctx, s.curve, ctx.cfg.seed, side, out, r.tin); updated = true; }
    s.complaintAt[side.key] = t; // §7.3 a complaint: the side is not released for a while
    s.quiet.lastAt = t; // the quiet streak restarts after a vote
    const last = voter.lastVote;
    pushed = true;
    if (last && t - last.at < p.cooldownMin * MIN) {
      // §7.3: inside the cooldown a repeat counts only if the room is stalled — it moved inward less than
      // half of what the thermal model expected with the equipment running on that side
      const expected = inwardOf(side, 0, expectedChange(s.thermal, p, out, (t - last.at) / 3600000, out - last.tin, side.key)); // > 0: expected inward movement
      const moved = inwardOf(side, last.tin, r.tin); // > 0 when the room moved inward since the last vote
      if (expected > 1e-9 && moved >= 0.5 * expected) pushed = false;
    }
    if (pushed) {
      if (last && last.dir !== side.dir) voter.step = Math.max(p.stepMin, voter.step / 2);
      else if (last && last.dir === side.dir && t - last.at < p.repeatWindowMin * MIN) voter.step = Math.min(p.stepMax, voter.step * p.stepGrow);
      pushTo(ctx, side, r.tin - side.sign * voter.step);
    }
    voter.lastVote = { at: t, dir: side.dir, tin: r.tin, equip: r.equip };
    ctx.feedback = pushed ? (side.key === "cool" ? "nudge.cooler" : "nudge.warmer") : "noted.cooldown";
    ctx.dirty = true;
  }
  ctx.rec("vote", {
    user: ev.user,
    dir: ev.dir,
    src: ev.src ?? null,
    tin: r?.tin ?? null,
    rh: r?.rh ?? null,
    out,
    applied: r?.applied ?? null,
    step: s.voters[ev.user]?.step ?? p.stepInit,
    push: { ...s.push },
    updated,
    pushed,
  });
}

/** §7.2: a manual change inward is a weak vote on that side and a push to the applied value; not a complaint. */
function onManual(ctx: Ctx, ev: Extract<EngineEvent, { type: "manual" }>) {
  const s = ctx.s;
  const lo = s.lastOutput;
  const out = ctx.out;
  if (!lo || !s.reading || out === null) return;
  for (const side of SIDES) {
    const applied = ev.applied[side.key];
    if (applied === undefined || inwardOf(side, lo[side.key], applied) <= 1e-9) continue;
    if (!s.frozen) observeVote(ctx, s.curve, ctx.cfg.seed, side, out, s.reading.tin, ctx.p.manualWeight);
    pushTo(ctx, side, applied);
    ctx.dirty = true;
  }
}

function onReading(ctx: Ctx, ev: Extract<EngineEvent, { type: "reading" }>) {
  const s = ctx.s;
  const t = ctx.w.t;
  const prev = s.reading;
  // §2b the interval since the previous reading teaches the thermal model; `equip` reports what the
  // equipment has been doing since that reading
  const out = ctx.out;
  if (prev && out !== null) {
    const dtMin = (t - prev.at) / MIN;
    if (dtMin >= 1 && dtMin <= 30) { observeInterval(s.thermal, ctx.p, out, dtMin / 60, ev.tin - prev.tin, out - prev.tin, ev.equip ?? null); ctx.dirty = true; }
  }
  s.reading = { tin: ev.tin, rh: ev.rh ?? null, equip: ev.equip ?? null, applied: ev.applied ?? null, at: t };
}

function onWeather(ctx: Ctx, ev: Extract<EngineEvent, { type: "weather" }>) {
  ctx.s.weather = { out: ev.out, high: ev.high ?? null, low: ev.low ?? null, at: ctx.w.t };
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
    let r: State;
    try {
      r = restore(event.snapshot, config);
    } catch {
      return reject(state, config, nowStr, "snapshot", event.type);
    }
    const ctx = new Ctx(r, config, w, nowStr);
    const out = computeOutput(ctx);
    finishOutput(ctx, out);
    return { state: ctx.s, output: out, effects: { records: ctx.records } };
  }

  const ctx = new Ctx(s, config, w, nowStr);
  const p = ctx.p;
  const prevT = s.lastEventAt;

  // §3.2 a new seed (or grid/knot parameters) restarts the curve and the thermal model
  if (s.seedKey !== seedKey(config)) {
    s.seedKey = seedKey(config);
    s.curve = newCurve(ctx, config.seed);
    s.thermal = newThermal(ctx.p);
    ctx.dirty = true;
  }
  // §5.3 step 4: the elapsed time before this event (learn)
  learn(ctx, prevT);
  // §5.3 step 5: apply the event
  switch (event.type) {
    case "vote":
      onVote(ctx, event);
      break;
    case "reading":
      onReading(ctx, event);
      break;
    case "weather":
      onWeather(ctx, event);
      break;
    case "manual":
      onManual(ctx, event);
      break;
    case "freeze":
      if (s.frozen !== !!event.on) ctx.dirty = true;
      s.frozen = !!event.on;
      break;
    case "tick":
      break;
  }
  // §5.3 step 6–7: band, act, effects
  const out = computeOutput(ctx);
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
  if (!same) {
    const { curve: _curve, ...rest } = out;
    ctx.rec("decision", rest);
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
  const gr = gridOf(config);
  const mid = (gr.p.knotMin + gr.p.knotMax) / 2;
  return {
    heat: config.seed.heat,
    cool: config.seed.cool,
    mode: config.capabilities.modes.includes("auto") ? "auto" : config.capabilities.modes[0],
    state: "SEEDED",
    band: { ...config.seed },
    released: { heat: false, cool: false },
    push: { heat: null, cool: null },
    reasons: ["seed"],
    confidence: { heat: 0, cool: 0 },
    deltaFromAmbient: { heat: null, cool: null },
    thermal: thermalAt(state.thermal, gr.p, mid),
    curve: curvePoints(gr, state.curve, state.thermal),
    protect: null,
  };
}

// ---------------------------------------------------------------- §7.9 projection

export interface ProjectionDay {
  /** the room temperature at the start */
  tin: number;
  /** hourly (or finer) outdoor temperatures through the day, in order */
  hours: { now: string; out: number }[];
}

/** §7.9: a given day's range from ambient — the band, what the air will do, what the equipment will do,
 * and where the room is expected to be, from the learned curve and thermal response. Pure. */
export function project(state: State, config: ZoneConfig, day: ProjectionDay): ProjectedHour[] {
  const gr = gridOf(config);
  const th = state.thermal;
  let tin = day.tin;
  let released: PerSide<boolean> = { ...state.released };
  let releasedAt: PerSide<number | null> = { ...state.releasedAt };
  let protecting = state.protecting;
  let lastMode: Mode | null = state.lastOutput ? state.lastOutput.mode : null;
  let last: PerSide<number> | null = state.lastOutput ? { heat: state.lastOutput.heat, cool: state.lastOutput.cool } : null;
  const none: PerSide<boolean> = { heat: false, cool: false };
  const rows: ProjectedHour[] = [];
  for (let h = 0; h < day.hours.length; h++) {
    const { now, out } = day.hours[h];
    const next = day.hours[h + 1];
    const minutes = next ? Math.max(1, (parseWhen(next.now).t - parseWhen(now).t) / MIN) : 60;
    const t0 = parseWhen(now).t;
    const a = act(gr, config, state, { t: t0, tin, out, outBand: out, released, releasedAt, push: { heat: null, cool: null }, fresh: none, protecting, lastMode, last });
    released = a.released;
    releasedAt = a.releasedAt;
    protecting = a.protecting;
    lastMode = a.mode;
    last = { heat: a.heat, cool: a.cool };
    // the room over this interval: 5-minute substeps of the thermal model, the equipment deciding as act() does
    let runMin = 0;
    let equipment: "heat" | "cool" | "idle" = "idle";
    const tin0 = tin;
    for (let m = 0; m < minutes; m += 5) {
      const dt = Math.min(5, minutes - m) / 60;
      const sub = act(gr, config, state, { t: t0 + m * MIN, tin, out, outBand: out, released, releasedAt, push: { heat: null, cool: null }, fresh: none, protecting, lastMode, last });
      const equip: Equip | null = sub.equipment ? sub.equipment.key : null;
      tin += expectedChange(th, gr.p, out, dt, out - tin, equip);
      if (sub.equipment) { runMin += dt * 60; equipment = sub.equipment.key; }
    }
    rows.push({ now, out, tin: Math.round(tin0 * 100) / 100, band: a.band, heat: a.heat, cool: a.cool, released: { ...released }, equipment, runMin: Math.round(runMin), deltaFromAmbient: perSide((sd) => a.band[sd.key] - out) });
  }
  return rows;
}
