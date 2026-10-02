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

- **Comfort is a range per person per time block** — the coolest and the warmest
  indoor temperature they accept. "Too hot" at 24.2 °C means their warm limit is
  below 24.2; "too cold" teaches the other end. Quiet hours with someone home
  weakly confirm the room is inside their range.
- **The household band** is the tightest range that keeps everyone *present*
  comfortable; with people who disagree, the season decides who is protected.
- **Votes are felt.** A vote moves the band so the room ends up about one step
  past where it is now (cooler or warmer), and the step shrinks if the person
  changes their mind — a search, not a number.
- **Entropy toward idle.** Without complaints the band drifts wider (≤ ~0.3 °C/h,
  under what people notice), never past what a present person is likely to
  accept; vacancy drift is faster and stops at a setback, with recovery timed to
  an expected arrival if you supply one.
- **Blocks are learned too.** It starts from your schedule and splits, merges or
  nudges block boundaries as votes show where preferences really change.
- **It adapts to the weather**: a warm week moves the whole band up a little, as
  the ASHRAE 55 adaptive comfort model predicts.

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
npm install https://github.com/MasonRhodesDev/open-comfort-engine/releases/download/v0.1.1/node-red-contrib-open-comfort-engine-0.1.1.tgz
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
