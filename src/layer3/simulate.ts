/**
 * Layer 3 — pre/post intervention simulation (spec §4).
 *
 * Wraps the pure integrator to produce T/I/OE trajectories before and after a
 * parameter intervention at a node. An "intervention" here is a scalar shift to
 * a node's value (e.g. raising production capacity, or lifting a backlog). The
 * output is two parallel time-series that the sparkline UI renders as small
 * multiples — directional delta only, not financial precision.
 *
 * Per the architecture rule, this module holds no state. `simulate` is a pure
 * function of `(graph, intervention, options)`.
 */

import type { Graph } from "@/model/types";
import {
  DEFAULT_INTEGRATOR_OPTIONS,
  type IntegratorOptions,
  type SimState,
  type TioeSnapshot,
  initialState,
  run,
  tioeOf,
} from "./integrator";

export interface Intervention {
  /** Node whose value is perturbed. */
  nodeId: string;
  /**
   * New value for the node at the intervention point. Omit to leave the value
   * unchanged and perturb a parameter instead (future: edge strengths).
   */
  setValue?: number;
  /** Additive shift to the node's value at the intervention point. */
  delta?: number;
}

export interface Trajectory {
  /** One T/I/OE snapshot per step (including the initial state at t=0). */
  series: TioeSnapshot[];
  /** Elapsed model time at each point. */
  times: number[];
}

export interface SimulationResult {
  pre: Trajectory;
  post: Trajectory;
  /** The node the intervention was applied to. */
  nodeId: string;
  options: IntegratorOptions;
}

export interface SimulateOptions {
  intervention: Intervention;
  integrator?: IntegratorOptions;
  /** Number of steps per trajectory. */
  steps?: number;
}

/**
 * Run a pre/post intervention simulation. The "pre" trajectory runs from the
 * graph's initial state; the "post" trajectory runs from the initial state with
 * the intervention applied at t=0. Both use the same integrator settings.
 */
export function simulate(graph: Graph, opts: SimulateOptions): SimulationResult {
  const integrator = opts.integrator ?? DEFAULT_INTEGRATOR_OPTIONS;
  const steps = opts.steps ?? 200;

  const start = initialState(graph);
  const preStates = run(graph, start, integrator, steps);
  const pre = toTrajectory(graph, preStates);

  const perturbed = applyIntervention(graph, start, opts.intervention);
  const postStates = run(graph, perturbed, integrator, steps);
  const post = toTrajectory(graph, postStates);

  return { pre, post, nodeId: opts.intervention.nodeId, options: integrator };
}

function applyIntervention(graph: Graph, state: SimState, iv: Intervention): SimState {
  const values = new Map(state.values);
  const cur = values.get(iv.nodeId) ?? 0;
  let next = cur;
  if (typeof iv.setValue === "number") next = iv.setValue;
  if (typeof iv.delta === "number") next += iv.delta;
  values.set(iv.nodeId, next);
  void graph;
  return { values, delays: state.delays, t: state.t };
}

function toTrajectory(graph: Graph, states: SimState[]): Trajectory {
  const series: TioeSnapshot[] = states.map((s) => tioeOf(graph, s));
  const times: number[] = states.map((s) => s.t);
  return { series, times };
}
