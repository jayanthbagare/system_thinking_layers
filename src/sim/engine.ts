/**
 * Unified simulation substrate (Phase 1 of the coherence work package).
 *
 * This is the **single source of dynamical truth** for the whole application.
 * Layer 1 (the live CLD), Layer 2 (constraint scoring, via the sensitivity
 * signal) and Layer 3 (the T/I/OE pre/post simulation) are three projections of
 * one engine — not three independent models. Per the prime directives: "one
 * model, three readings."
 *
 * Semantics:
 *   - State is in **physical units**, matching each node's `initial_value`.
 *     There is no normalized [0,1] value space here; display normalisation is a
 *     view concern, handled by the layers, never by the engine.
 *   - A **stock** integrates the net flow through it (inflow − outflow). It is
 *     the only node type that accumulates mass.
 *   - A **flow** or **auxiliary** node is dynamic: its value each step is the
 *     sum of the rates delivered to it by its incoming edges
 *     (`value = Σ delivered/dt`). A node with *no* incoming edges is treated as
 *     an exogenous driver and held at its `initial_value` (e.g. customer
 *     demand).
 *   - An edge carries a rate `rate = polarity_sign * strength * source_value`.
 *   - A **delayed edge** is a FIFO pipeline: `slots = ceil(magnitude / dt)`
 *     buckets. Each step the source pushes `rate*dt` onto the back and the
 *     front bucket is delivered to the target. A non-delayed edge delivers
 *     `rate*dt` to the target in the same step.
 *   - Mass conservation on a closed system holds by construction: a stock
 *     loses `rate*dt` to every outgoing edge (into the queue if delayed, to the
 *     target if not) and gains the delivered amount from every incoming edge.
 *     In-flight material lives in the queues, which are observable in
 *     `SimState.delayQueues` (this is what Phase 2 §2.4 needs for Throughput
 *     Accounting and reject-and-backpressure).
 *
 * Collars ARE enforced here (Phase 2). Each node's optional `collar` block
 * (physical lower/upper bounds in the node's own units) is applied inside
 * `stepEuler`: the state is clamped after the derivative is computed, with
 * anti-windup (excess does not accumulate) and reject-and-backpressure (excess
 * returns to delay queues or stays with the source). A collar-free node behaves
 * exactly as it did in Phase 1.
 *
 * The engine is pure: given the same `(graph, state, opts)` it produces the
 * same next state. No hidden time, no RNG. A `SimState` is a value object the
 * caller threads through `step` (or owns via the `createEngine` wrapper).
 */

import type { Edge, Graph, Node } from "@/model/types";
import { computeBoundary } from "@/model/boundary";

export type IntegratorMethod = "euler" | "rk4";

/** The single dynamical state of the system. A value object. */
export interface SimState {
  /** Elapsed model time. */
  t: number;
  /** node id -> current value, in physical units. */
  values: Record<string, number>;
  /** Per-step value history, node id -> chronological samples (oldest first). */
  history: Record<string, number[]>;
  /** edge id -> FIFO pipeline contents (front = next to deliver). Empty/absent for non-delayed edges. */
  delayQueues: Record<string, number[]>;
  /**
   * node id -> current collar pin state, populated in Phase 2. Always null in
   * Phase 1. Present now so the SimState shape is stable across the migration.
   */
  pinned: Record<string, "lower" | "upper" | null>;
}

export interface EngineOptions {
  /** Step size in model time units. */
  dt: number;
  /** Integration method. For Phase 1's linear stock dynamics euler and rk4
   * coincide; rk4's 4th-order value arrives in Phase 2 at collar boundaries. */
  integrator: IntegratorMethod;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = { dt: 0.1, integrator: "rk4" };

/** Cap on retained history length to keep memory bounded for long runs. */
const HISTORY_CAP = 2000;

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

/**
 * Build the initial state from a Graph: every node at its `initial_value`, and
 * every delayed edge's pipeline pre-filled with the steady-state rate so the
 * system starts in equilibrium at t=0 (mass already in transit). This mirrors
 * the integrator's seeding and makes conservation tests clean.
 */
export function initialState(graph: Graph, opts: EngineOptions): SimState {
  const values: Record<string, number> = {};
  const history: Record<string, number[]> = {};
  for (const n of graph.nodes) {
    values[n.id] = n.initial_value;
    history[n.id] = [n.initial_value];
  }
  const delayQueues: Record<string, number[]> = {};
  const slotsByEdge = computeSlots(graph, opts.dt);
  for (const e of graph.edges) {
    const slots = slotsByEdge[e.id];
    if (slots > 0) {
      const rate = edgeRate(e, values);
      delayQueues[e.id] = new Array<number>(slots).fill(rate * opts.dt);
    }
  }
  const pinned: Record<string, "lower" | "upper" | null> = {};
  for (const n of graph.nodes) pinned[n.id] = null;
  return { t: 0, values, history, delayQueues, pinned };
}

// ---------------------------------------------------------------------------
// Stepping
// ---------------------------------------------------------------------------

/** Advance the state by one step. Pure: returns a new state, never mutates. */
export function step(graph: Graph, state: SimState, opts: EngineOptions): SimState {
  return opts.integrator === "rk4" ? stepRK4(graph, state, opts) : stepEuler(graph, state, opts);
}

/** Run `steps` steps, collecting the trajectory (length steps+1, state at t=0 first). Pure. */
export function run(graph: Graph, state: SimState, opts: EngineOptions, steps: number): SimState[] {
  const out: SimState[] = [state];
  let s = state;
  for (let i = 0; i < steps; i++) {
    s = step(graph, s, opts);
    out.push(s);
  }
  return out;
}

/**
 * The canonical discrete advance (one Euler step). This is the only place the
 * FIFO pipelines move, the only place stock/flow values change, and — from
 * Phase 2 — the only place collars are enforced.
 *
 * Collar enforcement (spec §2.3):
 *   - **Clamp the state, not the derivative.** The derivative (rates, delivers)
 *     is computed normally; the resulting state is then bounded.
 *   - **Anti-windup is mandatory.** If a stock is pinned at its upper collar
 *     and inflow continues, the excess does NOT accumulate. For delayed edges
 *     the rejected material goes back to the front of the pipeline
 *     (reject-and-backpressure, §2.4). For non-delayed edges the source stock
 *     keeps the undelivered material. A lower-pinned stock's excess outflow
 *     simply does not happen — no phantom lag.
 *   - **Event detection.** The exact excess is computed and distributed back
 *     proportionally, so the stock lands on the boundary, not past it.
 */
function stepEuler(graph: Graph, state: SimState, opts: EngineOptions): SimState {
  const dt = opts.dt;
  const slotsByEdge = computeSlots(graph, dt);
  // Current edge rates, computed from start-of-step values.
  const rates: Record<string, number> = {};
  for (const e of graph.edges) rates[e.id] = edgeRate(e, state.values);

  // Phase 1: pop queue fronts (potential deliver); do NOT push backs yet.
  const delayQueues: Record<string, number[]> = {};
  const potentialDeliver: Record<string, number> = {};
  const isDelayed: Record<string, boolean> = {};
  for (const e of graph.edges) {
    const slots = slotsByEdge[e.id];
    if (slots > 0) {
      isDelayed[e.id] = true;
      const q = state.delayQueues[e.id] ? state.delayQueues[e.id].slice() : new Array<number>(slots).fill(0);
      while (q.length < slots) q.unshift(0);
      potentialDeliver[e.id] = q.shift() ?? 0;
      delayQueues[e.id] = q; // queue without front; back pushed later
    } else {
      isDelayed[e.id] = false;
      potentialDeliver[e.id] = rates[e.id] * dt;
    }
  }

  const incomingByNode = groupIncoming(graph);
  const outgoingByNode = groupOutgoing(graph);

  // Phase 2: compute candidate stock values (pre-clamp).
  // For `approach: "soft"` collars, scale incoming transfer by a smooth ramp
  // that reaches zero at the upper boundary (Phase 7 §7.1). This makes the
  // stock approach the ceiling asymptotically — continuously differentiable,
  // no kink. The hard clamp in Phase 3 remains as a safety net.
  const stockCandidates: Record<string, number> = {};
  for (const n of graph.nodes) {
    if (n.type !== "stock") continue;
    const prev = state.values[n.id] ?? 0;
    let totalIn = 0;
    const incoming = incomingByNode.get(n.id) ?? [];
    const softFactor = softInflowFactor(n, prev);
    for (const e of incoming) totalIn += potentialDeliver[e.id] * softFactor;
    let totalOut = 0;
    for (const e of outgoingByNode.get(n.id) ?? []) totalOut += rates[e.id] * dt;
    stockCandidates[n.id] = prev + totalIn - totalOut;
  }

  // Phase 3: enforce upper collars (backpressure) and lower collars (cap
  // outflow). Adjust delivers and outflows; excess goes back to queues or
  // stays with the source. This is the event-detection step: compute the
  // exact crossing and handle the excess, rather than naive post-clip.
  const actualDeliver: Record<string, number> = { ...potentialDeliver };
  const actualOutflow: Record<string, number> = {};
  for (const e of graph.edges) actualOutflow[e.id] = rates[e.id] * dt;
  // Track which nodes were clamped in Phase 3 so Phase 4 can mark them pinned
  // even when the adjusted candidate lands exactly on the boundary (==, not >).
  const clampedUpper = new Set<string>();
  const clampedLower = new Set<string>();

  for (const n of graph.nodes) {
    if (n.type !== "stock") continue;
    const candidate = stockCandidates[n.id];
    const collar = n.collar;
    if (!collar) continue;
    if (collar.upper !== undefined && candidate > collar.upper) {
      clampedUpper.add(n.id);
      // Backpressure: reduce incoming delivers so the stock lands on upper.
      const excess = candidate - collar.upper;
      const incoming = incomingByNode.get(n.id) ?? [];
      let totalIn = 0;
      for (const e of incoming) totalIn += potentialDeliver[e.id];
      if (totalIn > 0) {
        const rejectFraction = Math.min(1, excess / totalIn);
        for (const e of incoming) {
          const rejected = actualDeliver[e.id] * rejectFraction;
          actualDeliver[e.id] -= rejected;
          if (isDelayed[e.id]) {
            // Material stays in the pipeline (reject-and-backpressure, §2.4).
            delayQueues[e.id].unshift(rejected);
          }
          // For non-delayed edges, the source keeps the undelivered material:
          // actualOutflow will be synced to actualDeliver below.
        }
      }
    } else if (collar.lower !== undefined && candidate < collar.lower) {
      clampedLower.add(n.id);
      // Cap outflow so the stock lands on lower. The excess outflow simply
      // does not happen — no phantom lag, no windup (§2.3 anti-windup).
      const excess = collar.lower - candidate;
      const outgoing = outgoingByNode.get(n.id) ?? [];
      let totalOut = 0;
      for (const e of outgoing) totalOut += rates[e.id] * dt;
      if (totalOut > 0) {
        const rejectFraction = Math.min(1, excess / totalOut);
        for (const e of outgoing) {
          actualOutflow[e.id] -= actualOutflow[e.id] * rejectFraction;
        }
      }
    }
  }

  // For non-delayed edges, outflow = deliver (the same flow seen from both
  // ends). Sync after backpressure adjustments so conservation holds: the
  // source only loses what the target actually absorbed.
  for (const e of graph.edges) {
    if (!isDelayed[e.id]) {
      const min = Math.min(actualDeliver[e.id], actualOutflow[e.id]);
      actualDeliver[e.id] = min;
      actualOutflow[e.id] = min;
    }
  }

  // Phase 4: compute final values from adjusted delivers/outflows, and
  // apply a final clamp (handles any residual from proportional rounding).
  // A node clamped in Phase 3 is marked pinned even if the adjusted candidate
  // lands exactly on the boundary (==, not >), because backpressure held it there.
  const values: Record<string, number> = {};
  const pinned: Record<string, "lower" | "upper" | null> = {};
  for (const n of graph.nodes) {
    const prev = state.values[n.id] ?? 0;
    if (n.type === "stock") {
      let totalIn = 0;
      for (const e of incomingByNode.get(n.id) ?? []) totalIn += actualDeliver[e.id];
      let totalOut = 0;
      for (const e of outgoingByNode.get(n.id) ?? []) totalOut += actualOutflow[e.id];
      let candidate = prev + totalIn - totalOut;
      const collar = n.collar;
      if (collar?.upper !== undefined && (candidate > collar.upper || clampedUpper.has(n.id))) {
        candidate = collar.upper;
        pinned[n.id] = "upper";
      } else if (collar?.lower !== undefined && (candidate < collar.lower || clampedLower.has(n.id))) {
        candidate = collar.lower;
        pinned[n.id] = "lower";
      } else {
        pinned[n.id] = null;
      }
      values[n.id] = candidate;
    } else {
      const incoming = incomingByNode.get(n.id) ?? [];
      if (incoming.length === 0) {
        values[n.id] = prev; // exogenous driver: hold initial_value
      } else {
        let v = 0;
        for (const e of incoming) v += actualDeliver[e.id];
        values[n.id] = v / dt;
      }
      // Apply collars to flow/auxiliary nodes too.
      const collar = n.collar;
      if (collar?.upper !== undefined && values[n.id] > collar.upper) {
        values[n.id] = collar.upper;
        pinned[n.id] = "upper";
      } else if (collar?.lower !== undefined && values[n.id] < collar.lower) {
        values[n.id] = collar.lower;
        pinned[n.id] = "lower";
      } else {
        pinned[n.id] = null;
      }
    }
  }

  // Phase 5: push new chunks to queue backs (using actual outflow, so a
  // lower-pinned source pushes less into the pipeline).
  for (const e of graph.edges) {
    if (isDelayed[e.id]) {
      delayQueues[e.id].push(actualOutflow[e.id]);
    }
  }

  const history = appendHistory(state.history, values, graph);
  return { t: state.t + dt, values, history, delayQueues, pinned };
}

/**
 * RK4 on the stock ODE sub-system. Phase 2's collar clamps introduce a
 * non-linearity (a kink at the boundary). The current implementation delegates
 * to Euler because the FIFO-queue-fed stock dynamics are linear between
 * collar events, and the clamp is handled inside the Euler step's enforcement
 * phase. True 4th-order staging across the kink would require sub-stepping
 * to the event and is deferred. Per spec §2.3: when a node is pinned under
 * RK4, accuracy is reduced at the boundary — the UI should warn.
 */
function stepRK4(graph: Graph, state: SimState, opts: EngineOptions): SimState {
  return stepEuler(graph, state, opts);
}

// ---------------------------------------------------------------------------
// Impulse / set value (used by L1 nudge and L3 intervention alike)
// ---------------------------------------------------------------------------

/** Return a copy of `state` with `values[nodeId] += delta`. Pure. */
export function impulse(state: SimState, nodeId: string, delta: number): SimState {
  return setValue(state, nodeId, (state.values[nodeId] ?? 0) + delta);
}

/** Return a copy of `state` with `values[nodeId] = value`. Pure.
 * Does not append a history sample; the next `step` records the trajectory. */
export function setValue(state: SimState, nodeId: string, value: number): SimState {
  const values = { ...state.values };
  values[nodeId] = value;
  return { ...state, values };
}

// ---------------------------------------------------------------------------
// Equilibrium / operating point
// ---------------------------------------------------------------------------

/**
 * Estimate the system's operating point: run from the initial state for a
 * burn-in, then return the per-node mean over a trailing window. For a
 * converging system this is the true equilibrium; for an oscillating or
 * amplifying system it is the mean around which deviations should be measured
 * (used by Layer 1 to colour value circles by sign of deviation). Deterministic.
 */
export function equilibrium(
  graph: Graph,
  opts: EngineOptions,
  steps = 2000,
  window = 500,
): Record<string, number> {
  const traj = run(graph, initialState(graph, opts), opts, steps);
  const start = Math.max(0, traj.length - window);
  const sums: Record<string, number> = {};
  for (const n of graph.nodes) sums[n.id] = 0;
  for (let i = start; i < traj.length; i++) {
    for (const n of graph.nodes) sums[n.id] += traj[i].values[n.id] ?? 0;
  }
  const count = Math.max(1, traj.length - start);
  const out: Record<string, number> = {};
  for (const n of graph.nodes) out[n.id] = sums[n.id] / count;
  return out;
}

// ---------------------------------------------------------------------------
// Observables
// ---------------------------------------------------------------------------

/** Total conserved mass: stock values + material resident in delay queues. */
export function totalMass(graph: Graph, state: SimState): number {
  let m = 0;
  for (const n of graph.nodes) if (n.type === "stock") m += state.values[n.id] ?? 0;
  for (const q of Object.values(state.delayQueues)) for (const v of q) m += v;
  return m;
}

/**
 * Degrees of freedom: the count of nodes NOT currently pinned at a collar.
 * Every pinned node is a lost dimension — the constraint is precisely the
 * dimension that was lost. This tells an architect how much room the system
 * has left. Unbounded nodes (no collar) are always free.
 */
export function degreesOfFreedom(graph: Graph, state: SimState): number {
  let free = 0;
  for (const n of graph.nodes) {
    const p = state.pinned[n.id];
    if (p === null || p === undefined) free++;
  }
  return free;
}

/**
 * Headroom for a single node: `(upper - current) / (upper - lower)` as a
 * fraction in [0,1]. 1 = at the lower bound (full room above); 0 = at the
 * upper bound (no room). Returns null for unbounded nodes.
 */
export function headroom(node: Node, value: number): number | null {
  const c = node.collar;
  if (!c || c.upper === undefined || c.lower === undefined) return null;
  const span = c.upper - c.lower;
  if (span <= 0) return null;
  return Math.max(0, Math.min(1, (c.upper - value) / span));
}

/**
 * T/I/OE snapshot — derived from the system boundary + topology (Phase 3),
 * NOT from a hand-authored tag. See `deriveTioe` for the derivation rules.
 */
export interface TioeSnapshot {
  T: number;
  I: number;
  OE: number;
}

/**
 * Derive Throughput / Inventory / Operating Expense from the graph topology +
 * system boundary + simulation state. This replaces the Phase-1 `tioeOf`
 * fallback that summed values by a hand-authored `tioe_class` tag.
 *
 * Derivation (Theory of Constraints, adapted for a flow model):
 *
 *   - **T (Throughput)** — the rate at which the system exchanges value with
 *     its environment. This is the sum of absolute rates on boundary-crossing
 *     edges. For a model with outbound edges (inside → boundary), T = sum of
 *     those rates (the system delivering to the market). For a model with only
 *     inbound edges (boundary → inside, e.g. demand driving the system), T =
 *     the inbound rate — the demand rate IS the throughput target. When both
 *     exist, T = outbound rate (actual delivery), and the inbound rate is a
 *     separate observable (target throughput).
 *
 *   - **I (Inventory / Investment)** — the total mass tied up inside the
 *     system: sum of all inside stock values + all material resident in delay
 *     queues of edges between inside nodes. This is the "investment" the
 *     system carries to generate throughput.
 *
 *   - **OE (Operating Expense)** — the rate of resource consumption at
 *     constrained resources. For a collared stock with a declared
 *     `capacity_cost`, OE counts that fixed cost (the cost of *having* the
 *     capacity, independent of utilization) — so Exploit (collar fixed) holds
 *     OE flat and Elevate (collar moved, cost scaled) raises OE. When no
 *     `capacity_cost` is declared, OE falls back to the flow through the
 *     collared stock (the sum of its incoming edge rates — the Phase 3
 *     utilization proxy). If no nodes are collared, OE = 0.
 *
 * All three are derived, not annotated. The boundary is computed from the
 * graph (see `src/model/boundary.ts`); the stock/queue mass and edge rates
 * are read from the simulation state.
 */
export function deriveTioe(graph: Graph, state: SimState): TioeSnapshot {
  const boundary = computeBoundary(graph);

  // --- T (Throughput) ---
  // Prefer outbound boundary-crossing rates (system delivering to market).
  // If none, use inbound rates (demand driving the system = target throughput).
  let outboundT = 0;
  let inboundT = 0;
  for (const e of graph.edges) {
    const srcIn = !boundary.has(e.source);
    const tgtIn = !boundary.has(e.target);
    if (srcIn && !tgtIn) {
      outboundT += Math.abs(edgeRate(e, state.values));
    } else if (!srcIn && tgtIn) {
      inboundT += Math.abs(edgeRate(e, state.values));
    }
  }
  const T = outboundT > 0 ? outboundT : inboundT;

  // --- I (Inventory / Investment) ---
  // Sum of inside stock values + in-flight queue mass of edges whose target
  // is inside (material heading into or within the system). Edges between two
  // boundary nodes are entirely outside the system.
  let I = 0;
  for (const n of graph.nodes) {
    if (boundary.has(n.id)) continue;
    if (n.type === "stock") I += state.values[n.id] ?? 0;
  }
  for (const e of graph.edges) {
    if (boundary.has(e.target)) continue;
    const q = state.delayQueues[e.id];
    if (q) for (const v of q) I += v;
  }

  // --- OE (Operating Expense) ---
  // For each inside collared node with a declared `capacity_cost`: that fixed
  // cost (utilization-independent) is the OE — so Exploit (collar fixed) holds
  // OE flat and Elevate (collar moved, cost scaled) raises OE. For collared
  // STOCKS without a declared cost, fall back to the flow through the
  // constraint (sum of incoming rates — the Phase 3 utilization proxy).
  let OE = 0;
  const incomingByNode = groupIncoming(graph);
  for (const n of graph.nodes) {
    if (boundary.has(n.id)) continue;
    if (!n.collar) continue;
    if (n.capacity_cost !== undefined) {
      OE += n.capacity_cost;
      continue;
    }
    if (n.type !== "stock") continue;
    for (const e of incomingByNode.get(n.id) ?? []) {
      if (boundary.has(e.source)) continue;
      OE += Math.abs(edgeRate(e, state.values));
    }
  }

  return { T, I, OE };
}

// ---------------------------------------------------------------------------
// Stateful Engine wrapper (used by L1's live animation)
// ---------------------------------------------------------------------------

export interface Engine {
  readonly graph: Graph;
  readonly opts: EngineOptions;
  /** The current state. Replaced (not mutated) on each step. */
  state: SimState;
  /** Advance one step; updates and returns `state`. */
  step(): SimState;
  /** Run `n` steps, returning the trajectory. */
  run(n: number): SimState[];
  /** Reset to the graph's initial state. */
  reset(): void;
  /** Apply an additive impulse to a node's value (the L1 nudge / L3 Δ). */
  impulse(nodeId: string, delta: number): void;
  /** Set a node's value absolutely. */
  setValue(nodeId: string, value: number): void;
  /** The operating-point estimate (cached after first call). */
  equilibrium(): Record<string, number>;
}

export function createEngine(graph: Graph, opts: EngineOptions): Engine {
  const engine: Engine = {
    graph,
    opts,
    state: initialState(graph, opts),
    step() {
      this.state = step(this.graph, this.state, this.opts);
      return this.state;
    },
    run(n) {
      return run(this.graph, this.state, this.opts, n);
    },
    reset() {
      this.state = initialState(this.graph, this.opts);
    },
    impulse(nodeId, delta) {
      this.state = impulse(this.state, nodeId, delta);
    },
    setValue(nodeId, value) {
      this.state = setValue(this.state, nodeId, value);
    },
    equilibrium() {
      return equilibrium(this.graph, this.opts);
    },
  };
  return engine;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Number of pipeline buckets for an edge's delay at step size `dt`. */
export function computeSlots(graph: Graph, dt: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of graph.edges) {
    out[e.id] = e.delay.magnitude > 0 ? Math.max(1, Math.round(e.delay.magnitude / dt)) : 0;
  }
  return out;
}

/** Signed rate carried by an edge from the current values. */
export function edgeRate(e: Edge, values: Record<string, number>): number {
  const sign = e.polarity === "+" ? 1 : -1;
  return sign * e.strength * (values[e.source] ?? 0);
}

function groupIncoming(graph: Graph): Map<string, Edge[]> {
  const m = new Map<string, Edge[]>();
  for (const e of graph.edges) {
    const list = m.get(e.target) ?? [];
    list.push(e);
    m.set(e.target, list);
  }
  return m;
}

function groupOutgoing(graph: Graph): Map<string, Edge[]> {
  const m = new Map<string, Edge[]>();
  for (const e of graph.edges) {
    const list = m.get(e.source) ?? [];
    list.push(e);
    m.set(e.source, list);
  }
  return m;
}

/**
 * Append a per-node value snapshot to history. When `graph` is provided the
 * node set is taken from it; otherwise the existing history keys are used.
 * History is capped to `HISTORY_CAP` samples (FIFO).
 */
function appendHistory(
  history: Record<string, number[]>,
  values: Record<string, number>,
  graph: Graph | undefined,
): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  const ids = graph ? graph.nodes.map((n) => n.id) : Object.keys(history);
  for (const id of ids) {
    const prev = history[id] ? history[id].slice() : [];
    prev.push(values[id] ?? 0);
    while (prev.length > HISTORY_CAP) prev.shift();
    out[id] = prev;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phase 7: soft collar approach + Little's Law
// ---------------------------------------------------------------------------

/**
 * Soft inflow scaling factor for a collared stock (Phase 7 §7.1). When
 * `approach: "soft"` and the current value is in the top 10% of the collar
 * span, returns a smooth ramp from 1 (at the 90% mark) to 0 (at the upper
 * boundary). Uses a half-cosine: `0.5 * (1 + cos(pi * progress))`, which is
 * continuously differentiable at both ends. For `approach: "hard"` or when the
 * value is below the soft zone, returns 1 (no scaling).
 */
export function softInflowFactor(node: Node, value: number): number {
  const c = node.collar;
  if (!c || c.approach !== "soft" || c.upper === undefined) return 1;
  const lower = c.lower ?? 0;
  const span = c.upper - lower;
  if (span <= 0) return 1;
  const softStart = c.upper - 0.1 * span; // top 10% of the span
  if (value < softStart) return 1;
  if (value >= c.upper) return 0;
  const progress = (value - softStart) / (0.1 * span); // 0..1 in the soft zone
  return 0.5 * (1 + Math.cos(Math.PI * progress));
}

/**
 * Little's Law per internal stock (Phase 7 §7.2). For each inside stock node:
 *   - **L** = stock level + material resident in delay queues feeding it
 *   - **λ** (lambda) = throughput rate through the stock = sum of outgoing edge rates
 *   - **W** = L / λ  (wait time / residence time)
 *   - **ρ** (rho) = current / upper collar  (utilisation; exact with physical collars)
 *
 * Pure: a projection over `(graph, state)`. Returns null for λ or ρ when the
 * values are undefined or the denominator is zero.
 */
export interface LittleLawEntry {
  nodeId: string;
  label: string;
  L: number;
  lambda: number;
  W: number | null;
  rho: number | null;
}

export function littleLaw(graph: Graph, state: SimState): LittleLawEntry[] {
  const boundary = computeBoundary(graph);
  const incoming = groupIncoming(graph);
  const outgoing = groupOutgoing(graph);
  const entries: LittleLawEntry[] = [];
  for (const n of graph.nodes) {
    if (boundary.has(n.id)) continue;
    if (n.type !== "stock") continue;
    const L = state.values[n.id] ?? 0;
    // Queue contents feeding this stock.
    let queueMass = 0;
    for (const e of incoming.get(n.id) ?? []) {
      const q = state.delayQueues[e.id];
      if (q) for (const v of q) queueMass += v;
    }
    const totalL = L + queueMass;
    // λ = sum of outgoing edge rates (throughput through this stock).
    let lambda = 0;
    for (const e of outgoing.get(n.id) ?? []) {
      lambda += Math.abs(edgeRate(e, state.values));
    }
    const W = lambda > 0 ? totalL / lambda : null;
    const rho = n.collar?.upper !== undefined ? (state.values[n.id] ?? 0) / n.collar.upper : null;
    entries.push({ nodeId: n.id, label: n.label, L: totalL, lambda, W, rho });
  }
  return entries;
}

/**
 * Utilisation curve point for the "you are here" marker (Phase 7 §7.3).
 * Returns W as a function of ρ: `W ∝ ρ/(1−ρ)`. At ρ=0 W=0; as ρ→1 W→∞.
 * Returns null for ρ >= 1 (beyond the knee — the system is saturated).
 */
export function utilisationW(rho: number): number | null {
  if (rho < 0 || rho >= 1) return null;
  return rho / (1 - rho);
}

/**
 * Sample the utilisation curve at `n` points in [0, 1) for the chart.
 * Returns arrays of { rho, W } for plotting.
 */
export function utilisationCurve(n = 50): { rho: number; W: number }[] {
  const pts: { rho: number; W: number }[] = [];
  for (let i = 0; i < n; i++) {
    const rho = i / n; // 0, 1/n, 2/n, ... (n-1)/n — never reaches 1
    const W = utilisationW(rho);
    if (W !== null) pts.push({ rho, W });
  }
  return pts;
}
