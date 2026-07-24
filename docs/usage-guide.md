# Usage Guide

A complete walkthrough of Layers — from authoring a graph to running each
overlay and the ABM companion view. The app is a client-side SPA; everything
runs in the browser with no backend.

---

## Table of Contents

1. [Quick Start](#1-quick-start)
2. [Authoring a Graph](#2-authoring-a-graph)
3. [Layer 1 — Causal Loop Diagram](#3-layer-1--causal-loop-diagram)
4. [Layer 2 — Constraint Overlay](#4-layer-2--constraint-overlay)
5. [Layer 3 — T/I/OE Simulation](#5-layer-3--tioe-simulation)
6. [ABM Companion View](#6-abm-companion-view)
7. [Layer Switcher](#7-layer-switcher)
8. [Session Save / Load](#8-session-save--load)
9. [Keyboard & Accessibility](#9-keyboard--accessibility)
10. [Programmatic API](#10-programmatic-api)

---

## 1. Quick Start

```bash
npm ci          # install dependencies
npm run dev     # start the Vite dev server at http://localhost:5173
```

Open the URL in a browser. The app loads the **beer-distribution** fixture
automatically — a classic bullwhip supply-chain model with six nodes, seven
edges, and two reinforcing loops.

Other useful commands:

```bash
npm run typecheck   # tsc --noEmit (strict mode)
npm run lint        # eslint
npm test            # vitest — 335 unit tests
npm run build       # production build → dist/ (~70 KB gzipped + 2 KB worker)
```

---

## 2. Authoring a Graph

Graphs are authored in YAML (or JSON) **before** any visuals are wired up.
This keeps the focus on structure, not layout. See
[`docs/dsl-reference.md`](./dsl-reference.md) for the full grammar and
[`public/examples/beer-distribution.yaml`](../public/examples/beer-distribution.yaml)
for a working fixture.

### Minimal Example

```yaml
nodes:
  - id: backlog
    label: Order Backlog
    type: stock
    initial_value: 0
    unit: units

  - id: orders
    label: Order Rate
    type: flow
    boundary: true
    initial_value: 100
    unit: units/week

edges:
  - id: e1
    source: orders
    target: backlog
    polarity: +
    delay: { type: material, magnitude: 4 }
    strength: 1
```

### Key Rules

| Rule | Why |
|---|---|
| `id` fields must be unique | the validator rejects duplicates |
| `loops` is **never authored** | loops are computed from edges (Johnson's algorithm) |
| `polarity` is `+` or `-` | even number of `-` edges around a cycle → reinforcing (R); odd → balancing (B) |
| `delay.magnitude` must be ≥ 0 | measured in model time units |
| `boundary: true` marks the system's ports | T/I/OE are derived from the boundary + topology, not hand-authored. Nodes with no incoming edges are auto-detected as boundary. |
| `type` is `stock`, `flow`, or `auxiliary` | stocks accumulate; flows are rates; auxiliaries are conduits |

### Defaults

Omitted fields get sensible defaults: `type` → `auxiliary`, `boundary` →
auto (exogenous nodes auto-detected), `initial_value` → `0`, `polarity` → `+`, `strength` → `1`,
`delay` → `{ type: none, magnitude: 0 }`.

### Validation

The parser collects **all** violations in one pass (not just the first). Call
`parseGraph(input)` to get `{ graph, issues }` without throwing, or
`parseGraphOrThrow(input)` to throw a `ParseError` carrying the structured
issue list.

---

## 3. Layer 1 — Causal Loop Diagram

Layer 1 is the base view: a force-directed graph rendered with D3. It is
always visible underneath the other layers.

### What You See

- **Nodes** — circles labeled with the node's `label`. Pinned nodes have a
  thicker border.
- **Edges** — straight arrows from source to target with a polarity symbol
  (`+` or `−`) at the midpoint.
- **Delay marks** — edges with `delay.type ≠ none` and `magnitude > 0` are
  decorated with a **double-hash mark** (two short perpendicular strokes) and
  a small numeric badge showing the delay magnitude.
- **Loop labels** — `R1`, `R2`, `B1`, etc. placed at each loop's centroid.
  Reinforcing loops are green; balancing loops are red.

### Interactions

| Action | Effect |
|---|---|
| **Drag a node** | Moves it; the position is persisted as a `pin` on the node (survives save/load). The force simulation resumes briefly. |
| **Hover a node** | Highlights the first loop the node belongs to — only that loop's edges and nodes stay bright; everything else dims. |
| **Hover a loop label** | Highlights that specific loop. |
| **Pan** | Click and drag the background. |
| **Zoom** | Mouse wheel or trackpad scroll. Scale range: 0.2×–4×. |
| **Double-click background** | Resets zoom (does not re-layout). |

### How Loops Are Computed

Loops are derived via Johnson's algorithm for elementary cycle enumeration
(`src/graph/cycles.ts`). Each cycle is annotated with:

- **Sign** — XOR of edge polarities around the cycle.
- **Cycle time** — sum of edge delays.
- **Dominant delay** — maximum single-edge delay in the loop.

Loop IDs (`R1`, `B1`, …) are assigned deterministically: reinforcing and
balancing loops are numbered separately, ordered by their canonical node
sequence. The same graph always produces the same IDs.

---

## 4. Layer 2 — Constraint Overlay

Layer 2 is a **heat overlay** on Layer 1 — same nodes and edges, colored and
sized by a computed constraint score. It answers: *where is a bottleneck
likely sitting, and why?*

### The Score

Each node gets a score in `[0, 1]` — a weighted sum of four signals:

| Signal | What it measures | Why it matters |
|---|---|---|
| **Loop membership** (`w1`) | Number of loops the node belongs to | Nodes where many loops converge are natural bottlenecks |
| **Delay ratio** (`w2`) | Max incident delay ÷ average loop cycle time | Long delays relative to surrounding loops cause pile-up |
| **Rate mismatch** (`w3`) | Gap between avg reinforcing and avg balancing loop cycle times at the node | Where a fast reinforcing loop meets a slow balancing loop, inventory or oscillation builds |
| **Dominant-loop share** (`w4`) | Node's max loop cycle time ÷ global max loop cycle time | Nodes in the loop with the longest cycle time score higher |

The final score is normalized by the weight sum, so **only the ratios between
weights matter** — scaling all weights by a constant leaves scores unchanged.

### The Side Panel

The panel (top right) shows:

1. **An on/off toggle** for the overlay.
2. **Four weight sliders** — drag to re-weight the signals. Scores recompute
   live (debounced to 80 ms) without re-running the force layout.
3. **Top-3 ranked constraints** — each card shows:
   - Rank (`#1`, `#2`, `#3`)
   - Score chip (colored by the heat scale)
   - Node label
   - Per-signal breakdown: each contribution (normalized) and raw value, so the
     "why" is inspectable.

### Visual Encoding

- **Color** — heat scale from cool blue (low score) to red (high score).
- **Size** — node radius scales from 0.85× to 1.5× of the base radius.
- **Ranking** — the side panel's textual order.

Score is conveyed by **three channels** (color, size, ranking), not color
alone — per the accessibility spec.

### Default Behavior

With default equal weights, the beer-distribution fixture ranks
**`wholesaler_orders`** as the #1 constraint — the node where the bullwhip
amplification is most pronounced.

---

## 5. Layer 3 — T/I/OE Simulation

Layer 3 adds a lightweight stock-flow simulation engine. It answers: *what
happens to Throughput, Investment-Inventory, and Operating Expense if I shift
a parameter at the identified constraint?*

### What It Computes

The integrator (`src/layer3/integrator.ts`) steps through the graph's
stock-flow structure:

- **Stocks** accumulate net flow.
- **Flows** are rates (conduits, not accumulators).
- **Delayed edges** are modeled as first-order exponential delays — a state
  variable per delay with `dx/dt = (input − x) / τ`, where `τ` is the delay
  magnitude. This conserves mass: every unit leaving a source enters a delay
  state and eventually arrives at the target.

Two integrators are available:

| Method | Order | When to use |
|---|---|---|
| **RK4** (default) | 4th-order Runge-Kutta | Higher accuracy; recommended for most cases. Conserves mass to ~1e-13 on a closed system. |
| **Euler** | 1st-order | Faster per step but less accurate on stiff systems. Useful for quick directional checks. |

### The Side Panel

The panel (bottom right) shows:

1. **Intervention node selector** — defaults to the Layer 2 top-ranked
   constraint.
2. **Intervention Δ slider** — the scalar shift applied to the node's value
   at `t = 0` (range −200 to +200).
3. **Step size (dt)** — integration step in model time units (0.01–1.0).
4. **Steps** — number of integration steps (50–2000).
5. **Integrator method** — Euler or RK4 toggle buttons.
6. **Three sparklines** (T, I, OE) — each shows the **pre** (grey) and
   **post** (blue) intervention trajectory on a shared y-axis, with an
   end-of-run delta badge (`Δ +12.3` or `Δ −5.7`).

### Important Caveat

Per the spec, this is **simulated directional delta only** — not a financial
model. The moment it aims for precision it stops being useful for
architectural thinking. The sparklines show *which way things move*, not exact
dollar amounts.

---

## 6. ABM Companion View

The ABM (Agent-Based Model) companion is a **separate pane**, not an overlay.
It opens from the layer switcher and answers: *do agent-level rules actually
reproduce the loop you drew?*

### What It Does

1. You author a population of agents bound to a node.
2. Each agent runs a simple local rule (no global knowledge).
3. The engine aggregates the agent state over time.
4. The validator compares the aggregate's macro behavior (reinforcing vs
   balancing) and response lag against the bound node's loops.
5. The verdict is written back onto the `Node.abm_verdict` field (single
   source of truth).

### Rule Vocabulary

Three fixed rules (no arbitrary code execution — per the security spec):

| Rule | Expected behavior | How it works |
|---|---|---|
| **Reorder policy** | Reinforcing (amplifying) | Each agent orders `sensitivity × backlog`. Backlog grows with the global mean order — classic bullwhip. |
| **Capacity threshold** | Balancing (converging) | Agents below threshold produce; agents above consume. Coupled to neighbors' mean. Converges to equilibrium. |
| **Info-passing delay** | Balancing (lagged) | Agents pass a value to neighbors after `delay` steps via a history queue. Shows lagged propagation. |

### Topologies

| Topology | Description |
|---|---|
| **Well-mixed** | Every agent sees every other (global coupling). |
| **Lattice** | Ring: each agent sees its two immediate neighbors. |
| **Network** | Fixed random graph: each agent connects to 3 random others (deterministic from the seed). |

### The Panel

1. **Bound node** — the Layer 1 node being validated.
2. **Rule** — dropdown (reorder / capacity / info-passing).
3. **Topology** — dropdown (well-mixed / lattice / network).
4. **Sensitivity** slider (0–3) — gain for reorder, threshold for capacity.
5. **Delay** slider (0–10 steps) — for info-passing.
6. **Agent count** slider (100–10,000).
7. **Seed** slider (0–999) — drives the deterministic PRNG.
8. **Run validation** button — runs the ABM (in a Web Worker) and reports the
   verdict.
9. **Perturbation Δsensitivity** slider + **Perturb & re-run** button — shifts
   the sensitivity by the slider amount, re-runs, and compares to the baseline.

### Validation Output

| Verdict | Meaning |
|---|---|
| **Validated** (green) | The aggregate's macro behavior matches the bound node's loop polarity, and the response lag is within 2× of the loop's cycle time. |
| **Flagged** (red) | Mismatch — either the polarity doesn't match (e.g. a balancing rule on a reinforcing loop) or the delay is off. The detail text explains which. |

### Perturbation Verdict

After a baseline run, perturbing a parameter and re-running produces a macro
stability verdict:

| Verdict | Meaning |
|---|---|
| **Held** | Same macro behavior (reinforcing stays reinforcing, etc.) with similar magnitude. The system is in the same basin. |
| **Weakened** | Same behavior but materially less pronounced — slower amplification, or convergence with more residual oscillation. |
| **Bifurcated** | Behavior flipped — convergence became amplification or vice versa. A micro-level change moved the system across a basin boundary. |

This is the most valuable output of the companion view: it shows which
agent-level changes are capable of moving the whole system into a different
regime.

### Determinism

The engine uses a seeded mulberry32 PRNG. Same `(population, seed, steps)`
always produces the identical aggregate series. Change the seed to get a
different stochastic realization; change a parameter to test sensitivity.

### Performance

The ABM runs in a **Web Worker** so the main thread stays responsive. A
10,000-agent / 100-step run completes in well under 5 seconds. The worker is
bundled as a separate ~2 KB chunk.

---

## 7. Layer Switcher

The switcher (top left) enforces **one active overlay at a time** — per the
spec, Layers 1–3 are views over the same graph, not simultaneous diagrams.

| Tab | What it shows |
|---|---|
| **L1: CLD** | The base causal loop diagram with no overlay. |
| **L2: Constraints** | Heat coloring + the constraint side panel. |
| **L3: T/I/OE** | The simulation side panel with sparklines. |
| **ABM** | The agent-based model companion pane. |

Switching to a layer disables all others. Layer 1 (the CLD itself) is always
visible underneath — the overlays color/annotate it, they don't replace it.

---

## 8. Session Save / Load

The **Save session** and **Load session** buttons (bottom left) persist and
restore the full application state.

### What Is Saved

A session JSON file contains:

```json
{
  "version": 1,
  "graph": { "nodes": [...], "edges": [...], "loops": [...] },
  "weights": { "in_degree": 1, "delay_ratio": 1, "rate_mismatch": 1, "dominant_loop": 1 },
  "savedAt": "2026-07-22T12:00:00.000Z"
}
```

- **Graph** — all nodes (including manual pins and ABM verdicts), edges, and
  computed loops.
- **Weights** — the Layer 2 slider values at save time.
- **savedAt** — ISO timestamp.

### Loading

When you load a session file:

1. The JSON is parsed and prototype-pollution keys (`__proto__`,
   `constructor`, `prototype`) are stripped recursively.
2. The graph is validated structurally.
3. Loops are re-derived from edges (they are computed, never trusted from
   the file).
4. The canvas re-renders, the Layer 2 panel picks up the saved weights, and
   the Layer 3 panel resets to the first node.

### Round-Trip Guarantees

`loadSession(saveSession(graph, weights))` is lossless: the reloaded graph and
weights are deep-equal to the originals. ABM verdicts written onto nodes are
preserved.

---

## 9. Keyboard & Accessibility

- **Tab** — moves focus through all interactive controls (layer switcher
  tabs, sliders, buttons, selects) in document order.
- **`:focus-visible`** — every interactive element shows a 2px blue focus
  outline when reached via keyboard.
- **ARIA roles** — the layer switcher is a `role="tablist"` with `role="tab"`
  children; the canvas has `role="img"` with an `aria-label`; side panels have
  `aria-label`; the IO bar is `role="toolbar"`.
- **Color is never the sole encoding** — Layer 2 heat uses color + node size
  + the ranked side panel; Layer 3 sparklines use color + line position + delta
  badges; ABM verdicts use color + text status.

---

## 10. Programmatic API

All core logic is in framework-agnostic, unit-tested modules. You can use them
without the UI.

### Parse and validate a graph

```typescript
import { parseGraphOrThrow } from "@/dsl/parser";
import { withComputedLoops } from "@/graph/loops";

const graph = withComputedLoops(parseGraphOrThrow(yamlString));
console.log(graph.loops); // [{ id: "R1", sign: "reinforcing", cycle_time: 11, ... }]
```

### Score constraints

```typescript
import { scoreGraph, DEFAULT_WEIGHTS } from "@/layer2/scoring";

const { ranked } = scoreGraph(graph, DEFAULT_WEIGHTS);
console.log(ranked[0]); // { nodeId: "wholesaler_orders", score: 0.87, ... }
```

### Run a simulation

```typescript
import { simulate } from "@/layer3/simulate";

const result = simulate(graph, {
  intervention: { nodeId: "wholesaler_orders", delta: 50 },
  integrator: { dt: 0.1, method: "rk4" },
  steps: 200,
});
console.log(result.pre.series);  // [{ T: 100, I: 0, OE: 100 }, ...]
console.log(result.post.series); // [{ T: 150, I: 0, OE: 100 }, ...]
```

### Run the ABM

```typescript
import { runAbm } from "@/abm/engine";
import { validateAbm } from "@/abm/validate";

const result = runAbm(
  {
    boundNode: "wholesaler_orders",
    agentCount: 1000,
    rule: "reorder_policy",
    topology: "well_mixed",
    params: { sensitivity: 1.5, delay: 1 },
    seed: 42,
  },
  300,
);
const verdict = validateAbm({ graph, result });
console.log(verdict); // { status: "validated", detail: "...", macro: "held" }
```

### Save and load a session

```typescript
import { saveSession, loadSession } from "@/io/session";

const json = saveSession(graph, weights);
const session = loadSession(json);
// session.graph and session.weights are deep-equal to the originals
```

---

## Further Reading

- [`docs/dsl-reference.md`](./dsl-reference.md) — full YAML/JSON authoring grammar
- [`docs/data-model.md`](./data-model.md) — the `Graph` types and invariants
- [`docs/contributing.md`](./contributing.md) — branch model and Definition of Done
- [`PLAN.md`](../PLAN.md) — development plan, testing, and deployment strategy
- [`prompt.md`](../prompt.md) — the original architecture spec
