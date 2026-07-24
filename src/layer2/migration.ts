/**
 * Layer 2 — constraint migration: predicted vs observed (spec Phase 5).
 *
 * Step 5 of the Five Focusing Steps is "go back to step 1." After an
 * intervention the constraint relocates. This module gives L2's structural
 * score something to be *validated* against: the **predicted** constraint
 * (L2's #1 ranked node) vs the **observed** constraint (the node with the
 * highest fraction of run time pinned at its upper collar under load).
 *
 * Agreement is earned confidence in the heuristic. Disagreement is the
 * finding — and it is stated plainly, never auto-corrected.
 *
 * The migration trail records the ordered sequence of applied interventions and
 * the constraint's movement (predicted and observed). Cycle detection fires when
 * the constraint returns to a node already in the trail — the payload of the
 * whole feature, made unmissable.
 *
 * All functions are pure: referentially transparent projections over
 * `(graph, opts, weights, trail)`. No state, no side effects, no DOM.
 */

import type { Graph, Node } from "@/model/types";
import { scoreGraph, type Weights } from "@/layer2/scoring";
import { deriveLoops } from "@/graph/loops";
import {
  applyTypedIntervention,
  simulateTyped,
  type TypedIntervention,
} from "@/layer3/intervention";
import {
  DEFAULT_ENGINE_OPTIONS,
  initialState,
  run,
  type EngineOptions,
} from "@/sim";

/** Which constraint identity this is — the structural prediction or the dynamical observation. */
export interface ConstraintIdentity {
  /** The node id, or null when no node qualifies (no collars, or nothing pins). */
  nodeId: string | null;
  /** The score or pinned-fraction that earned it the #1 spot. */
  value: number;
}

/** Per-node pinned-fraction data (the "observed" side). */
export interface PinnedFraction {
  /** node id -> fraction of steps pinned at "upper" (0..1). */
  fractions: Record<string, number>;
}

export interface ObservedConstraintResult extends PinnedFraction {
  /** The node with the highest upper-pinned fraction, or null when none pin. */
  nodeId: string | null;
  /** That node's pinned fraction (0 when nothing pins). */
  fraction: number;
}

// ---------------------------------------------------------------------------
// Predicted: L2's #1 ranked node (structural score)
// ---------------------------------------------------------------------------

/**
 * The **predicted** constraint: L2's top-ranked node from the structural score.
 * Pure — a thin wrapper over `scoreGraph`. When `sensitivities` is omitted the
 * sensitivity signal is inert (structural four signals only). Returns the #1
 * node id (or null for an empty graph) plus its score.
 */
export function predictedConstraint(
  graph: Graph,
  weights: Weights,
  sensitivities?: Map<string, number>,
): ConstraintIdentity {
  const { ranked } = scoreGraph(graph, weights, sensitivities);
  const top = ranked[0];
  if (!top) return { nodeId: null, value: 0 };
  return { nodeId: top.nodeId, value: top.score };
}

// ---------------------------------------------------------------------------
// Observed: highest fraction of run time pinned at the upper collar
// ---------------------------------------------------------------------------

/**
 * The **observed** constraint: the node with the highest fraction of run time
 * pinned at its upper collar under current load. Runs the engine from the
 * initial state for `steps` steps and counts, per node, the fraction of steps
 * where `state.pinned[nodeId] === "upper"`. The node with the highest fraction
 * is the observed constraint — the place the system is *actually* binding.
 *
 * Returns null for `nodeId` when no node ever pins (no collars, or the system
 * never reaches a boundary). Pure and deterministic.
 */
export function observedConstraint(
  graph: Graph,
  opts: EngineOptions = DEFAULT_ENGINE_OPTIONS,
  steps = 500,
): ObservedConstraintResult {
  const traj = run(graph, initialState(graph, opts), opts, steps);
  const fractions: Record<string, number> = {};
  for (const n of graph.nodes) fractions[n.id] = 0;
  // Count upper-pinned steps. The trajectory has steps+1 states (t=0 .. t=steps).
  for (const s of traj) {
    for (const n of graph.nodes) {
      if (s.pinned[n.id] === "upper") fractions[n.id] += 1;
    }
  }
  const count = Math.max(1, traj.length);
  for (const id of Object.keys(fractions)) fractions[id] /= count;

  let best: string | null = null;
  let bestFrac = 0;
  for (const n of graph.nodes) {
    const f = fractions[n.id] ?? 0;
    // Require a non-trivial pinned fraction (> 1%) to call it the constraint;
    // a node that pins for one step out of 500 is not "the constraint."
    if (f > bestFrac && f > 0.01) {
      bestFrac = f;
      best = n.id;
    }
  }
  return { fractions, nodeId: best, fraction: bestFrac };
}

// ---------------------------------------------------------------------------
// Persist an intervention to the working graph
// ---------------------------------------------------------------------------

/**
 * Permanently apply a typed intervention to a graph, returning the new graph
 * that becomes the working baseline for subsequent runs. For Exploit, the
 * operating point is persisted as the node's new `initial_value` (the collar
 * does not move). For Subordinate/Elevate, the structural change from
 * `applyTypedIntervention` is the new graph. Loops are re-derived.
 *
 * Pure: returns a new graph, never mutates the input.
 */
export function persistIntervention(
  graph: Graph,
  iv: TypedIntervention,
  opts: EngineOptions = DEFAULT_ENGINE_OPTIONS,
): Graph {
  const applied = applyTypedIntervention(graph, initialState(graph, opts), iv, opts);
  let next = applied.graph;
  if (iv.type === "exploit") {
    const nodes = next.nodes.map((n): Node =>
      n.id === iv.target
        ? { ...n, initial_value: applied.state.values[iv.target] ?? n.initial_value }
        : n,
    );
    next = { ...next, nodes };
  }
  return withLoops(next);
}

/** Re-derive loops on a graph (structural changes may add/remove cycles). */
function withLoops(graph: Graph): Graph {
  const { loops } = deriveLoops(graph);
  return { ...graph, loops };
}

// ---------------------------------------------------------------------------
// Migration trail
// ---------------------------------------------------------------------------

/** One step in the migration trail: a single applied intervention's record. */
export interface MigrationStep {
  /** Zero-based index in the trail. */
  index: number;
  /** The intervention that was applied. */
  intervention: TypedIntervention;
  /** Predicted (L2 #1) before the intervention. */
  predictedBefore: string | null;
  /** Predicted (L2 #1) after the intervention. */
  predictedAfter: string | null;
  /** Observed (highest pinned fraction) before. */
  observedBefore: string | null;
  /** Observed (highest pinned fraction) after. */
  observedAfter: string | null;
  /** End-of-horizon ΔT (post − pre). */
  deltaT: number;
  /** End-of-horizon ΔOE (post − pre). */
  deltaOE: number;
  /** DoF change (after − before). */
  deltaDoF: number;
  /** True when either the predicted or observed #1 changed. */
  constraintMoved: boolean;
  /** Which identity moved: "predicted", "observed", "both", or "none". */
  movedWhich: "predicted" | "observed" | "both" | "none";
}

/** The migration trail: an ordered list of applied interventions. */
export type MigrationTrail = MigrationStep[];

/**
 * Record a migration step for an applied intervention. Computes the predicted
 * and observed constraints before and after, the end-of-horizon ΔT/ΔOE/ΔDoF
 * from the pre/post run, and whether the constraint moved. Returns the new
 * graph (post-intervention) and the step to append to the trail.
 *
 * Pure: does not mutate the trail; the caller appends.
 */
export function recordMigrationStep(
  graph: Graph,
  iv: TypedIntervention,
  opts: EngineOptions = DEFAULT_ENGINE_OPTIONS,
  weights: Weights,
  sensitivities?: Map<string, number>,
  steps = 500,
): { nextGraph: Graph; step: MigrationStep } {
  // Before: constraints on the current graph.
  const predBefore = predictedConstraint(graph, weights, sensitivities);
  const obsBefore = observedConstraint(graph, opts, steps);

  // The pre/post simulation for ΔT/ΔOE/ΔDoF (the Phase 4 analysis).
  const sim = simulateTyped(
    graph,
    iv,
    { dt: opts.dt, method: opts.integrator },
    steps,
  );

  // Apply the intervention to get the new working graph.
  const nextGraph = persistIntervention(graph, iv, opts);

  // After: constraints on the new graph.
  const predAfter = predictedConstraint(nextGraph, weights, sensitivities);
  const obsAfter = observedConstraint(nextGraph, opts, steps);

  const predMoved = predBefore.nodeId !== predAfter.nodeId;
  const obsMoved = obsBefore.nodeId !== obsAfter.nodeId;
  const movedWhich: MigrationStep["movedWhich"] = predMoved && obsMoved
    ? "both"
    : predMoved
      ? "predicted"
      : obsMoved
        ? "observed"
        : "none";

  const step: MigrationStep = {
    index: -1, // set by the caller when appending
    intervention: iv,
    predictedBefore: predBefore.nodeId,
    predictedAfter: predAfter.nodeId,
    observedBefore: obsBefore.nodeId,
    observedAfter: obsAfter.nodeId,
    deltaT: sim.deltaT,
    deltaOE: sim.deltaOE,
    deltaDoF: sim.dof.delta,
    constraintMoved: predMoved || obsMoved,
    movedWhich,
  };

  return { nextGraph, step };
}

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

export interface CycleDetection {
  /** True when the observed constraint returned to a node already in the trail. */
  detected: boolean;
  /** The node the constraint cycled back to. */
  node: string | null;
  /** Trail index where the cycle started (the earlier step's "before"). */
  fromStep: number;
  /** Trail index where the cycle closed (the latest step's "after"). */
  toStep: number;
  /** Net ΔT across the cycle (sum of steps from `fromStep` to `toStep`). */
  netDeltaT: number;
  /** Net ΔOE across the cycle. */
  netDeltaOE: number;
  /** Number of interventions in the cycle. */
  length: number;
}

/**
 * Detect whether the constraint has cycled: the observed constraint after the
 * latest step matches the observed constraint before an earlier step in the
 * trail. When detected, reports the node, the cycle span, and the net ΔT/ΔOE
 * across the cycle (the payload — "two elevations, net ΔT ≈ 0, ΔOE +X").
 *
 * Pure: scans the trail without mutating it.
 */
export function detectCycle(trail: MigrationTrail): CycleDetection | null {
  if (trail.length < 2) return null;
  const last = trail[trail.length - 1];
  const obsAfter = last.observedAfter;
  if (!obsAfter) return null;
  // Search backward for a step whose observedBefore matches the latest observedAfter.
  for (let i = trail.length - 2; i >= 0; i--) {
    if (trail[i].observedBefore === obsAfter) {
      let netT = 0;
      let netOE = 0;
      for (let j = i; j < trail.length; j++) {
        netT += trail[j].deltaT;
        netOE += trail[j].deltaOE;
      }
      return {
        detected: true,
        node: obsAfter,
        fromStep: i,
        toStep: trail.length - 1,
        netDeltaT: netT,
        netDeltaOE: netOE,
        length: trail.length - i,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Formatting helpers (pure, for the UI)
// ---------------------------------------------------------------------------

/**
 * A one-line summary of a migration step, for the compact trail rendering.
 * Pure.
 */
export function stepSummary(step: MigrationStep, graph: Graph): string {
  const iv = step.intervention;
  const typeLabel = iv.type.charAt(0).toUpperCase() + iv.type.slice(1);
  const target = graph.nodes.find((n) => n.id === iv.target)?.label ?? iv.target;
  let moved = "";
  if (step.movedWhich === "both") {
    moved = ` → pred ${labelOf(graph, step.predictedAfter)} / obs ${labelOf(graph, step.observedAfter)}`;
  } else if (step.movedWhich === "predicted") {
    moved = ` → pred ${labelOf(graph, step.predictedAfter)}`;
  } else if (step.movedWhich === "observed") {
    moved = ` → obs ${labelOf(graph, step.observedAfter)}`;
  }
  const dTStr = `${step.deltaT >= 0 ? "+" : ""}${step.deltaT.toFixed(1)}`;
  const dOEStr = `${step.deltaOE >= 0 ? "+" : ""}${step.deltaOE.toFixed(1)}`;
  return `${typeLabel} on ${target}: ΔT ${dTStr}, ΔOE ${dOEStr}${moved}`;
}

function labelOf(graph: Graph, id: string | null): string {
  if (!id) return "—";
  return graph.nodes.find((n) => n.id === id)?.label ?? id;
}

/**
 * A disagreement message between predicted and observed, per spec §5.1.
 * Returns null when they agree (or when either is null).
 */
export function disagreementMessage(
  graph: Graph,
  predicted: string | null,
  observed: string | null,
): string | null {
  if (!predicted || !observed) return null;
  if (predicted === observed) return null;
  const pLabel = graph.nodes.find((n) => n.id === predicted)?.label ?? predicted;
  const oLabel = graph.nodes.find((n) => n.id === observed)?.label ?? observed;
  return `L2 predicts ${pLabel}. Under load, ${oLabel} is pinned the most. The score is weighting structure the dynamics do not bear out.`;
}
