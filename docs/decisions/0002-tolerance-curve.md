# ADR 0002 — The tolerance curve: system definition for 0.5.0 (approved 2026-10-04)

## Context

Three engine versions shipped in two days (0.3 rules → 0.4 loop → 0.5 "fluid drift", parked on
`wip/0.5.0-fluid-drift`). Each of Mason's messages became code within the hour, and the thing
that matters was never written down: what the system is *for*, what it learns, and what its
outputs should look like over a day and a season. This document is that definition. Nothing
is built until it is approved; then it becomes spec 0.5.0 and the home-flows integration.

What Mason has said the system is (his words, condensed):

- It **biases toward idle**. Its goal is to **learn the tolerance of the affected population**;
  the population conveys tolerance through their own comfort (votes). That drives tolerance
  bands over time. Entropy toward idle **decays with confidence**.
- The learned model must **predict the accepted range from ambient**: on an extremely hot day the
  median sits far below ambient, on a temperate day it almost matches ambient, on an extremely
  cold day far above. The curve is **derived from the population, not defined**; it is **not
  linear**.
- The engine is **one loop** with logic-defined behaviour, not a pile of rules; heat and cool are
  the same rule with a sign; **no cooling lockout** on a hot day; the outdoor-indoor vector
  decides what the air does for free.
- User interaction must be **fluid**: no resets, freezes or snaps.
- Trigger bands: the engine outputs a range, never a target temperature.
- **The time of day a vote is cast matters less than the temperature and the current tolerance
  band.** No time blocks, no sleep windows. Once the tolerance is known, comfort persists
  through the night whether or not anyone can vote.
- **Presence is not the engine's concern.** External systems turn the equipment off or use a
  different range while everyone is away.
- Success is judged by **votes per present-hour**, **HVAC minutes per degree-day**, and
  **band width and drift over ambient**, in Grafana.
- Projections = **a given day's range from the external ambient temperature**.

## 1. Goal

Learn, for each zone, the **tolerance curve** of the people who use it — the indoor temperature
range they accept as a function of the outdoor temperature — and run the equipment as little as
that curve allows. The curve is learned from two signals only: votes (the room is past an edge)
and quiet attended time (the room is acceptable). Nothing in the configuration says where the
curve should sit or how it should bend with the weather; nothing says what time it is or who is
home.

Idle is the default. Equipment runs only when the room is outside the learned range **and** the
outdoor air is not already bringing it back.

## 2. The learned model: one tolerance curve per zone

**Tolerance edge.** For each side `s` (`heat` = coolest accepted, `cool` = warmest accepted),
the engine learns `T_s(out)`: the indoor temperature at which the zone's population stops
accepting the room, given the outdoor temperature `out`. One curve per zone, not per person:
whoever is there when the room is wrong is whoever teaches it, and since people are present
at the temperatures they are present for, the curve already carries "warmer in the day for
her, cooler at night for him".

**Representation (nonparametric).** `K` knots over outdoor temperature, every `knotStep` °C
(default 5 °C from −10 to 45 → 12 knots). Each knot holds a discrete posterior over indoor
temperature on the 0.1 °C grid (exactly today's edge posterior, spec 0.4 §6.1). The curve at
any `out` is the linear interpolation of the two neighbouring knots' statistics. No slope, no
functional form, no time of day, no identity: a hot knot learns what people say on hot days.

**Prior.** Every knot starts at the seed range (one `{heat, cool}` per zone, a flat curve) with
`priorSigma` 1.5 °C. At migration the recorded votes in `comfort_records` (they carry `tin` and
`out`) are **replayed** into the new model, so the curve starts from the real data gathered so
far rather than from the seed.

**Observations** (all at the current `out`, split between the two neighbouring knots by
interpolation weight):

| signal | meaning | update |
|---|---|---|
| vote `hot` / `cold` | the room `tin` is past the population's edge on that side | censored likelihood on that side's knots (as today), full weight, always |
| quiet attended time (`silenceEveryMin` of continuous events without a vote) | the room may be acceptable — **exploration** | weak evidence on both sides, weighted by `(1 − confidence)` of that edge at that knot |
| manual change inward | a weak vote | vote likelihood × `manualWeight` |

"Attended" is not an input: a quiet streak counts only across **continuous** events (no gap
longer than `attendedGapMin`, default 10 min). The host feeds the engine while someone is
home and stops while nobody is; a gap breaks the streak, so an empty house teaches nothing.

Forgetting (`forget`) as today. **This is the only learning.** There is no drift, risk, nudge
state, pause, reset, presence, block or sleep state: the band moves because evidence moves the
posterior.

**Entropy toward idle that decays with confidence.** Quiet attended time is the only
exploration the engine does. While an edge is still uncertain (few votes: sigma near the
prior), each quiet hour pushes it outward past the current room temperature; once the safe
quantile (§3) passes the room, the equipment on that side stops, the room drifts with the air,
and quiet at the new temperature pushes the edge further. As the posterior tightens — from
votes, and from the silence evidence itself — `confidence` rises toward 1 and silence stops
moving the edge. So the band opens by itself only while the population's tolerance is unknown,
and settles where their votes and their quiet have put it. A complaint moves the edge inward by
data and (for immediacy) by the felt step (§4). Office "aggressive" = a higher silence weight
(it explores faster while uncertain), not a different mechanism.

**Comfort persists through the night.** A confident edge is held whether or not anyone is able
to vote: sleeping people are quiet, and quiet cannot move a confident edge. Only while a night
knot is still being learned does a quiet night widen it — and the first uncomfortable wake-up
vote narrows it again. The need for a sleep window decays with the learning, so there is none.

**Time of day is not a dimension.** What a vote means comes from the room temperature, the
outdoor temperature and the current tolerance band — not from the hour it was cast. Night and
day differ through the one thing the model sees, the outdoor temperature (night lands on the
cool knots). Nothing in the engine knows the hour.

**Expected resolution (what the curve should look like after a season):** the upper edge rises
with outdoor temperature but more slowly than 1:1 (people accept 27 °C indoors at 38 °C out, not
at 20 °C out); the lower edge falls with outdoor temperature likewise. Delta from ambient
`T − out`: large negative on hot days, ≈ 0 across the temperate middle (the band contains
ambient, the equipment idles), large positive on cold days. Nothing enforces this shape; if the
population's votes say otherwise, the curve says otherwise.

## 2b. The zone's thermal response (learned, not configured)

Zones differ in how fast their temperature can be changed: the office is small and moves in
minutes; the house takes hours. The engine learns this from the readings it already receives,
as a first-order model with two kinds of rate:

```
idle:     dtin/dt = envelope · (out − tin)                        # envelope: 1/h, the room's coupling to outdoor
running:  dtin/dt = envelope · (out − tin) − σ · equipment[side]   # equipment[side]: °C/h the device adds, net of the envelope
```

The rate of change is therefore **derived from the delta from ambient**: the further the room
is from outdoor, the faster it moves, by a coupling the zone teaches the engine. Both rates
are estimated online from consecutive readings (`equip` idle vs heat/cool, `tin` and `out`
known, 1–30 min apart) with an exponential forgetting factor; priors from the configuration
(`envelopePrior`, `equipmentPrior`) only matter until the first days of data. Replaces
`responseMin` and `responseRate`.

**More inputs, same estimator.** The model is a regression of the room's rate of change on
whatever drives it; `out − tin` and the equipment side are the two drivers 0.5.0 fits. Others
can be added as further terms when they are measured, without changing the loop: relative
humidity (already in `reading.rh`; affects how the room feels and how cooling behaves), solar
gain (a daytime term from the forecast's cloud cover or a lux sensor), wind (a stronger
envelope term), and the equipment's measured power (the office already reports it). Each is
derived the same way; none is a setting. They are listed so the design has a place for them,
not for 0.5.0.

What they are used for:

- **Stalled or on its way** (§4): a repeat vote inside the cooldown counts only if the room has
  moved less than the model expected since the last vote — no fixed "minutes to respond".
- **Projection** (§6): a predicted room trajectory for the day, with expected equipment run
  minutes, not only the band.
- **The host's pre-conditioning** (§6): how early to start for an arrival follows from the
  equipment rate and the gap to close.
- **Release** stays vector-based (§3); the rates only say *when* the air will get there, and the
  projection shows it.

Whether a fast zone should also explore faster than a slow one is decision 4 in §11.

## 3. The loop (sense → band → act → learn)

- **Sense**: room `tin`, outdoor `out`, votes, manual changes.
- **Band**: for each side, the curve's edge at the current `out` at the **safe quantile**
  `qSafe` (0.2: 80 % likely still accepted). Capped by `protect`.
- **Act**: idle inside the band. Outside it, a side the outdoor air is pushing the room *away*
  from is **released** to setback (the air does the work; taken back when the air reverses or
  when the room has caught up with the air short of the band — as in 0.4.0). Otherwise condition
  to the nearest edge. `mode` for devices without `auto`: the side the room is outside of, else
  the side it was running.
- **Learn**: the observations of §2. A vote is also **felt** immediately (§4).

Everything per side with a sign; the implementation keeps `src/side.ts`.

## 4. The felt vote (fluid)

A vote must do something now, not after the posterior catches up. The felt response is a
**push** of that side's edge to one `step` inward of the room (Thermovote step search, as
0.4.0: the voter's step halves on reversal, grows on repeat; a repeat inside the cooldown
counts only if the room is **stalled** — it moved less than the thermal model (§2b) expected
since the last vote; the step and last vote are kept per voter `user`, the only use of the id). The push is not a
separate drifting state: on every step the edge is `inner(learned edge, push)` until the
learned edge has absorbed the vote (its safe quantile passes the push), after which the push
has no effect and is dropped. No timer, no reset. For `complaintMin` after a vote the side is
not released and is the side kept by the device's gap rule (responsiveness, not band state).

## 5. Inputs (events; all carry RFC 3339 `now` with offset)

| event | fields (units) | source in home-lab |
|---|---|---|
| `vote` | `user` (opaque id, for records and the step search), `dir` hot/cold, `src` | HA buttons, phone actions, voice (`anonymous` when unknown) |
| `reading` | `tin` °C, `rh?`, `equip?`, `applied?` | Daikin poll (2 min); ESPHome (push) |
| `weather` | `out` °C (≤ 10 min old), `high?`, `low?` | Daikin outdoor sensor (2 min) / Open-Meteo (30 min, forecast) |
| `manual` | `applied {heat, cool, mode}` | thermostat/app/HA change; AC remote |
| `freeze` | `on` | HA "comfort learning" switch |
| `tick` | — | every minute, **only while someone is home** |
| `restore` | `snapshot` | Postgres at boot |

Removed from 0.4: `presence` (with `expectedArrival`/`expectedUsers`) and `cost`.

Configuration: device capabilities (modes, minGap, setpointStep, ranges), one seed range
`{heat, cool}`, setback, protect min/max, and the parameters below.

Parameters (every one is a learning rate or a device/physics constant, never a comfort value):
`gridMin/Max/Step`, `priorSigma`, `voteNoise`, `silenceSigma`, `silenceWeight`,
`silenceEveryMin`, `attendedGapMin`, `manualWeight`, `forget`, `qSafe`, `knotMin/Max/Step`,
`step*`, `cooldownMin`, `repeatWindowMin`, `natureMargin`, `complaintMin`, `envelopePrior`,
`equipmentPrior`, `thermalForget`, `convergedSigma/Votes`, `protectHysteresis`,
`snapshotEveryMin`. Removed from 0.4: `driftRate`/`riskRate`, `qRisk`, `riskPauseMin`,
`nudgeMax`, `costWeight`, `preconditionMaxMin`, `responseMin`, `responseRateDefault`,
`stallDelta`, every block-structure parameter, `structureHour`, `sleep`, the PRNG.

## 6. Outputs

Per step (`output`):
`heat`, `cool` (°C, the device setpoints), `mode`, `state` (SEEDED / LEARNING / CONVERGED /
FROZEN), `band {heat, cool}` (the learned band at this `out`, before release and protection),
`released {heat, cool}`, `push {heat, cool}` (the felt edge or null), `protect`, `reasons[]`,
`confidence {heat, cool}`, `deltaFromAmbient {heat, cool}` = `band − out`,
`thermal {envelope, heat, cool}` (the learned rates of §2b; for the host's own pre-conditioning).

Per step for graphs (`output.curve`): the tolerance curve at every knot —
`[{out, heat, cool, heatSigma, coolSigma}]`.

**Projection** (a new pure function, `project(state, config, day)`): given a day's hourly
outdoor temperatures (from the forecast high/low, or supplied) and the starting room
temperature, returns per hour: band, the predicted room temperature (from the thermal model,
§2b), which sides the air will release, expected equipment side (`heat` / `cool` / `idle`) and
run minutes, and the delta from ambient. This is "a given day's range from ambient", with what
the room and the equipment are expected to do inside it. It uses the same `band` and `act`
functions as `step`, so it cannot disagree with them. The host applies its own presence plan on
top (which hours it will run the engine at all).

Effects: records (`vote`, `decision`, `rejected`), snapshot, feedback code.

**What the host owns** (site policy, outside the engine): presence and vacancy (turn the
equipment off, or apply its own away range, and stop feeding the engine); pre-conditioning for
arrivals (from `project()` and `thermal`); holds after a manual change (house 2 h, office
60 min); quiet hours, tariffs, protection actuation when the engine says `protect`.

## 7. Example graphs (what we expect to see; rendered properly once approved)

**G1 — tolerance curve (per zone), after a season**

```
indoor °C
 30 |                                        cool edge  ·  ·  ·
 28 |                              ·  ·  ·  ·
 26 |                    ·  ·  ·
 24 |           ·  ·  ·                         ← band contains ambient here: idle
 22 |  ·  ·  ·     ─ ─ ─ ─ ─ ─  ambient (out = indoor) ─ ─ ─
 20 |  ·  ·  ·  ·  ·
 18 |                 ·  ·  ·  ·  heat edge
 16 |                              ·  ·  ·  ·  ·
    +----+----+----+----+----+----+----+----+----+
     0    5   10   15   20   25   30   35   40  outdoor °C
```
Shaded width = posterior sigma per knot (wide where few votes). The curve is what the
population taught; the ambient line is drawn for reference only.

**G2 — delta from ambient (same data, Mason's framing)**

```
band − out
 +15 |■■
 +10 |  ■■■
  +5 |     ■■■
   0 |        ■■■■■■■■■■■          ← temperate: nothing to do
  −5 |                   ■■■
 −10 |                      ■■■
 −15 |                         ■■
     +----+----+----+----+----+----+
      0    5   10   15   20   25   30   35   40  outdoor °C
```

**G3 — one hot day (projection before, actual after)**

```
°C  36 |            ╭──────────╮                 outdoor
    32 |        ╭───╯          ╰───╮
    28 |   ─────╯ · · · · · · · · · ╰────        cool edge (rises with out)
    24 |   ════════════════════════════════      room (follows cool edge in the afternoon)
    20 |   ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─      heat edge (released all day: grey)
       +---------+---------+---------+------
       06        12        18        24  h
  equipment:  idle ░░░░ cool ████████ idle ░░
  released:   heat ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
```

**G4 — a season (weekly): the success metrics**

```
votes / present-hour      HVAC min / degree-day      band width (°C) · |delta from ambient|
 0.6 |▮                      40 |▮                      8 |          ▮▮▮▮▮
 0.4 |▮▮                     30 |▮▮▮                    6 |     ▮▮▮▮▮
 0.2 |▮▮▮▮▮▮▮▮               20 |▮▮▮▮▮▮▮▮               4 |▮▮▮▮▮
     +-------- wk 1..8           +-------- wk 1..8         +-------- wk 1..8
 (down as the curve resolves)   (down as the band opens)  (opens while uncertain, then settles;
                                                           its width then follows ambient)
```

## 8. Metrics (Prometheus, from the Node-RED integration)

`comfort_band_celsius{zone,side}`, `comfort_delta_ambient_celsius{zone,side}`,
`comfort_curve_celsius{zone,side,out}` (one series per knot), `comfort_curve_sigma{zone,side,out}`,
`comfort_released{zone,side}`, `comfort_votes_total{zone,user,dir}`,
`comfort_attended_hours_total{zone}` (new; hours the host fed the engine — the denominator of
votes per present-hour), `hvac_running` / `hvac_*` (existing; HVAC minutes), `weather_*`
(degree-days). Grafana "Comfort" row: G1, G2 (current curve, live), G3 (today: projection vs
actual), G4; votes per present-hour by hour of day as a diagnostic.

## 9. How it will be verified before it goes live

1. **Unit tests** per spec rule (sides, knot interpolation, observations, confidence-weighted
   silence, attended streaks, felt push absorbed by learning, release, protection,
   projection = step).
2. **Household simulator** with synthetic occupants whose *true* tolerance curves bend with
   outdoor temperature (hot-day acceptance higher), who are **unable to vote while asleep**
   (23:00–07:00), and whose presence the simulated host turns into "feed / don't feed"; two
   zones with different true thermal constants (office-like: fast; house-like: slow). Assert
   the learned envelope and equipment rates converge to the sim's true constants within a
   week, and that the projected room trajectory tracks the simulated one.
   Assert: the learned curve converges toward the population's true one (RMS error falling
   week over week); votes per attended hour falling; HVAC minutes per degree-day below the
   static schedule; the delta-from-ambient graph has the expected shape; and **once a night
   knot is confident, a quiet night changes the band by less than the setpoint step** (comfort
   persists without votes). Report (not assert) the residual complaint rate from an occupant
   whose true range differs by hour at the same outdoor temperature.
3. **Permutation sweep** (existing, 1080 cases + swings): no inverted / fighting / flapping /
   stranded behaviour.
4. **Projection check**: for each sim day, `project()` before vs `step()` outputs during —
   identical bands at matching inputs.
5. **Adversarial review** of spec + code before release (as for 0.4.0).
6. **Live, first two weeks**: Grafana G1–G4 with the pre-engine weeks as baseline; the curve
   must visibly bend with outdoor temperature by then or the model is wrong.

## 10. What changes where (only after approval)

- `open-comfort-engine` (spec 0.5.0): §6 model → one tolerance curve per zone over outdoor
  knots; no presence, blocks, sleep, cost; §7 → felt push absorbed by learning, no drift/risk
  state; thermal model; `project()`; `output.curve`, `deltaFromAmbient`, `thermal`; snapshot
  v3 with migration by vote replay. Files: `spec/SPEC.md`, schemas, `src/model.ts` (knots),
  `src/thermal.ts` (new), `src/engine.ts`, `src/types.ts`; `src/blocks.ts` removed; tests,
  `test/sim/*` (occupants with outdoor-dependent true curves, sleep, host-side presence, two
  thermal constants), vectors. Node-RED adapter: drop
  presence handling; the host decides when to send events.
- `home-flows`: `tools/comfort.py` — one seed range per zone; the feeder sends ticks/readings
  only while the zone is occupied (office: its presence logic; house: `person.*` home), sends
  `freeze` never on vacancy (no events is enough); vote replay at migration from
  `comfort_records`; metrics above (plus `comfort_thermal{zone,rate}`); daily projection from
  the Open-Meteo forecast; pin 0.5.0. `house_climate.py` / `office_climate.py`: away range / off
  when vacant (already so for the office), pre-conditioning for arrivals from `project()` +
  `thermal` (game night, work window, `person` arrivals), hold = 2 h / 60 min.
- `home-lab`: Energy dashboard Comfort row = G1–G4 + votes by hour.

## 11. Open decisions for Mason (answer before implementation)

1. Knot spacing 5 °C from −10..45 (12 knots) — or coarser (10 °C) to learn faster with fewer votes?
2. House away range while nobody is home (host-side): the current setback 60–85 °F, or off?
3. Should exploration pace follow the zone's ability to correct (a zone that can fix a wrong
   guess in minutes explores faster: the silence weight scales with the learned equipment
   rate), or stay a plain per-zone setting (office 2× house)? The first is derived, the second
   is a knob.
