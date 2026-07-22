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

All six phases are complete:

| Phase | Scope | Status |
|---|---|---|
| 1 | Data model + DSL parser | Done |
| 2 | Layer 1 renderer (CLD with computed loops) | Done |
| 3 | Layer 2 constraint overlay (heat + ranking) | Done |
| 4 | Layer 3 T/I/OE simulation (Euler/RK4 + sparklines) | Done |
| 5 | ABM companion view (agent engine + validation) | Done |
| 6 | Polish (layer switcher, session save/load, a11y) | Done |

134 tests passing. Production build: 49 KB gzipped JS + 2 KB worker (budget: 250 KB).

See [`PLAN.md`](./PLAN.md) for the full roadmap and [`prompt.md`](./prompt.md) for the original architecture spec.

## Quick start

```bash
npm ci
npm run dev         # vite dev server at http://localhost:5173
```

The app loads the beer-distribution fixture automatically. Use the layer
switcher (top left) to toggle overlays; use the side panels (right) for
constraint scores, T/I/OE simulation, and ABM validation.

```bash
npm run typecheck   # tsc --noEmit
npm run lint
npm test            # vitest — 134 unit tests
npm run build       # production build → dist/
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

- [`docs/usage-guide.md`](./docs/usage-guide.md) — detailed walkthrough of every layer and feature
- [`docs/dsl-reference.md`](./docs/dsl-reference.md) — YAML/JSON authoring grammar
- [`docs/data-model.md`](./docs/data-model.md) — the `Graph` types and invariants
- [`docs/contributing.md`](./docs/contributing.md) — branch model and Definition of Done
- [`PLAN.md`](./PLAN.md) — development plan, testing, and deployment strategy
- [`AGENTS.md`](./AGENTS.md) — instructions for AI coding agents

## License

Private.
