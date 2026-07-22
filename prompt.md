# Layered Constraint Visualization — Architecture Spec

## 0. Design Philosophy

Three layers, one canvas, one companion view:

1. **Layer 1 (CLD substrate)** — the system as drawn: loops, polarity, delays.
2. **Layer 2 (constraint overlay)** — the system as scored: where a constraint is likely sitting, and why.
3. **Layer 3 (T/I/OE overlay)** — the system as valued: what moving the constraint does financially.
4. **Companion view (ABM)** — the system as generated: do agent-level rules actually reproduce the loop you drew?

Layers 1–3 share one data model and one canvas — they are views over the same graph, not separate diagrams. The companion view is deliberately *not* a fourth overlay. It's stochastic and only meaningful over a run, while 1–3 are deterministic and meaningful at a glance. Flattening that distinction would be a modeling error, not just a UI choice. It opens from a node, runs independently, and reports back whether the macro structure held, weakened, or bifurcated — which either validates Layer 1 or flags that its assumed polarity/delay was wrong.

Core principle throughout: **compute, don't just draw.** Loops, constraint scores, and T/I/OE deltas should all be derived from the graph, not manually annotated — so the diagram stays live as the model changes.

---

## 1. Core Data Model

This is the single source of truth. All three layers read from it; Layer 2 and 3 add computed fields; the ABM companion writes validation results back onto it.

```
Node {
  id: string
  label: string
  type: enum [stock, flow, auxiliary]      // stock-flow semantics, not just CLD box
  tioe_class: enum [T, I, OE, none]         // Layer 3 tag
  initial_value: number
  unit: string
  agent_binding?: AgentRuleRef              // present if this node has an ABM companion
}

Edge {
  id: string
  source: NodeId
  target: NodeId
  polarity: enum [+, -]
  delay: {
    type: enum [none, material, information, perception]
    magnitude: number        // in model time units
  }
  strength: number            // relative influence weight, for simulation
}

Loop {                        // COMPUTED, not authored
  id: string
  nodes: NodeId[]
  edges: EdgeId[]
  sign: enum [reinforcing, balancing]   // product of edge polarities
  dominant_delay: number                // max delay in the loop
  cycle_time: number                    // sum of delays around the loop
}

Graph {
  nodes: Node[]
  edges: Edge[]
  loops: Loop[]              // derived via cycle enumeration, see §2
}
```

Everything downstream — constraint scores, T/I/OE deltas, ABM validation flags — is an *annotation* on top of this graph, never a parallel structure. This is what keeps the three layers from drifting out of sync with each other.

---

## 2. Layer 1 — CLD Substrate

**Input:** user-authored nodes and edges (graph editor, or imported from a simple text/YAML DSL — recommend authoring in a DSL first, rendering second, since Jayanth's stated preference is to think architecturally before building).

**Computed:**
- **Cycle enumeration** — Johnson's algorithm (or simple DFS for graphs under ~50 nodes, which this will be) to find all elementary cycles.
- **Loop sign** — product of edge polarities around the cycle. Even number of `-` edges → reinforcing; odd → balancing.
- **Cycle time** — sum of edge delays around the loop. This becomes critical input to Layer 2.

**Render:**
- Directed graph, force-directed or manually pinned layout (allow both — auto-layout for exploration, manual pin for the version that goes in the essay/deck).
- Loops highlighted on hover/select, labeled R1/R2/B1/B2 automatically.
- Delay edges rendered with a double-hash mark; delay magnitude shown as edge thickness or a small numeric badge.

**Library recommendation:** D3.js for full control over loop highlighting and custom edge rendering (delay marks, polarity signs) — Cytoscape.js is a reasonable alternative if graph-analysis features (built-in cycle detection) matter more than bespoke visual control.

---

## 3. Layer 2 — Constraint Positioning Overlay

Not a separate diagram — a heat overlay on Layer 1. Same nodes, same edges, colored/sized by a computed constraint score.

**Constraint score per node**, a weighted function of:

| Signal | Rationale |
|---|---|
| In-degree (loop membership count) | Nodes where many loops converge are natural bottlenecks |
| Max incident delay | Long delays relative to surrounding loop cycle-times cause pile-up |
| Upstream/downstream rate mismatch | Fast reinforcing loop feeding a slow balancing loop is where inventory or oscillation builds |
| Position in dominant loop | Nodes in the loop with the longest cycle-time score higher |

```
score(node) = w1 * norm(in_degree)
            + w2 * norm(max_delay / avg_loop_cycle_time)
            + w3 * norm(rate_mismatch_at_node)
            + w4 * norm(dominant_loop_membership)
```

Weights (`w1..w4`) should be exposed as sliders in the UI, not hardcoded — the "right" constraint definition varies by system, and Jayanth will want to test sensitivity (which is itself a small dynamical-systems point: constraint identity can be a function of parameter regime, not a fixed fact about the graph).

**Render:** heat-map coloring on existing Layer 1 nodes (no new shapes), plus a ranked side-panel listing top-3 candidate constraints with their score breakdown, so the "why[118;1:3u" is inspectable, not just the "where."

**Framing note worth keeping in the tool itself:** where two loops of mismatched cycle-time meet is often not just a bottleneck but a point where a small parameter shift can move the whole system into a different basin of attraction — oscillation instead of convergence, or vice versa. Worth a tooltip/annotation at high-score nodes rather than leaving it implicit.

---

## 4. Layer 3 — T/I/OE Overlay + Simulation

**Static part:** each node tagged `tioe_class` (Throughput / Investment-Inventory / Operating Expense / none), rendered as a color band or icon on Layer 1 nodes — again, overlay not new diagram.

**Dynamic part (the actual payoff):** a lightweight stock-flow simulation engine underneath, so that shifting a parameter at the Layer-2-identified constraint produces a *simulated* T/I/OE trajectory, not a static delta.

- Engine: simple Euler or RK4 integration over the stock-flow structure implied by Layer 1's nodes/edges (stocks accumulate, flows are rates, delays are modeled as first-order exponential delays or fixed pipeline delays depending on `delay.type`).
- Output: time-series for T, I, OE pre- and post-intervention, rendered as small multiples (three sparklines) next to the graph, not a big dashboard — keep it a thinking tool, not a report generator.
- Explicitly **do not** build this into a full financial model. Attribution + simulated directional delta is the right scope; the moment it aims for precision it stops being useful for architectural thinking and turns into a spreadsheet with extra steps.

---

## 5. Companion View — Agent-Based Model

Opens from any node as a separate pane/modal, not an overlay. Purpose: check whether the macro loop was actually assumed correctly, by seeing if it emerges from micro rules.

```
AgentPopulation {
  bound_node: NodeId
  agent_count: number
  rule: AgentRule            // e.g. reorder policy, capacity threshold, info-passing delay
  interaction_topology: enum [well-mixed, lattice, network]
}

AgentRule {
  state_vars: KeyValue[]
  update_fn: string           // simple DSL or JS snippet — local rule only, no global knowledge
  perturbation_params: KeyValue[]   // exposed as sliders for "what if this agent behaved differently"
}
```

**Workflow:**
1. Pick a node from Layer 1 (e.g., "Order backlog").
2. Define a small agent population whose local rule should, in aggregate, reproduce that node's behavior and its role in the loop.
3. Run the simulation (schooling-fish-style: simple local rules, emergent aggregate pattern — same idea, applied to reorder policies or capacity thresholds instead of separation/alignment/cohesion).
4. **Validation output:** does the aggregate time-series match the polarity/delay assumed in Layer 1?
   - **Match** → Layer 1's assumption is validated.
   - **Mismatch** → flag on the Layer 1 node/edge: "assumed delay/polarity not reproduced by agent rules — reconsider."
5. **Perturbation:** change one agent-level rule parameter, re-run, and check whether the *macro* loop structure holds, weakens, or bifurcates (e.g., convergence → sustained oscillation). This is the most valuable output of the whole companion view — it shows which micro-level changes are capable of moving the system across a basin boundary, versus which just perturb within the same basin.

**Library recommendation:** keep this dead simple initially — a canvas-based agent simulation (vanilla JS or a minimal library like `flocking.js`-style custom code) rather than pulling in a heavy ABM framework (Mesa/NetLogo-equivalent) for a v1. Complexity can be added once the validation loop itself is proven useful.

---

## 6. Interaction Model

- Single canvas for Layers 1–3, toggled via a layer switcher (not simultaneous — one active overlay at a time, to keep it a thinking tool rather than a cluttered dashboard).
- Layer 2 weights and Layer 3 intervention parameters live in a side panel, always visible, since these are the "what if" controls Jayanth will actually manipulate.
- Companion view is a distinct pane — click a node → "Run agent validation" → new panel/modal, results reported back as an annotation on the Layer 1 node (small icon: validated / flagged).
- Everything is derived from the one `Graph` object — no separate state per layer.

---

## 7. Suggested Tech Stack

| Concern | Recommendation |
|---|---|
| Graph rendering | D3.js (force-directed + manual pin) |
| Data model | Plain JS objects / TypeScript interfaces per §1 |
| Authoring | Simple YAML/JSON DSL for nodes+edges, parsed into the Graph model — author structure before wiring visuals |
| Loop detection | Custom DFS cycle enumeration (graph size is small; no need for a heavy graph library) |
| Stock-flow sim | Custom Euler/RK4 integrator, ~100 lines |
| ABM companion | Vanilla canvas + custom local-rule engine |
| UI shell | React, single page, layer-switcher + side panel |

Small enough in scope that this doesn't need a backend — everything can run client-side, in-memory, with the Graph model as the only persisted artifact (JSON export/import so a session can be saved and reopened).

---

## 8. Build Phases (for Claude Code handoff)

1. **Data model + DSL parser** — get Graph{} loading from a hand-authored YAML file.
2. **Layer 1 renderer** — static graph, computed loops, delay marks, R/B labels.
3. **Layer 2 overlay** — constraint scoring + heat coloring + ranked panel, weights as sliders.
4. **Layer 3 overlay + sim engine** — T/I/OE tagging, stock-flow integrator, sparkline output on intervention.
5. **Companion ABM view** — agent population authoring, run, validation flag written back to Layer 1.
6. **Polish** — layer switcher, session save/load, weight sensitivity UI.

Recommend building and validating phase-by-phase rather than all at once — each phase is independently useful even if later ones stall, and Layer 1 alone (a live, computed loop diagram) is already a legitimate deliverable on its own.
