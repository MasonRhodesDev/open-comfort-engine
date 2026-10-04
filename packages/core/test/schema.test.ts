// Every vector's config, events and outputs validate against spec/schema.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { init, step } from "../src";
import { house } from "./fixtures";

const sdir = new URL("../../../spec/schema/", import.meta.url).pathname;
const vdir = new URL("../../../spec/vectors/", import.meta.url).pathname;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
for (const f of readdirSync(sdir)) ajv.addSchema(JSON.parse(readFileSync(sdir + f, "utf8")));
const v = (id: string) => ajv.getSchema(`https://github.com/MasonRhodesDev/open-comfort-engine/spec/schema/${id}.schema.json`)!;

describe("schemas", () => {
  for (const f of readdirSync(vdir).filter((x) => x.endsWith(".jsonl"))) {
    it(`vector ${f} validates`, () => {
      const [head, ...lines] = readFileSync(vdir + f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(v("zone-config")(head.config), JSON.stringify(v("zone-config").errors)).toBe(true);
      for (const l of lines) {
        if (l.roundtrip) continue;
        const rejected = l.expect.effects.records.some((r: any) => r.type === "rejected");
        if (!rejected) expect(v("event")(l.event), JSON.stringify(v("event").errors)).toBe(true);
        expect(v("output")(l.expect.output), JSON.stringify(v("output").errors)).toBe(true);
      }
    });
  }
  it("a snapshot validates", () => {
    const r = step(init(house), { type: "reading", now: "2026-07-01T09:00:00-07:00", tin: 23, equip: "idle" }, house);
    expect(v("snapshot")(r.effects.snapshot), JSON.stringify(v("snapshot").errors)).toBe(true);
    expect(v("effects")(r.effects), JSON.stringify(v("effects").errors)).toBe(true);
  });
});
