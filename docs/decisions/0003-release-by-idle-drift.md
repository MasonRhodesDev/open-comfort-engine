# ADR 0003 — Release judged by the room's own idle drift (proposed 2026-10-07)

Status: **proposed** — against 0.5.0-rc.4, targeting **0.5.0-rc.5**. Decided 2026-10-07: the rate
form of release (§3) and the rc.5 target. §8 lists what is still open. Nothing is built.

## Context

ADR 0002 §2b fixed one sentence this document revises: *"Release stays vector-based; the rates
only say when the air will get there."* On 2026-10-07 that sentence left the office occupant in
a warming room with the AC parked, and the spec review that followed found the cause in the
loop's physics, not in the host. The same ADR also anticipated the fix — §2b's *"more inputs,
same estimator … solar gain … derived the same way; none is a setting"* — so what follows is
0002's own extension clause applied, not a new mechanism.

**What happened (office, times UTC; `comfort_records` 517–519 and `/office/events`).**

| when | engine saw | engine did |
|---|---|---|
| 15:43 | door, light: occupied; policy sends `cool 25` from the last output | — |
| 15:44:41 | first fed reading: `tin 25.5`, `out 24.0`, `band.cool 24.74` | §7.4: `push = out − tin = −1.5 ≤ −1.0`, `reach = 24.74 − 24.0 = +0.74 ≥ 0` → **cooling released** to setback (29, clamped); no `auto` on this unit → `mode = heat 19` (the side opposing the air) |
| 15:46:52 | — | host applies `heat 19`; unit idles (5 W). This *is* the spec's intent (§1 "idle is the default", §7.8 `act`): not an illegal config, not a host misreading |
| 15:52 → 16:12 | `tin 25.5 → 26.5 → 27.5` with `out 24.5–25` | still released: the air is cooler than the room, so by §6.5 the room "must" be cooling |
| 16:12 | `out 25 > band.cool 24.74` → `reach < 0` | un-release wanted, deferred by the 30-min dwell until 16:14:41 |
| 16:14:18 | **vote hot** (`tin 27.5`) | complaint un-releases at once: `cool 24.5`, LEARNING |

Recovery would have come from the *weather* crossing the edge 23 s later — never from what the
room was observed to do. Had the outdoor temperature stayed at 24.5, cooling would have stayed
released while the room climbed.

**Why the model could not see it.** §6.5's idle model is `dtin/dt = envelope·(out − tin)`: a
room always drifts toward outdoor. The office does not. Two intervals from the same day that
no single `envelope` can fit:

| interval | `out − tin` | observed idle drift | §6.5 prediction |
|---|---|---|---|
| 04:44 → 10:00 (empty, closed, night) | ≈ −5 | 28.0 → 28.5: **+0.1 °C/h** | −0.5 to −4.5 °C/h |
| 15:52 → 16:12 (occupied, morning sun, PCs) | −1 to −2.5 | 25.5 → 27.5: **≈ +5 °C/h**¹ | −1.3 °C/h (learned `envelope` 0.89) |

¹ Follows a 4-min cooling episode; the unit's intake sensor rebounds after the coil stops, so
part of this is sensor, not room. The sign is the point: the room warmed while the air outside
was cooler, with a person in it. A source term fits both rows; a coupling alone fits neither.

**The office's learned thermal model is also wrong, for a reason that matters here.**
`thermal` at the 25 °C knot read `envelope 0.89 /h` at 16:05 (a room that closes 89 % of its
gap to outdoor every hour — the overnight row says ≤ 0.02) and `heat 2.0 / cool 2.0` at
**every** knot. The engine is only fed while the office is occupied, and of the 39 cooling
episodes since 2026-10-06 only two were attended; the 12-minute one at 16:14–16:26 (27.5 →
24.5 °C) left `cool` at 2.0 and moved `envelope` instead (25 °C knot 0.89 → 0.73, 30 °C knot
0.65 → 0.38): **the run was learned as air, not equipment.** Cause: the host feeds `equip`
from the ESPHome climate state's `action` (`office_climate.py:117` → `comfort.py`
`ACT[o.ac.action]`), and that field read `0` (OFF) throughout the run, at 152 W down to 109 W.
Under today's estimator a mislabelled run drags `envelope` whichever way the sign of
`out − tin` happens to point; under the estimator proposed below it would land in the source
term as a large *negative* gain and make release **more** eager. The host fix is therefore a
prerequisite of this change, not a follow-up (§5).

**Two smaller findings from the same review.** (a) §7.8 computes `equipment` (`heat` /
`cool` / `idle` — the act) but the output does not carry it; a host that wants a device with a
real `off` to be off while idle has to re-derive the act, which the spec's own §7.9 argument
("uses exactly this, so it cannot disagree") says it must not. (b) The mode rule for devices
without `auto` can never produce `off` (the fall-through always lands on a side), so a host
branch on `mode === "off"` is dead code.

## 1. The change to the loop

```
sense ──► band ──► act ──► learn
                    │        │
                    │        └─ §6.5 thermal: idle = envelope·(out − tin) + gain   (gain is new, learned)
                    └─ §7.4 release: judged on `idle`, the room's own predicted drift, not on `out − tin`
```

Everything else — the tolerance curve, votes, quiet, the felt push, protection, the dwell and
margin of release, the mode rule — is untouched. One term is added to the model the engine
already learns; the release rule reads that model instead of the raw outdoor vector. Written
once per side, as every rule is.

## 2. §6.5 — the thermal model gains a source term (learned, not configured)

```
idle:     dtin/dt = envelope(out) · (out − tin) + gain(out)                       # gain: °C/h
running:  dtin/dt = envelope(out) · (out − tin) + gain(out) − σ · equipment[side](out)
```

`gain` is the heat the room makes or loses on its own at that outdoor temperature — people,
equipment, sun through the glass, a basement's floor — in °C/h. Like `envelope` it is a curve
over the same outdoor knots, interpolated the same way, learned from the same consecutive
readings, and reported in `output.thermal` and `output.curve[].thermal`.

**Estimator.** Per knot, `envelope` and `gain` are the slope and intercept of the room's idle
rate on `x = out − tin`, fitted by exponentially-forgotten least squares. Each idle interval
(`rate = Δtin/dtH`, `x` at its start) updates the two neighbouring knots' sufficient
statistics with interpolation weight `w` and forgetting `f = thermalForget·w`:

```
n ← (1−f)·n + w ;  Sx ← (1−f)·Sx + w·x ;  Sy ← (1−f)·Sy + w·rate ;  Sxx ← (1−f)·Sxx + w·x² ;  Sxy ← (1−f)·Sxy + w·x·rate
envelope = clamp((n·Sxy − Sx·Sy) / (n·Sxx − Sx²), 0.02, 5)        # the floor as today
gain     = clamp((Sy − envelope·Sx) / n, −10, 10)
```

Priors are pseudo-observations: `thermalPriorHours` (default 2) of data on the line
`rate = envelopePrior·x` (gain 0), at `x = ±3`. They matter until the first days of readings,
as today's priors do. The `|out − tin| ≥ 1` guard goes: a small `x` cannot tell the slope, and
the regression knows that — it informs the intercept instead, which is exactly the number
release needs at that operating point. Running intervals update `equipment[side]` as today,
net of the full idle model (`σ·(idle(out, tin) − rate)`, same clamps).

What this is not: a configured internal-gain figure (physics is learned, like everything else
in §6.5), a time-of-day term (the engine has no clock; the knots over outdoor temperature carry
what they carry), a solar model (a later input per 0002 §2b, when something measures it).

A property worth stating: the host feeds the engine only while someone is there (§6.3), so the
`gain` it learns is the *attended* gain — the person, their equipment, the daytime sun. That is
the regime release has to be right in. The vacant room is the host's business (§1).

## 3. §7.4 — release reads the model

Today: `push = σ·(out − tin)` and `reach = σ·(edge − out)`, both in °C, both read off the
outdoor vector. **Decided (2026-10-07): release judges the room's own predicted drift, in
°C/h** — where the room is, and where the edge is:

```
push  = σ · idle(out, tin)        ≤ −natureRate  → released       (the room is drifting away from this edge on its own)
reach = −σ · idle(out, edge)      < 0            → taken back      (a room sitting at the edge would drift back outside it)
```

with `idle(out, T) = envelope(out)·(out − T) + gain(out)` from §2. The same two questions as
today — is the room being carried away from this edge, and would it be carried inside it —
asked of the learned model instead of the raw air. Well-conditioned: `push` is bounded by the
learned rates, so a 0.1 °C/h wobble in `gain` moves it by 0.1 °C/h. `natureMargin` (°C)
becomes **`natureRate`** (°C/h, default **0.3** = today's 1 °C margin × `envelopePrior`, range
0.05–2); hysteresis is `±natureRate`. With `gain = 0` and `envelope` at its prior the rule is
exactly today's; once a zone has taught its envelope it differs by design — a leaky zone
releases at a 1 °C outdoor difference, a tight one only at several, which is what "the air is
doing the work" has to mean in a tight room.

The 30-min dwell, the complaint exemption and the stale-weather rule stay exactly as written.
§7.3's stall test and §7.9's projection already integrate the thermal model, so they take
`gain` with no further change and stay consistent with `act`.

*Considered and rejected: the equilibrium form* — substitute `T_idle = out + gain/envelope`
for `out` in today's tests, keeping `natureMargin` in °C. Identical to today at `gain = 0`, but
ill-conditioned in the zone that motivated this: with `envelope` at its 0.02 floor a 0.5 °C/h
wobble in `gain` moves `T_idle` by 25 °C, the margin degenerates to a sign test, and only the
dwell stands against flapping.

**Today, replayed.** With the office's attended drift learned at the 25 °C knot (`gain` of a
few °C/h against an `envelope` near its floor), `idle(24, 25.5)` is positive: the room is not
drifting away from the cool edge, cooling is not released at 15:44:41, the unit keeps cooling
at 24.5–25, and no vote is needed. The house (`auto`, slow, a small positive attended gain)
releases cooling a little less on mild days — the correct direction, and a cost to measure
(§6).

## 4. §7.8 / §10 — the act is published

`equipment: "heat" | "cool" | "idle"` joins the output object (it is already computed, and the
projection already reports it per interval); a change in it is a `decision` record trigger.
Hosts whose device has an `off` mode MAY apply `off` while `equipment` is `idle`; `mode`
remains the device setting the engine would leave armed. The house in `auto` idles by itself
and needs nothing. Vectors pin `equipment`.

§4, `reading.equip`: one sentence tightened — *what the equipment actually ran since the
previous reading, from the equipment's own state (power, compressor), never inferred from its
mode*. A duty field (`equipMin`) for short-cycling units is deferred (§8, item 2).

## 5. Before this ships (prerequisite, home-flows)

- `comfort.py` office feeder: `equip` from power and mode (running ⇔ watts above the standby
  floor, side from the mode), not from ESPHome `action`, which is 0 while cooling. Until then
  every cooling interval teaches the wrong term under either estimator.
- Check the office's `out` source. The engine is fed the unit's own outdoor sensor
  (`o.outdoor ?? w.now`), which climbed 24.5 → 27.5 °C during the 30-minute cooling run while
  the house's sensor had read 21 °C at 14:07. If the condenser warms that sensor, release is
  being judged on a number the equipment itself moves; compare against the house sensor or
  Open-Meteo for a day before trusting it.
- Replay the office's `comfort_records` readings through the new model offline and check the
  learned `envelope`/`gain` at the 25 °C knot against the two rows in Context before trusting
  the live number.

## 6. Verification before release

1. Unit: the regression recovers `(envelope, gain)` from synthetic idle data within tolerance;
   with `gain = 0` and `envelope` held at its prior, the new release rule reproduces today's
   `nature-release` decisions step for step (the vector is then re-pinned with learning on).
2. Simulator: an office-like zone (`envelope` 0.05, attended `gain` 1–3 °C/h, sensor quantised to
   0.5 °C, 3-min episodes) — no release while the room's own drift points outward, no stranding,
   no flapping; the house sim's release-on/off comparison (design.md) re-run with `gain` 0.3 to
   put a number on the house cost.
3. Projection: `project()` before vs `step()` during, unchanged requirement.
4. Record 517's inputs replayed against the new engine: no release.
5. Adversarial review of spec + code, as for 0.4.0 and rc.2.
6. Live, one week: `comfort_thermal{rate="gain"}`, `comfort_released{zone,side}` and
   `hvac_running` in the Comfort row, office and house.

## 7. What changes where (only after approval)

- **Spec** 0.5.0-rc.5: §3.4 (`natureRate` replaces `natureMargin`; `thermalPriorHours`), §4 (`equip` sentence),
  §6.5 (source term, estimator), §7.4 (release reads the model), §7.8/§10 (`equipment`),
  §9 snapshot v4 (per-knot statistics; migration restarts the thermal model and keeps the curve).
  Vectors: `thermal`, `nature-release`, `stall-reactuates` re-pinned; a new `idle-gain` vector.
- **Reference**: `thermal.ts` (statistics, fit, `idle()`), `engine.ts` `act()` (two lines),
  output type, snapshot migration; sim zone with a gain.
- **home-flows**: §5 first; then `office_climate.py` maps `equipment: idle → off` (one line)
  and drops the dead `mode === "off"` branch; `comfort.py` metrics add `rate="gain"`.
  Separately observed, not this ADR: the vacant pre-cool for the work window short-cycles the
  compressor (three 3-min runs 14:59–15:33, each killed by "vacant (light off)").

Rejected on the way: un-release when the room moves away from the edge while released (a rule
on top of a wrong model; the model change makes it unnecessary and the rule would still release
first and learn second); a configured internal-gain parameter (a physics value the zone can
teach); a time-of-day or solar term now (no clock in the engine; a later measured input).

## 8. Decisions

Taken 2026-10-07: **release in rate form** (§3; the equilibrium form rejected as
ill-conditioned) and **target 0.5.0-rc.5** (rc.4 is live; 0.5.0 final is not cut).

Also taken 2026-10-07 (may still move in PR review):

1. **Office maps `idle → off`** once `equipment` is published; spec wording MAY (the house in
   `auto` must not be told to switch off).
2. **No `equipMin`** for now: the single `equip` with the host fix; revisit if the office's
   equipment rates still do not learn after a week of correct attribution.
3. Defaults: `thermalPriorHours` 2 h, `natureRate` 0.3 °C/h (range 0.05–2), gain clamp
   ±10 °C/h.

Sequence from here: this ADR → the spec diff (§7, reviewed before code) → reference
implementation, vectors, sim → rc.5 → the home-flows prerequisite (§5) and host changes.
