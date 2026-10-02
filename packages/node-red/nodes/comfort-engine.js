"use strict";
const core = require("../lib/core.cjs");
const { nowLocal, cToF, fToC, FEEDBACK_EN } = require("../lib/host");

module.exports = function (RED) {
  function ComfortEngine(n) {
    RED.nodes.createNode(this, n);
    const node = this;
    const zoneNode = RED.nodes.getNode(n.zone);
    node.tickSec = Number(n.tickSec) || 0;
    node.persist = !!n.persist;
    node.sendAlways = !!n.sendAlways;
    let published = false;
    if (!zoneNode || !zoneNode.zone) {
      node.status({ fill: "red", shape: "ring", text: "no zone" });
      return;
    }
    const units = zoneNode.units;
    const zone = zoneNode.zone;
    const ctx = node.context();
    let state = (node.persist && ctx.get("state")) || core.init(zone);

    const toUnits = (c) => (units === "F" ? Math.round(cToF(c) / (zoneStepF() || 1)) * (zoneStepF() || 1) : c);
    function zoneStepF() {
      // the device step the user entered in °F (zoneToC converted it); recover it for output rounding
      return units === "F" ? Math.round(((zone.capabilities.setpointStep * 9) / 5) * 100) / 100 : null;
    }

    function apply(event, send, done) {
      if (!event.now) event.now = nowLocal();
      let r;
      try {
        r = core.step(state, event, zone);
      } catch (e) {
        done ? done(e) : node.error(e);
        return;
      }
      state = r.state;
      if (node.persist) ctx.set("state", state);
      const o = r.output;
      const outMsg = {
        topic: zone.id,
        payload: { heat: toUnits(o.heat), cool: toUnits(o.cool), mode: o.mode, state: o.state, units },
        engine: o,
      };
      const recs = r.effects.records.map((rec) => ({ topic: rec.type, payload: rec }));
      const snap = r.effects.snapshot ? { topic: "snapshot", payload: r.effects.snapshot } : null;
      const fb = r.effects.feedback ? { topic: r.effects.feedback, payload: FEEDBACK_EN[r.effects.feedback] || r.effects.feedback, event } : null;
      node.status({ fill: o.state === "FROZEN" ? "grey" : o.state === "HOLD" ? "yellow" : "green", shape: "dot",
        text: `${o.state} ${toUnits(o.heat)}–${toUnits(o.cool)}° ${o.reasons.filter((x) => x !== "seed").join(",")}` });
      // setpoints when the decision changed (the engine emits a `decision` record then), on the
      // first step after start and after a restore (consumers may hold a stale value), or on every
      // step when configured (so consumers can treat the age of the last message as liveness)
      const changed = r.effects.records.some((x) => x.type === "decision");
      const publish = changed || !published || event.type === "restore" || node.sendAlways;
      published = true;
      send([publish ? outMsg : null, recs.length ? recs : null, snap, fb]);
      if (done) done();
    }

    node.on("input", (msg, send, done) => {
      // msg.payload is an engine event, or msg.topic is the event type and msg.payload its fields
      let ev = msg.payload && typeof msg.payload === "object" && msg.payload.type ? { ...msg.payload } : { ...(typeof msg.payload === "object" ? msg.payload : {}), type: msg.topic };
      if (!ev.type) {
        done(new Error("comfort-engine: need msg.payload.type or msg.topic (vote, presence, reading, weather, cost, manual, freeze, tick, restore)"));
        return;
      }
      if (units === "F") ev = fromUnits(ev);
      apply(ev, send, done);
    });

    // event temperatures in °F -> °C (votes and presence have none)
    function fromUnits(ev) {
      const c = { ...ev };
      if (typeof c.tin === "number") c.tin = fToC(c.tin);
      if (typeof c.out === "number") c.out = fToC(c.out);
      if (typeof c.high === "number") c.high = fToC(c.high);
      if (typeof c.low === "number") c.low = fToC(c.low);
      if (c.applied) {
        c.applied = { ...c.applied };
        if (typeof c.applied.heat === "number") c.applied.heat = fToC(c.applied.heat);
        if (typeof c.applied.cool === "number") c.applied.cool = fToC(c.applied.cool);
      }
      return c;
    }

    let timer = null;
    if (node.tickSec > 0) {
      timer = setInterval(() => apply({ type: "tick" }, (msgs) => node.send(msgs)), node.tickSec * 1000);
    }
    node.on("close", () => timer && clearInterval(timer));
    node.status({ fill: "grey", shape: "ring", text: "waiting for events" });
  }
  RED.nodes.registerType("comfort-engine", ComfortEngine);
};
