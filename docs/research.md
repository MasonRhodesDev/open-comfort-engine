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

## Gaps this project fills

No open-source component did vote-based, per-person, per-time-block comfort
learning with presence-weighted aggregation, a decaying exploration drift, learned
block structure, and a generic inputs → setpoints state machine with a spec
others can implement.
