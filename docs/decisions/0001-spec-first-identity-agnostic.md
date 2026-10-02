# 0001 — Spec-first, identity- and presence-agnostic engine

Status: accepted (2026-10-02)

## Context
The engine started as a home-lab automation (Node-RED, Home Assistant, a Daikin
heat pump, an office mini-split). Its owner wanted it reusable by anyone, in any
language, without leaking that home's specifics.

## Decision
- The engine is defined by a normative, language-neutral spec with JSON Schemas
  and conformance vectors; the TypeScript package is a reference implementation.
- The engine is a pure state machine; time arrives in events.
- Users are opaque uid strings; the engine never models identity.
- Presence (and any arrival prediction) is an input; the engine never models people.
- Device capabilities are declared in configuration; the engine never actuates.
- Site policy (tariff-driven pre-cooling, quiet hours, holiday modes) is applied
  by the host after the engine's output; the host reports back what it applied.

## Consequences
- Any host can embed it; conformance is checkable.
- Some useful behaviour (arrival prediction, tariff policy) has to be built by
  each integration; the engine provides hooks (`expectedArrival`/`expectedUsers`,
  `cost`) instead.
