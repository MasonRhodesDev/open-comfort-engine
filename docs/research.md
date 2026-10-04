# Research behind the defaults

Compiled 2026-10-02 from a prior-art survey and a design review. Claims marked
*(summary)* rest on search-result summaries rather than a full read of the paper.

## Prior art

**Commercial**
- **Nest Learning Thermostat / Seasonal Savings** — learns schedules from manual
  changes; Seasonal Savings shifts presets "a fraction of a degree each day", about
  1 °C over a campaign, reverts on a discomfort signal and waits before trying
  again. The closest commercial analogue of our drift; no published decay schedule
  and no per-person model.
  https://support.google.com/googlenest/answer/9244739
- **Comfy (Building Robotics → Siemens)** — office occupants press "warm my space"
  / "cool my space"; a ~10-minute burst plus ML that narrows the programmed range
  from collective requests. Same two-button, no-numbers UX.
  https://architizer.com/blog/practice/materials/power-to-the-people-comfy/
- **ecobee eco+ "Adjust for Humidity"** — a static feels-like offset, no learning.
  https://www.ecobee.com/en-us/citizen/learn-about-a-thermostat-feature-that-just-feels-good/
- **tado° AI Assist, Sensibo Climate React, Mysa** — learn the building or apply
  rules; no occupant votes.

**Open source / Home Assistant** — no vote-based preference learner found.
Adjacent: Thermal Comfort (feels-like sensors,
https://github.com/dolezsa/thermal_comfort), Versatile Thermostat (building
dynamics, https://github.com/jmcollin78/versatile_thermostat), a tiny Q-learning
thermostat treating overrides as penalties
(https://github.com/batman202012/Python_HA_Learning_Thermostat).

**Academic**
- **Thermovote** (Erickson & Cerpa, BuildSys 2012) — net vote moves the setpoint
  by a fixed step; 10.1 % energy saved over five months with 39 people; notes the
  step-size trade-off our shrinking step addresses.
  https://www.semanticscholar.org/paper/24a7ff789c2024aadbca408c953a0dbb48873a2c
- **Jazizadeh et al.** — per-user comfort profiles from participatory feedback;
  zone setpoint from occupants present; large airflow savings, higher satisfaction.
  https://www.researchgate.net/publication/269077003
- **Personal comfort models** (Kim, Schiavon, Brager, CBE Berkeley) — per-person
  models outperform PMV and adaptive models.
  https://escholarship.org/uc/item/18d174zs
- **Bandit thermostats** — learning from overrides with minimal exploration; up to
  12.7 % saved in a two-zone field test *(summary)*.
  https://www.sciencedirect.com/science/article/pii/S0378778826000903
- **Bayesian preference learning with unimodality** — https://arxiv.org/pdf/1903.09094
- **Fairness / strategy-proof comfort voting** — cap per-user influence.
  https://dl.acm.org/doi/10.1145/2676061.2674074

## Numbers used

| default | source |
|---|---|
| drift 0.1–0.3 °C/h | just-noticeable difference ≈ 0.38 °C (Sci Rep 2023, https://www.nature.com/articles/s41598-023-47880-5); ramps ≈ 0.5 K/h largely unnoticed *(summary)*; ASHRAE 55 drift limits 1.1 °C/15 min … 3.3 °C/4 h are acceptability ceilings, not noticeability (https://www.ashrae.org) |
| adaptive slope 0.10 | ASHRAE 55 adaptive model is T = 0.31·Trm + 17.8 for naturally ventilated buildings; RP-884 found less than half that gradient in conditioned buildings (de Dear & Brager, https://escholarship.org/content/qt4qq2p9c6/qt4qq2p9c6.pdf; https://cbe.berkeley.edu/research/adaptive-comfort-model/) |
| running mean α = 0.8 | EN 15251 / EN 16798 running-mean outdoor temperature convention |
| step 1.0 °C, halve on reversal | Thermovote step trade-off; Robbins–Monro style step decay (https://www.di.ens.fr/~fbach/orsay2016/lecture3.pdf) |
| drift ceiling at the 30th percentile, protect the heat-sensitive in cooling | design choice validated in `packages/core/test/sim` (median ceiling caused steady complaints) |

## Added for 0.4.0 (release, risk, sleep) — from search-result summaries only; verify before quoting

- **Wider deadband saves energy**: Hoyt, Arens & Zhang (2015) *Extending air temperature setpoints*, Building and Environment 88 — raising cooling 22.2→25 °C saved ~29 % cooling / 27 % HVAC energy; lowering heating 21.1→20 °C saved ~34 % terminal heating (office simulations). https://www.sciencedirect.com/science/article/abs/pii/S0360132314003023 *(summary)*
- **Setpoints that follow outdoor temperature**: Parkinson, de Dear & Brager (2020) *Nudging the adaptive thermal comfort model*, Energy and Buildings 206, doi:10.1016/j.enbuild.2019.109559 — seasonal/synoptic setpoint shifts; ~7–15 % HVAC energy per °C of band expansion beyond a ~2 K deadband (figure seen in a snippet, attribution unconfirmed) *(summary)*
- **Nudging only in the saving direction**: Nest Labs (2013) *Seasonal Savings* white paper — schedules nudged over weeks, ~5–10 % less heating in a field trial, 80 % kept the result *(summary)*
- **Outdoor lockout of heating**: ASHRAE Guideline 36-2018 (addendum y) — hot-water plant lockout above an outdoor temperature (defaults 65–75 °F); balance-point temperature theory for residential envelopes *(summary)*
- **Changeover deadband**: ASHRAE 90.1 / Title 24 require ≥ 5 °F between heating and cooling setpoints where both exist *(summary)*
- **Sleep**: Lan, Tsuzuki, Liu & Lian (2017) *Thermal environment and sleep quality: a review*, Energy and Buildings 149 — even moderate heat or cold exposure reduces sleep quality; avoid letting temperature fall toward morning *(summary)*
- **Alliesthesia**: de Dear (2011), Building Research & Information 39(2), doi:10.1080/09613218.2011.552269 — a slow drift feels pleasant or unpleasant by direction *(summary)*
- No published work was found on applying the adaptive shift only in the energy-saving direction, or on alternating heat/cool under auto changeover within a day; both are this project's own design choices.

## Gaps this project fills

No open-source component did vote-based, per-person, per-time-block comfort
learning with presence-weighted aggregation, a decaying exploration drift, learned
block structure, and a generic inputs → setpoints state machine with a spec
others can implement.
