"use strict";
const { zoneToC } = require("../lib/host");

module.exports = function (RED) {
  function ComfortZone(n) {
    RED.nodes.createNode(this, n);
    this.name = n.name;
    this.units = n.units === "F" ? "F" : "C";
    let cfg;
    try {
      cfg = typeof n.config === "string" ? JSON.parse(n.config) : n.config;
    } catch (e) {
      this.error("zone config is not valid JSON: " + e.message);
      cfg = null;
    }
    if (cfg) {
      cfg.id = cfg.id || n.zoneId || this.id;
      this.zone = this.units === "F" ? zoneToC(cfg) : cfg;
    }
  }
  RED.nodes.registerType("comfort-zone", ComfortZone);
};
