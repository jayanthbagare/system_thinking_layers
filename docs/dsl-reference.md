# DSL Reference

Graphs are authored in YAML or JSON before any visuals are wired up. The parser
(`src/dsl/parser.ts`) maps the DSL onto the `Graph` model, fills sensible
defaults, and collects **all** validation violations in one pass.

## Minimal example

```yaml
nodes:
  - id: backlog
    label: Order Backlog
    type: stock
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

A working fixture lives at
[`public/examples/beer-distribution.yaml`](../public/examples/beer-distribution.yaml).

## Top-level keys

| Key | Required | Notes |
|---|---|---|
| `nodes` | yes | list of node objects |
| `edges` | yes (may be empty) | list of edge objects |
| `loops` | **no** | rejected — loops are computed, never authored |

## Node fields

| Field | Required | Type | Default |
|---|---|---|---|
| `id` | yes | string | — |
| `label` | no | string | falls back to `id` |
| `type` | no | `stock` \| `flow` \| `auxiliary` | `auxiliary` |
| `boundary` | no | `true` \| `false` | auto (exogenous) | Marks the node as the system's interface with its environment. T/I/OE are derived from the boundary + topology. Auto-derived: nodes with no incoming edges are boundary when no explicit `boundary: true` is set. |
| `initial_value` | no | number | `0` |
| `unit` | no | string | `""` |
| `collar` | no | object (below) | omitted (unbounded) |
| `capacity_cost` | no | number | omitted | Operating expense the constrained resource consumes per unit of model time, regardless of utilization. When present, `deriveTioe` counts it as that node's fixed OE — so Exploit (collar fixed) holds OE flat and Elevate (collar moved) raises OE. When absent, OE falls back to the flow through the collared stock. |
| `agent_binding` | no | `{ rule_id: string }` | omitted |
| `pin` | no | `{ x: number, y: number }` | omitted (auto-layout) |

> **Migration note:** the legacy flat fields `lower_collar` / `upper_collar`
> (normalized [0,1]) are **rejected** at parse time with `collar_ambiguous_units`.
> Restate them in the `collar:` block with physical units matching `initial_value`.

### Collar object

| Field | Type | Default | Meaning |
|---|---|---|---|
| `lower` | number | omitted (no lower clamp) | Physical lower bound. Engine clamps value to >= lower. |
| `upper` | number | omitted (no upper clamp) | Physical upper bound. Engine clamps value to <= upper. |
| `approach` | `hard` \| `soft` | `hard` | `hard` clips at the boundary; `soft` ramps transfer to zero in the top 10% of the span (Phase 7). |

Validation: `lower < upper`; `lower <= initial_value <= upper`; each bound
optional independently. A node with neither bound is unbounded. The engine
enforces collars with anti-windup (excess does not accumulate) and
reject-and-backpressure (excess returns to delay queues).

```yaml
- id: production_capacity
  initial_value: 100
  unit: units/week
  collar: { lower: 0, upper: 120 }
  capacity_cost: 50
```

### Typed ToC interventions (Layer 3, Phase 4)

Layer 3's intervention control is a type selector, not a raw Δ slider. The
three types map onto collar operations on the selected node:

| Type | What it does | Expected T/I/OE |
|---|---|---|
| **Exploit** | Raise the operating point toward the *existing* upper collar (the collar does not move). Capped at available headroom; disabled at zero headroom. | T up, OE flat, I flat-or-down |
| **Subordinate** | Splice a rope — a negative-polarity information edge `buffer -> release` — reducing upstream pressure on a collar that cannot absorb it. | I down sharply, T flat, OE flat |
| **Elevate** | Move the upper collar up; the `capacity_cost` is scaled proportionally so OE rises. | T up, OE up, I up |

The panel reports the expected vs observed signature (disagreements flagged),
the TA decision ratios (ΔT/ΔOE, ΔT/ΔI, ΔT per constraint time, payback
horizon), the J-curve (worse-before-better depth/duration), and the
degrees-of-freedom change. See `src/layer3/intervention.ts`.

## Edge fields

| Field | Required | Type | Default |
|---|---|---|---|
| `id` | yes | string | — |
| `source` | yes | node id | — |
| `target` | yes | node id | — |
| `polarity` | no | `+` \| `-` | `+` |
| `delay` | no | object (below) | `{ type: none, magnitude: 0 }` |
| `strength` | no | number | `1` |
| `range` | no | object (below) | omitted |

### Delay object

| Field | Type | Values |
|---|---|---|
| `type` | `none` \| `material` \| `information` \| `perception` | |
| `magnitude` | number (>= 0) | model time units |

### Range object (Phase 8)

Authored uncertainty on an edge's static properties. NOT enforced by the
engine — consumed only by the Phase 8 Monte Carlo sampler. A `range` says "I
don't know this number precisely," distinct from a `collar` which says "the
system cannot go there."

| Field | Type | Meaning |
|---|---|---|
| `strength` | `[min, max]` | Range for the edge's `strength` |
| `delay_magnitude` | `[min, max]` | Range for `delay.magnitude` |

```yaml
- id: e2
  source: retailer_backlog
  target: retailer_orders
  strength: 1.3
  range: { strength: [1.1, 1.6], delay_magnitude: [1, 4] }
```

## JSON

The same structure is accepted as JSON. `parseGraph` detects the format
automatically; `serializeGraph` emits JSON, so a saved session round-trips
losslessly.

## Errors

`parseGraph` never throws — it returns `{ graph, issues }` where `issues` is a
list of `{ code, message, ref? }`. `parseGraphOrThrow` throws a `ParseError`
carrying the same list. See [`data-model.md`](./data-model.md) for the full set
of validation codes.

## Security notes

- YAML is parsed with the `core` schema — `!!js/function` and similar tags that
  instantiate arbitrary objects are rejected.
- Prototype-pollution keys (`__proto__`, `constructor`, `prototype`) are
  stripped from the parsed structure before normalization.
- Labels and other strings are rendered as text, never as HTML, downstream.
