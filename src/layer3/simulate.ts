/**
 * Layer 3 — pre/post intervention simulation (spec §4), now a thin projection
 * over the unified engine (Phase 1).
 *
 * The "pre" trajectory runs from the graph's initial state; the "post"
 * trajectory runs from the same initial state with the intervention applied as
 * an impulse at t=0 — the very same `engine.impulse` the Layer 1 nudge arrows
 * use, so a canvas nudge and an equivalent L3 Δ produce identical trajectories.
 * Both runs use the same engine settings. Output is two parallel T/I/OE series
 * the sparkline UI renders as small multiples — directional delta only, not
 * financial precision (spec §4).
 *
 * Per the architecture rule, this module holds no state. `simulate` is a pure
 * function of `(graph, intervention, options)`.
 */

import type { Graph } from "@/model/types";
import {
  initialState,
  run,
  impulse,
  tioeOf,
  type EngineOptions,
  type IntegratorMethod,
  type SimState,
  type TioeSnapshot,
} from "@/sim";

/** L3-facing integrator settings: dt + method (mapped to the engine's `integrator`). */
export interface IntegratorOptions {
  dt: number;
  method: IntegratorMethod;
}

export const DEFAULT_INTEGRATOR_OPTIONS: IntegratorOptions = { dt: 0.1, method: "rk4" };

export interface Intervention {
  /** Node whose value is perturbed. */
  nodeId: string;
  /**
   * New value for the node at the intervention point. Omit to leave the value
   * unchanged and perturb a parameter instead (future: edge strengths).
   */
  setValue?: number;
  /** Additive shift to the node's value at the intervention point (an impulse). */
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
 * graph's initial state; the "post" trajectory runs from the initial state
 * with the intervention applied at t=0. Both use the same engine settings.
 */
export function simulate(graph: Graph, opts: SimulateOptions): SimulationResult {
  const integrator = opts.integrator ?? DEFAULT_INTEGRATOR_OPTIONS;
  const steps = opts.steps ?? 200;
  const engineOpts: EngineOptions = { dt: integrator.dt, integrator: integrator.method };

  const start = initialState(graph, engineOpts);
  const preStates = run(graph, start, engineOpts, steps);
  const pre = toTrajectory(graph, preStates);

  const perturbed = applyIntervention(start, opts.intervention);
  const postStates = run(graph, perturbed, engineOpts, steps);
  const post = toTrajectory(graph, postStates);

  return { pre, post, nodeId: opts.intervention.nodeId, options: integrator };
}

/** Apply an intervention (setValue then additive delta) to a state. Pure. */
function applyIntervention(state: SimState, iv: Intervention): SimState {
  const cur = state.values[iv.nodeId] ?? 0;
  let next = cur;
  if (typeof iv.setValue === "number") next = iv.setValue;
  if (typeof iv.delta === "number") next += iv.delta;
  return impulse(state, iv.nodeId, next - cur);
}

function toTrajectory(graph: Graph, states: SimState[]): Trajectory {
  const series: TioeSnapshot[] = states.map((s) => tioeOf(graph, s));
  const times: number[] = states.map((s) => s.t);
  return { series, times };
}
