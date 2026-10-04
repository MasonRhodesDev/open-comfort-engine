# Open Comfort Engine — Specification

Version: **0.4.0** (draft)
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
cooling setpoints for one climate **zone**. It is one loop, run on every event:

```
sense  →  band  →  act  →  learn
```

- **Sense**: the room temperature, the outdoor temperature, who is present (and
  whether they are asleep), and votes — all supplied by the host as events.
- **Band**: the range of room temperatures everyone present accepts, at the
  current **risk** level, never wider than the configured protection limits.
  With nobody present the band is the setback range.
- **Act**: the device stays idle while the room is inside the band, or outside
  it but drifting toward it by itself (the outdoor air is doing the work).
  Otherwise the device conditions the room to the nearest edge of the band.
- **Learn**: a vote moves that person's edge and lowers risk on that side;
  quiet time with people awake raises risk slowly; sleep freezes it.

Energy is saved by two things only: the band widens as the engine gains
confidence (risk), and a side of the band whose job the outdoor air is already
doing is released.

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
arrival prediction, weather fetching, tariffs, actuation, manual-override
holds and their timeouts, persistence, user-facing wording, site rules (quiet
hours, pre-cooling for peak pricing, holiday modes, …).

### 1.1 Sides

Everything the engine does to a setpoint it does to **a side**. A side is one
edge of the band:

| side | edge | sign `σ` | device limit | protection limit |
|---|---|---|---|---|
| `cool` | `upper` (warmest accepted) | `+1` | `capabilities.cool` | `protect.max` |
| `heat` | `lower` (coolest accepted) | `−1` | `capabilities.heat` | `protect.min` |

"Inward" means toward the middle of the band: `edge − σ·x` moves edge `x`
inward; "outward" is `edge + σ·x`. The sign lets every rule below be written
once; an implementation MUST NOT contain a heat version and a cool version of
the same rule.

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
  tolerances in `CONFORMANCE.md`. Setpoints are rounded to the device setpoint
  step (§3.1) **inward** (`floor` for the `cool` side, `ceil` for `heat`,
  with a 1e−9 tolerance), which makes them exact and never past a limit.

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
| `setback.heat` / `setback.cool` | the band when nobody is present, and the value a **released** side takes (§7.4) |
| `protect.min` / `protect.max` | optional absolute indoor range (°C) that must never be crossed — e.g. to protect electronics, plants or pets kept in the space. Overrides everything else (§7.6) |
| `responseMin` | typical minutes for the room to respond to a setpoint change (stall detection, §7.2) |

### 3.4 Sleep windows

`sleep`: an optional list of up to 4 `{ start: "HH:MM", end: "HH:MM" }` local
times of day when the zone's present users are asleep (a window MAY wrap
midnight; `start = end` is ignored). Sleeping users cannot vote, so while the
local minute is inside a window and at least one user is present: risk is
frozen in place (§7.3), no silence observations are made (§6.3), and no trial
shift moves a boundary that starts or ends inside a window (§8.4). The output
carries the reason `sleep`. Like the seed, the windows are the host's knowledge
about its occupants; the engine only applies them.

### 3.5 Parameters (`params`, all optional)

Defaults are normative. Hosts MAY override within the allowed range.

| name | default | range | used in |
|---|---|---|---|
| `gridMin` / `gridMax` / `gridStep` | 14 / 32 / 0.1 | — | §6.1 |
| `priorSigma` | 1.5 | 0.5–4 | §6.1 |
| `voteNoise` | 0.7 | 0.2–2 | §6.2 |
| `silenceSigma` | 2.0 | 0.5–5 | §6.2 |
| `silenceWeight` | 0.3 | 0–1 | §6.2 |
| `silenceEveryMin` | 60 | 15–1440 | §6.3 |
| `manualWeight` | 0.5 | 0–1 | §6.2 |
| `forget` | 0.02 | 0–0.2 | §6.4 |
| `qSafe` | 0.2 | 0.05–0.5 | §7.1 (the edge at risk 0) |
| `qRisk` | 0.35 | qSafe–0.5 | §7.1 (the edge at risk 1; 0.5 = the person's median limit) |
| `riskRate` | 0.25 | /h | §7.3 (0 → 1 in 4 quiet hours) |
| `riskPauseMin` | 120 | — | §7.3 |
| `stepInit` / `stepMin` / `stepMax` / `stepGrow` | 1.0 / 0.3 / 2.0 / 1.25 | °C | §7.2 |
| `cooldownMin` | 30 | — | §7.2 |
| `stallDelta` | 0.3 | °C | §7.2 |
| `nudgeMax` | 3.0 | °C | §7.2 |
| `repeatWindowMin` | 120 | — | §7.2 |
| `natureMargin` | 1.0 | 0.3–3 | §7.4 |
| `preconditionMaxMin` | 120 | — | §7.5 |
| `responseRateDefault` | 0.05 | °C/min | §7.5 |
| `costWeight` | 0.5 | 0–2 | §7.3, §8.4 |
| `convergedSigma` | 0.6 | — | §5.2 |
| `convergedVotes` | 20 | — | §5.2 |
| `structureHour` | 3 | 0–23 | §5.3 |
| `splitMinVotes` | 5 | — | §8.2 |
| `splitMinGap` | 1.0 | °C | §8.2 |
| `mergeMedianDelta` | 0.3 | °C | §8.3 |
| `mergeSigma` | 0.6 | — | §8.3 |
| `blockMinMin` | 120 | — | §8.2–8.4 |
| `blocksMax` | 8 | — | §8.2 |
| `trialProb` | 0.2 | 0–1 | §8.4 |
| `trialShiftsMin` | [15, 30] | — | §8.4 |
| `trialRevertWindowMin` / `trialRevertDays` | 60 / 3 | — | §8.4 |
| `structureVotesFull` | 100 | — | §8.4 |
| `voteHistoryDays` | 30 | — | §8.2 |
| `snapshotEveryMin` | 60 | — | §9 |
| `protectHysteresis` | 1.0 | 0.2–3 | §7.6 |

## 4. Events

Every event is a JSON object with `type` and `now`. JSON Schemas live in
[`schema/`](schema/). Unknown fields MUST be ignored. Unknown `type` MUST be
rejected with a `{type:"rejected", reason:"type"}` record.

| type | fields | meaning |
|---|---|---|
| `vote` | `user`, `dir: "hot"\|"cold"`, `src?` | a user says they are too hot / too cold. `src` is provenance for records only; the engine MUST NOT branch on it |
| `presence` | `users: uid[]`, `expectedArrival?` (RFC 3339), `expectedUsers?: uid[]` | the complete set of present users (replaces the previous set), and optionally when the host expects the next arrival and who (§7.5). The engine never predicts arrivals itself |
| `reading` | `tin`, `rh?`, `equip?: "heat"\|"cool"\|"fan"\|"idle"\|"off"`, `applied?: {heat?, cool?, mode?}` | indoor conditions and what the device is actually set to |
| `weather` | `out`, `high?`, `low?` | outdoor temperature now (and today's forecast extremes, recorded only). Hosts SHOULD send it at least every 10 min: release (§7.4) follows the last value and ignores one older than 3 h |
| `cost` | `level` ∈ [0,1] | relative energy price signal (0 = cheapest) |
| `manual` | `applied: {heat?, cool?, mode?}` | someone changed the device directly. Learned as a weak vote (§7.2); the **host** owns any hold and its timeout and simply does not actuate the engine's output while it holds |
| `freeze` | `on: boolean` | "we've got this": stop all learning and risk (§7.7) |
| `tick` | — | periodic heartbeat; hosts SHOULD send one every 1–5 minutes |
| `restore` | `snapshot` | replace state with a snapshot (§9) |

## 5. State machine

### 5.1 State variables (summary; full list in the snapshot schema)

- `blocks` — the learned block structure (§8), each `{id, start, heat, cool}`.
- `models[uid][blockId]` — comfort range model per user and block (§6).
- `presence` — `{known, users, since, expectedArrival, expectedUsers}`; `since` is when the set of present users last changed.
- `reading` — last `{tin, rh, equip, applied, at}`.
- `weather` — last `{out, high, low, at}`.
- `risk` — per side `{heat, cool}` ∈ [0,1]; `paused` — per side, until when a complaint holds (§7.3).
- `nudge` — per side inward offsets `{heat, cool}` ≥ 0 and `blockId` (§7.2).
- `released` — per side booleans `{heat, cool}` (§7.4).
- `frozen` — boolean.
- `protecting` — `"max"`, `"min"` or null (§7.6).
- `responseRate` — learned °C/min (§7.5).
- `structure` — `{rng, lastRunDate, trials[], votes[]}` (§8).
- `cost` — last level (default 0).
- `lastEventAt`.

### 5.2 States

The **state** reported in the output is derived, in this priority order:

1. `FROZEN` — `frozen` is true.
2. `VACANT` — presence is known and no users are present.
3. `SEEDED` — no user present has any vote in the current block.
4. `CONVERGED` — every present user's current-block model has
   `sigma < convergedSigma` (both edges) and `n ≥ convergedVotes`.
5. `LEARNING` — otherwise.

### 5.3 Processing order for one `step`

1. Reject out-of-order or unknown events (§2, §4).
2. Compute the local date/minute. If the configured seed changed, reseed
   (§8.7). Run **block maintenance** (§8) if this event is the first one at or
   after `structureHour` on a local date later than `structure.lastRunDate`.
   The very first event an engine processes only sets `lastRunDate` to its
   local date (no maintenance), so day one always starts from the seed.
3. If the current block changed since the previous event: clear `nudge`.
4. Apply the event (§6–§7, per type).
5. **Learn** for the elapsed time since `lastEventAt`, `min(now − lastEventAt, 60 min)`:
   silence observations (§6.3), risk (§7.3).
6. **Band** and **act**: compute the output (§7.8).
7. Emit effects (§10). Set `lastEventAt = now`.

### 5.4 Applied values

`reading.applied` and `manual.applied` report what the device is *actually* set
to after the host applied its own policy. The engine MUST use `reading.tin`
(not its own output) as the temperature votes are judged against. The engine's
next output is computed from its own state, never by echoing `applied` back.

## 6. Comfort model

### 6.1 Comfort range and posteriors

A user's comfort in a block is a **range** `[T_lo, T_hi]`: the coolest and the
warmest indoor temperature they accept. The engine learns each edge separately.
For each `(uid, blockId, side)` it keeps a discrete posterior over the edge's
value `c` on the grid `c_i = gridMin + i·gridStep`, `i = 0..N−1`,
`N = round((gridMax − gridMin)/gridStep) + 1`.

Priors are Gaussians on the grid (normalised to sum 1) whose conservative
quantile reproduces the seed block exactly (§7.1):

```
μ_side = b[side] − σ · priorSigma · Φ⁻¹(qSafe)      # cool: cool + 0.8416·s ; heat: heat − 0.8416·s   (qSafe 0.2)
w_i ∝ exp(−½ ((c_i − μ_side)/priorSigma)²)
```

`b` is the block the model belongs to (§8.1) and `σ` the side's sign (§1.1).
`Φ⁻¹(0.2) = −0.8416212335729143`; for another `qSafe` use any inverse-normal
accurate to 1e−9.

A user's block model is `{ lower, upper, n, step, lastVote }`, created lazily
from the priors the first time it is needed. `n` counts vote updates
(manual updates add `manualWeight`), `step` is the nudge step (§7.2),
`lastVote` is `{at, dir, tin}` or null.

Statistics of one edge posterior (weights `w` on grid `c`):
- `quantile(q)` — the smallest `c_i` whose cumulative weight ≥ `q − 1e−12`,
- `median = quantile(0.5)`,
- `mean`, `sigma` — weighted mean and standard deviation of `c`,
- `confidence = clamp(1 − sigma/priorSigma, 0, 1)`.

A block model's `sigma` is the larger of its edges' sigmas and its
`confidence` the smaller of their confidences.

### 6.2 Likelihoods

With `tin` the current indoor temperature, `σ` the sign of the side being
updated, and `Φ` the standard normal CDF (Appendix A):

| observation | side updated | likelihood `L_i` |
|---|---|---|
| vote (`hot` → `cool` side, `cold` → `heat` side): the room is past that edge | the voted side | `Φ(σ·(tin − c_i)/voteNoise)` |
| silence: the room is inside the range | both sides | `(1 − silenceWeight) + silenceWeight · Φ(σ·(c_i − tin)/silenceSigma)` |
| manual (§7.2) | as the vote | the vote likelihood raised to the power `manualWeight` |

Update: `w_i ← w_i · max(L_i, 1e−9)`, then normalise.

Φ MUST be computed with the formula in Appendix A, so that implementations in
different languages agree to within floating-point rounding.

If no `reading` has been received, votes are recorded but cause no model update
and no nudge (`effects.feedback = "noted.no_reading"`).

### 6.3 Silence

While a user is present, the zone is not `FROZEN`, and it is not a sleep window
(§3.4), every `silenceEveryMin` minutes of continuous presence without a vote
from that user, the engine applies one silence observation to both sides of
that user's current-block model, using the latest `tin`. Implementations track
`lastSilenceAt[uid]`, set to `now` when the user votes and when the user
becomes present.

### 6.4 Forgetting

After every vote or manual update, on the updated side:
`w_i ← (1 − forget)·w_i + forget·prior_i`.

## 7. Control (the loop)

All of §7 is written for one side; it runs for both (§1.1). `tin` is the last
reading, `out` the last outdoor temperature if received within the last 3 h.

### 7.1 Band

For each side, each present user `u` with block model `M_u` contributes the
edge it accepts at the current risk `r = risk[side]`:

```
q_u(x)      = quantile(M_u[side], 0.5 − σ·(0.5 − x))       # cool: x ; heat: 1 − x
edge_u      = q_u(qSafe) + r · (q_u(qRisk) − q_u(qSafe))    # risk 0: the safe edge; risk 1: the risky one
edge[side]  = σ · min_u ( σ · edge_u )                      # the most sensitive present user wins
```

So the band is the intersection of everyone's accepted range. Risk widens it
symmetrically; that is equivalent to widening only toward the outdoor air,
because the side the outdoor air pushes the room away from is released
anyway (§7.4) and its edge has no effect.

With nobody present the band is `setback`. (A side that has no present user
contributing, e.g. `FROZEN` with nobody home, uses `setback` too.)

### 7.2 Nudge (a vote is felt)

A vote on a side is a step search (Thermovote-style): after the model update
(§6.2) the voted edge MUST end at least one `step` **inward of the room**, so
the device responds right away:

```
target        = tin − σ · M_u.step
nudge[side]   = clamp( max( nudge[side], σ·(edge[side] − target) ), 0, nudgeMax )     # inward offset
```

where `edge[side]` is the band edge after learning. `nudge` is cleared when the
block changes. The user's `step` halves on a direction reversal (floor
`stepMin`) and grows by `stepGrow` on a repeated same-direction vote within
`repeatWindowMin` (cap `stepMax`). A vote within `cooldownMin` of the user's
previous vote nudges only if the room is **stalled**: `responseMin` has passed
and `|tin − lastVote.tin| < stallDelta`; otherwise `feedback = noted.cooldown`.
Feedback for a felt vote is `nudge.cooler` (`cool` side) / `nudge.warmer`.

`manual{applied}`: for each side whose `applied` value moved inward of the
engine's last output, treat as a vote on that side from every present user
with weight `manualWeight` (§6.2), with `target = applied[side]` instead of
`tin − σ·step`; a side that moved outward or did not move is ignored.

### 7.3 Risk (learn)

`risk[side] ∈ [0,1]` is how far into the uncertain part of people's accepted
range the band extends. Per elapsed hour `dtH` (§5.3 step 5), while users are
present, awake (§3.4), the zone is not `FROZEN` and the side is not paused
(`paused[side]` is null or ≤ `now`):

```
risk[side] ← min(1, risk[side] + riskRate · (1 + costWeight · cost) · dtH)
```

A vote on a side is a **complaint**: `risk[side] ← 0` and
`paused[side] ← now + riskPauseMin` (the other side is untouched). While paused
the side neither widens nor is released (§7.4). Risk persists across blocks and
vacancy; it is frozen in place while asleep or `FROZEN`.

### 7.4 Nature (release)

The outdoor air pushes the room along the vector `out − tin`. A side the room
is being pushed **away from** has nothing to do: it is released to `setback`.
With hysteresis so the thermostat is not rewritten around the crossing:

```
released[side] ← true   when  σ·(out − tin) ≤ −natureMargin
released[side] ← false  when  σ·(out − tin) ≥ 0, or out is unknown (older than 3 h), or the side is paused (§7.3)
if released[side]: setpoint[side] = setback[side]
```

A complaint on a side un-releases it for `riskPauseMin` — the person is
uncomfortable now and the outdoor air is too slow. Protection (§7.6) also overrides release.
Cooling is released only when the outdoor air is cooler than the room, so on a
hot day cooling is always available; the same for heating on a cold one.

### 7.5 Pre-conditioning

Before a tighter band arrives — the next block, or an `expectedArrival` with
`expectedUsers` not yet present — the engine starts conditioning early enough
to be there on time. With `rate = max(responseRate, 1e−6)` °C/min and the
coming band `next` (computed as §7.1 with the next block's models, or with the
expected users added, at the current risk):

```
need     = σ · (edge[side] − next[side])             # how far this side must move inward
if need > 0 and minutesAhead ≤ min(preconditionMaxMin, need / rate):  edge[side] = next[side]
```

`responseRate` is learned from readings: when `equip` is `heat` or `cool` and
the room moved in that direction over 1–30 min,
`responseRate ← 0.8·responseRate + 0.2·|Δtin|/Δmin`.

### 7.6 Protection

Applied last and whatever the state is, including `FROZEN`:

```
setpoint[side] = σ · min( σ·setpoint[side], σ·limit[side] )        # cool ≤ protect.max ; heat ≥ protect.min
```

The engine also tracks whether the **room** is beyond a limit, with hysteresis:

```
protecting = side   when  σ·(tin − limit[side]) ≥ 0 ;  stays until  σ·(tin − limit[side]) ≤ −protectHysteresis
```

`output.protect` is `"max"` (cool side), `"min"` (heat side) or `null`, and the
reason `protect` is added while clamping or protecting. **While
`output.protect` is not null, hosts MUST actuate toward the output even when
their own policy would otherwise leave the device off** (the zone is empty,
quiet hours, an automation switch is off, a manual hold). This is the one
place the engine's output overrides site policy.

### 7.7 Freeze

`freeze{on:true}` sets `frozen`. While frozen: no posterior updates (votes,
silence, manual), no forgetting, risk frozen in place, no structure changes
(§8). Votes still nudge (§7.2) and are recorded. `freeze{on:false}` clears it.

### 7.8 Output (band → act)

```
for each side:
  edge      = §7.1 band edge (setback if nobody present)
  edge      = edge − σ·nudge[side]                     # §7.2
  edge      = pre-conditioned                          # §7.5
  setpoint  = released ? setback[side] : edge          # §7.4
  setpoint  = clamped to capabilities[side], rounded inward to setpointStep (§2)
if cool − heat < minGap: keep the side with an active nudge if exactly one has it, else the side the
                         room is pushed toward (`cool` if out > tin, else `heat`); the other side moves
                         outward to restore the gap; re-clamp
for each side: setpoint = protection clamp (§7.6), rounded inward; if that breaks the gap the other side gives way
mode = "auto" if supported;
       else the side the room is outside of (tin past that setpoint, not released) if supported;
       else the side opposing the outdoor air (out > tin → "cool", else "heat") if supported;
       else the first supported mode
```

Output object:

```
{ heat, cool, mode, state, block: b.id, blockEnd (RFC 3339: start of the next block),
  band: { heat, cool },                      # before release and protection
  released: { heat, cool }, risk: { heat, cool }, nudge: { heat, cool },
  reasons: [string], confidence, protect }
```

`reasons` is a list of stable codes describing what contributed, in this
order: `seed` (state SEEDED), `learned` (LEARNING or CONVERGED), `conflict`,
`nudge`, `risk`, `vacant`, `released`, `precondition`, `frozen`, `sleep`,
`protect`, `limit` (a capability clamp bit), `gap`. `confidence` is the
smallest present user's block-model confidence (0 if nobody is present).

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
the neighbour with the **looser edge on the side the outdoor air pushes the
room toward** — with `σ` the sign of that side (`out > tin` → `cool`, else
`heat`; `heat` if `out` or `tin` is unknown), the block with the larger
`σ·b[side]`; ties: later. The shift MUST keep every block ≥ `blockMinMin`, and is skipped if the
boundary's old or new time is inside a sleep window (§3.4).
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
`snapshotVersion: 2`. `restore{snapshot}` MUST accept any version ≤ the
implementation's and migrate it; unknown higher versions MUST be rejected.
Migrating a version-1 snapshot keeps `models`, `blocks`, `structure`,
`presence`, `reading`, `weather`, `frozen`, `protecting`, `responseRate`,
`cost` and the bookkeeping fields, and starts `risk`, `nudge` and `released`
at zero / false; `drift`, `vacancy`, `hold`, `trm`, `day`, `lastShift` and
`conflictDay` are dropped.
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
| `vote` | every accepted vote | `user, dir, src, block, tin, rh, out, present, applied, step, nudge, state, updated (bool)` |
| `decision` | output `heat`, `cool`, `mode`, `state`, `protect` or a `released` flag differs from the previous output | the full output |
| `conflict` | §7.8 the band is narrower than `minGap` while occupied (at most once per block per day) | `block, present, band` |
| `blocks` | split / merge / trial / revert / reseed | `action, blocks` |
| `rejected` | §2, §4 | `reason, event type` |

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
