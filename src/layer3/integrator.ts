/**
 * Layer 3 — stock-flow integrator (spec §4).
 *
 * A lightweight, framework-agnostic integration engine over the graph's
 * stock-flow structure. Stocks accumulate; flows are rates; delayed edges are
 * modeled as first-order exponential delays (a single state variable per delay
 * with `dx/dt = (input - x)/tau`). This is deliberately NOT a full financial
 * model — per spec §4, "attribution + simulated directional delta is the right
 * scope."
 *
 * The integrator is pure: given the same `(graph, state, dt, method)` it
 * produces the same next state. There is no internal time accumulation or
 * hidden RNG; callers own the stepping. This makes it unit-testable and lets
 * the sparkline UI step deterministically.
 *
 * Architecture rule: this module holds no state. A `SimState` is a value object
 * the caller threads through `step()`.
 */

import type { Edge, Graph, Node, TioeClass } from "@/model/types";

export type IntegratorMethod = "euler" | "rk4";

/** A flat state vector: node values + one delayed-state per delayed edge. */
export interface SimState {
  /** node id -> current value */
  values: Map<string, number>;
  /** edge id -> delayed-state value (the "in-flight" quantity for that edge) */
  delays: Map<string, number>;
  /** Elapsed model time. */
  t: number;
}

export interface IntegratorOptions {
  /** Step size in model time units. */
  dt: number;
  method: IntegratorMethod;
}

export const DEFAULT_INTEGRATOR_OPTIONS: IntegratorOptions = {
  dt: 0.1,
  method: "rk4",
};

/**
 * Build the initial state from a Graph: each node starts at its
 * `initial_value`, and each delayed edge starts with its delay-state equal to
 * the source node's initial value (so the system is in steady state at t=0 if
 * nothing is perturbed — convenient for mass-conservation tests).
 */
export function initialState(graph: Graph): SimState {
  const values = new Map<string, number>();
  for (const n of graph.nodes) values.set(n.id, n.initial_value);
  const delays = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.delay.magnitude > 0) {
      delays.set(e.id, values.get(e.source) ?? 0);
    }
  }
  return { values, delays, t: 0 };
}

/** Advance the state by one step. Pure: returns a new state, does not mutate. */
export function step(graph: Graph, state: SimState, opts: IntegratorOptions): SimState {
  if (opts.method === "rk4") return stepRK4(graph, state, opts);
  return stepEuler(graph, state, opts);
}

/**
 * Run the integrator for `steps` steps, collecting a trajectory of states.
 * Pure: same inputs -> identical trajectory.
 */
export function run(
  graph: Graph,
  state: SimState,
  opts: IntegratorOptions,
  steps: number,
): SimState[] {
  const out: SimState[] = [state];
  let s = state;
  for (let i = 0; i < steps; i++) {
    s = step(graph, s, opts);
    out.push(s);
  }
  return out;
}

// --- derivatives --------------------------------------------------------

/**
 * Compute the time-derivative of every state variable, given the current
 * state. This is the f(t, y) that both Euler and RK4 evaluate.
 *
 * Semantics:
 *   - A node's value is its current quantity.
 *   - An edge A -> B conveys flow from A to B, scaled by `strength` and the
 *     edge's polarity (a `-` edge subtracts at the source and adds at the
 *     target, modeling an inverse relationship).
 *   - For delayed edges, the flow out of the source enters a delay state, and
 *     the delay state flows into the target. The delay-state's dynamics are
 *     `d/dt = (input - delayState) / tau` (first-order exponential delay). For
 *     non-delayed edges, flow goes directly A -> B.
 *   - Stocks accumulate the net flow; flows/auxiliaries simply hold the
 *     computed value (no accumulation) — they serve as conduits.
 *
 * For mass conservation on a closed system (no source/sink), every unit that
 * leaves a source arrives at a target, possibly with a delay. The test fixture
 * in `layer3.test.ts` verifies this to within 1e-6 over 1000 RK4 steps.
 */
export function derivatives(
  graph: Graph,
  state: SimState,
): { dValues: Map<string, number>; dDelays: Map<string, number> } {
  const dValues = new Map<string, number>();
  const dDelays = new Map<string, number>();
  for (const n of graph.nodes) dValues.set(n.id, 0);
  for (const e of graph.edges) if (e.delay.magnitude > 0) dDelays.set(e.id, 0);

  const nodeById = new Map(graph.nodes.map((n): [string, Node] => [n.id, n]));

  for (const e of graph.edges) {
    const srcVal = state.values.get(e.source) ?? 0;
    const mag = e.strength;
    const sign = e.polarity === "+" ? 1 : -1;
    const isStock = (id: string) => nodeById.get(id)?.type === "stock";

    if (e.delay.magnitude > 0) {
      // First-order exponential delay: source -> delayState -> target.
      const tau = Math.max(e.delay.magnitude, 1e-9);
      const dState = state.delays.get(e.id) ?? 0;
      // Flow from source into the delay state. Source loses, delay gains.
      const inflow = (sign * srcVal * mag) / tau;
      // Delay-state dynamics: relax toward the signed input.
      dDelays.set(e.id, (dDelays.get(e.id) ?? 0) + (inflow - dState / tau));
      if (isStock(e.source)) {
        dValues.set(e.source, (dValues.get(e.source) ?? 0) - inflow);
      }
      if (isStock(e.target)) {
        dValues.set(e.target, (dValues.get(e.target) ?? 0) + dState / tau);
      }
    } else {
      // No delay: direct flow source -> target.
      const flow = sign * srcVal * mag;
      if (isStock(e.source)) {
        dValues.set(e.source, (dValues.get(e.source) ?? 0) - flow);
      }
      if (isStock(e.target)) {
        dValues.set(e.target, (dValues.get(e.target) ?? 0) + flow);
      }
      // Non-stock (flow/auxiliary) nodes reflect the value rather than
      // accumulate; they don't gain/lose mass.
    }
  }

  return { dValues, dDelays };
}

// --- integrators --------------------------------------------------------

function stepEuler(graph: Graph, state: SimState, opts: IntegratorOptions): SimState {
  const { dValues, dDelays } = derivatives(graph, state);
  return applyDelta(state, dValues, dDelays, opts.dt);
}

function stepRK4(graph: Graph, state: SimState, opts: IntegratorOptions): SimState {
  const dt = opts.dt;
  const k1 = derivatives(graph, state);
  const k2 = derivatives(graph, applyDelta(state, k1.dValues, k1.dDelays, dt / 2));
  const k3 = derivatives(graph, applyDelta(state, k2.dValues, k2.dDelays, dt / 2));
  const k4 = derivatives(graph, applyDelta(state, k3.dValues, k3.dDelays, dt));

  const dValues = new Map<string, number>();
  const dDelays = new Map<string, number>();
  for (const id of state.values.keys()) {
    const a = k1.dValues.get(id) ?? 0;
    const b = k2.dValues.get(id) ?? 0;
    const c = k3.dValues.get(id) ?? 0;
    const d = k4.dValues.get(id) ?? 0;
    dValues.set(id, (dt / 6) * (a + 2 * b + 2 * c + d));
  }
  for (const id of state.delays.keys()) {
    const a = k1.dDelays.get(id) ?? 0;
    const b = k2.dDelays.get(id) ?? 0;
    const c = k3.dDelays.get(id) ?? 0;
    const d = k4.dDelays.get(id) ?? 0;
    dDelays.set(id, (dt / 6) * (a + 2 * b + 2 * c + d));
  }
  return applyDelta(state, dValues, dDelays, 1);
}

function applyDelta(
  state: SimState,
  dValues: Map<string, number>,
  dDelays: Map<string, number>,
  scale: number,
): SimState {
  const values = new Map<string, number>();
  for (const [id, v] of state.values) values.set(id, v + (dValues.get(id) ?? 0) * scale);
  const delays = new Map<string, number>();
  for (const [id, v] of state.delays) delays.set(id, v + (dDelays.get(id) ?? 0) * scale);
  return { values, delays, t: state.t + scale };
}

// --- T/I/OE attribution -------------------------------------------------

/**
 * Aggregate a state's node values by `tioe_class`. The T/I/OE trajectory is the
 * sum of all nodes tagged T, I, or OE respectively — a directional indicator,
 * not a financial statement (spec §4).
 */
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
    const v = state.values.get(n.id) ?? 0;
    if (n.tioe_class === "T") T += v;
    else if (n.tioe_class === "I") I += v;
    else if (n.tioe_class === "OE") OE += v;
  }
  return { T, I, OE };
}

/** Sum of all stock values — the conserved "mass" of the system. */
export function totalStockMass(graph: Graph, state: SimState): number {
  let m = 0;
  for (const n of graph.nodes) {
    if (n.type === "stock") m += state.values.get(n.id) ?? 0;
  }
  // Delay states also hold in-flight mass that has left a source but not yet
  // arrived at a target; include them for conservation accounting.
  for (const v of state.delays.values()) m += v;
  return m;
}

export function clampClass(cls: TioeClass): TioeClass {
  return cls;
}

export type { Edge, Node };
