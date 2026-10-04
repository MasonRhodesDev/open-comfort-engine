# Conformance

An implementation is **conformant with spec version X.Y** when it passes every
vector in `spec/vectors/` whose `specVersion` is ≤ X.Y.

## Vector format

Each file in `vectors/` is JSON Lines (UTF-8, one JSON value per line):

1. Line 1 — header:
   `{"vector": "<name>", "specVersion": "0.1.0", "description": "…", "config": ZoneConfig, "snapshot": Snapshot | null}`
   (`snapshot: null` means "fresh state").
2. Every following line — one step:
   `{"event": Event, "expect": { "output"?: {…}, "effects"?: {…} } }`

## Running a vector

```
state = snapshot ? restore(snapshot) : init(config)
for each step line:
    (state, output, effects) = step(state, line.event, config)
    compare(output,  line.expect.output)
    compare(effects, line.expect.effects)
```

`compare(actual, expected)` checks only the keys present in `expected`
(recursively; arrays element-wise and of equal length). Absent keys are not
checked, so vectors pin what matters for that scenario.

## Tolerances

| value | tolerance |
|---|---|
| `heat`, `cool` (already rounded to `setpointStep`) | exact |
| `mode`, `state`, `reasons`, `released`, `protect`, feedback codes, record `type`/`dir`/`user`/`pushed` | exact |
| any other number (band, push, confidence, delta, thermal rates, curve points, record numbers) | absolute 1e−6 |
| snapshot | not compared directly; round-trip is tested by `restore` steps (below) |

## Special step

A step line may instead be `{"roundtrip": true}`: the runner serialises the
current state to a snapshot (JSON text), restores a fresh engine from it, and
continues with that engine. Later expectations must still pass.

## Reference runner

`packages/core/test/vectors.test.ts` is the reference runner; it is ~40 lines
and a good template for other languages.
