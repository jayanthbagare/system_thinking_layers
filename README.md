# Layers — A Complete Beginner's User Guide

This guide assumes you have never used a system-dynamics tool before. Every
term is explained in plain language, and every screen is described step by
step.

---

## Table of Contents

1. [What Is Layers?](#1-what-is-layers)
2. [Plain-Language Glossary](#2-plain-language-glossary)
3. [Installing and Starting the App](#3-installing-and-starting-the-app)
4. [Tour of the Main Screen](#4-tour-of-the-main-screen)
5. [The Built-In Example: Beer Distribution](#5-the-built-in-example-beer-distribution)
6. [Layer 1 — The Causal Loop Diagram](#6-layer-1--the-causal-loop-diagram)
7. [Layer 2 — Finding the Bottleneck](#7-layer-2--finding-the-bottleneck)
8. [Layer 3 — The "What-If" Simulation](#8-layer-3--the-what-if-simulation)
9. [ABM — Checking Your Assumptions](#9-abm--checking-your-assumptions)
10. [Saving and Loading Your Work](#10-saving-and-loading-your-work)
11. [Authoring Your Own Model](#11-authoring-your-own-model)
12. [Keyboard and Accessibility](#12-keyboard-and-accessibility)
13. [Frequently Asked Questions](#13-frequently-asked-questions)

---

## 1. What Is Layers?

**Layers is a thinking tool for understanding how systems behave over time.**

A "system" here means anything made of parts that influence each other — a
supply chain, a team's workflow, an economy, an ecosystem. In such systems,
cause and effect chase each other in loops: A affects B, which affects C,
which circles back to A. These loops are what make systems hard to reason
about with your gut, because our brains are good at straight-line thinking
but bad at circular thinking.

Layers helps you:

1. **Draw** the system as a diagram of causes and effects.
2. **Find** where the bottleneck probably sits (the place a small change
   would have the biggest ripple).
3. **Simulate** what would happen to throughput, inventory, and cost if you
   changed that bottleneck.
4. **Check** whether your mental model is even right, by simulating
   individual agents (people, machines, warehouses) and seeing if their
   collective behavior matches the big picture you drew.

All of this runs in your browser. There is no server, no login, no
internet connection required after the page loads. Your data never leaves
your machine.

---

## 2. Plain-Language Glossary

Read this section once; you can come back to it whenever a term is
unfamiliar.

| Term                     | Plain-language meaning                                                                                                                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Node**                 | A thing in your system — a quantity, a rate, or a helper variable. Shown as a circle on the diagram. Examples: "Inventory," "Order Rate," "Customer Demand."                                                                                                                                           |
| **Edge**                 | An arrow from one node to another, meaning "the first influences the second."                                                                                                                                                                                                                          |
| **Polarity**             | Whether an influence is same-direction or opposite-direction. A `+` (plus) means "more of the source causes more of the target" (or less causes less). A `−` (minus) means "more of the source causes less of the target." Example: more demand → more orders is `+`; more price → less demand is `−`. |
| **Delay**                | How long it takes for an influence to take effect. If you order goods today but they arrive in 4 weeks, that edge has a delay of 4. Delays are shown as a **double-hash mark** (`//`) drawn in blue just past the arrow's midpoint, with a small blue number beside it showing how long. The number sits off to one side of the arrow so it never overlaps the `+`/`−` polarity chip at the midpoint.                                                                                             |
| **Loop**                 | A circular chain of cause and effect: A→B→C→A. The app finds these automatically — you never draw them yourself.                                                                                                                                                                                       |
| **Reinforcing loop (R)** | A loop that amplifies itself. More → more → more (growth), or less → less → less (decline). Shown in **green** with a label like `R1`, `R2`. Example: success → investment → more success.                                                                                                             |
| **Balancing loop (B)**   | A loop that counteracts itself, pushing toward a goal or equilibrium. Shown in **red** with a label like `B1`, `B2`. Example: high inventory → price cuts → sales → lower inventory.                                                                                                                   |
| **Cycle time**           | The total delay around a loop (sum of all edge delays in the loop). Long cycle-time loops respond slowly; short ones respond fast. When a fast loop feeds a slow one, oscillation and pile-ups happen.                                                                                                 |
| **Stock**                | A node that accumulates over time — like the water level in a tank. Examples: inventory, backlog, cash balance.                                                                                                                                                                                        |
| **Flow**                 | A node that is a rate of change — like the faucet filling the tank. Examples: order rate, production rate.                                                                                                                                                                                             |
| **Auxiliary**            | A helper node that is neither a stock nor a flow — just a converter or constant.                                                                                                                                                                                                                       |
| **Constraint**           | A bottleneck: a node where many loops converge and delays pile up. Moving a constraint tends to shift the whole system's behavior.                                                                                                                                                                     |
| **T / I / OE**           | Three financial-flavored categories for Layer 3: **T** = Throughput (revenue-generating rate), **I** = Investment / Inventory (tied-up resources), **OE** = Operating Expense (ongoing cost). These come from the Theory of Constraints.                                                               |
| **Heat overlay**         | Coloring the nodes by score — cool blue for low scores, red for high scores — so the likely bottleneck stands out visually.                                                                                                                                                                            |
| **Sparkline**            | A tiny line chart showing how a value changes over time. No axis labels; just the shape.                                                                                                                                                                                                               |
| **Signal**               | A pulse that travels along an edge carrying a value change. When you nudge a node, a signal rides every outgoing arrow; when it lands, the target node's value shifts and a fresh signal rides onward. This is the live "running the network" animation — reinforcing loops amplify the pulse, balancing loops dampen it. |
| **Nudge**                | A small push to a node's value via the ▲/▼ arrows that appear on hover. Up grows the value (positive direction); down shrinks it (negative direction). The signed change propagates to the next node and around the loop.                                                                              |
| **Value circle**         | The filled circle inside each node. Its radius encodes the node's current value (bigger = higher); its color encodes the direction of drift (green = above rest, red = below rest). Updates live as pulses circulate.                                                                                  |
| **Collar**               | A physical bound on a node's value, in the same units as `initial_value`. Authored as a `collar:` block with optional `lower` and `upper`. The simulation engine enforces it: the value is clamped at the boundary, with anti-windup (excess doesn't accumulate) and backpressure (excess stays in delay queues). A collar is a fact about the system — a real capacity limit that changes trajectories. Omit for an unbounded node. |
| **Node monitor**         | A right-side panel (L1 only) that plots node values over time as sparklines. In small graphs (< 7 nodes) all nodes are shown; in larger graphs a dropdown picks one. Lets you watch oscillation and amplification unfold as the live animation runs. |
| **Intervention**         | A hypothetical change you make to one node to see what would happen — "what if we doubled capacity here?"                                                                                                                                                                                              |
| **Agent**                | An individual actor in the system — one warehouse, one customer, one machine. The ABM view simulates many agents individually and sees what emerges in aggregate.                                                                                                                                      |
| **ABM**                  | Agent-Based Model. Instead of modeling the system as one big equation, you model many small agents with simple rules and watch the big-picture pattern emerge.                                                                                                                                         |
| **Perturbation**         | A small change to one agent-level parameter, to test whether the system's big-picture behavior is stable or fragile.                                                                                                                                                                                   |
| **Bifurcation**          | A tipping point: a small change causes the system to flip into a qualitatively different behavior (e.g., smooth convergence turns into wild oscillation).                                                                                                                                              |
| **YAML**                 | A simple text format for writing structured data. You author your model in a YAML file; the app reads it and draws the diagram.                                                                                                                                                                        |
| **Fixture**              | A ready-made example model. The app ships with one: the beer-distribution (bullwhip) model.                                                                                                                                                                                                            |

---

## 3. Installing and Starting the App

### Prerequisites

- **Node.js** (version 18 or newer) installed on your computer. Download it
  from <https://nodejs.org> if you don't have it.

### Steps

1. Open a terminal (Command Prompt / PowerShell on Windows, Terminal on
   macOS/Linux).

2. Navigate to the project folder:

   ```bash
   cd /path/to/layers
   ```

3. Install dependencies (only needed the first time, or after updating):

   ```bash
   npm ci
   ```

   This downloads the libraries the app needs. It may take a minute.

4. Start the development server:

   ```bash
   npm run dev
   ```

5. The terminal will print a URL like `http://localhost:5173`. Open that
   URL in your web browser.

The app loads automatically with a built-in example model (described in
section 5). You can start exploring immediately.

### Other useful commands

| Command             | What it does                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`     | Creates a production build in the `dist/` folder. You can open `dist/index.html` directly in a browser, or deploy it to any static host. |
| `npm test`          | Runs the test suite (195 automated tests). Not needed for normal use.                                                                    |
| `npm run lint`      | Checks code quality. Only relevant if you are editing the source.                                                                        |
| `npm run typecheck` | Checks TypeScript types. Only relevant if you are editing the source.                                                                    |

---

## 4. Tour of the Main Screen

When the app opens, you see a nearly full-screen canvas with several
floating panels. Here is what each part is, starting from top-left and
going clockwise:

```
┌──────────────────────────────────────────────────────┐
│  [L1: CLD] [L2: Constraints] [L3: T/I/OE] [ABM]      │  ← Layer switcher (top-left)
│             [Pause] [Reset]  Hover a node, click ▲/▼ │  ← Play bar (top-center)
│                                                      │
│                                       ┌────────────┐ │
│            MAIN CANVAS                │ L2 / L3 /   │ │  ← Side panel (top-right)
│         (the diagram, drawn           │ Node monitor│ │     (switches with the layer)
│          here with nodes and          │            │ │
│          arrows and loops)            │            │ │
│                                      ─┤            │ │
│         ▲ hover a node to nudge it    │            │ │
│         ▼ (up = +, down = −)          │            │ │
│                                       └────────────┘ │
│                                                      │
│  [Save session] [Load session]                       │  ← Session bar (bottom-left)
└──────────────────────────────────────────────────────┘
```

### The layer switcher (top-left)

Four buttons that let you choose which overlay is active. Only one
overlay can be active at a time (this is deliberate — the tool is meant
for thinking, not for overwhelming you with simultaneous views).

| Button              | What it shows                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| **L1: CLD**         | The base diagram + the live node monitor panel (sparklines of node values over time).              |
| **L2: Constraints** | The diagram + heat coloring + the constraint ranking panel. This is the default when the app opens. |
| **L3: T/I/OE**      | The diagram + the simulation panel with sparklines.                                                 |
| **ABM**             | The diagram + the agent-based model companion panel.                                                |

The base diagram (Layer 1) is **always visible** underneath. Layers 2 and
3 add color and annotations on top of it; they do not replace it. The ABM
view replaces the side panel with a different one.

### The main canvas (center)

This is where the diagram is drawn — circles (nodes) connected by arrows
(edges), with loop labels (R1, B1, etc.) floating near each loop. You can
drag, pan, and zoom. Details in section 6.

### The side panels (right side)

The right-side panel swaps depending on which layer is active:

- **L1: CLD** — the **live node monitor** (sparklines of node values over
  time; see below).
- **L2: Constraints** — the constraint panel (sliders + ranked list).
- **L3: T/I/OE** — the simulation panel (sparklines).
- **ABM** — the ABM companion panel (full right-side height).

Only one panel is visible at a time (the layer switcher enforces this).

### The play bar (top-center)

A small toolbar with three parts:

| Control      | What it does                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Pause/Play** | Pauses or resumes the live signal animation (the pulses traveling along edges). The animation runs by default when the app opens.      |
| **Reset**    | Returns every node's value to its rest state and clears all traveling signals. Useful before starting a fresh nudge experiment.         |
| **Hint text** | Reminds you how to drive the simulation: "Hover a node, click ▲/▼ to nudge it."                                                        |

### The live node monitor (L1 only, right side)

When **L1: CLD** is the active layer, the right-side panel becomes a live
node monitor. It plots each node's value over time as the live animation
runs — so you can watch the bullwhip effect unfold: values rise (green)
or fall (red) as pulses circulate and amplify or dampen around the loops.

The monitor has two modes, chosen automatically by graph size:

- **Small graphs (fewer than 7 nodes):** a sparkline is shown for **every
  node**, stacked vertically. Each card shows the node's label, its current
  numeric value (colored green for growth / red for decline), and a large
  rolling sparkline of the last ~200 animation frames. The beer-distribution
  model (6 nodes) uses this mode — you see all six nodes at once.
- **Larger graphs (7 or more nodes):** a **dropdown** lets you pick which
  node to monitor. Nudging a node on the canvas automatically switches the
  dropdown to that node; you can also pick any node manually (e.g. switch
  from "Wholesaler Backlog" to "Customer Demand").

A **Value / Cumulative** toggle in the monitor header switches the metric:

- **Value** (default): plots the node's raw value (its operating point = rest). Shows
  the current state — oscillation, growth, decline.
- **Cumulative**: plots the running sum of each node's deviation from rest.
  Shows the net drift direction over time — a rising line means the node has
  been pushed above rest more than below, a flat line means it's oscillating
  symmetrically. Useful for spotting which nodes accumulate the most stress.

### The session bar (bottom-left)

Two buttons: **Save session** and **Load session**. These let you save
your entire workspace to a file and restore it later. Details in section 10.

---

## 5. The Built-In Example: Beer Distribution

The app opens with a classic example called the **Beer Distribution
Model**. It is the most famous illustration of the "bullwhip effect" in
supply chains.

### The story behind it

Imagine a beer supply chain with these stages:

```
Customer → Retailer → Wholesaler → Production
```

Customers buy beer from the retailer. When the retailer runs low, they
order more from the wholesaler. When the wholesaler runs low, they order
more from production. Each order takes time to arrive (delays).

Here is the surprising part: even if customer demand is perfectly steady,
a **tiny** fluctuation causes the orders to amplify wildly as they move
upstream. The retailer orders a little extra "just in case," so the
wholesaler sees a bigger spike and orders even more "just in case," so
production sees a huge spike. This is the **bullwhip effect** — small
demand wiggle at one end becomes a giant whip crack at the other.

### The six nodes in the model

| Node                | What it represents                              | Type  | T/I/OE                 |
| ------------------- | ----------------------------------------------- | ----- | ---------------------- |
| Customer Demand     | The rate at which customers buy beer            | Flow  | T (Throughput)         |
| Retailer Backlog    | Unfilled orders at the retailer (accumulates)   | Stock | I (Inventory)          |
| Retailer Orders     | The rate at which the retailer places orders    | Flow  | T (Throughput)         |
| Wholesaler Backlog  | Unfilled orders at the wholesaler (accumulates) | Stock | I (Inventory)          |
| Wholesaler Orders   | The rate at which the wholesaler places orders  | Flow  | T (Throughput)         |
| Production Capacity | How fast production can supply (accumulates)    | Stock | OE (Operating Expense) |

### The seven edges (arrows)

Each arrow says "this influences that," with a polarity and a delay:

| Arrow                                    | Meaning                                | Delay                              |
| ---------------------------------------- | -------------------------------------- | ---------------------------------- |
| Customer Demand → Retailer Backlog       | More demand grows the backlog          | none                               |
| Retailer Backlog → Retailer Orders       | More backlog triggers more orders      | 2 (information delay)              |
| Retailer Orders → Wholesaler Backlog     | Orders become the wholesaler's backlog | 4 (material delay — shipping)      |
| Wholesaler Backlog → Wholesaler Orders   | More backlog triggers more orders      | 2 (information delay)              |
| Wholesaler Orders → Production Capacity  | Orders drive production                | 6 (material delay — manufacturing) |
| Production Capacity → Wholesaler Backlog | Production fills the backlog           | 3 (material delay)                 |
| Wholesaler Orders → Retailer Backlog     | Orders eventually reach the retailer   | 4 (material delay)                 |

### The loops (computed automatically)

The app finds the loops for you. In this model there are reinforcing loops
(where the bullwhip amplification happens) and the delays are what cause
the oscillation. You will see labels like `R1`, `R2` on the diagram. Their
exact count and naming depends on the automatic cycle detection.

> **Key insight:** You did not have to tell the app about any loops. It
> found them by tracing the arrows. If you change an arrow, the loops
> recompute instantly. This is the "compute, don't annotate" principle.

---

## 6. Layer 1 — The Causal Loop Diagram

Select **L1: CLD** in the layer switcher (top-left) to see the base
diagram with no overlays.

### What you see

- **Nodes** — circles labeled with their name (e.g., "Retailer Backlog").
  If you have manually dragged a node to fix its position, it gets a
  thicker border to show it is "pinned." Inside each node, a smaller filled
  circle (the **value circle**) grows and shrinks to show the node's current
  value as the live simulation runs — this is the loopy-style heartbeat of
  the network. The value circle also **changes color**: green when the
  node's value is above its rest state (growth), red when below (decline),
  with intensity proportional to how far it has drifted — so you can see at
  a glance which nodes are being amplified or dampened.

- **Nudge arrows** — when you hover a node, two small arrows appear: a
  **▲ above** it and a **▼ below** it. Click ▲ to nudge the node's value
  up (positive growth direction); click ▼ to nudge it down (negative
  direction). The nudge sends a signed pulse onto every outgoing edge, so
  the direction of growth propagates to the next node and around the loop.

- **Edges** — straight arrows from source to target. At the midpoint of
  each arrow you see a `+` or `−` symbol showing the polarity.

- **Delay marks** — arrows that have a delay show a **double-hash mark**
  (two short perpendicular lines, like `//`) drawn in blue just past the
  midpoint, plus a small blue number showing the delay magnitude. The
  number is placed off to the side of the arrow so it never overlaps the
  `+`/`−` polarity chip. This is how you spot slow influences at a glance.

- **Loop labels** — bold letters like `R1`, `R2`, `B1` placed near the
  center of each loop. Reinforcing loops are **green**; balancing loops
  are **red**.

- **Traveling signals** — when the animation is playing, small dots ride
  along the edges. These are the pulses carrying value changes from node
  to node. A pulse on a `+` edge keeps its sign; on a `−` edge it flips.
  Reinforcing loops amplify them; balancing loops dampen them.

### How to interact

| What you do                                           | What happens                                                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Hover a node**                                      | Two arrows (▲ above, ▼ below) appear, and the first loop that node belongs to lights up. All other nodes and arrows dim to 25% opacity. This lets you trace one loop at a time. |
| **Click ▲ on a hovered node**                         | Nudges the node's value up. Emits a positive pulse onto every outgoing edge — the growth direction is "up" to the next node and onward. The node's inner value circle grows. |
| **Click ▼ on a hovered node**                         | Nudges the node's value down. Emits a negative pulse onto every outgoing edge — the growth direction is "down" to the next node and onward. The node's inner value circle shrinks. |
| **Drag a node** (click and hold a circle, move mouse) | The node moves. Its position is saved as a "pin" and will survive a save/load. The layout engine briefly re-adjusts surrounding nodes. (Dragging is suppressed while pressing an arrow.) |
| **Hover over a loop label** (R1, B1, etc.)            | That specific loop highlights — its edges and nodes stay bright, everything else dims.                                                 |
| **Shift-click a node**                                | Opens the **edit modal** for that node (see "Editing a node" below). Lets you change the node's properties and write them back to the YAML. Does not nudge the value. |
| **Pan the canvas** (click and drag the background)    | The whole diagram moves.                                                                                                               |
| **Zoom** (mouse wheel or trackpad scroll)             | Zooms in and out. Range: 0.2× to 4×.                                                                                                   |
| **Double-click the background**                       | Resets the zoom to 100% (does not re-layout).                                                                                          |

### Understanding the loop labels

- **R1, R2, R3, …** — Reinforcing loops. These amplify change. In the beer
  model, they are where the bullwhip effect lives: more backlog → more
  orders → more backlog downstream → more orders upstream → …

- **B1, B2, B3, …** — Balancing loops. These push toward equilibrium.
  Think of a thermostat: temperature rises → AC turns on → temperature
  falls.

The numbering is deterministic: the same diagram always produces the same
R1, R2, B1 labels. If you add or remove an arrow, the labels may change.

### Running the network (live simulation)

The diagram is not static — it is alive. By default, the animation is
**playing** when the app opens. You drive it with the ▲/▼ nudge arrows:

1. **Hover any node.** The ▲ and ▼ arrows appear above and below it.
2. **Click ▲** to nudge the value up, or **▼** to nudge it down. Each
   click emits a pulse carrying that signed change onto every outgoing
   edge.
3. **Watch the pulse travel.** A small dot rides along each arrow. When
   it reaches the target node, that node's value shifts (and its inner
   value circle resizes and recolors — green for growth, red for decline),
   then a fresh pulse rides onward down that node's outgoing edges.
4. **Watch the loop close.** On a reinforcing loop where edge strengths
   exceed 1, the pulse comes back bigger (amplification) — this is the
   bullwhip effect made visible. On a balancing loop, or where strengths
   are below 1, the pulse dampens. In the beer model, the order-triggering
   edges (backlog → orders) have a strength of 1.3, so a small demand nudge
   amplifies as it travels upstream: each stage's value circle grows larger
   than the last.
5. **Watch the live node monitor** (right side, L1 only). The node you
   nudged gets its value plotted over time in a sparkline. If the graph has
   fewer than 7 nodes (the beer model has 6), you see a sparkline for every
   node at once. You see the oscillation — values rise and fall as pulses
   circle the loops and come back — which is the characteristic signature of
   the bullwhip.

Use the **Pause/Play** and **Reset** buttons in the play bar
(top-center) to control the animation. Pause to inspect a frozen state;
Reset to return every node to its rest value before a new experiment.

> **The animation is view-only.** It never writes to your graph — it is a
> visualization aid. The only thing a nudge pushes outward (beyond the
> canvas) is a signal to Layer 3's sparklines, so they re-simulate from
> what you just poked (see section 8).

### Editing a node (edit mode)

Layer 1 has an **edit mode** for changing a node's properties without
leaving the canvas. It is triggered by **shift-clicking** a node — this
opens a modal dialog showing every editable field of that node:

| Field                 | What it controls                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Label**             | The human-readable name shown on the diagram.                                                                              |
| **Type**              | `stock`, `flow`, or `auxiliary` (see glossary).                                                                            |
| **TIOE class**        | `T`, `I`, `OE`, or `none` — the Layer 3 financial category.                                                                |
| **Initial value**     | The starting value for quantitative simulation.                                                                             |
| **Unit**              | The unit of measurement (e.g., "units/week").                                                                              |
| **Collar lower (physical)** | The lower bound for the node's value, in the node's own units. The engine clamps the value to stay at or above this.       |
| **Collar upper (physical)** | The upper bound for the node's value, in the node's own units. The engine clamps the value to stay at or below this.       |
| **Pin x / y**         | The node's fixed screen position. Check "auto-layout (clear pin)" to remove the pin and let the layout engine place it.   |
| **Agent binding**     | The ABM rule id bound to this node, if any. Check "no binding" to remove an existing binding.                              |

When you click **Save**, the app:

1. **Validates** the candidate node against the full graph — if the edit
   would break the model (e.g., an invalid collar range), an error
   message appears and the save is blocked.
2. **Applies** the change to the in-memory graph (the single source of
   truth).
3. **Re-renders** the canvas and refreshes the Layer 2 and Layer 3
   panels so they reflect the edited node.
4. **Downloads** the updated graph serialized back to YAML
   (`graph.yaml`), so you can keep the edited model as a file.

> **Why shift-click?** Plain click stays reserved for selecting/inspecting
> a node, and the ▲/▼ nudge arrows handle value changes. Shift-click is
> an explicit "I want to edit the structure" gesture that won't fire
> accidentally.

The downloaded YAML is in the same authoring format as the built-in
fixture (see section 11), so you can drop it into `public/examples/` and
it will load on the next startup.

### Why loops matter

Loops are the DNA of system behavior. A system dominated by reinforcing
loops tends to grow or collapse exponentially. A system dominated by
balancing loops tends to settle toward a steady state. A system where fast
reinforcing loops meet slow balancing loops tends to **oscillate** — which
is exactly what happens in the beer distribution model.

---

## 7. Layer 2 — Finding the Bottleneck

Select **L2: Constraints** in the layer switcher. This is the default
view when the app opens.

### What it does

Layer 2 colors and sizes the nodes by a **constraint score** — a number
from 0 to 1 that estimates how likely each node is to be the system's
bottleneck. The higher the score, the hotter the color and the bigger the
node.

This answers the question: **"If I could change one thing in this system,
which node would have the biggest ripple effect?"**

The score is a **pure function of the graph and your weights** — it never
changes as the animation runs, so the ranking is stable and trustworthy. A
fifth signal, **sensitivity**, measures how much a unit nudge at each node
perturbs the whole system (computed once from the simulation engine and cached
until you edit the graph). The four structural signals still describe *where*
the constraint probably sits; sensitivity tells you *how much it matters* when
you poke it.

### What you see

#### On the canvas (heat overlay)

- Nodes are colored on a heat scale: **cool blue** (low score) → **red**
  (high score).
- Nodes are also **sized** by score: high-scoring nodes are up to 1.5×
  larger; low-scoring nodes shrink to 0.85×.
- The ranking is also shown textually in the side panel, so the score is
  never communicated by color alone (important for accessibility).

#### The side panel (top-right)

The panel has three parts:

**1. Header with on/off toggle**

```
┌─────────────────────────────────┐
│ Layer 2 — Constraints    [On]   │
└─────────────────────────────────┘
```

Click **On/Off** to toggle the heat coloring without leaving the layer.

**2. Weight sliders**

```
Weights — only the ratios matter.

Loop membership        1.0
━━━━━━●━━━━━━━━━━━━━━━

Delay / cycle time     1.0
━━━━━━●━━━━━━━━━━━━━━━

R/B rate mismatch      1.0
━━━━━━●━━━━━━━━━━━━━━━

Dominant-loop share    1.0
━━━━━━●━━━━━━━━━━━━━━━

Sensitivity (impulse)  1.0
━━━━━━●━━━━━━━━━━━━━━━
```

These five sliders control how much weight each signal carries in the
score. Drag them to test different theories about what makes a node a
constraint. The scores recompute live (within 80 milliseconds) as you
drag — you do not need to press a button.

The five signals, in plain language:

| Slider                  | What it measures                                                                                     | Why it matters                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Loop membership**     | How many loops pass through this node                                                                | Nodes where many loops converge are natural choke points.                                      |
| **Delay / cycle time**  | The biggest delay touching this node, relative to the average loop cycle time                        | A long delay at a node causes pile-ups: stuff arrives late, and the system over-corrects.      |
| **R/B rate mismatch**   | The gap between the average reinforcing-loop speed and the average balancing-loop speed at this node | Where a fast reinforcing loop meets a slow balancing loop, inventory or oscillation builds up. |
| **Dominant-loop share** | Whether this node is in the loop with the longest cycle time                                         | The slowest loop often governs the system's overall response time.                             |
| **Sensitivity (impulse)** | How much a unit nudge at this node perturbs the whole system (L2 norm of the trajectory deviation) | A node whose nudge ripples furthest is the one with the most leverage — and the most risk.    |

> **Tip:** "Only the ratios matter" means that doubling all five sliders
> at once changes nothing. What matters is the _relative_ emphasis. Set
> one slider to 0 to ignore that signal entirely; set it to 3 to
> emphasize it heavily.

**3. Top-3 ranked constraints**

```
Top 3 candidate constraints

┌──────────────────────────────────┐
│ #1  0.87  Wholesaler Orders      │
│   Loop membership     0.50 (2)   │
│   Delay / cycle time  0.80 (0.67)│
│   R/B rate mismatch   0.90 (1.2) │
│   Dominant-loop share 1.00 (1.0) │
└──────────────────────────────────┘

┌──────────────────────────────────┐
│ #2  0.72  Retailer Orders        │
│   ...                            │
└──────────────────────────────────┘

┌──────────────────────────────────┐
│ #3  0.65  Wholesaler Backlog     │
│   ...                            │
└──────────────────────────────────┘
```

Each card shows:

- **Rank** (#1, #2, #3) — the ordering by score.
- **Score chip** (e.g., 0.87) — the constraint score, colored by the heat
  scale so it matches the node on the canvas.
- **Node label** — the name of the node.
- **Per-signal breakdown** — each signal's contribution (normalized 0–1)
  and its raw value in parentheses. This is the "why" — you can see
  exactly which signals are pushing this node to the top.

### How to use it

1. **Start with the defaults.** With all weights equal, the beer model
   ranks **Wholesaler Orders** as the #1 constraint — the node where
   bullwhip amplification is most pronounced. This matches the known
   intuition for this model.

2. **Experiment with the sliders.** If you believe delays are the main
   driver, drag "Delay / cycle time" up and the others down. Watch the
   ranking change. If the #1 node changes, that tells you the constraint
   location is sensitive to your theory — which is itself a useful
   insight.

3. **Read the breakdown.** For the #1 node, look at which signals
   contribute most. This tells you _why_ it is the constraint, not just
   _that_ it is.

4. **Use the result downstream.** The #1 constraint is automatically
   selected as the default intervention node in Layer 3, so you can go
   straight to "what if I changed this?" (see section 8).

---

## 8. Layer 3 — The "What-If" Simulation

Select **L3: T/I/OE** in the layer switcher.

### What it does

Layer 3 runs a lightweight simulation: it steps through time, updating
each stock and flow according to the diagram's cause-and-effect arrows
and delays. It runs the simulation twice — once as-is (the "pre" run)
and once with your hypothetical intervention applied (the "post" run) —
and shows the difference as three small line charts (sparklines).

This answers: **"If I changed this one node, would Throughput go up or
down? Would Inventory? Would Operating Expense?"**

### Important caveat

This is a **directional** simulation, not a financial model. The
sparklines show which way things move and roughly how much, not exact
dollar amounts. The moment you try to read them as precise forecasts, the
tool stops being useful for architectural thinking. Trust the direction
and the relative magnitude; do not trust the absolute numbers.

### The side panel (bottom-right)

```
┌──────────────────────────────────────┐
│ Layer 3 — T / I / OE         [Off]   │
│                                      │
│ Intervention node                    │
│ ┌──────────────────────────────────┐ │
│ │ Wholesaler Orders          ▼     │ │
│ └──────────────────────────────────┘ │
│                                      │
│ Intervention Δ             50        │
│ ━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                      │
│ Step size (dt)            0.10        │
│ ━━●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                      │
│ Steps                    200          │
│ ━━━━━━━━━━━━━●━━━━━━━━━━━━━━━━━━━━  │
│                                      │
│ Integrator                           │
│ [Euler]  [RK4]                       │
│                                      │
│ Pre (grey) vs. post (blue)           │
│ intervention. Directional delta only.│
│                                      │
│ ┌──────────────────────────────────┐ │
│ │ T · Throughput        Δ +12.30   │ │
│ │ ╱╲    ╱╲    ╱╲                 │ │  ← sparkline
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ I · Investment/Inv.   Δ -5.70   │ │
│ │ ─╲╱─╲╱─╲╱─                    │ │  ← sparkline
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ OE · Operating Expense Δ +3.20   │ │
│ │ ──╱╲╱╲╱╲───                   │ │  ← sparkline
│ └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```

#### The controls

| Control                          | What it does                                                                                                 | Range                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------- |
| **Intervention node** (dropdown) | Which node to apply the hypothetical change to. Defaults to the Layer 2 #1 constraint.                       | Any node in the graph |
| **Intervention Δ** (slider)      | The size of the change applied to that node at time zero. Positive = increase; negative = decrease.          | −200 to +200          |
| **Step size (dt)** (slider)      | How fine-grained each simulation step is. Smaller = more accurate but slower.                                | 0.01 to 1.0           |
| **Steps** (slider)               | How many steps to simulate. More steps = longer time horizon.                                                | 50 to 2000            |
| **Integrator** (two buttons)     | The math method. **RK4** (default) is more accurate. **Euler** is faster but less accurate on stiff systems. | Euler or RK4          |

#### The sparklines

Three small charts, one for each T/I/OE category:

- **T · Throughput** — the sum of all nodes tagged `T`.
- **I · Investment / Inventory** — the sum of all nodes tagged `I`.
- **OE · Operating Expense** — the sum of all nodes tagged `OE`.

Each sparkline shows two lines:

- **Grey line** — the "pre" run (the system as-is, no intervention).
- **Blue line** — the "post" run (with your intervention applied).

At the top-right of each sparkline is a **delta badge** showing the
end-of-run difference: `Δ +12.30` (green, went up) or `Δ −5.70` (red,
went down).

### How to use it

1. **Pick a node to intervene on.** The dropdown defaults to the Layer 2
   top constraint, which is usually what you want. You can choose any
   node.

2. **Set the intervention size.** Drag the Δ slider. Positive values
   simulate increasing the node (e.g., adding capacity); negative values
   simulate decreasing it (e.g., removing a delay). The sparklines update
   instantly.

3. **Or nudge directly from the canvas.** Instead of the slider, switch
   to Layer 1 (or keep Layer 3's panel active) and click a node's **▲/▼**
   nudge arrows. Each nudge selects that node as the intervention node
   and sets the Δ's sign from the nudge direction (▲ = positive, ▼ =
   negative), keeping the current magnitude. The sparklines re-simulate
   immediately, so you see the financial consequence of each poke as you
   "run the network." This is the bridge between the live Layer 1
   animation and the quantitative Layer 3 view.

4. **Read the sparklines.** For each of T, I, OE:
   - Did the blue line end above or below the grey line? That tells you
     the direction of the effect.
   - How big is the gap? That tells you the relative magnitude.
   - Does the blue line oscillate where the grey line was smooth? That
     tells you the intervention destabilized the system.

5. **Adjust the simulation settings if needed.** If the sparklines look
   jagged or unstable, switch to RK4 (if not already) or decrease the
   step size. If you want to see further into the future, increase the
   number of steps.

### Worked example with the beer model

1. With the beer model loaded and Layer 2 active, note that **Wholesaler
   Orders** is the #1 constraint.
2. Switch to **L3: T/I/OE**. The intervention node is already set to
   Wholesaler Orders.
3. Set Δ to **+50** (simulate boosting wholesale order capacity by 50).
4. Watch the sparklines: Throughput (T) likely rises; Inventory (I) may
   dip then recover; Operating Expense (OE) may rise slightly.
5. Now set Δ to **−50** (simulate cutting wholesale orders by 50). The
   sparklines flip direction. This tells you the system is sensitive to
   this node in both directions — confirming it is a real constraint.

---

## 9. ABM — Checking Your Assumptions

Select **ABM** in the layer switcher.

### What it does

Layer 1 is your _macro_ theory of the system: "these loops exist and
they behave this way." But is that theory right? The ABM (Agent-Based
Model) view lets you test it by simulating many individual agents with
simple rules and checking whether their collective behavior matches the
loop you drew.

This answers: **"If I model the individuals in this system with simple
rules, do they collectively reproduce the big-picture loop I drew? Or
does my diagram have a wrong assumption?"**

### Why this is valuable

A causal loop diagram is an assumption about macro behavior. But macro
behavior emerges from micro behavior. If the micro rules do not produce
the macro loop, then your diagram is wrong somewhere — maybe a polarity
is flipped, or a delay is misestimated. The ABM view catches this.

### The panel (right side, full height)

```
┌──────────────────────────────────────┐
│ ABM Companion                        │
│                                      │
│ Bound node                           │
│ ┌──────────────────────────────────┐ │
│ │ Wholesaler Orders          ▼     │ │
│ └──────────────────────────────────┘ │
│                                      │
│ Rule                                 │
│ ┌──────────────────────────────────┐ │
│ │ Reorder policy (reinforcing) ▼   │ │
│ └──────────────────────────────────┘ │
│                                      │
│ Topology                             │
│ ┌──────────────────────────────────┐ │
│ │ Well-mixed                 ▼     │ │
│ └──────────────────────────────────┘ │
│                                      │
│ Sensitivity               1.20       │
│ ━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                      │
│ Delay (steps)               1        │
│ ●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                      │
│ Agent count             1000         │
│ ━━━━━━━━━━━━●━━━━━━━━━━━━━━━━━━━━━  │
│                                      │
│ Seed                      42         │
│ ━━●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│                                      │
│ ┌──────────────────────────────────┐ │
│ │        Run validation            │ │
│ └──────────────────────────────────┘ │
│                                      │
│ Perturbation Δsensitivity   0.00     │
│ ━━━━━●━━━━━━━━━━━━━━━━━━━━━━━━━━━━  │
│ ┌──────────────────────────────────┐ │
│ │       Perturb & re-run           │ │
│ └──────────────────────────────────┘ │
│                                      │
│ (status appears here after running)  │
└──────────────────────────────────────┘
```

#### The controls

| Control                                         | What it means                                                                                                                                                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bound node** (dropdown)                       | Which Layer 1 node this agent population corresponds to. The agents' aggregate behavior will be compared against this node's loops.                                                                         |
| **Rule** (dropdown)                             | The local rule each agent follows. Three choices (explained below).                                                                                                                                         |
| **Topology** (dropdown)                         | How agents are connected to each other. Three choices (explained below).                                                                                                                                    |
| **Sensitivity** (slider 0–3)                    | A gain parameter. For the reorder rule, higher means agents react more aggressively to backlog. For the capacity rule, it sets the threshold.                                                               |
| **Delay** (slider 0–10)                         | How many steps an agent waits before acting. Used by the info-passing rule.                                                                                                                                 |
| **Agent count** (slider 100–10,000)             | How many individual agents to simulate. More agents = smoother aggregate but slower run.                                                                                                                    |
| **Seed** (slider 0–999)                         | Random seed. The same seed always produces the same result (deterministic). Change it to get a different random realization.                                                                                |
| **Run validation** (button)                     | Runs the simulation and reports whether the agents' macro behavior matches the bound node's loop.                                                                                                           |
| **Perturbation Δsensitivity** (slider −1 to +1) | How much to shift the sensitivity for the perturbation re-run.                                                                                                                                              |
| **Perturb & re-run** (button)                   | Runs the simulation again with the perturbed sensitivity and compares to the baseline. Reports whether the system's macro behavior held, weakened, or bifurcated. (Disabled until you have run a baseline.) |

#### The three rules

| Rule                   | Expected behavior        | How it works in plain language                                                                                                                                                                          |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reorder policy**     | Reinforcing (amplifying) | Each agent orders an amount proportional to its backlog. Backlogs grow with the group's average order. This is the classic bullwhip mechanism: everyone over-orders "just in case," and orders amplify. |
| **Capacity threshold** | Balancing (converging)   | Agents below a threshold produce; agents above it consume. Each agent is coupled to its neighbors' average. The system converges to equilibrium — the balancing counterpart of the reorder rule.        |
| **Info-passing delay** | Balancing (lagged)       | Each agent passes a value to its neighbors after a delay (using a history queue). You see the value propagate through the population with a lag — useful for testing delay assumptions.                 |

#### The three topologies

| Topology             | What it means                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Well-mixed**       | Every agent sees every other agent. Full global coupling.                                                                         |
| **Lattice (ring)**   | Agents are arranged in a circle; each agent only sees its two immediate neighbors.                                                |
| **Network (random)** | Each agent connects to 3 random others. The connections are deterministic from the seed, so the same seed gives the same network. |

### How to use it

#### Step 1: Run a baseline validation

1. Choose a **bound node** — the Layer 1 node whose loop you want to
   check. Start with **Wholesaler Orders** (the #1 constraint).
2. Choose a **rule** that you _think_ should reproduce that node's
   behavior. For Wholesaler Orders, the **Reorder policy** is the natural
   choice — it should produce reinforcing (amplifying) behavior.
3. Leave topology, sensitivity, delay, agent count, and seed at their
   defaults for now.
4. Click **Run validation**.

The simulation runs in a background thread (a Web Worker), so the page
stays responsive. For 1,000 agents and 300 steps, it finishes in under a
second.

#### Step 2: Read the verdict

After the run, a status message appears at the bottom of the panel:

| Verdict                   | What it means                                                                                                                                     | What to do                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Validated** (green bar) | The agents' collective behavior matches the bound node's loop polarity and response lag. Your Layer 1 diagram is consistent with the micro rules. | Your assumption is confirmed. Move on, or try a perturbation.                             |
| **Flagged** (red bar)     | Mismatch. Either the polarity is wrong (e.g., a balancing rule on a reinforcing loop) or the delay is off. The detail text explains which.        | Reconsider your Layer 1 diagram. You may have a polarity flipped or a delay misestimated. |

The detail text after the verdict explains exactly what was compared and
what was found.

#### Step 3: Perturb and re-run

Once you have a baseline, you can test stability:

1. Drag the **Perturbation Δsensitivity** slider to a non-zero value
   (e.g., +0.5 or −0.5). This shifts each agent's sensitivity by that
   amount.
2. Click **Perturb & re-run**.

The system runs again with the perturbed parameter and compares to the
baseline. The result is a **macro verdict**:

| Verdict        | What it means                                                                                                 | Plain-language interpretation                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Held**       | The macro behavior is the same (reinforcing stays reinforcing, etc.) with similar magnitude.                  | The system is robust to this change. You are in the same behavioral regime.                                                                                                             |
| **Weakened**   | Same behavior type but less pronounced — slower amplification, or convergence with more residual oscillation. | The change matters but does not flip the system. You are near the edge of the regime.                                                                                                   |
| **Bifurcated** | The behavior flipped — convergence became amplification or vice versa.                                        | **This is the most valuable finding.** A small agent-level change moved the whole system across a tipping point. This is where interventions have outsized leverage — or outsized risk. |

### Worked example with the beer model

1. Bind to **Wholesaler Orders**, rule **Reorder policy**, topology
   **Well-mixed**, sensitivity **1.2**, 1000 agents, seed 42.
2. Click **Run validation**. Result: **Validated** — the reorder rule
   produces reinforcing behavior, matching the loop at Wholesaler Orders.
3. Set perturbation to **−0.5** (make agents less reactive) and click
   **Perturb & re-run**. Result might be **Weakened** — still
   reinforcing, but less amplified.
4. Set perturbation to **+1.0** (make agents much more reactive) and
   re-run. If the result is **Bifurcated**, that tells you: beyond a
   certain reactivity threshold, the system does not just amplify more —
   it qualitatively changes behavior. That is the boundary of the stable
   regime.

### Determinism

The same inputs always produce the same output. If you want a different
random realization (a different "roll of the dice" for the agent
initialization), change the **seed**. If you want to test whether the
result is robust to randomness, run with several different seeds and
check that the verdict is consistent.

---

## 10. Saving and Loading Your Work

The **Save session** and **Load session** buttons are at the bottom-left
of the screen.

### Save session

Click **Save session**. Your browser downloads a JSON file containing:

- The entire graph (all nodes, edges, and computed loops).
- Any manual pin positions you set by dragging nodes.
- Any ABM validation verdicts written onto nodes.
- The Layer 2 weight slider values.
- A timestamp.

The file is named with the date and time. It is a plain JSON file — you
can open it in any text editor, share it, or version-control it.

### Load session

Click **Load session**. A file picker opens. Select a previously saved
session JSON file. The app:

1. Reads the file and strips any malicious keys (prototype-pollution
   protection).
2. Validates the graph structure.
3. **Re-derives the loops from the edges** — loops in the file are never
   trusted; they are always recomputed. This guarantees consistency.
4. Re-renders the canvas, restores the weights, and resets the Layer 3
   panel.

If the file is invalid, you see an alert explaining the problem.

### When to use this

- **Experimenting with weights:** Save a session with one set of weights,
  then try different weights and save again. You can compare later.
- **Sharing a model:** Send the JSON file to a colleague. They open it
  with Load session and see exactly what you see.
- **Resuming work:** Save before closing the browser; load to continue.

---

## 11. Authoring Your Own Model

You create a model by writing a YAML text file. The app ships with one
example at `public/examples/beer-distribution.yaml`. Here is how to write
your own.

### What is YAML?

YAML is a plain-text format for structured data. It uses indentation
(spaces, not tabs) to show nesting. You list items with `- ` (dash
space). You set key-value pairs with `key: value`. That is essentially
all you need to know.

### The structure

A model file has two top-level lists: `nodes` and `edges`.

```yaml
nodes:
  - id: <unique-id>
    label: <human-readable name>
    type: <stock | flow | auxiliary>
    tioe_class: <T | I | OE | none>
    initial_value: <number>
    unit: <string>
    lower_collar: <deprecated — use collar: block>
    # Instead:
    collar: { lower: <number>, upper: <number>, approach: hard }

edges:
  - id: <unique-id>
    source: <node id>
    target: <node id>
    polarity: <+ | ->
    delay: { type: <none | material | information | perception>, magnitude: <number> }
    strength: <number>
```

### Step-by-step: authoring a simple model

Let's model a simple hiring loop: more workload → more hiring → more
capacity → less workload (a balancing loop).

**1. Define the nodes:**

```yaml
nodes:
  - id: workload
    label: Workload
    type: stock
    tioe_class: I
    initial_value: 100
    unit: tasks
    collar: { lower: 0, upper: 200 }

  - id: hiring_rate
    label: Hiring Rate
    type: flow
    tioe_class: OE
    initial_value: 5
    unit: people/week

  - id: capacity
    label: Team Capacity
    type: stock
    tioe_class: T
    initial_value: 10
    unit: people
```

**2. Define the edges:**

```yaml
edges:
  - id: e1
    source: workload
    target: hiring_rate
    polarity: +
    delay: { type: information, magnitude: 2 }
    strength: 1

  - id: e2
    source: hiring_rate
    target: capacity
    polarity: +
    delay: { type: material, magnitude: 4 }
    strength: 1

  - id: e3
    source: capacity
    target: workload
    polarity: -
    delay: { type: none, magnitude: 0 }
    strength: 1
```

Reading the edges in plain language:

- `e1`: More workload causes more hiring (polarity `+`), but it takes 2
  weeks to notice the workload (information delay).
- `e2`: More hiring grows capacity (polarity `+`), but it takes 4 weeks
  to hire and onboard (material delay).
- `e3`: More capacity reduces workload (polarity `−`), immediately.

This forms a balancing loop: workload → hiring → capacity → less
workload. The app will detect this automatically and label it `B1`.

**3. Do NOT add a `loops` section.** Loops are always computed. If you
add `loops:` to your file, the parser rejects it.

**4. Save the file** as `my-model.yaml` in `public/examples/` (or
anywhere you can load it).

### How to load your model into the app

The app currently loads the beer-distribution fixture automatically on
startup. To use your own model, the simplest approach is to save your
YAML as a session JSON via the programmatic API, or replace the fixture
content and restart the dev server. For details on the programmatic API
(parsing, scoring, simulating from code), see
[docs/usage-guide.md §10](./docs/usage-guide.md#10-programmatic-api).

### Field reference

#### Node fields

| Field           | Required? | Type                           | Default            | Meaning                                                                                  |
| --------------- | --------- | ------------------------------ | ------------------ | ---------------------------------------------------------------------------------------- |
| `id`            | **yes**   | string                         | —                  | A unique identifier (no spaces, use underscores).                                        |
| `label`         | no        | string                         | falls back to `id` | The human-readable name shown on the diagram.                                            |
| `type`          | no        | `stock` / `flow` / `auxiliary` | `auxiliary`        | Whether the node accumulates (stock), is a rate (flow), or is a helper (auxiliary).      |
| `tioe_class`    | no        | `T` / `I` / `OE` / `none`      | `none`             | The Layer 3 financial category.                                                          |
| `initial_value` | no        | number                         | `0`                | The starting value for simulation.                                                       |
| `unit`          | no        | string                         | `""`               | The unit of measurement (e.g., "units", "units/week").                                   |
| `collar`       | no        | `{ lower?, upper?, approach? }` | omitted (unbounded) | Physical bounds on the node's value, in the same units as `initial_value`. Enforced inside the simulation engine with anti-windup and backpressure. `approach` is `hard` (default) or `soft` (Phase 7). |
| `pin`           | no        | `{ x: number, y: number }`     | omitted            | A fixed screen position. If omitted, the layout engine positions the node automatically. |

#### Edge fields

| Field      | Required? | Type           | Default                        | Meaning                                           |
| ---------- | --------- | -------------- | ------------------------------ | ------------------------------------------------- |
| `id`       | **yes**   | string         | —                              | A unique identifier.                              |
| `source`   | **yes**   | node id        | —                              | The node the arrow starts from.                   |
| `target`   | **yes**   | node id        | —                              | The node the arrow points to.                     |
| `polarity` | no        | `+` or `-`     | `+`                            | Same-direction (`+`) or opposite-direction (`−`). |
| `delay`    | no        | object (below) | `{ type: none, magnitude: 0 }` | The delay on this influence.                      |
| `strength` | no        | number         | `1`                            | Relative influence weight for simulation.         |

#### Delay object

| Field       | Type         | Values                                             | Meaning                                                                                                                     |
| ----------- | ------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `type`      | string       | `none` / `material` / `information` / `perception` | What kind of delay. `material` = physical transit; `information` = reporting/decision lag; `perception` = mental model lag. |
| `magnitude` | number (≥ 0) | model time units                                   | How long the delay lasts.                                                                                                   |

You can also use a shorthand on the edge itself:

```yaml
- id: e1
  source: a
  target: b
  delay_type: material
  delay_magnitude: 4
```

### Validation

When the app reads your file, it checks for problems and reports **all**
of them at once (not just the first). Common issues:

| Problem                                       | What it means                                                          |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `duplicate_node_id`                           | Two nodes have the same `id`. IDs must be unique.                      |
| `duplicate_edge_id`                           | Two edges have the same `id`.                                          |
| `edge_unknown_source` / `edge_unknown_target` | An edge references a node `id` that does not exist.                    |
| `edge_self_loop`                              | An edge points from a node back to itself. Self-loops are not allowed. |
| `duplicate_edge`                              | Two edges have the same source and target.                             |
| `invalid_node_type` / `invalid_tioe_class`    | The `type` or `tioe_class` value is not one of the allowed options.    |
| `invalid_polarity` / `invalid_delay_type`     | The `polarity` or `delay.type` value is not recognized.                |
| `negative_delay` / `negative_strength`        | A delay magnitude or strength is negative.                             |
| `collar_ambiguous_units`                     | Legacy flat `lower_collar`/`upper_collar` fields present. Restate in the `collar:` block with physical units. |
| `collar_lower_above_upper`                    | A node's `collar.lower` is not less than `collar.upper`. |
| `collar_initial_out_of_range`                | The `initial_value` lies outside the `collar` bounds. |
| `collar_invalid_approach`                    | `collar.approach` is not `"hard"` or `"soft"`. |
| `range_invalid`                              | An edge `range` pair is not `[min, max]` with `min <= max`. |

Fix all reported issues, then reload.

### A note on delays

Delays are the most important and most underestimated aspect of system
models. When in doubt:

- **Material delays** (shipping, production, physical transit) tend to be
  long. Use `type: material`.
- **Information delays** (noticing a change, deciding to act, reporting)
  tend to be medium. Use `type: information`.
- **Perception delays** (mental model updates, habit changes) tend to be
  the longest. Use `type: perception`.
- **No delay** (`type: none`) means the effect is immediate. Use this
  sparingly — real systems almost always have some lag.

---

## 12. Keyboard and Accessibility

The app is designed to be fully usable without a mouse.

### Keyboard navigation

- **Tab** — moves focus through every interactive control in order: layer
  switcher buttons, sliders, dropdowns, toggle buttons, run/perturb
  buttons, save/load buttons.
- **Shift + Tab** — moves focus backward.
- **Enter / Space** — activates the focused button or toggle.
- **Arrow keys** — adjust a focused slider up/down (or left/right).

### Visual accessibility

- **Focus indicator** — every interactive element shows a 2-pixel blue
  outline when focused via keyboard, so you always know where you are.
- **Color is never the only signal** — Layer 2 heat uses color _and_ node
  size _and_ the ranked text panel. Layer 3 sparklines use color _and_
  line position _and_ delta badges. ABM verdicts use color _and_ text
  status. If you cannot distinguish colors, you can still read every
  score and verdict.
- **ARIA roles** — the layer switcher is a proper tablist, the canvas
  has an image role with a text label, and panels are labeled regions.
  Screen readers can announce them.

### Zoom and pan

- **Mouse wheel** — zoom in/out.
- **Click-drag on background** — pan.
- **Double-click background** — reset zoom.

---

## 13. Frequently Asked Questions

### "The diagram moved when I dragged a node — why?"

The app uses a force-directed layout: nodes repel each other and edges
pull connected nodes together. When you drag a node, the layout briefly
re-adjusts to find a new equilibrium. Once it settles, the dragged node
stays where you put it (it is "pinned"). Other nodes may shift slightly.

### "I nudged a node but nothing traveled along the edges — why?"

Check the play bar (bottom-left). If the animation is **paused**, the
pulses you emit are still queued but won't advance until you press
**Play**. Also, a pulse only travels along a node's **outgoing** edges —
if the node has no outgoing arrows, there is nowhere for the signal to
go. Click **Reset** to clear stale pulses before starting a fresh
experiment.

### "I dragged a node and it has a thicker border now. What does that mean?"

The thicker border means the node is **pinned** — its position is fixed
and saved. If you want to un-pin it, drag it back approximately to where
the layout would put it (or just leave it pinned; it does not affect any
calculations, only the visual position).

### "The loop labels changed when I edited an edge. Is that a bug?"

No. Loops are computed from the edges. Adding, removing, or changing an
edge can create or destroy loops, so the labels (R1, R2, B1, …) are
re-derived. The numbering is deterministic, but it may shift when the set
of loops changes.

### "Layer 3 says 'directional delta only.' Can I use it for real financial forecasting?"

No. The simulation is intentionally lightweight. It shows you _which
way_ Throughput, Inventory, and Operating Expense move when you
intervene, and roughly _how much_. It is not calibrated to real dollars.
If you need financial precision, use a dedicated financial model. Layers
is for architectural thinking — deciding _where_ to intervene — not for
sizing the intervention.

### "The ABM run said 'Flagged.' Does that mean my diagram is wrong?"

It means the agent-level rules you chose do not reproduce the loop at
the bound node. Either:

1. Your Layer 1 diagram has a wrong polarity or delay (the diagram is
   the problem), or
2. You chose the wrong rule or parameters for the agents (the ABM setup
   is the problem).

Read the detail text — it tells you specifically whether the mismatch is
in polarity (reinforcing vs. balancing) or in delay (response lag). Then
decide which model to adjust.

### "What does 'bifurcated' mean and why should I care?"

A bifurcation is a tipping point. It means a small change to agent-level
behavior caused the whole system to flip into a qualitatively different
regime — for example, smooth convergence turned into sustained
oscillation, or amplification turned into convergence.

This matters because:

- **If you are trying to fix a system**, a bifurcation tells you that a
  small intervention at this level could have a huge, system-wide effect.
  That is leverage — but also risk.
- **If you are trying to keep a system stable**, a bifurcation tells you
  that you are near the edge of the stable regime, and a small push could
  destabilize everything.

### "Can I run the app offline?"

Yes. Once the page is loaded, the app makes zero network requests. You
can disconnect from the internet and everything — drawing, scoring,
simulating, ABM, saving — continues to work. This is by design: there is
no backend.

### "How many nodes can the app handle?"

The app is designed for models up to about 50 nodes and 150 edges. At
that scale, loop detection takes under 50 milliseconds and the layout
converges in under 2 seconds. Beyond 50 nodes, performance degrades
gracefully but the diagram becomes visually crowded. For most
system-dynamics thinking, 50 nodes is more than enough.

### "I changed a weight slider and the ranking changed. Is that normal?"

Yes. The constraint score is a weighted sum of five signals. Changing
the weights changes the scores, which can reorder the ranking. This is
the intended use: you are testing the sensitivity of the constraint
location to your theory about what matters. If the #1 node changes when
you shift weights, that tells you the constraint is not a fixed fact but
depends on which signals you emphasize — a useful insight in itself.

Note that the ranking no longer changes while the animation runs: the
score is a pure function of the graph and your weights (plus the cached
**sensitivity** signal, recomputed only when you edit the graph). What
you see is what the structure says, not a snapshot of the animation.

### "What is the difference between Euler and RK4?"

These are two methods for stepping the simulation forward in time:

- **Euler** is simpler and faster per step, but less accurate. It can
  drift or go unstable on stiff systems (systems with fast and slow
  dynamics mixed together).
- **RK4** (Runge-Kutta 4th order) is more accurate — it takes four
  samples per step to better approximate the curve. It is the default
  and recommended for most uses.

If your sparklines look jagged or explode to extreme values, switch to
RK4 (if not already) or decrease the step size.

---

## Further Reading

- [Usage Guide (technical)](./docs/usage-guide.md) — the same features with
  API details and code examples, for developers.
- [DSL Reference](./docs/dsl-reference.md) — the complete YAML grammar.
- [Data Model](./docs/data-model.md) — the TypeScript types and validation
  rules.
- [Architecture Spec](./prompt.md) — the original design document.
- [Development Plan](./PLAN.md) — build phases, testing, and deployment.
