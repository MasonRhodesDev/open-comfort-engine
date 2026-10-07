# Open Comfort Engine — Specification

Version: **0.5.0-rc.5** (release candidate)
Status: normative. The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are
to be interpreted as described in RFC 2119.

This document defines the Open Comfort Engine completely: an implementation in
any language that follows it and passes the conformance vectors in
[`vectors/`](vectors/) (see [`CONFORMANCE.md`](CONFORMANCE.md)) is a conformant
engine. The TypeScript package in `packages/core` is the reference
implementation; where it and this document disagree, this document wins and the
reference implementation has a bug.

## 1. Purpose and scope

The engine learns, for one climate **zone**, the **tolerance curve** of the
people who use it — the indoor temperature range they accept as a function of
the outdoor temperature — and runs the equipment as little as that curve
allows. It is one loop, run on every event:

```
sense  →  band  →  act  →  learn
```

- **Sense**: the room temperature, the outdoor temperature, votes and manual
  changes — all supplied by the host as events.
- **Band**: the range of room temperatures the population accepts at the
  current outdoor temperature, read from the learned curve at its safe
  quantile, never wider than the configured protection limits.
- **Act**: the device stays idle while the room is inside the band, or outside
  it but drifting toward it by itself (the outdoor air, and whatever the room
  makes or loses on its own, are doing the work). Otherwise the device
  conditions the room to the nearest edge of the band.
- **Learn**: a vote moves the curve at the outdoor temperature it was cast at
  and is felt at once; quiet attended time, while the curve is still uncertain,
  widens it; nothing else moves the band.

Idle is the default. Energy is saved by two things only: the band is as wide as
the population has shown it tolerates, and a side of the band whose job the
room's own drift is already doing is released.

The engine is a pure state machine:

```
step(state, event, config) -> { state', output, effects }
```

- It performs no I/O, reads no clock (time arrives in every event), and keeps no
  hidden state: everything it knows is in `state`, which is serialisable
  (the **snapshot**, §9).
- It knows **no identity**: a vote's `user` is an opaque string kept only for
  records and for that voter's step search (§7.3). The curve is the zone's, not
  anyone's.
- It knows **no time of day** and **no presence**. What a vote means comes from
  the room temperature, the outdoor temperature and the current band, not from
  the hour it was cast or who was home. The host decides when the engine is
  fed (§6.3) and what to do with the equipment when nobody is home.
- It does not decide what the weather is, what the device can do, or what site
  policy allows. Those arrive as events and configuration. The host applies
  site policy *after* the engine's output and reports what it actually applied
  (§5.4).

Out of scope (host / integration concerns): identity, presence and vacancy
(turning the equipment off or applying an away range, and not feeding the
engine meanwhile), arrival pre-conditioning (from the projection, §7.9),
holds after manual changes and their timeouts, weather fetching, tariffs,
actuation, persistence, user-facing wording, site rules (quiet hours, peak
pricing, holiday modes, …).

### 1.1 Sides

Everything the engine does to a setpoint it does to **a side**. A side is one
edge of the band:

| side | edge | sign `σ` | device limit | protection limit |
|---|---|---|---|---|
| `cool` | `upper` (warmest accepted) | `+1` | `capabilities.cool` | `protect.max` |
| `heat` | `lower` (coolest accepted) | `−1` | `capabilities.heat` | `protect.min` |

"Inward" means toward the middle of the band: `edge − σ·x` moves edge `x`
inward; "outward" is `edge + σ·x`; `inner(a, b)` is whichever of two values
lies further inward. The sign lets every rule below be written once; an
implementation MUST NOT contain a heat version and a cool version of the same
rule.

## 2. Units, time and numbers

- Temperatures are degrees Celsius (`°C`), as JSON numbers. Rates are °C per
  hour; the envelope coupling is per hour.
- Durations are minutes unless a field name says otherwise.
- Time: every event carries `now`, an RFC 3339 timestamp **with a UTC offset**
  (e.g. `2026-10-02T09:15:00-07:00`). The engine derives the instant `t` for
  elapsed-time arithmetic and keeps the offset only to format times back. It
  needs no timezone database and never computes a local time of day.
- Events MUST be fed in non-decreasing `now` order. An event older than the
  last processed event MUST be rejected (no state change, `effects.records`
  contains one `{type:"rejected", reason:"time"}` record). A `reading` whose
  `tin`, or a `weather` whose `out`, is not a finite number MUST be rejected
  the same way with `reason:"value"`.
- Floating point: IEEE-754 binary64. Conformance compares numbers with the
  tolerances in `CONFORMANCE.md`. Setpoints are rounded to the device setpoint
  step (§3.1) **inward** (`floor` for the `cool` side, `ceil` for `heat`,
  with a 1e−9 tolerance), which makes them exact and never past a limit.

## 3. Configuration (`ZoneConfig`)

Configuration is supplied with every `step` call and is not part of state.
JSON Schema: [`schema/zone-config.schema.json`](schema/zone-config.schema.json).

### 3.1 Device capabilities

| field | meaning |
|---|---|
| `capabilities.modes` | subset of `["heat","cool","auto","off"]` the device supports |
| `capabilities.minGap` | minimum `cool − heat` the device accepts in `auto`, °C |
| `capabilities.setpointStep` | setpoint resolution, °C (e.g. `0.1`, `0.5`) |
| `capabilities.heat.min/max` | allowed heating setpoint range |
| `capabilities.cool.min/max` | allowed cooling setpoint range |

### 3.2 Seed

`seed: { heat, cool }` — where the tolerance curve starts: one range, the same
at every outdoor temperature. It MUST satisfy `cool − heat ≥ minGap`. Changing
the seed restarts the curve (§6.1).

### 3.3 Limits

| field | meaning |
|---|---|
| `setback.heat` / `setback.cool` | what a **released** side is set to (§7.4) |
| `protect.min` / `protect.max` | optional absolute indoor range (°C) that must never be crossed — e.g. to protect electronics, plants or pets kept in the space. Overrides everything else (§7.6) |

### 3.4 Parameters (`params`, all optional)

Defaults are normative. Hosts MAY override within the allowed range; a value
outside it is clamped to the range. Every parameter is a learning rate, a
prior or a device/physics constant; none is a comfort value.

| name | default | range | used in |
|---|---|---|---|
| `gridMin` / `gridMax` / `gridStep` | 14 / 32 / 0.1 | — | §6.1 |
| `knotMin` / `knotMax` / `knotStep` | −10 / 45 / 5 | — | §6.1 |
| `priorSigma` | 1.5 | 0.5–4 | §6.1 |
| `voteNoise` | 0.7 | 0.2–2 | §6.2 |
| `silenceSigma` | 2.0 | 0.5–5 | §6.2 |
| `silenceWeight` | 0.3 | 0–1 | §6.3 |
| `silenceEveryMin` | 60 | 15–1440 | §6.3 |
| `attendedGapMin` | 10 | — | §6.3 |
| `manualWeight` | 0.5 | 0–1 | §6.2 |
| `forget` | 0.02 | 0–0.2 | §6.4 |
| `qSafe` | 0.2 | 0.05–0.5 | §7.1 |
| `stepInit` / `stepMin` / `stepMax` / `stepGrow` | 1.0 / 0.3 / 2.0 / 1.25 | °C | §7.3 |
| `cooldownMin` | 30 | — | §7.3 |
| `repeatWindowMin` | 120 | — | §7.3 |
| `natureRate` | 0.3 | 0.1–2 (°C/h) | §7.4 |
| `releaseDwellMin` | 30 | 0–120 | §7.4 |
| `complaintMin` | 120 | — | §7.2, §7.4, §7.8 |
| `envelopePrior` | 0.3 | /h | §6.5 |
| `equipmentPrior` | 2.0 | °C/h | §6.5 |
| `thermalForget` | 0.1 | 0.01–0.5 (per hour of evidence) | §6.5 |
| `thermalPriorHours` | 2 | 0.5–24 | §6.5 |
| `convergedSigma` | 0.6 | — | §5.2 |
| `convergedVotes` | 20 | — | §5.2 |
| `protectHysteresis` | 1.0 | 0.2–3 | §7.6 |
| `snapshotEveryMin` | 60 | — | §9 |

## 4. Events

Every event is a JSON object with `type` and `now`. JSON Schemas live in
[`schema/`](schema/). Unknown fields MUST be ignored. Unknown `type` MUST be
rejected with a `{type:"rejected", reason:"type"}` record.

| type | fields | meaning |
|---|---|---|
| `vote` | `user`, `dir: "hot"\|"cold"`, `src?` | someone says they are too hot / too cold. `user` is an opaque id for records and the step search; `src` is provenance for records only; the engine MUST NOT branch on either |
| `reading` | `tin`, `rh?`, `equip?: "heat"\|"cool"\|"fan"\|"idle"\|"off"`, `applied?: {heat?, cool?, mode?}` | the room now; `equip` is what the equipment has been doing **since the previous reading** (§6.5), taken from the equipment's own state — compressor or burner running, measured power — never inferred from its mode or setpoint (a unit in cool mode with its compressor off is `idle`). Hosts SHOULD send it — an interval without it teaches the thermal model nothing (§6.5) — and SHOULD send a reading at least every 10 min while feeding, changed or not (§6.5 learns only from intervals of 1–30 min); `applied` what the device is actually set to |
| `weather` | `out`, `high?`, `low?` | outdoor temperature now (and today's forecast extremes, recorded only). Hosts SHOULD send it at least every 10 min: release (§7.4) follows the last value and ignores one older than 3 h |
| `manual` | `applied: {heat?, cool?, mode?}` | someone changed the device directly. Learned as a weak vote and felt (§7.3); the **host** owns any hold and its timeout and simply does not actuate the engine's output while it holds |
| `freeze` | `on: boolean` | "we've got this": stop all learning and exploration (§7.7) |
| `tick` | — | heartbeat; hosts SHOULD send one every 1–5 minutes **while someone is home** (§6.3) |
| `restore` | `snapshot` | replace state with a snapshot (§9) |

## 5. State machine

### 5.1 State variables (summary; full list in the snapshot schema)

- `curve` — the tolerance curve: per side, one knot per outdoor temperature (§6.1).
- `voters[uid]` — `{step, lastVote}` per voter (§7.3).
- `reading` — last `{tin, rh, equip, applied, at}`; `weather` — last `{out, high, low, at}`.
- `quiet` — `{lastAt}`: when quiet was last counted in the attended streak (§6.3).
- `push` — per side `{at, edge}` or null: the felt edge a vote set (§7.2).
- `complaintAt` — per side, when the last complaint was made (§7.4, §7.8).
- `released` — per side booleans, and `releasedAt` when each last changed (§7.4).
- `frozen` — boolean. `protecting` — `"max"`, `"min"` or null (§7.6).
- `thermal` — per knot: the idle-drift statistics `{n, sx, sy, sxx, sxy}` and each side's
  equipment rate — the learned thermal response (§6.5).
- `lastOutput`, `lastEventAt`, `lastSnapshotAt`.

### 5.2 States

The **state** reported in the output is derived, in this priority order:

1. `FROZEN` — `frozen` is true.
2. `SEEDED` — no vote has ever been learned (every knot's `n` is 0).
3. `CONVERGED` — at the current outdoor temperature, both sides have
   `sigma < convergedSigma` and the two sides' vote weight together is
   `≥ convergedVotes`.
4. `LEARNING` — otherwise.

### 5.3 Processing order for one `step`

1. Reject out-of-order, unknown or non-finite events (§2, §4); a `restore`
   whose snapshot cannot be read is rejected with `reason:"snapshot"`.
2. If the configured seed or the grid/knot parameters changed, restart the
   curve and the thermal model (§6.1).
3. **Learn** for the time before this event: the attended quiet streak and its
   silence observations (§6.3).
4. Apply the event (§6–§7, per type).
5. **Band** and **act**: compute the output (§7.8).
6. Emit effects (§10). Set `lastEventAt = now`.

### 5.4 Applied values

`reading.applied` and `manual.applied` report what the device is *actually* set
to after the host applied its own policy. The engine MUST use `reading.tin`
(not its own output) as the temperature votes are judged against. The engine's
next output is computed from its own state, never by echoing `applied` back.

## 6. Learning

### 6.1 The tolerance curve

For each side the engine learns `T_side(out)`: the indoor temperature at which
the zone's population stops accepting the room, as a function of the outdoor
temperature `out`. It is represented by **knots** at outdoor temperatures
`knotMin, knotMin + knotStep, …, knotMax`. Each knot holds a discrete
posterior over the indoor edge on the grid `c_i = gridMin + i·gridStep`,
`i = 0..N−1`, `N = round((gridMax − gridMin)/gridStep) + 1`, and the vote
weight `n` it has absorbed.

Priors are Gaussians on the grid (normalised to sum 1) whose safe quantile
reproduces the seed exactly (§7.1), the same at every knot (a flat curve):

```
μ_side = seed[side] − σ · priorSigma · Φ⁻¹(qSafe)      # cool: cool + 0.8416·s ; heat: heat − 0.8416·s   (qSafe 0.2)
w_i ∝ exp(−½ ((c_i − μ_side)/priorSigma)²)
```

`Φ⁻¹(0.2) = −0.8416212335729143`; for another `qSafe` use any inverse-normal
accurate to 1e−9.

**Reading the curve.** An observation or a query at outdoor temperature `out`
falls between two knots, `k` and `k+1`, with interpolation weights
`1 − f` and `f`, `f = (out − knot_k)/knotStep`; at or beyond the ends, the
end knot with weight 1. A statistic of the curve at `out` is the weighted sum
of the two knots' statistics:

- `quantile(q)` of a knot — the smallest `c_i` whose cumulative weight ≥ `q − 1e−12`;
- `sigma` of a knot — the weighted standard deviation of `c`;
- `confidence = clamp(1 − sigma/priorSigma, 0, 1)`.

**No slope, no functional form, no time of day, no identity**: a hot knot
learns only what people say on hot days.

### 6.2 Likelihoods

With `tin` the current indoor temperature, `σ` the sign of the side being
updated, and `Φ` the standard normal CDF (Appendix A). An observation at `out`
updates each of the two knots around it with the observation's weight times
that knot's interpolation weight, `wt`:

| observation | side updated | likelihood `L_i` |
|---|---|---|
| vote (`hot` → `cool` side, `cold` → `heat` side): the room is past that edge | the voted side | `Φ(σ·(tin − c_i)/voteNoise)^wt` |
| quiet attended time: the room may be acceptable (§6.3) | both sides | `1 − s + s · Φ(z)` with `z = σ·(c_i − tin)/silenceSigma`, `s = clamp(wt, 0, 1)` — and exactly `1` where `z ≥ 2`: quiet says nothing about an edge the room is nowhere near, so a far edge is never walked outward by it |
| manual (§7.3) | as the vote | the vote likelihood with weight `manualWeight` |

Update: `w_i ← w_i · max(L_i, 1e−9)`, then normalise. A vote also adds `wt`
to the knot's `n`.

Φ MUST be computed with the formula in Appendix A, so that implementations in
different languages agree to within floating-point rounding.

If no `reading` has been received, or no `weather` within the last 3 h, votes
are recorded but cause no model update and no push (`effects.feedback =
"noted.no_reading"`): a dead weather feed must not teach the wrong knot.

### 6.3 Quiet attended time (exploration)

Quiet is evidence only if someone could have complained. The engine does not
know who is home; it knows whether it is being **fed**. A quiet streak runs
across continuous events: it starts (or restarts, counting nothing) whenever
the gap since the previous event exceeds `attendedGapMin`, and whenever a vote
is cast. Time while `FROZEN`, or without a reading or a current (≤ 3 h)
outdoor temperature, is not quiet either: it is skipped, never counted later.
Hosts feed the engine (ticks and readings) while someone is home and stop
while nobody is.

Every `silenceEveryMin` of streak, the engine applies one quiet observation to
both sides at the current `out` and `tin`, with weight

```
w_side = silenceWeight · (1 − confidence_side(out)) · clamp(thermal[side] · silenceEveryMin/60 / silenceSigma, 0, 1)
```

— **exploration that decays with confidence** (an edge the population has
resolved is not moved by quiet; sleeping people are quiet, so a confident
night band holds without votes), **scaled by the zone's ability to correct**
(a zone whose equipment can move the room by `silenceSigma` within the
silence interval explores at full weight; a slow one proportionally less,
because a wrong guess there is expensive to undo). Not while `FROZEN`.

### 6.4 Forgetting

After every vote or manual update, on the updated knots:
`w_i ← (1 − forget·wt)·w_i + forget·wt·prior_i`.

### 6.5 Thermal response

The zone's physics, learned from consecutive readings 1–30 min apart with a
current (≤ 3 h) outdoor temperature. The rate of change is variable, so it is learned
as a **curve over outdoor temperature** on the same knots as the tolerance
curve — the room's idle drift (its coupling to the outdoor air, and what it
makes or loses on its own) and each side's equipment rate per knot. The
rates at an outdoor temperature — `envelope(out)`, `gain(out)`,
`equipment[side](out)` — are the §6.1 interpolation of the two knots'
**fitted** values; the statistics below are never interpolated. Not while
`FROZEN` (§7.7).

```
idle:     dtin/dt = idle(out, tin) = envelope(out) · (out − tin) + gain(out)   # envelope: 1/h ; gain: °C/h
running:  dtin/dt = idle(out, tin) − σ · equipment[side](out)                   # equipment: °C/h, net of the idle drift
```

`gain` is the heat the room makes or loses by itself at that outdoor
temperature — people, their equipment, sun through the glass, the ground
under a basement. It is learned, never configured: a room's idle drift is a
line in `out − tin` whose slope is the envelope and whose intercept is the
gain, and both are read off the same readings.

`reading.equip` says what the equipment has been doing **since the previous
reading**, so the interval it closes is attributed to it: `idle`, `fan` or
`off` to the idle drift, `heat` or `cool` to that side; an interval without
`equip` teaches nothing (a running interval learned as drift would feed
release, §7.4). Per interval of `dtH` hours at outdoor `out`, with
`rate = Δtin/dtH` and `x = out − tin_previous`, each of the two knots around
`out` is updated with weight `w = wt · dtH` (`wt` its interpolation weight:
an interval is as much evidence as it is long) and forgetting
`f = thermalForget · w`. An interval whose `|rate|` exceeds what any
admissible line can produce — `5·|x| + 10` idle (the envelope and gain
clamps), `5·|x| + 30` running (plus the equipment clamp) — is a sensor fault
and teaches nothing:

- idle: the knot's idle statistics
  ```
  n ← (1 − f)·n + w ;  sx ← (1 − f)·sx + w·x ;  sy ← (1 − f)·sy + w·rate ;
  sxx ← (1 − f)·sxx + w·x² ;  sxy ← (1 − f)·sxy + w·x·rate
  ```
  and its rates are the least-squares line through them and the prior (below):
  ```
  N = n + h ;  SXX = sxx + 9h ;  SXY = sxy + 9h · envelopePrior          # h = thermalPriorHours
  envelope_k = clamp( (N·SXY − sx·sy) / (N·SXX − sx²), 0.02, 5 )
  gain_k     = clamp( (sy − envelope_k·sx) / N, −10, 10 )
  ```
- running on a side: `equipment[side]_k ← (1 − f)·equipment[side]_k +
  f·clamp(σ·(envelope_k·x + gain_k − rate), 0.1, 20)` (a floor, never zero:
  a mislabelled interval can pull a rate down, and it recovers).

The prior is `thermalPriorHours` of pseudo-observations on the line
`rate = envelopePrior · x` (gain 0), half at `x = +3` and half at `x = −3`,
added to the statistics whenever the rates are evaluated — never stored,
never forgotten. The statistics themselves start at zero (`n` is effective
hours of evidence; it saturates near `1/thermalForget`). With no data this
reads back exactly `envelope = envelopePrior`, `gain = 0`. With data, the
prediction `idle(out, tin)` at the operating point follows the data; the
prior decides how the fit splits it between slope and intercept, and pulls
the prediction toward `rate = envelopePrior · x` by at most `h/(h + n)` of
the disagreement (one sixth at the defaults once `n` has saturated). The
denominator is never zero (it is at least `9h²`). No interval is too close
to outdoor to count.

So the rate of change is derived from the delta from ambient and from what
the room does on its own, and an equipment whose capacity fades in the heat
(a heat pump, a window unit) is seen as such. The model is used for stall detection (§7.3), the projection
(§7.9) and the exploration weight (§6.3), and reported to hosts at the
current outdoor temperature (`output.thermal`) and per knot
(`output.curve[].thermal`) for their own pre-conditioning and for graphs.

## 7. Control (the loop)

All of §7 is written for one side; it runs for both (§1.1). `tin` is the last
reading; `out` is the last outdoor temperature (for release, §7.4, only if
received within the last 3 h); the band is read at the last outdoor
temperature ever received, or at the middle of the knot range if none. The
thermal model (§6.5) is read at the same outdoor temperature as the rule
that uses it: release (§7.4) at the ≤ 3 h value, `output.thermal` at the
band's.

### 7.1 Band

```
band[side] = curve_side(out) at quantile  0.5 − σ·(0.5 − qSafe)     # cool: qSafe ; heat: 1 − qSafe
```

The safe quantile: the edge the population is `1 − qSafe` likely to still
accept. With no weather ever received the band is the seed.

### 7.2 The felt push

A vote (§7.3) or a manual change sets a **push** on its side: `{at: now, edge:
target}`. While it stands, the edge the device follows is the push rather
than the band:

```
faded      = push.edge + (band[side] − push.edge) · clamp((now − push.at) / complaintMin, 0, 1)
edge[side] = faded   while  inward(band[side], faded) > 0,   else band[side] (and the push is dropped)
```

So a push is felt at once, fades linearly back into the learned band over
`complaintMin` of quiet (another vote restarts it), and is absorbed the moment
learning has moved the band past it. No timer resets anything; the band itself
never jumps.

### 7.3 Votes, manual changes, step search

A vote on a side, with a reading and weather available:

1. Learn: the vote likelihood at `(out, tin)` on that side (§6.2), unless `FROZEN`.
2. `complaintAt[side] ← now`; the quiet streak's `lastAt ← now`.
3. Feel it (Thermovote-style step search, per voter `user`): the voter's
   `step` starts at `stepInit`, halves on a direction reversal (floor
   `stepMin`) and grows by `stepGrow` on a repeated same-direction vote within
   `repeatWindowMin` (cap `stepMax`). A vote within `cooldownMin` of the same
   voter's previous vote is felt only if the room is **stalled** — it moved
   inward since that vote by less than half of what the thermal model (§6.5)
   expected with the equipment running on that side over that time, from
   that vote's room and the current outdoor temperature; otherwise
   `feedback = noted.cooldown` and only the learning stands (an equipment
   already doing all it can is not asked for more). A felt vote pushes to
   `target = tin − σ·step` (`feedback = nudge.cooler` / `nudge.warmer`); the
   new push is `inner(previous faded push, target)`.

`manual{applied}`: for each side whose `applied` value moved inward of the
engine's last output, apply the vote likelihood with weight `manualWeight` and
push to `target = applied[side]`. A manual change is **not** a complaint: no
`complaintAt`, no step change, no `lastVote`, so it never un-releases a side
(§7.4). A side that moved outward or did not move is ignored.

### 7.4 Nature (release)

The room drifts on its own at `idle(out, tin)` °C/h (§6.5): the outdoor air
through the envelope, plus what the room makes or loses by itself. A side the
room is drifting **away from**, by a drift that would carry it inside that
edge on its own, has nothing to do: it is released to `setback` and the drift
does the work. It is taken back when the drift turns or can no longer reach
the edge. With `drift = σ·idle(out, tin)` (negative: the room drifts away
from this edge) and `reach = −σ·idle(out, edge)` (negative: a room sitting
at the edge would drift back outside it), both in °C/h:

```
released[side] ← true   when  drift ≤ −natureRate  and  reach ≥ 0
released[side] ← false  when  drift ≥ +natureRate  or  reach < 0,
                        or out is unknown (older than 3 h), or a complaint on this side is fresh (within complaintMin)
a change of released[side] is deferred while the last one is younger than releaseDwellMin
  (unless the side is in a fresh complaint, or out/tin became unknown)
if released[side]: setpoint[side] = setback[side]
```

Between the thresholds nothing changes, so a drift jittering around zero
cannot flap a side, and the dwell keeps a sun-struck outdoor sensor from
cycling the equipment; a room is never left outside the band when its own
drift cannot bring it in (the device takes it at once); and a complaint on a
side keeps it in the device's hands for `complaintMin` — the person is
uncomfortable now and the drift is too slow. Cooling is released only while
the learned model says the room cools on its own (attended data, possibly
another day's): on a hot day cooling is always available, and a room that
warms from its occupants with cooler air outside keeps its cooling; the same
for heating on a cold one. While a zone's model is still at its priors
(`gain` 0, `envelope` = `envelopePrior`) this is the 0.5.0-rc.4 rule with its
margin at `natureRate / envelopePrior`; once the zone has taught its
envelope, a leaky room releases at a small outdoor difference and a tight
one only at a large one, which is what "the air is doing the work" means in
each. `reach` has no hysteresis and moves with every reading as the model
learns, not only with the weather: a room settling exactly at its edge can
change state once per dwell, and the dwell is the only defence (the
simulator's flapping criterion counts release changes per hour).

### 7.5 (reserved)

Pre-conditioning for arrivals and block changes is the host's (from the
projection, §7.9, and the thermal response, §6.5); the engine has no schedule.

### 7.6 Protection

Applied last and whatever the state is, including `FROZEN`:

```
setpoint[side] = inner( setpoint[side], limit[side] )  rounded inward        # cool ≤ protect.max ; heat ≥ protect.min
```

If that breaks the device gap, the other side gives way (§7.8). The engine
also tracks whether the **room** is beyond a limit, with hysteresis:

```
protecting = side   when  σ·(tin − limit[side]) ≥ 0 ;  stays until  σ·(tin − limit[side]) ≤ −protectHysteresis
```

`output.protect` is `"max"` (cool side), `"min"` (heat side) or `null`, and the
reason `protect` is added while clamping or protecting. **While
`output.protect` is not null, hosts MUST actuate toward the output even when
their own policy would otherwise leave the device off** (nobody home, quiet
hours, an automation switch is off, a manual hold). This is the one place the
engine's output overrides site policy.

### 7.7 Freeze

`freeze{on:true}` sets `frozen`. While frozen: no posterior updates (votes,
silence, manual), no forgetting, no thermal learning. Votes still push (§7.2)
and are recorded. `freeze{on:false}` clears it.

### 7.8 Output (band → act)

```
for each side:
  edge      = §7.2 (the band, or the felt push while it stands)
  wanted    = released ? setback[side] : edge                                   # §7.4
  wanted    = clamped to capabilities[side]                                     # reason `limit` if the clamp bit
  setpoint  = the engine's previous output if |wanted − previous| < setpointStep  # a trigger band on the output
              else wanted rounded inward to setpointStep (§2)
if cool − heat < minGap: keep the side with a fresh complaint if exactly one has it, else `heading` (below);
                         the other side moves outward (rounded outward) to restore the gap; re-clamp
for each side: setpoint = protection clamp (§7.6), rounded inward; if that breaks the gap the other side gives way
heading = the side the room is drifting toward: `cool` if idle(out, tin) > 0, else `heat` (`heat` if unknown)
side    = the side whose setpoint the room is past (σ·(setpoint − tin) < 0 — a released side's setpoint is its
          setback, a clamped one's the limit), else the side `protecting` names (§7.6 hysteresis), else none
mode = "auto" if supported;
       else `side` if it is a side the device supports;
       else the previous output's mode if it is a side (hysteresis);
       else `heading` if supported;
       else the first supported mode
act:   `equipment` = `side` when the mode allows it (`auto`, or the mode is that side); else "idle" — also while
       there is no reading (the projection, §7.9, uses exactly this)
```

A released side is not idle at any price: its setpoint is the setback, and
the equipment runs when the room passes it (the floor's or ceiling's job);
the same holds for a protection limit, so §7.6's MUST is reachable on a
device without `auto`.

Output object:

```
{ heat, cool, mode, state,
  equipment,                                 # "heat" | "cool" | "idle": the act — what the equipment should be doing now
  band: { heat, cool },                      # the learned band at this outdoor temperature (§7.1)
  released: { heat, cool }, push: { heat, cool },   # the faded push edges or null (§7.2)
  reasons: [string], confidence: { heat, cool },
  deltaFromAmbient: { heat, cool },          # band − out, or null without weather
  thermal: { envelope, gain, heat, cool },    # §6.5, at this outdoor temperature
  curve: [ { out, heat, cool, heatSigma, coolSigma, thermal } … ],   # the safe edges, spreads and thermal response at every knot
  protect }
```

`reasons` is a list of stable codes describing what contributed, in this
order: `seed` (state SEEDED), `learned` (LEARNING or CONVERGED), `frozen`,
`conflict` (the band is narrower than `minGap`), `push`, `released`,
`protect`, `limit` (a capability clamp bit), `gap`.

`mode` is the device setting the engine leaves armed; `equipment` says whether
anything should be running under it. A host whose device has an `off` mode
MAY apply `off` while `equipment` is `idle` (a device without `auto` is
otherwise parked on a side); a device in `auto` idles by itself and needs
nothing. A host that does so takes over the device's own cycle control —
`equipment` has no hysteresis and no minimum run time — and SHOULD apply its
own minimum on and off times.

### 7.9 Projection

`project(state, config, day)` — a pure function of the same state. Given the
room temperature at the start and a list of `{now, out}` through the day, it
returns, per interval: the band at that outdoor temperature, the predicted
room temperature (integrated with the thermal model of §6.5 in 5-minute
substeps, the equipment running as §7.8's act says), which sides the drift releases, the
equipment side and its run minutes, and the delta from ambient. It uses the
same band and act computation as `step` (with no pushes and no fresh
complaints), so it cannot disagree with it. The host applies its own presence
plan on top. This is "a given day's range from ambient".

## 8. (reserved)

There is no block structure: the engine has no notion of time of day.

## 9. Snapshot

The snapshot is the complete state as JSON
([`schema/snapshot.schema.json`](schema/snapshot.schema.json)) with
`snapshotVersion: 4`. `restore{snapshot}` MUST accept any version ≤ the
implementation's and migrate it; unknown higher versions MUST be rejected.
Migrating a version-1 or version-2 snapshot keeps `reading`, `weather`,
`frozen`, `protecting` and `voters` and starts everything else fresh, with
`lastEventAt` cleared so that older events are accepted again; hosts that
kept vote records SHOULD replay them (as `weather` + `reading` + `vote`
events at their original times) so the curve starts from real data.

Migrating a version-3 snapshot keeps everything, including the equipment
rates (they mean the same thing: °C/h net of the idle drift, which at `gain`
0 is the version-3 model); the idle statistics start at zero, which needs the
zone config. `lastEventAt` stands; `lastOutput` is replaced by the restore
step's own output (a version-3 one has no `equipment`).
Migrating also happens when a version-3 or version-4 snapshot was built with
other grid or knot parameters (its `seedKey` differs): the curve and thermal
model restart.
A restored curve that has never learned a vote (every knot's `n` is 0) is as
good as fresh: `lastEventAt` is cleared so that a replay of older events is
accepted.
The engine emits `effects.snapshot` after any event that changed the curve,
the thermal model or `frozen`, or that produced a `decision` record (so a
restored snapshot's `lastOutput` is the output actually published), and
otherwise at most once every `snapshotEveryMin`. Round-trip requirement:
`restore(snapshot)` followed by the same events MUST produce identical outputs
to never having snapshotted.

## 10. Effects

```
{ records: Record[], snapshot?: Snapshot, feedback?: FeedbackCode }
```

Record types (all include `at` = `now` and `zone` = config `id`):

| type | when | fields |
|---|---|---|
| `vote` | every accepted vote | `user, dir, src, tin, rh, out, applied, step, push, updated (bool), pushed (bool)` |
| `decision` | output `heat`, `cool`, `mode`, `state`, `protect` or a `released` flag differs from the previous output (not `equipment`: it flips every time the room crosses a setpoint, and hosts see it on every output) | the full output without `curve` |
| `rejected` | §2, §4, §9 | `reason` (`time`, `type`, `value`, `snapshot`), `event` type |

Feedback codes (hosts render words, never numbers): `nudge.cooler`,
`nudge.warmer`, `noted.cooldown`, `noted.no_reading`.

## Appendix A — Φ

`Φ(x) = ½·erfc(−x/√2)`, with erfc computed as follows (Numerical Recipes
`erfcc`, absolute error < 1.2e−7):

```
erfc(x):  z = |x|; t = 1/(1 + 0.5 z)
          r = t·exp(−z² − 1.26551223 + t(1.00002368 + t(0.37409196 + t(0.09678418 +
              t(−0.18628806 + t(0.27886807 + t(−1.13520398 + t(1.48851587 +
              t(−0.82215223 + t·0.17087277)))))))))
          return x ≥ 0 ? r : 2 − r
```

This formula is normative.
