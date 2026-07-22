# Layers

Layered Constraint Visualization — a thinking tool for system-dynamics modeling.

Three layers, one canvas, one companion view, all driven by a single `Graph` data model:

1. **Layer 1 (CLD substrate)** — the system as drawn: loops, polarity, delays.
2. **Layer 2 (constraint overlay)** — the system as scored: where a constraint is likely sitting, and why.
3. **Layer 3 (T/I/OE overlay)** — the system as valued: what moving the constraint does financially.
4. **Companion view (ABM)** — the system as generated: do agent-level rules reproduce the loop you drew?

Layers 1–3 share one data model and one canvas. The ABM companion is a separate pane that reads from a node and writes validation flags back onto the graph.

**Core principle:** compute, don't just draw. Loops, constraint scores, and T/I/OE deltas are derived from the graph, never manually annotated.

## Status

Phase 1 complete: the `Graph` data model and a YAML/JSON DSL parser that validates input into it. Later phases (renderer, overlays, simulation, ABM) build on this. See [`PLAN.md`](./PLAN.md) for the full roadmap and [`prompt.md`](./prompt.md) for the original architecture spec.

## Quick start

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm run lint
npm test            # vitest
npm run dev         # vite dev server (UI lands in Phase 2)
```

## Authoring a graph

Graphs are authored in YAML before any visuals are wired up. See
[`public/examples/beer-distribution.yaml`](./public/examples/beer-distribution.yaml)
for a working fixture, and [`docs/dsl-reference.md`](./docs/dsl-reference.md)
for the full grammar.

```yaml
nodes:
  - id: backlog
    label: Order Backlog
    type: stock
    tioe_class: I
    initial_value: 0
    unit: units
edges:
  - id: e1
    source: demand
    target: backlog
    polarity: +
    delay: { type: material, magnitude: 4 }
    strength: 1
```

Loops are **never authored** — they are computed from the edges.

## Documentation

- [`PLAN.md`](./PLAN.md) — development plan, testing, and deployment strategy
- [`docs/data-model.md`](./docs/data-model.md) — the `Graph` types and invariants
- [`docs/dsl-reference.md`](./docs/dsl-reference.md) — YAML/JSON authoring grammar
- [`docs/contributing.md`](./docs/contributing.md) — branch model and Definition of Done
- [`AGENTS.md`](./AGENTS.md) — instructions for AI coding agents

## License

Private.
