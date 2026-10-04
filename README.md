# Open Comfort Engine

**Thermostats that learn how warm people actually like it, from "I'm too hot" and
"I'm too cold" — and quietly save energy while nobody complains.**

Instead of fixed setpoints, a zone (a house, an office, a room) learns each
occupant's comfortable range for each part of the day. People never see or type a
number: they say *too hot* or *too cold* from a button, a phone or a voice
assistant, the room responds with a change they can feel, and the engine learns.
When nobody is complaining it slowly widens the band toward idle to find
savings — faster when the zone is empty — and backs off as soon as someone
objects. As it becomes confident, the exploration ("entropy") dies down; a
"we've got this" switch freezes it entirely.

In a simulated two-person household over six weeks the engine cut discomfort by
35–60 % and HVAC runtime by 21–25 % against the same static schedule it started
from (`npm run sim`, `packages/core/test/sim.test.ts`).

## How it works, in plain words

The engine learns one thing per zone: the **tolerance curve** — the indoor
temperature range the people who use the space accept, as a function of the
outdoor temperature. It runs one loop on every event:

```
sense → band → act → learn
```

- **Sense.** The room temperature, the outdoor temperature, votes and manual
  changes, all supplied by your integration.
- **Band.** The curve read at the current outdoor temperature, at its safe
  quantile. On a 38 °C day the accepted ceiling is what people said on 38 °C
  days; on a 20 °C evening what they said then. Nothing in the configuration
  says how comfort should bend with the weather — the curve is derived from
  the population's votes, knot by knot, and it is not assumed to be linear.
- **Act.** Idle inside the band. Outside it, a side the outdoor air is already
  pushing the room toward is *released* (no heating while it's warmer out than
  in, no cooling while it's cooler out than in — the air does the work);
  otherwise condition to the nearest edge. A device without "auto" is told
  which side to run. Setpoints change only when the wanted value has moved a
  full step: the engine outputs a range, never a target temperature.
- **Learn.** A vote teaches the knots at the outdoor temperature it was cast
  at and is *felt* at once: the voted edge is pushed one step past the room,
  then fades back into the learned band over a couple of quiet hours. Quiet
  attended time is **exploration that decays with confidence**: while an edge
  is uncertain it widens past the room; once the population has resolved it,
  quiet moves nothing — so a confident night band holds whether or not anyone
  is awake to vote. The engine also learns the zone's **thermal response** (how
  fast the room drifts toward outdoor, how fast the equipment moves it) from
  the readings, and uses it to tell a stalled vote from one still on its way,
  to **project** a day's band, room and run time from the forecast, and to let
  a zone that can correct fast explore faster.

It is deliberately **identity-free** (a vote's user id is only for records),
**presence-free** (your integration stops feeding it while nobody is home and
decides what the equipment does then), **schedule-free** (no time of day; the
hour a vote is cast matters less than the temperature and the band) and
**device-agnostic** (you tell it what the device can do; it never actuates).
Heat and cool are the same rule with a sign: there is no heating logic and no
cooling logic, just the loop.

## What's here

| path | what |
|---|---|
| [`spec/`](spec/SPEC.md) | **The specification** — normative, language-neutral: data model, events, state machine, every algorithm and constant, JSON Schemas, and conformance vectors. Implement it in any language. |
| [`packages/core`](packages/core) | `open-comfort-engine`: the TypeScript reference implementation. Pure (`step(state, event, config)`), zero dependencies, no I/O. |
| [`packages/node-red`](packages/node-red) | `node-red-contrib-open-comfort-engine`: Node-RED nodes (`comfort-zone`, `comfort-engine`). |
| [`docs/`](docs/) | Design notes, the research behind the defaults, decisions. |

## Quick start (Node-RED)

Until it's on npm, install a release tarball (Menu → Manage palette → Install →
upload, or in your Node-RED user directory):

```sh
npm install https://github.com/MasonRhodesDev/open-comfort-engine/releases/download/v0.5.0-rc.3/node-red-contrib-open-comfort-engine-0.5.0-rc.3.tgz
```

Import `examples/basic.json` from the package. Feed the `comfort-engine` node:

- `presence` `{users:["alice","bob"]}` whenever who's home changes,
- `reading` `{tin, equip?, applied?}` from your thermostat,
- `weather` `{out}` now and then,
- `vote` `{user, dir:"hot"|"cold"}` from buttons/voice/phone,

and send output 1 (`{heat, cool, mode}`) to your thermostat. Store output 3
(snapshots) somewhere and send it back as `restore` on start.

## Using the core directly

```ts
import { init, step } from "open-comfort-engine";
let state = init(zoneConfig);
const r = step(state, { type: "vote", now: "2026-10-02T14:05:00-07:00", user: "u1", dir: "hot" }, zoneConfig);
state = r.state;            // persist r.effects.snapshot when present
r.output;                   // { heat, cool, mode, state, reasons, ... } in °C
```

## Implementing it elsewhere

Read [`spec/SPEC.md`](spec/SPEC.md), validate against
[`spec/schema/`](spec/schema/), and run the vectors in
[`spec/vectors/`](spec/vectors/) as described in
[`spec/CONFORMANCE.md`](spec/CONFORMANCE.md). The reference runner is
[`packages/core/test/vectors.test.ts`](packages/core/test/vectors.test.ts).

## Development

```sh
npm install
npm test            # unit + conformance vectors + schema + simulation outcomes
npm run sim -- 42   # print a 42-day household simulation
npm run vectors     # regenerate spec/vectors from the reference implementation (review the diff!)
npm run build
```

Status: **0.1.0, draft spec.** Built for and running in a home lab; feedback and
other-language implementations welcome. MIT licensed.
