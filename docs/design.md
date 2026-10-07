# Design notes

The normative definition is [`spec/SPEC.md`](../spec/SPEC.md). This page explains
*why* it looks the way it does.

## Layers and boundaries

1. **Spec** — language-neutral, normative.
2. **Reference implementation** (`packages/core`) — pure TypeScript, passes the vectors.
3. **Adapters** — Node-RED today; anything else (HA integration, MQTT service, other languages) later.
4. **Integration** — yours: identity, presence (and any arrival prediction), weather, tariffs, actuation, persistence, wording, site policy.

The engine decides *what comfortable means and how hard to chase it*; the
integration decides *what is physically and politically allowed* and makes it
happen, then reports back what it actually applied so the engine learns against
reality. Nothing site-specific crosses into the engine; no learning crosses out.

## Why a range, not a point

A single "comfort temperature" fits energy-saving bands badly: if someone is too
hot at the cooling setpoint, a point model barely moves because it already
thought that temperature was warm. People have a comfortable *range*; a vote is a
censored observation of one edge of it. Learning both edges makes "save energy as
confidence grows" fall out of the math: the cooling setpoint follows the
conservative quantile of the most heat-sensitive present person's warm limit, and
rises toward it as the posterior narrows.

## Why the nudge is room-relative

A vote has to be *felt*. "Too cold" at 22 °C that raises heating from 20.6 to
21.6 changes nothing physically. So the voted edge always ends at least one step
past the current room temperature; learning that already moved it counts toward
the step.

## Things we tried that didn't work (and the simulator caught)

- **Flattening the posterior after every complaint** ("caution") prevented it
  from ever converging — after 15 votes it was less certain than the prior.
  Caution now comes from resetting and pausing drift instead.
- **Drifting all the way to the median learned limit** produces complaints by
  design once the model is accurate; drift now stops at the 30th percentile.
- **One leash for both sides** let the never-exercised edge (heating, in summer)
  hold back the cooling side; each side is now leashed by confidence in its own limit.
- **Transitions** dominated residual discomfort; pre-conditioning (tighten early,
  using the zone's learned response rate) toward the next block and toward
  expected arrivals fixed most of it.

## 0.4.0: one loop instead of a pipeline

By 0.3.0 the output stage had grown six separate mechanisms — adaptive weather
term, occupied drift, vacancy drift with recovery, holds, protection, sleep —
each adjusting the setpoints at its own place in the order. A bug (a 99 °F day
on which the weather term raised the heating setpoint and the furnace ran at
09:00) was being fixed with a seventh rule when the owner called it: *too many
individual rules and exceptions make a program, not an engine; an engine must be
describable as a looped system with logic-defined behaviour.*

0.4.0 is that loop (spec §1, §7): **sense → band → act → learn**.

- *Band*: the overlap of present people's accepted ranges at the current **risk**
  level (per side, 0 = the safe quantile, 1 = `qRisk`), capped by protection.
- *Act*: idle inside the band or when the outdoor air is already pushing the
  room toward it (**release**, keyed on the vector `out − tin` with hysteresis,
  symmetric for both sides); otherwise condition to the nearest edge.
- *Learn*: votes move edges and are felt (nudge); a complaint resets its side's
  risk and keeps that side conservative and un-released for a while; quiet
  awake time raises risk; sleep freezes it.

Dropped: the adaptive term (weather now acts through release), drift and
vacancy as separate processes (risk, and the setback band when nobody is
present), holds (the host owns them — it just doesn't actuate while holding,
and `blockEnd` tells it when the engine's block ends). Every per-setpoint rule
is written once against a signed *side* (§1.1); the reference implementation
has no heat-specific or cool-specific code path.

**What the simulators say** (household: two strict synthetic occupants, 42 days,
seeds 7/11/13/17, metrics over week 6; sweep: 1080 permutations, 6 h each, no
votes). Reproduce with `npx vitest run` and `npm run sweep`.

- *Engine vs a programmed thermostat* (seed schedule, frozen, no nudge, no
  release; the sweep's baseline also has the same setback when nobody is home):
  household week 6, four seeds summed — discomfort 1515 vs 4260 person-minutes
  (−64 %), HVAC 6155 vs 8440 minutes (−27 %). Sweep: occupied-awake −12 %,
  asleep −6 %, vacant 0 % (both sit at the setback; the earlier "21 %" headline
  came from a baseline without a setback and is withdrawn).
- *Release on vs off* (`natureMargin: 99` disables it), same four seeds, week 6
  summed: discomfort 1515 vs 1700 (release 11 % better), HVAC 6155 vs 6125
  (equal). Over all 42 days release has slightly *more* discomfort on three of
  four seeds (−5 % HVAC on one, equal elsewhere): early on, the engine's idea
  of what people tolerate is loose, and a released side lets the room sit
  there until a complaint. The sim's room has a ~2–4 h time constant and its
  occupants complain whenever they are outside their true range, so this is a
  pessimistic view of release; the real case it exists for (a 99 °F morning
  with the room 0.1 °C under the heating edge) is one it cannot show.
- *Release was revised twice by the sweep.* Pure "outdoor warmer → no heating"
  left a 14 °C room at 15 °C with a 15 °C outdoor forever (the air cannot reach
  an 18 °C band). Requiring the air to be able to reach the band instead
  heated a 14 °C room with 20 °C outside all the way to 22 °C, wasting the
  free 6 °C. The rule that survives: released while the air pushes the room
  away from the edge; taken back when the air pushes the other way (beyond
  the margin, so jitter cannot flap it) or when the room has caught up with
  the air and that was not enough. One rule, two thresholds, no filter.
- An adversarial review of the first cut found: release flapping on jittery
  outdoor readings (hysteresis was one-sided), mode flapping on devices
  without "auto" (no memory), nudges outliving the people who asked for them,
  votes from users the host says are absent moving the room, risk accruing
  before anyone was present, manual changes subject to the vote cooldown and
  counting as complaints, and no validation of non-finite readings. All fixed
  in the 0.4.0 release; each fix is a change to the loop's definition, not a
  new rule (symmetric hysteresis; mode keeps its side; nudge cleared on a
  presence change; absent votes learn but don't act; elapsed time from
  `presence.since`; manual = weak vote, not complaint; reject `value`).
- Widening *both* sides with risk: only the side the air pushes the room toward
  can cost energy; the other is usually released, and when it is not, widening
  it is harmless because the room is not heading there.
- Risk is linear between the safe and risky *quantiles* (not a moving quantile),
  so the band is continuous in risk and exact at the seed.
- Hosts should feed the outdoor temperature at least every 10 min.
- Known and accepted: a released side still heats / cools to the setback floor /
  ceiling (that is the floor's job); up to natureMargin (1 °C) of conditioning
  against the air near a crossing; risk 1 is the steady state after four quiet
  hours, so a side that is never exercised (heating in summer) enters its
  season at the risky edge and the first complaint of the season resets it;
  two users voting opposite ways inside the device's minimum gap — the side
  the air pushes the room toward wins and a `conflict` record is written.

## 0.5.0: the tolerance curve

0.4.0 had answered "is it an engine?" but not "what does it learn?". Its model was an edge
temperature per person per time block, blind to the weather, and each of the owner's
observations (the band should widen toward ambient; a hot day's accepted range must be far
below ambient and a temperate day's near it; sleep should not matter once tolerance is
known; nights must hold comfort without votes; user interaction must be fluid) was being
turned into another mechanism. The owner stopped the work and asked for the system to be
defined first — goal, inputs, outputs, the learned model, example graphs, projections — and
approved that definition (`docs/decisions/0002-tolerance-curve.md`) before 0.5.0 was built.

What 0.5.0 learns:

- **One tolerance curve per zone**: for each side, a posterior over the indoor edge at every
  outdoor-temperature knot (5 °C apart). A vote teaches the knots at the outdoor temperature
  it was cast at. The curve's shape is derived, not defined: no slope, no linear assumption,
  no time of day, no identity.
- **The zone's thermal response**: how fast the room drifts toward outdoor when idle and
  how fast the equipment moves it, from consecutive readings. The rate of change is
  derived from the delta from ambient.

What it does with them: the band is the curve at the current outdoor temperature; the air
releases a side it is already pushing the room toward; a vote is felt as a push that fades
back into the learned band over two quiet hours; quiet attended time widens an *uncertain*
edge (exploration that decays with confidence, scaled by the zone's ability to correct);
`project()` turns a forecast into the day's band, room trajectory and run time.

What left: presence (the host feeds the engine only while someone is home — a gap in events
is the signal), time blocks and the structure machinery, sleep windows, per-person models,
drift/risk/nudge state, the cost input, the PRNG. The spec went from 709 lines (0.3.0) to
549, with more defined.

**What the simulators say** (two strict synthetic occupants whose true tolerance bends with
outdoor temperature and who cannot vote 23:00–07:00; a slow house and a fast office whose
equipment loses capacity in the heat; 42 summer days; `npm run sim`; numbers at rc.2):

- The thermal response is learned within a week, per outdoor knot: house cooling 3.0 °C/h at
  the 25 °C knot and 2.6 at 35 (true 3.0 → 2.5), envelope 0.15/h; office 7.8 → 6.7 (true 8 → 6.5).
- The curve bends the way the population does: house cooling edge 25.2 °C at 35 °C out (true
  25.5), 23.7 at 25 (true 24.1); knots the population never spoke at stay at the seed.
- Against a programmed thermostat (the seed range, nothing learned, no release), weeks 3–6:
  **awake** discomfort −84 % at equal energy for the house; the office saves 20 % HVAC with
  about twice the static schedule's (small) discomfort — its exploration cost.
- **Sleepers.** Counting discomfort while asleep, the engine is *worse* than the static
  schedule at night: 3375 vs 625 person-minutes over four weeks. Quiet nights teach the
  cold-outdoor knots that 17 °C is accepted, because the only people there cannot complain, and
  the wake-up vote at 07:00 lands on a warmer knot. The engine does exactly what it is told —
  quiet is evidence — and only the host knows people are asleep. This is reported by the sim
  and is the open decision for the owner: feed night-time quiet as evidence or not (host-side,
  from a sleep signal), or accept it on the grounds that real sleepers tolerate a wider range
  than the sim's occupants (sleep-comfort literature puts 18–22 °C as the good range).
- Confidence plateaus at 0.6–0.7 after four months whatever the forgetting rate (0.02 /
  0.005 / 0 give 0.61 / 0.65 / 0.69): votes are one-sided evidence, so an edge is never pinned
  from both sides unless quiet does it. The night band moves 0.007 °C per night by month four
  under all three. Forgetting stays at 0.02 for adaptation; "confidence reaches 1" is not a
  claim this design makes.
- Four things the adversarial review of rc.1 found and rc.2 fixed: release could strand a
  slow zone for hours (now a side is released only while the air pushes the room away from
  the edge *and* can bring it inside; otherwise the device takes it at once); quiet walked a
  far edge outward forever (quiet now says nothing about an edge the room is nowhere near,
  so cold knots stop creeping in summer); frozen hours were counted as quiet after unfreezing;
  stall detection ignored the envelope. Plus: a 30-minute dwell on release changes (a
  sun-struck outdoor sensor cannot cycle the equipment), learning only from a current
  outdoor temperature, restore that rejects instead of throwing, CONVERGED defined so it can
  happen, and the trigger band on the output (a setpoint changes only once the wanted value is
  a full step away).
- The permutation sweep (390 cases + outdoor swings): no inverted, fighting, both-in-one-hour,
  flapping, leaking or stranded behaviour; 6 % less HVAC than the seed schedule.

## 0.5.0-rc.5: the room's own drift

Live, rc.4 released the office's cooling on a morning when the outdoor air was 1.5 °C cooler
than the room, and the room — a closed, well-insulated box with a person, their computers and
the morning sun in it — warmed 2.5 °C in half an hour while the unit sat parked on its heat
edge. The rule was doing exactly what it said: the air *was* cooler. The model behind it could
not say anything else: §6.5's idle drift was `envelope · (out − tin)`, a room that always
drifts toward outdoor. Recovery came 30 minutes later from the weather crossing the edge, not
from anything the room did (`docs/decisions/0003-release-by-idle-drift.md`).

rc.5 adds the term the room was missing and reads release off the model instead of the air:

- The idle drift is `envelope · (out − tin) + gain`, per outdoor knot; `gain` (°C/h, the
  heat the room makes or loses by itself) is the intercept of the same line whose slope was
  already being learned, fitted by least squares on the same readings, each interval weighted
  by its length. Still no configured physics.
- Release judges `idle(out, tin)` in °C/h — is the room drifting away from this edge, and
  would a room at the edge drift back inside — against `natureRate` (0.3 °C/h), replacing the
  1 °C `natureMargin` on `out − tin`. The equilibrium form (`out + gain/envelope`, keeping the
  margin in °C) was rejected as ill-conditioned in a tight room.
- The act (`equipment`: heat / cool / idle) is in the output, so a host can map idle to a
  device's real `off` instead of re-deriving it.
- The host's `equip` must come from the equipment's own state: the office had been reporting
  ESPHome's `action`, which reads 0 while the compressor runs, so every cooling run had been
  learned as air (the office's equipment rates never left their prior).
