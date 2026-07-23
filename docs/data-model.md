# Data Model

The `Graph` object is the single source of truth for the Layers application. All
three layers read from it; Layer 2 and 3 add computed fields; the ABM companion
writes validation results back onto it. Everything downstream is an annotation
on top of this graph, never a parallel structure.

Source: [`src/model/types.ts`](../src/model/types.ts).

## Node

```ts
Node {
  id: string
  label: string
  type: "stock" | "flow" | "auxiliary"   // stock-flow semantics, not just a CLD box
  tioe_class: "T" | "I" | "OE" | "none"  // Layer 3 tag
  initial_value: number
  unit: string
  collar?: Collar                         // physical bounds, same units as initial_value
  agent_binding?: AgentRuleRef           // present only if this node has an ABM companion
  pin?: { x: number; y: number }         // manual layout pin (view-derived, but persists)
  abm_verdict?: AbmVerdict               // written by the ABM companion (Phase 5)
}

Collar {
  lower?: number     // physical lower bound; engine clamps value to >= lower
  upper?: number     // physical upper bound; engine clamps value to <= upper
  approach?: "hard" | "soft"   // hard (default) clips; soft ramps (Phase 7)
}
```

`type` uses stock-flow semantics rather than a generic CLD box, because the
simulation engine treats stocks as accumulators and flows as rates. Collars are
physical bounds enforced inside the engine (`src/sim/engine.ts`): the value is
clamped after the derivative is computed, with anti-windup (excess does not
accumulate) and reject-and-backpressure (excess returns to delay queues). A
collar is a fact about the system in the system's own units — not a display
clamp. Legacy flat `lower_collar`/`upper_collar` fields (normalized [0,1]) are
rejected at parse time with `collar_ambiguous_units`; authors must restate them
in the `collar:` block with physical units.

## Edge

```ts
Edge {
  id: string
  source: NodeId
  target: NodeId
  polarity: "+" | "-"
  delay: {
    type: "none" | "material" | "information" | "perception"
    magnitude: number        // in model time units
  }
  strength: number           // relative influence weight, for simulation
  range?: EdgeRange           // authored uncertainty (Phase 8 sampler; not engine-enforced)
}

EdgeRange {
  strength?: [number, number]         // [min, max] range for the edge's strength
  delay_magnitude?: [number, number]  // [min, max] range for delay.magnitude
}
```

## Loop (computed, never authored)

```ts
Loop {
  id: string
  nodes: NodeId[]
  edges: EdgeId[]
  sign: "reinforcing" | "balancing"   // product of edge polarities
  dominant_delay: number              // max delay in the loop
  cycle_time: number                  // sum of delays around the loop
}
```

Loops are derived via cycle enumeration (DFS, Johnson's algorithm for larger
graphs). An even number of `-` edges → `reinforcing`; odd → `balancing`. The
parser always emits `loops: []` and rejects any authored `loops:` section —
loops appear only after `src/graph` computes them.

## Graph

```ts
Graph {
  nodes: Node[]
  edges: Edge[]
  loops: Loop[]   // derived, never hand-authored
}
```

## Invariants (enforced by `validate`)

Validation collects **every** violation before failing, so authors can fix all
problems in one pass. A `Graph` is valid iff `validate(graph)` returns `[]`.

| Code | Rule |
|---|---|
| `duplicate_node_id` | node ids are unique |
| `duplicate_edge_id` | edge ids are unique |
| `edge_unknown_source` / `edge_unknown_target` | edges reference existing nodes |
| `edge_self_loop` | an edge's source and target differ |
| `duplicate_edge` | no two edges share the same `source -> target` pair |
| `invalid_node_type` / `invalid_tioe_class` | enums respected |
| `invalid_polarity` / `invalid_delay_type` | enums respected |
| `negative_delay` / `negative_strength` | magnitudes and weights are non-negative |
| `loop_sign_mismatch` | if loops are carried at load time, their sign must match edge polarities |

See [`src/model/validate.ts`](../src/model/validate.ts) for the implementation.
