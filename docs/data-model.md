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
  boundary?: boolean                      // system boundary: the node is the system's port to its environment
  initial_value: number
  unit: string
  collar?: Collar                         // physical bounds, same units as initial_value
  capacity_cost?: number                  // OE the constrained resource consumes (fixed; Phase 4)
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

`capacity_cost` is the operating expense a constrained resource consumes per
unit of model time, regardless of utilization — the cost of *having* the
capacity. When present, `deriveTioe` counts it (fixed) as that node's OE
contribution, so **Exploit** (which keeps the collar fixed) holds OE flat and
**Elevate** (which moves the collar) raises OE proportionally. When absent, OE
falls back to the flow through the collared stock (the Phase 3 utilization
proxy). See the typed interventions in `src/layer3/intervention.ts`.

`boundary` marks a node as the system's interface with its environment (market
demand, supplier inputs, customer outputs). When no node has `boundary: true`,
the boundary is auto-derived: nodes with no incoming edges (exogenous drivers)
are treated as boundary. T/I/OE are **derived** from the boundary + topology
(see `deriveTioe` in `src/sim/engine.ts`), not hand-authored via a `tioe_class`
tag. Legacy `tioe_class` fields are rejected at parse time with
`tioe_class_deprecated`.

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
| `invalid_node_type` / `invalid_boundary` | enums / boolean respected |
| `tioe_class_deprecated` | legacy `tioe_class` field present — use `boundary` instead |
| `invalid_polarity` / `invalid_delay_type` | enums respected |
| `negative_delay` / `negative_strength` | magnitudes and weights are non-negative |
| `loop_sign_mismatch` | if loops are carried at load time, their sign must match edge polarities |

| `collar_ambiguous_units` | legacy flat collar fields present, or non-numeric collar bounds |
| `collar_lower_above_upper` | `collar.lower < collar.upper` when both set |
| `collar_initial_out_of_range` | `lower <= initial_value <= upper` when bounds set |
| `collar_invalid_approach` | `collar.approach` is `"hard"` or `"soft"` |
| `capacity_cost_negative` | `capacity_cost` is a non-negative number |
| `range_invalid` | authored `range` pairs are `[min, max]` with `min <= max` |

See [`src/model/validate.ts`](../src/model/validate.ts) for the implementation.

## Layer 3 — typed ToC interventions (Phase 4)

With physical collars in place, the three Theory-of-Constraints interventions
are exact collar operations (see `src/layer3/intervention.ts`):

| Type | Collar operation | Expected signature |
|---|---|---|
| **Exploit** | Close the gap to the *existing* upper collar; the collar does not move. Capped at available headroom; disabled at zero headroom. | T up, OE flat, I flat-or-down |
| **Subordinate** | Add a rope — a negative-polarity information edge from a downstream buffer to the upstream release flow (a structural edit). | I down sharply, T flat, OE flat |
| **Elevate** | Move the upper collar up; the capacity cost (OE) is scaled proportionally. | T up, OE up, I up |

Each intervention runs as a pre/post pair over the same engine; the panel shows
the expected vs observed signature (disagreements are flagged), the TA decision
ratios (ΔT/ΔOE, ΔT/ΔI, ΔT per unit of constraint time, payback horizon), the
J-curve (worse-before-better depth and duration), and the degrees-of-freedom
change. The L1 canvas nudge remains a raw impulse probe (the Phase 1 bridge),
separate from the typed selector.

## Layer 2 — constraint migration: predicted vs observed (Phase 5)

Step 5 of the Five Focusing Steps is "go back to step 1." After an intervention
the constraint relocates. Layer 2 now shows two constraint identities:

- **Predicted** — L2's #1 ranked node from the structural score (a heuristic).
- **Observed** — the node with the highest fraction of run time pinned at its
  upper collar under current load (a dynamical measurement).

Agreement is earned confidence in the heuristic. Disagreement is the finding,
stated plainly — the score is weighting structure the dynamics do not bear out.
The score is **never auto-corrected** to match the observation (spec §5.1).

When an intervention is **applied** (L3 → Apply button), it is persisted to the
working graph and a migration step is recorded. The step captures the predicted
and observed constraint before and after, plus ΔT, ΔOE, ΔDoF. The migration
trail (see `src/layer2/migration.ts`) renders compactly in the L2 panel, with
dashed arcs drawn on the L1 canvas from the previous constraint to the new,
faded by recency.

**Cycle detection** fires when the observed constraint returns to a node already
in the trail: *"Cycle detected: two elevations, net ΔT ≈ 0, ΔOE +X. The
constraint returned to where it started."* This is the payload of the whole
feature — the most under-internalised idea in ToC.
