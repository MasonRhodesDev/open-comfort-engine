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

**What the simulators say (42-day household, seeds 7/11/13/17; 1080-case
permutation sweep):**

- vs a plain programmed thermostat: 45–60 % less discomfort and 20–25 % less
  HVAC runtime in week 6 (household); 21 % less HVAC across the sweep.
- *Release is neutral-to-positive*: it won on three seeds and lost on one. The
  loss is structural, not noise: releasing a side while the room is well
  outside the band on that side leaves people uncomfortable until the (slow)
  outdoor air fixes it; they complain, and the complaint pause then costs more
  conditioning than the release saved. We tried bounding release to "only while
  the room is inside the loosest band we would ever use" — it helped the
  household sim slightly but made the engine heat a cold vacant house on a hot
  morning, exactly the behaviour the owner's rule forbids. The rule stands as
  stated: the outdoor vector decides; a complaint overrides it.
- Widening *both* sides with risk is equivalent to the owner's "widen toward
  outdoor": the side the air pushes the room away from is released anyway, so
  widening it is inert — and it avoids a band jump when the vector reverses.
- Risk is linear between the safe and risky *quantiles* (not a moving quantile),
  so the band is continuous in risk and exact at the seed; with a 0.1 °C grid a
  moving quantile jumped a cell within a minute of presence.
- Hosts should feed the outdoor temperature at least every 10 min: at the daily
  crossing of outdoor and room temperature a 30-min-old value releases the
  wrong side for a few minutes (harmless — no equipment runs — but visible).
- The sweep (`npm run sweep`) checks every permutation of common indoor /
  outdoor / band / occupancy / sleep plus outdoor swings through the room
  temperature for inverted or fighting equipment, heat+cool in one hour,
  setpoint reversals, released-but-running sides and stranded rooms: zero
  findings. Two things it flagged and we *kept*: a released side still heats /
  cools to the setback floor / ceiling (that is the floor's job), and 5–10 min
  of conditioning inside the 1 °C release margin at a crossing (the margin is
  what stops flapping).
