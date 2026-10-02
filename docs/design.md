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
