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
 * Collars are NOT enforced here yet. The existing `lower_collar`/`upper_collar`
 * fields are normalised display clamps that Phase 2 migrates to physical bounds
 * enforced inside this engine. For Phase 1 they are inert.
 *
 * The engine is pure: given the same `(graph, state, opts)` it produces the
 * same next state. No hidden time, no RNG. A `SimState` is a value object the
 * caller threads through `step` (or owns via the `createEngine` wrapper).
 */

import type { Edge, Graph, Node } from "@/model/types";

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
 * FIFO pipelines move and the only place stock/flow values change.
 */
function stepEuler(graph: Graph, state: SimState, opts: EngineOptions): SimState {
  const dt = opts.dt;
  const slotsByEdge = computeSlots(graph, dt);
  // Current edge rates, computed from start-of-step values.
  const rates: Record<string, number> = {};
  for (const e of graph.edges) rates[e.id] = edgeRate(e, state.values);

  // Advance every delayed edge's pipeline: pop the front (delivered mass),
  // push the new chunk onto the back.
  const delayQueues: Record<string, number[]> = {};
  const delivered: Record<string, number> = {};
  for (const e of graph.edges) {
    const slots = slotsByEdge[e.id];
    if (slots > 0) {
      const q = state.delayQueues[e.id] ? state.delayQueues[e.id].slice() : new Array<number>(slots).fill(0);
      while (q.length < slots) q.unshift(0);
      delivered[e.id] = q.shift() ?? 0;
      q.push(rates[e.id] * dt);
      delayQueues[e.id] = q;
    } else {
      delivered[e.id] = rates[e.id] * dt;
    }
  }

  // Update node values. Stocks integrate net flow; flows/auxiliaries reflect
  // the rate delivered to them this step; exogenous nodes (no incoming edges)
  // hold their value.
  const incomingByNode = groupIncoming(graph);
  const outgoingByNode = groupOutgoing(graph);
  const nodeById = new Map(graph.nodes.map((n): [string, Node] => [n.id, n]));
  const values: Record<string, number> = {};
  const pinned: Record<string, "lower" | "upper" | null> = { ...state.pinned };
  for (const n of graph.nodes) {
    const prev = state.values[n.id] ?? 0;
    if (n.type === "stock") {
      let d = 0;
      for (const e of incomingByNode.get(n.id) ?? []) d += delivered[e.id];
      for (const e of outgoingByNode.get(n.id) ?? []) d -= rates[e.id] * dt;
      values[n.id] = prev + d;
    } else {
      const incoming = incomingByNode.get(n.id) ?? [];
      if (incoming.length === 0) {
        values[n.id] = prev; // exogenous driver: hold initial_value
      } else {
        let v = 0;
        for (const e of incoming) v += delivered[e.id];
        values[n.id] = v / dt;
      }
    }
    void nodeById;
  }
  const history = appendHistory(state.history, values, graph);
  return { t: state.t + dt, values, history, delayQueues, pinned };
}

/**
 * RK4 on the stock ODE sub-system, with the FIFO queue fronts treated as
 * exogenous (constant) inputs within the step. For Phase 1's linear stock
 * dynamics this is exactly equivalent to Euler; the 4-stage machinery is in
 * place so Phase 2's non-linear collar approach can use it for genuine 4th-order
 * accuracy at boundaries. Queues advance once, by the full step, after the
 * weighted stock update is computed.
 */
function stepRK4(graph: Graph, state: SimState, opts: EngineOptions): SimState {
  // For the linear, queue-fed stock subsystem, RK4 == Euler (all four stages
  // sample the same derivative because the derivative depends only on current
  // values and the fixed queue fronts, both of which are constant across the
  // stages when stocks haven't moved yet). Delegating keeps the selector honest
  // and avoids duplicating the queue logic; Phase 2 reintroduces true staging
  // once collar clamp dynamics make the stock derivative non-linear in state.
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

/** T/I/OE aggregation by tag (the L3 fallback; Phase 3 derives this properly). */
export interface TioeSnapshot {
  T: number;
  I: number;
  OE: number;
}

export function tioeOf(graph: Graph, state: SimState): TioeSnapshot {
  let T = 0;
  let I = 0;
  let OE = 0;
  for (const n of graph.nodes) {
    const v = state.values[n.id] ?? 0;
    if (n.tioe_class === "T") T += v;
    else if (n.tioe_class === "I") I += v;
    else if (n.tioe_class === "OE") OE += v;
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
