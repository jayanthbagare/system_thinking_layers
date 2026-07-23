/**
 * Sensitivity signal for Layer 2 (Phase 1 §1.3).
 *
 * Replaces the removed live-load reweighting with a principled, deterministic
 * measure of how much a unit impulse at each node perturbs the whole system.
 * For every node `n`: apply a unit impulse at `n`, run the engine to a horizon,
 * and take the L2 norm of the deviation across all nodes versus the unperturbed
 * run. Normalise across nodes. Pure function of `(graph, opts, horizon)`.
 *
 * `scoreGraph` consumes the resulting per-node sensitivities as a fifth signal
 * (passed in, so the scorer itself stays referentially transparent). The panel
 * computes this once and caches it, invalidating only on a graph edit — never
 * on an animation tick — which is the fix for "the ranking changes when you
 * click a nudge."
 */

import type { Graph } from "@/model/types";
import { initialState, run, impulse, type EngineOptions } from "./engine";

export interface SensitivityOptions {
  /** Integration settings; defaults to the engine default. */
  engine?: EngineOptions;
  /** How many steps to run each perturbed trajectory. */
  horizon?: number;
  /** Magnitude of the unit impulse applied at each node. */
  impulseMagnitude?: number;
}

export const DEFAULT_SENSITIVITY_OPTIONS: Required<SensitivityOptions> = {
  engine: { dt: 0.1, integrator: "rk4" },
  horizon: 200,
  impulseMagnitude: 1,
};

/**
 * Compute the sensitivity of every node: a unit impulse at node `n`, run to
 * `horizon`, L2 norm of the deviation vector over all nodes and all steps,
 * versus the unperturbed baseline. Returns `node id -> raw sensitivity`
 * (un-normalised across nodes; the scorer normalises).
 */
export function computeSensitivities(
  graph: Graph,
  opts: SensitivityOptions = {},
): Map<string, number> {
  const o = { ...DEFAULT_SENSITIVITY_OPTIONS, ...opts };
  const base = run(graph, initialState(graph, o.engine), o.engine, o.horizon);
  const out = new Map<string, number>();
  for (const n of graph.nodes) {
    const perturbed = impulse(initialState(graph, o.engine), n.id, o.impulseMagnitude);
    const traj = run(graph, perturbed, o.engine, o.horizon);
    let acc = 0;
    for (let i = 0; i < traj.length; i++) {
      for (const m of graph.nodes) {
        const d = (traj[i].values[m.id] ?? 0) - (base[i].values[m.id] ?? 0);
        acc += d * d;
      }
    }
    out.set(n.id, Math.sqrt(acc));
  }
  return out;
}

/** Normalise a sensitivity map to [0,1] by dividing by the max (max -> 1). */
export function normalizeSensitivities(raw: Map<string, number>): Map<string, number> {
  let max = 0;
  for (const v of raw.values()) if (v > max) max = v;
  const out = new Map<string, number>();
  for (const [k, v] of raw) out.set(k, max > 0 ? v / max : 0);
  return out;
}

/** Convenience: normalised sensitivities ready to feed `scoreGraph`. */
export function normalizedSensitivities(graph: Graph, opts: SensitivityOptions = {}): Map<string, number> {
  return normalizeSensitivities(computeSensitivities(graph, opts));
}
