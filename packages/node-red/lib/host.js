// Host helpers for the Node-RED adapter: the clock, units and feedback wording.
// None of this is engine logic (see spec §1: time, units at the edge and wording are host concerns).
"use strict";

/** RFC 3339 "now" with this machine's local UTC offset (spec §2 needs the offset). */
function nowLocal(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const local = new Date(d.getTime() + off * 60000);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

const fToC = (f) => ((f - 32) * 5) / 9;
const cToF = (c) => (c * 9) / 5 + 32;
const dF = (f) => (f * 5) / 9; // a temperature *difference* in °F -> °C

/** Convert a zone config written in °F to the engine's °C. */
function zoneToC(z) {
  const c = JSON.parse(JSON.stringify(z));
  const cap = c.capabilities;
  cap.minGap = dF(cap.minGap);
  cap.setpointStep = Math.round(dF(cap.setpointStep) * 1000) / 1000 || 0.1;
  for (const k of ["heat", "cool"]) cap[k] = { min: fToC(cap[k].min), max: fToC(cap[k].max) };
  c.seed.blocks = c.seed.blocks.map((b) => ({ ...b, heat: fToC(b.heat), cool: fToC(b.cool) }));
  c.setback = { heat: fToC(c.setback.heat), cool: fToC(c.setback.cool) };
  return c;
}

const FEEDBACK_EN = {
  "nudge.cooler": "Cooling it down a bit for you.",
  "nudge.warmer": "Warming it up a bit for you.",
  "noted.cooldown": "Noted. Give it a few minutes to catch up.",
  "noted.no_reading": "Noted. I can't read the room temperature right now.",
};

module.exports = { nowLocal, fToC, cToF, zoneToC, FEEDBACK_EN };
