# Open Comfort Engine — Specification

Version: **0.3.0** (draft)
Status: normative. The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are
to be interpreted as described in RFC 2119.

This document defines the Open Comfort Engine completely: an implementation in
any language that follows it and passes the conformance vectors in
[`vectors/`](vectors/) (see [`CONFORMANCE.md`](CONFORMANCE.md)) is a conformant
engine. The TypeScript package in `packages/core` is the reference
implementation; where it and this document disagree, this document wins and the
reference implementation has a bug.

## 1. Purpose and scope

The engine turns occupants' "too hot" / "too cold" votes into heating and
cooling setpoints for one climate **zone**, learning each occupant's comfort
over time, and spends any slack it finds on saving energy ("entropy": a slow
drift of setpoints toward idle that decays as it becomes confident).

The engine is a pure state machine:

```
step(state, event, config) -> { state', output, effects }
```

- It performs no I/O, reads no clock (time arrives in every event), and keeps no
  hidden state: everything it knows is in `state`, which is serialisable
  (the **snapshot**, §9).
- It knows nothing about who occupants are. A user is an opaque string id
  (`uid`). Two ids are the same user iff the strings are equal.
- It does not decide who is present, what the weather is, what the device can
  do, or what site policy allows. Those arrive as events and configuration.
  The host applies site policy *after* the engine's output and reports what it
  actually applied (§5.4).

Out of scope (host / integration concerns): identity, presence detection,
arrival prediction, weather fetching, tariffs, actuation, persistence,
user-facing wording, site rules (quiet hours, pre-cooling for peak pricing,
holiday modes, …).

## 2. Units, time and numbers

- Temperatures are degrees Celsius (`°C`), as JSON numbers.
- Durations are minutes unless a field name says otherwise.
- Time: every event carries `now`, an RFC 3339 timestamp **with a UTC offset**
  (e.g. `2026-10-02T09:15:00-07:00`). The engine derives:
  - `t` — the instant (for elapsed-time arithmetic),
  - the **local date** (`YYYY-MM-DD`) and **local minute of day** `m ∈ [0,1440)`
    from the timestamp's own offset.
  The engine needs no timezone database. Hosts MUST send local offsets.
- Events MUST be fed in non-decreasing `now` order. An event older than the
  last processed event MUST be rejected (no state change, `effects.records`
  contains one `{type:"rejected", reason:"time"}` record).
- Floating point: IEEE-754 binary64. Conformance compares numbers with the
  tolerances in `CONFORMANCE.md`. Outputs (setpoints) are rounded to the
  device setpoint step (§3.1) with round-half-up, which makes them exact.

## 3. Configuration (`ZoneConfig`)

Configuration is supplied with every `step` call and is not part of state.
Changing it between calls is allowed; §8.7 describes how blocks react.
JSON Schema: [`schema/zone-config.schema.json`](schema/zone-config.schema.json).

### 3.1 Device capabilities

| field | meaning |
|---|---|
| `capabilities.modes` | subset of `["heat","cool","auto","off"]` the device supports |
| `capabilities.minGap` | minimum `cool − heat` the device accepts in `auto`, °C |
| `capabilities.setpointStep` | setpoint resolution, °C (e.g. `0.1`, `0.5`) |
| `capabilities.heat.min/max` | allowed heating setpoint range |
| `capabilities.cool.min/max` | allowed cooling setpoint range |

### 3.2 Seed schedule

`seed.blocks`: a list of 1..12 `{ start: "HH:MM", heat: °C, cool: °C }`
with strictly increasing `start`, the first one MAY be later than `00:00`; the
schedule wraps: the last block runs until the first block's start the next day.
Every block MUST satisfy `cool − heat ≥ capabilities.minGap`.

### 3.3 Limits

| field | meaning |
|---|---|
| `setback.heat` | lowest heating setpoint vacancy drift may reach |
| `setback.cool` | highest cooling setpoint vacancy drift may reach |
| `responseMin` | typical minutes for the room to respond to a setpoint change |
| `protect.min` / `protect.max` | optional absolute indoor range (°C) that must never be crossed — e.g. to protect electronics, plants or pets kept in the space. Overrides everything else, including holds and freeze (§7.12) |

### 3.4 Parameters (`params`, all optional)

Defaults are normative. Hosts MAY override within the allowed range.

| name | default | range | used in |
|---|---|---|---|
| `gridMin` / `gridMax` / `gridStep` | 14 / 32 / 0.1 | — | §6.1 |
| `priorSigma` | 1.5 | 0.5–4 | §6.1 |
| `adaptiveSlope` (k) | 0.10 | 0–0.4 | §6.1 |
| `adaptiveRef` | 20 | — | §6.1 |
| `adaptiveTrmMin` / `adaptiveTrmMax` | 10 / 33.5 | — | §7.2a |
| `voteNoise` (s) | 0.7 | 0.2–2 | §6.2 |
| `silenceSigma` | 2.0 | 0.5–5 | §6.2 |
| `silenceWeight` | 0.3 | 0–1 | §6.2 |
| `silenceEveryMin` | 60 | 15–1440 | §6.3 |
| `manualWeight` | 0.5 | 0–1 | §6.2 |
| `forget` | 0.02 | 0–0.2 | §6.4 |
| `trmAlpha` | 0.8 | 0–0.99 | §6.5 |
| `coolingSeasonTrm` | 18 | — | §7.2 |
| `qLow` / `qHigh` | 0.2 / 0.8 | — | §7.2 |
| `leashBase` / `leashGain` | 1.0 / 2.0 | — | §7.2 |
| `stepInit` / `stepMin` / `stepMax` | 1.0 / 0.3 / 2.0 | — | §7.3 |
| `stepGrow` | 1.25 | 1–2 | §7.3 |
| `cooldownMin` | 30 | 0–240 | §7.3 |
| `stallDelta` | 0.3 | — | §7.3 |
| `nudgeMax` | 3.0 | — | §7.3 |
| `repeatWindowMin` | 120 | — | §7.3 |
| `driftRateMax` / `driftRateMin` | 0.3 / 0.1 | °C/h | §7.4 |
| `driftCapMax` / `driftCapMin` | 1.5 / 0.5 | °C | §7.4 |
| `driftPauseMin` | 120 | — | §7.5 |
| `driftQuantile` | 0.3 | 0.05–0.5 | §7.4 |
| `preconditionMaxMin` | 120 | 0–360 | §7.11 |
| `vacancyRate` | 0.5 | °C/h | §7.6 |
| `vacancyAccelPerHour` | 0.5 | — | §7.6 |
| `vacancyRateMax` | 1.0 | °C/h | §7.6 |
| `responseRateDefault` | 0.05 | °C/min | §7.7 |
| `costWeight` | 0.5 | 0–2 | §7.4, §7.6 |
| `convergedSigma` / `convergedVotes` | 0.6 / 20 | — | §5.2 |
| `structureHour` | 3 | 0–23 | §8 |
| `splitMinVotes` | 5 | — | §8.2 |
| `splitMinGap` | 1.0 | — | §8.2 |
| `mergeMedianDelta` / `mergeSigma` | 0.3 / 0.6 | — | §8.3 |
| `blockMinMin` | 120 | — | §8 |
| `blocksMax` | 8 | — | §8 |
| `trialProb` | 0.2 | 0–1 | §8.4 |
| `trialShiftsMin` | [15, 30] | — | §8.4 |
| `trialRevertWindowMin` / `trialRevertDays` | 60 / 3 | — | §8.4 |
| `structureVotesFull` | 100 | — | §8.4 |
| `voteHistoryDays` | 30 | — | §8.2 |
| `snapshotEveryMin` | 60 | — | §9 |
| `protectHysteresis` | 1.0 | 0.2–3 | §7.12 |

### 3.5 Sleep windows

`sleep`: an optional list of up to 4 `{ start: "HH:MM", end: "HH:MM" }` local
times of day when the zone's present users are asleep (a window MAY wrap
midnight; `start = end` is ignored). Sleeping users cannot vote, so while the
current local minute is inside a window **and** at least one user is present:

- occupied drift (§7.4) is **frozen in place**: `drift.value` neither grows nor
  resets on its own (the usual resets — a vote, a change of the present set, a
  block change — still apply);
- no silence observations (§6.3);
- no trial shift (§8.4) moves a boundary that starts or ends inside a window;
- the output carries the reason `sleep`.

Votes, nudges, holds, vacancy drift (nobody present = nobody asleep), recovery
and protection are unaffected. Like the seed, the windows are the host's
knowledge about its occupants; the engine only applies them.

## 4. Events

Every event is a JSON object with `type` and `now`. JSON Schemas live in
[`schema/`](schema/). Unknown fields MUST be ignored. Unknown `type` MUST be
rejected with a `{type:"rejected", reason:"type"}` record.

| type | fields | meaning |
|---|---|---|
| `vote` | `user`, `dir: "hot"\|"cold"`, `src?` | a user says they are too hot / too cold. `src` is provenance for records only; the engine MUST NOT branch on it |
| `presence` | `users: uid[]`, `expectedArrival?` (RFC 3339), `expectedUsers?: uid[]` | the complete set of present users (replaces the previous set), and optionally when the host expects the next arrival and who (§7.7, §7.11). The engine never predicts arrivals itself |
| `reading` | `tin`, `rh?`, `equip?: "heat"\|"cool"\|"fan"\|"idle"\|"off"`, `applied?: {heat?, cool?, mode?}` | indoor conditions and what the device is actually set to |
| `weather` | `out`, `high?`, `low?` | outdoor temperature now (and today's forecast extremes) |
| `cost` | `level` ∈ [0,1] | relative energy price signal (0 = cheapest) |
| `manual` | `applied: {heat?, cool?, mode?}`, `until?` (RFC 3339) | someone changed the device directly; a hold until `until` (host-chosen timeout) or else the next block (§7.9) |
| `freeze` | `on: boolean` | "we've got this": stop all learning and entropy (§7.8) |
| `tick` | — | periodic heartbeat; hosts SHOULD send one every 1–5 minutes |
| `restore` | `snapshot` | replace state with a snapshot (§9) |

## 5. State machine

### 5.1 State variables (summary; full list in the snapshot schema)

- `blocks` — the learned block structure (§8), each `{id, start, heat, cool}`.
- `models[uid][blockId]` — comfort range model per user and block (§6).
- `presence` — `{known, users, since, expectedArrival, expectedUsers}`; `since` is when the set of present users last changed.
- `reading` — last `{tin, rh, equip, applied, at}`.
- `weather` — last `{out, high, low, at}`, plus running-mean `trm` and the day being tracked `{date, sum, n, hl}` (§6.5).
- `nudge` — `{delta, blockId}` (§7.3).
- `drift` — occupied drift `{value, pausedUntil}` (§7.4).
- `vacancy` — `{since, value}` (§7.6).
- `hold` — `{until, applied}` or null (§7.9).
- `frozen` — boolean.
- `protecting` — `"max"`, `"min"` or null (§7.12).
- `responseRate` — learned °C/min (§7.7).
- `structure` — `{rng, lastRunDate, trials[], votes[]}` (§8).
- `cost` — last level (default 0).
- `lastEventAt`.

### 5.2 States

The **state** reported in the output is derived, in this priority order:

1. `FROZEN` — `frozen` is true.
2. `HOLD` — `hold` is active (`now < hold.until`).
3. `RECOVERING` — presence is known, no users present, recovery active (§7.7).
4. `VACANT` — presence is known and no users are present.
5. `SEEDED` — no user present has any vote in the current block.
6. `CONVERGED` — every present user's current-block model has
   `sigma < convergedSigma` (both edges) and `n ≥ convergedVotes`.
7. `LEARNING` — otherwise.

### 5.3 Processing order for one `step`

1. Reject out-of-order or unknown events (§2, §4).
2. Compute the local date/minute. If the configured seed changed, reseed
   (§8.7). Run **block maintenance** (§8) if this event is the first one at or
   after `structureHour` on a local date later than `structure.lastRunDate`.
   The very first event an engine processes only sets `lastRunDate` to its
   local date (no maintenance), so day one always starts from the seed.
3. If the current block changed since the previous event: clear `nudge`,
   expire a `hold` that has no host-given `until` (§7.9), reset occupied
   `drift.value` to 0.
4. Apply the event (§6–§7, per type).
5. Advance time-based processes for the elapsed time since `lastEventAt`:
   silence observations (§6.3), occupied drift (§7.4), vacancy drift (§7.6),
   recovery (§7.7). Elapsed time is `min(now − lastEventAt, 60 min)` so a
   long gap cannot cause a jump.
6. Compute the output (§7.10).
7. Emit effects (§10). Set `lastEventAt = now`.

### 5.4 Applied values

`reading.applied` and `manual.applied` report what the device is *actually* set
to after the host applied its own policy. The engine MUST use `reading.tin`
(not its own output) as the temperature votes are judged against, and MUST
treat `manual` as a hold (§7.9). The engine's next output is computed from its
own state, never by echoing `applied` back.

## 6. Comfort model

### 6.1 Comfort range and posteriors

A user's comfort in a block is a **range** `[T_lo, T_hi]`: the coolest and the
warmest indoor temperature they accept. The engine learns each edge separately.
For each `(uid, blockId, edge)` with `edge ∈ {lower, upper}` it keeps a discrete
posterior over `c`, the edge's value at the reference running-mean outdoor
temperature, on the grid `c_i = gridMin + i·gridStep`, `i = 0..N−1`,
`N = round((gridMax − gridMin)/gridStep) + 1`.

The edge's value **now** is

```
T(c) = c + k · (trm − adaptiveRef)        with k = adaptiveSlope
```

Priors are Gaussians on the grid (normalised to sum 1) whose conservative
quantile reproduces the seed block exactly (§7.2):

```
upper:  μU = b.cool − priorSigma · Φ⁻¹(qLow)      # e.g. cool + 0.8416·σ for qLow = 0.2
lower:  μL = b.heat − priorSigma · Φ⁻¹(qHigh)     # e.g. heat − 0.8416·σ for qHigh = 0.8
w_i ∝ exp(−½ ((c_i − μ)/priorSigma)²)
```

`b` is the block the model belongs to (§8.1). `Φ⁻¹(0.2) = −0.8416212335729143`,
`Φ⁻¹(0.8) = +0.8416212335729143`; for other `qLow`/`qHigh` use any inverse-normal
accurate to 1e−9.

A user's block model is `{ lower, upper, n, step, lastVote }`, created lazily
from the priors the first time it is needed. `n` counts vote updates
(manual updates add `manualWeight`), `step` is the nudge step (§7.3),
`lastVote` is `{at, dir, tin}` or null.

Statistics of one edge posterior (weights `w` on grid `c`):
- `quantile(q)` — the smallest `c_i` whose cumulative weight ≥ `q − 1e−12`,
- `median = quantile(0.5)`,
- `mean`, `sigma` — weighted mean and standard deviation of `c`,
- `confidence = clamp(1 − sigma/priorSigma, 0, 1)`.

A block model's `sigma` is the larger of its edges' sigmas and its
`confidence` the smaller of their confidences.

### 6.2 Likelihoods

With `tin` the current indoor temperature, `T_i = T(c_i)`, and `Φ` the standard
normal CDF (Appendix A):

| observation | edge updated | likelihood `L_i` |
|---|---|---|
| vote `hot` (`tin` is above the warmest acceptable) | upper | `Φ((tin − T_i)/voteNoise)` |
| vote `cold` (`tin` is below the coolest acceptable) | lower | `Φ((T_i − tin)/voteNoise)` |
| silence (`tin` is inside the range) | upper | `(1 − silenceWeight) + silenceWeight · Φ((T_i − tin)/silenceSigma)` |
| | lower | `(1 − silenceWeight) + silenceWeight · Φ((tin − T_i)/silenceSigma)` |
| manual (direction only, §7.9) | as the vote | the vote likelihood raised to the power `manualWeight` |

Update: `w_i ← w_i · max(L_i, 1e−9)`, then normalise.

Φ MUST be computed with the formula in Appendix A, so that implementations in
different languages agree to within floating-point rounding.

If no `reading` has been received, votes are recorded but cause no model update
and no nudge (`effects.feedback = "noted.no_reading"`).

### 6.3 Silence

While a user is present, the zone is not `FROZEN` or `HOLD`, and it is not a
sleep window (§3.5), every
`silenceEveryMin` minutes of continuous presence without a vote from that user,
the engine applies one silence observation to both edges of that user's
current-block model, using the latest `tin`. Implementations track
`lastSilenceAt[uid]`, set to `now` when the user votes and when the user
becomes present.

### 6.4 Forgetting

After every vote or manual update, on the updated edge:
`w_i ← (1 − forget)·w_i + forget·prior_i`.

### 6.5 Running-mean outdoor temperature (trm)

A day's mean outdoor temperature `d` is `(high + low)/2` from the latest
`weather` event of that local date that carried both `high` and `low`; if none
did, it is the mean of that date's `out` samples. (Sampling only part of a day —
e.g. an engine started mid-afternoon — badly overestimates the mean; the
forecast extremes don't.)

When the local date of a `weather` event differs from the date being tracked,
the finished day's `d` updates `trm ← (1 − trmAlpha)·d + trmAlpha·trm` (if
`trm` is unset: `trm ← d`). Until the first day completes, `trm` is today's `d`
so far. If no weather has ever been received, `trm = adaptiveRef`.

## 7. Control

### 7.1 Present users and the current block

`present` = `presence.users`. The current block is the block containing the
local minute of `now` (§8.1). Models are looked up for `(uid, currentBlock.id)`.

### 7.2 Aggregate band

For each present user `u` with block model `M_u`, and the block's priors
`PU`, `PL`:

```
dU_u = quantile(M_u.upper, qLow)  − quantile(PU, qLow)     # how far u's warm limit moved
dL_u = quantile(M_u.lower, qHigh) − quantile(PL, qHigh)    # how far u's cool limit moved
coolShift = min_u dU_u          # nobody present should be too hot
heatShift = max_u dL_u          # nobody present should be too cold
leashCool = leashBase + leashGain · min_u confidence(M_u.upper)   # each side is leashed by
leashHeat = leashBase + leashGain · min_u confidence(M_u.lower)   # confidence in the limit it follows
coolShift = clamp(coolShift, −leashCool, +leashCool)
heatShift = clamp(heatShift, −leashHeat, +leashHeat)
```

At cold start both shifts are exactly 0, so the output equals the seed block
(plus the adaptive term, §7.2a). With no users present the shifts keep the
values from the last time users were present in this block (0 if never).

If `(b.cool + coolShift) − (b.heat + heatShift) < capabilities.minGap` the
present users' ranges conflict; the engine records a `conflict` (§10) and the
gap rule in §7.10 resolves it in favour of the season.

### 7.2a Adaptive term

`A = adaptiveSlope · (clamp(trm, adaptiveTrmMin, adaptiveTrmMax) − adaptiveRef)`
(the clamp is the adaptive model's range of validity). The seed schedule is taken to be
comfortable at `trm = adaptiveRef`; on warmer (cooler) running-mean outdoor
temperatures the whole band moves up (down) by `A`, as in the ASHRAE 55 adaptive
comfort model. The default slope (0.10) is the value reported for mechanically
conditioned buildings, well below the 0.31 of naturally ventilated ones.
`A` is not subject to the leash.

### 7.3 Nudge (vote fast path)

On a `vote` from `u` (a reading must be available, §6.2), after the model
update (skipped when `FROZEN`, but the nudge still applies):

1. If `hold` is active: no nudge; feedback `noted.hold`.
2. Let `last = M_u.lastVote`. If `last` exists and
   `now − last.at < cooldownMin` and the room is **not stalled**, no nudge;
   feedback `noted.cooldown`. The room is *stalled* if
   `now − last.at ≥ responseMin` and `|tin − last.tin| < stallDelta`.
3. Step size: if `last` exists and `last.dir ≠ dir`:
   `step ← max(stepMin, step/2)`; else if `last` exists and `last.dir = dir`
   and `now − last.at < repeatWindowMin`: `step ← min(stepMax, step·stepGrow)`.
   (A new model starts at `stepInit`.)
4. Make the vote **felt**: after the model update, the voted edge of the
   output must end at least one step past the room temperature. With `A`
   (§7.2a) and the post-update shifts (§7.2):
   ```
   hot:   delta = min(0, (tin − step) − (b.cool + coolShift + A + nudge.delta))
   cold:  delta = max(0, (tin + step) − (b.heat + heatShift + A + nudge.delta))
   nudge.delta ← clamp(nudge.delta + delta, −nudgeMax, +nudgeMax) ;  nudge.blockId ← currentBlock.id
   ```
   Whatever the learned shift already moved counts toward it, so learning and
   the nudge never add up to more than "one step past the room".
5. `M_u.lastVote ← {at: now, dir, tin}` (also when no nudge was applied).

The nudge persists until the block changes (§5.3 step 3).

### 7.4 Occupied drift (entropy)

While users are present, the state is `SEEDED`, `LEARNING` or `CONVERGED`,
`now ≥ drift.pausedUntil`, and it is not a sleep window (§3.5; there the value
is frozen in place):

```
conf  = min_u confidence(M_u)        # block-model confidence, §6.1
rate  = (driftRateMax − (driftRateMax − driftRateMin)·conf) · (1 + costWeight·cost)   # °C/h
cap   = driftCapMax − (driftCapMax − driftCapMin)·conf
drift.value ← min(cap, drift.value + rate · blockElapsedHours)
```

`blockElapsedHours` is the elapsed time (§5.3) limited to the time since the
current block started and the time since the set of present users last
changed (`presence.since`), so neither a block nor a new set of occupants
inherits drift time from before. Occupied drift resets to 0 whenever the set of present users changes
(including the first `presence` event).

Drift widens the band toward idle: it raises the cooling setpoint and lowers
the heating setpoint (§7.10) — but on each side never past the most sensitive
present user's `driftQuantile` limit (default 0.3: a point the user is
learned to be ~70% likely to still accept):

```
coolCeil  = min_u (quantile(M_u.upper, driftQuantile)     − quantile(PU, qLow))   # as a shift from the seed
heatFloor = max_u (quantile(M_u.lower, 1 − driftQuantile) − quantile(PL, qHigh))
capCool   = max(0, coolCeil − coolShift)                      # coolShift/heatShift after the leash (§7.2)
capHeat   = max(0, heatShift − heatFloor)
driftCool = min(drift.value, capCool) ;  driftHeat = min(drift.value, capHeat)
```

So exploration may go from the conservative quantile toward the user's learned
limit, and no further; right after a complaint that is below the temperature
complained about. (Exploring right up to the median produces complaints by
design once the model is accurate; 0.3 trades a little saving for fewer of them.)

### 7.5 Complaint response

On any `vote`: `drift.value ← 0`, `drift.pausedUntil ← now + driftPauseMin`,
and nothing else: caution after a complaint comes from the reset, the pause,
and the drift ceiling (§7.4). (The posterior itself is not flattened — doing so
after every vote prevents it from ever converging.)

### 7.6 Vacancy drift

When `present` is empty: if `vacancy.since` is unset, set it to `now`.
While not recovering (§7.7) and not frozen:

```
h     = (now − vacancy.since) in hours
rate  = min(vacancyRateMax, vacancyRate · (1 + vacancyAccelPerHour · h)) · (1 + costWeight·cost)
vacancy.value ← vacancy.value + rate · min(elapsedHours, h)
```

When users become present: `vacancy ← {since: null, value: 0}`.

### 7.7 Recovery and response rate

**Response rate.** On each `reading` where the previous reading is 1–30
minutes older, `equip` is `heat` or `cool`, and the temperature moved in the
equipment's direction: `r = |Δtin| / Δminutes`;
`responseRate ← 0.8·responseRate + 0.2·r` (initial `responseRateDefault`).

**Recovery.** While vacant with `expectedArrival` set and not yet recovering:
`need = vacancy.value / responseRate` minutes. If `expectedArrival − now ≤ need`
the zone enters `RECOVERING`: `vacancy.value ← 0` and vacancy drift stops.
Recovering ends when presence becomes non-empty, when `expectedArrival`
changes (a `presence` event repeating the same empty set and the same
`expectedArrival` does not end it), or 60 minutes after `expectedArrival`
passes with nobody present (a no-show:
vacancy drift resumes from 0 with `vacancy.since ← now`). Without
`expectedArrival`, recovery happens when presence becomes non-empty.

**Unknown presence.** Until the first `presence` event, presence is unknown:
the zone is `SEEDED`, and neither occupied nor vacancy drift runs.

### 7.11 Pre-conditioning

While users are present and not `HOLD`, the output tightens early so the room
gets there in time. For a future band `(nCool, nHeat)` starting in `ahead`
minutes:

```
need = max(0, cool − nCool, nHeat − heat)         # °C the band must tighten
if need > 0 and ahead ≤ min(preconditionMaxMin, need / responseRate):
    cool = min(cool, nCool) ; heat = max(heat, nHeat) ; reason "precondition"
```

Two future bands are considered, in this order (both may apply):
1. the next block — its seed plus `shifts` for the **current** present users,
   plus `A`; `ahead` = minutes to the next block boundary;
2. expected arrivals — when `presence.expectedArrival` is in the future and
   `expectedUsers` contains users not present: the current block's band for
   present ∪ expected users (plus `A` and the nudge); `ahead` = minutes to
   `expectedArrival`.

Only tightening is applied early; loosening waits for the boundary.
While vacant and `RECOVERING` (§7.7), if `expectedUsers` is given the recovery
target is the current block's band for those users.

### 7.12 Protection

Applied last, after holds (§7.9) and whatever the state is (including `FROZEN`):

```
if protect.max set and cool > protect.max:  cool = protect.max ; if cool − heat < minGap: heat = cool − minGap
if protect.min set and heat < protect.min:  heat = protect.min ; if cool − heat < minGap: cool = heat + minGap
(each rounded to setpointStep toward the inside of the limit: down for max, up for min,
so the room settles inside the hysteresis band and protection can release)
```

The engine also tracks whether the **room** is beyond a limit, with hysteresis so
a device does not short-cycle at the threshold:

```
protecting = "max"  when tin ≥ protect.max ; stays until tin ≤ protect.max − protectHysteresis
protecting = "min"  when tin ≤ protect.min ; stays until tin ≥ protect.min + protectHysteresis
```

`output.protect` is `protecting` (`"max"`, `"min"` or `null`), and the reason
`protect` is added while clamping or protecting. For a device without `auto`,
`mode` becomes `cool` (`heat`) while protecting the max (min).

**While `output.protect` is not null, hosts MUST actuate toward the output even
when their own policy would otherwise leave the device off** (the zone is empty,
quiet hours, an automation switch is off, a manual hold). This is the one place
the engine's output overrides site policy.

### 7.8 Freeze

`freeze{on:true}` sets `frozen`. While frozen: no posterior updates (votes,
silence, manual), no forgetting, no occupied or vacancy drift (both reset to
0), no structure changes (§8). Votes still nudge (§7.3) and are recorded.
`freeze{on:false}` clears it.

### 7.9 Hold

`manual{applied, until?}`: `hold ← {until, applied, host: true}` when the
host gave an `until` later than `now` (the host owns the timeout; such a hold
survives block changes), else `hold ← {until: start of the next block, applied}`; for each
present user apply a manual (direction-only) update: if `applied.cool` is lower
than the engine's last output cool, or `applied.heat` is higher than the last
output heat, treat as `hot`-for-cool / `cold`-for-heat respectively (lowering
cool ⇒ `hot`, raising heat ⇒ `cold`, raising cool ⇒ `cold`, lowering heat ⇒ `hot`);
if both moved in conflicting directions, no update. While the hold is active (whether the state is reported as `HOLD` or `FROZEN`), the output
equals `hold.applied` (fields not given fall back to the computed value); if
that leaves `cool − heat < minGap`, the side *not* given in `hold.applied` moves
to restore the gap (within its capability limits, rounded to `setpointStep`).

### 7.10 Output

```
b      = current block
base   = { heat: b.heat + heatShift + A + nudge.delta,
           cool: b.cool + coolShift + A + nudge.delta }
if present non-empty:  heat −= driftHeat ; cool += driftCool       # §7.4
                       apply pre-conditioning                       # §7.11
else:                  heat = max(setback.heat, heat − vacancy.value)
                       cool = min(setback.cool, cool + vacancy.value)
clamp heat to capabilities.heat, cool to capabilities.cool
if cool − heat < minGap:  cooling season (trm ≥ coolingSeasonTrm): heat = cool − minGap
                          heating season:                       cool = heat + minGap
                          then re-clamp; if a clamp bites, move the other side
round both to setpointStep: floor(x/step + 0.5 + 1e−9)·step
mode_intent = "auto" if supported,
              else (trm ≥ coolingSeasonTrm ? "cool" : "heat") if supported, else first supported mode
if HOLD: replace with hold.applied fields
```

Output object:

```
{ heat, cool, mode, state, block: b.id,
  reasons: [string], confidence, coolShift, heatShift, adaptive: A, nudge, drift, vacancy,
  protect: "max" | "min" | null }
```

`reasons` is a list of stable codes describing what contributed, in this
order when applicable: `seed`, `adaptive`, `learned`, `conflict`, `nudge`, `drift`,
`vacancy`, `precondition`, `recovering`, `hold`, `frozen`, `sleep`, `protect`, `limit`, `gap`.

## 8. Block structure

### 8.1 Blocks

`state.blocks` starts as the seed blocks with ids `b0, b1, …` in order.
A block's `heat`/`cool` are its seed values (inherited on split/merge as
below). The block containing minute `m` is the last block with `start ≤ m`, or
the last block of the list if `m` is before the first start (wrap).

### 8.2 Split

At the daily maintenance run (§5.3 step 2), unless frozen, at most one block
is split per run — the one with the largest qualifying difference. For each block,
take the votes recorded in it during the last `voteHistoryDays`
(`structure.votes`, each `{at, minute, blockId, dir}`), score `+1` for `hot`
and `−1` for `cold`. For each candidate boundary at a whole hour strictly inside
the block such that both sides are at least `blockMinMin` long, compute the
mean score on each side; choose the candidate maximising the absolute
difference among those with ≥ `splitMinVotes` votes on both sides and
difference ≥ `splitMinGap` (ties: the earliest boundary). If one exists and
`blocks.length < blocksMax`, split: the new block starts at the boundary, gets
the next free id (`b<n>`, n counting up from the seed's length), the parent's
`heat`/`cool`, and a copy of every user's model for the parent; recorded votes
after the boundary move to the new block. Record `{type:"blocks", action:"split"}`.

### 8.3 Merge

After splitting: for each adjacent pair (cyclic) where every user that has a
model in either block has, in both, `sigma < mergeSigma` and
`|median_a − median_b| < mergeMedianDelta` for both edges, and at least one such user exists,
merge the later into the earlier: keep the earlier `start`, `heat`, `cool` and
id; each edge's posterior is combined by normalised element-wise product of
weights (users with a model in only one block keep it). At most one merge per run. Record
`{type:"blocks", action:"merge"}`.

### 8.4 Trial shifts (structure entropy)

After merging: `structConf = min(1, votesInHistory / structureVotesFull)`;
`p = trialProb · (1 − structConf)`. Draw `u = rng()`; if `u < p`, draw a
boundary index `j = floor(rng() · blocks.length)` (the start of block `j`,
skipped if there is one block) and a shift
`Δ = trialShiftsMin[floor(rng()·len)]` minutes in the direction that lengthens
the neighbour with the **lower energy use** — the block with the higher
`cool` in the cooling season (trm ≥ coolingSeasonTrm), the lower `heat`
otherwise; ties: later. The shift MUST keep every block ≥ `blockMinMin`, and is skipped if the
boundary's old or new time is inside a sleep window (§3.5).
Store `{at, blockId, from, to}` in `structure.trials`.

A trial is **reverted** (start restored) if any vote arrives within
`trialRevertWindowMin` minutes (local time of day) of the shifted boundary in
the `trialRevertDays` after it; after that it is permanent (removed from
`trials`).

### 8.5 PRNG

`structure.rng` is a uint32 state for **mulberry32**:

```
rng():  state = (state + 0x6D2B79F5) mod 2^32
        t = state
        t = imul(t XOR (t >>> 15), t OR 1)
        t = t XOR (t + imul(t XOR (t >>> 7), t OR 61))
        return ((t XOR (t >>> 14)) >>> 0) / 2^32
```

(`imul` = 32-bit multiply keeping the low 32 bits; `>>>` = logical shift.)
The initial state is `config.params.seed` if given, else 1. Reference values
for state 1: the first three draws are `0.6270739406`, `0.0027357212`,
`0.5274470400` (10 d.p.).

### 8.6 Vote history

Every vote appends `{at, minute, blockId, dir}` to `structure.votes`; entries
older than `voteHistoryDays` are dropped at maintenance.

### 8.7 Seed changes

If the configured seed differs from the one the blocks were built from
(compare the list of `start/heat/cool`), the engine rebuilds `blocks` from the
new seed and discards models (records `{type:"blocks", action:"reseed"}`).

## 9. Snapshot

The snapshot is the complete state as JSON
([`schema/snapshot.schema.json`](schema/snapshot.schema.json)) with
`snapshotVersion: 1`. `restore{snapshot}` MUST accept any version ≤ the
implementation's and migrate it; unknown higher versions MUST be rejected.
The engine emits `effects.snapshot` after any event that changed models,
blocks or `frozen`, or that produced a `decision` record (so a restored
snapshot's `lastOutput` is the output actually published), and otherwise at
most once every `snapshotEveryMin`.
Round-trip requirement: `restore(snapshot)` followed by the same events MUST
produce identical outputs to never having snapshotted.

## 10. Effects

```
{ records: Record[], snapshot?: Snapshot, feedback?: FeedbackCode }
```

Record types (all include `at` = `now` and `zone` = config `id`):

| type | when | fields |
|---|---|---|
| `vote` | every accepted vote | `user, dir, src, block, tin, rh, out, trm, present, applied, step, nudge, state, updated (bool)` |
| `decision` | output `heat`, `cool`, `mode` or `state` differs from the previous output | the full output |
| `conflict` | §7.2 ranges conflict (at most once per block per day) | `block, present, coolShift, heatShift` |
| `blocks` | split / merge / trial / revert / reseed | `action, blocks` |
| `rejected` | §2, §4 | `reason, event type` |

Feedback codes (hosts render words, never numbers): `nudge.cooler`,
`nudge.warmer`, `noted.cooldown`, `noted.hold`, `noted.no_reading`.

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
