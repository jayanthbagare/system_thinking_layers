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
| `tioe_class` | no | `T` \| `I` \| `OE` \| `none` | `none` |
| `initial_value` | no | number | `0` |
| `unit` | no | string | `""` |
| `lower_collar` | no | number (0–1) | omitted (no lower clamp) |
| `upper_collar` | no | number (0–1) | omitted (no upper clamp) |
| `agent_binding` | no | `{ rule_id: string }` | omitted |
| `pin` | no | `{ x: number, y: number }` | omitted (auto-layout) |

## Edge fields

| Field | Required | Type | Default |
|---|---|---|---|
| `id` | yes | string | — |
| `source` | yes | node id | — |
| `target` | yes | node id | — |
| `polarity` | no | `+` \| `-` | `+` |
| `delay` | no | object (below) | `{ type: none, magnitude: 0 }` |
| `strength` | no | number | `1` |

### Delay object

| Field | Type | Values |
|---|---|---|
| `type` | `none` \| `material` \| `information` \| `perception` | |
| `magnitude` | number (>= 0) | model time units |

A shorthand is also accepted on the edge itself for terseness:

```yaml
- id: e1
  source: a
  target: b
  delay_type: material
  delay_magnitude: 4
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
