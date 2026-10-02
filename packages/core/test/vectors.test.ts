// Reference conformance runner for spec/vectors (see spec/CONFORMANCE.md).
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { init, restore, serialize, step, type State } from "../src";

const dir = new URL("../../../spec/vectors/", import.meta.url).pathname;
const EXACT = new Set(["heat", "cool", "mode", "state", "block", "reasons", "feedback", "type", "action", "dir", "user", "updated"]);

function compare(actual: unknown, expected: unknown, path: string, key = ""): void {
  if (expected === null || typeof expected !== "object") {
    if (typeof expected === "number" && !EXACT.has(key)) expect(actual as number, path).toBeCloseTo(expected, 6);
    else expect(actual, path).toEqual(expected);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    expect((actual as unknown[]).length, path + ".length").toBe(expected.length);
    expected.forEach((e, i) => compare((actual as unknown[])[i], e, `${path}[${i}]`, key));
    return;
  }
  for (const [k, v] of Object.entries(expected)) compare((actual as Record<string, unknown>)?.[k], v, `${path}.${k}`, k);
}

for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort()) {
  describe(`vector ${f}`, () => {
    it("conforms", () => {
      const [head, ...lines] = readFileSync(dir + f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      let s: State = head.snapshot ? restore(head.snapshot) : init(head.config);
      lines.forEach((line, i) => {
        if (line.roundtrip) { s = restore(JSON.parse(JSON.stringify(serialize(s)))); return; }
        const r = step(s, line.event, head.config);
        s = r.state;
        if (line.expect.output) compare(r.output, line.expect.output, `step ${i + 1} output`);
        if (line.expect.effects) compare(r.effects, line.expect.effects, `step ${i + 1} effects`);
      });
    });
  });
}
