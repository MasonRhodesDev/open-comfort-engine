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

One loop, run on every event:

```
sense → band → act → learn
```

- **Sense.** The room temperature, the outdoor temperature, who is present (and
  whether they're asleep), and votes — all supplied by your integration.
- **Band.** Comfort is a range per person per time block: the coolest and the
  warmest indoor temperature they accept. "Too hot" at 24.2 °C means their warm
  limit is below 24.2; "too cold" teaches the other end. The band is the overlap
  of everyone *present*, at the current **risk** level, and never wider than
  your protection limits. Nobody home: the band is your setback.
- **Act.** The device stays idle while the room is inside the band — or outside
  it but drifting toward it on its own: a side the outdoor air is already
  pushing the room away from is *released* (no heating while it's warmer out
  than in, no cooling while it's cooler out than in). Otherwise it conditions to
  the nearest edge. A device that can't do "auto" is told which side to run.
- **Learn.** A vote moves that person's edge, is *felt* right away (the edge
  ends a step past the room, Thermovote-style), resets risk on that side and
  un-releases it for a while. Quiet time with people awake raises risk slowly,
  widening the band toward what people are learned to tolerate. Sleep freezes
  risk in place. Blocks split, merge and shift as votes show where preferences
  really change.

Everything is written once per *side* (heat/cool are the same rule with a sign),
so there is no heating logic and no cooling logic — just the loop.

It is deliberately *identity-agnostic* (users are opaque ids), *presence-agnostic*
(you tell it who is here), and *device-agnostic* (you tell it what the device can
do, it never actuates anything). Your integration owns all of that, plus site
rules like "pre-cool before peak pricing".

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
npm install https://github.com/MasonRhodesDev/open-comfort-engine/releases/download/v0.4.0/node-red-contrib-open-comfort-engine-0.4.0.tgz
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
