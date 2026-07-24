/**
 * Layer 3 — typed ToC interventions as collar operations (spec Phase 4).
 *
 * The Five Focusing Steps, made mechanical. With physical collars in place
 * (Phase 2), the three interventions have exact definitions as operations on a
 * node's collar:
 *
 *   - **Exploit** — close the gap between the current operating point and the
 *     *existing* upper collar (recover idle time, reduce waste). The collar does
 *     NOT move. Implemented as an additive impulse on the target node, capped at
 *     the available headroom so the slider cannot claim gain the system cannot
 *     deliver. Expected signature: T up, OE flat, I flat-or-down.
 *
 *   - **Subordinate** — reduce upstream pressure toward a collar that cannot
 *     absorb it: add (or tighten) a *rope* — a negative-polarity information
 *     edge from a downstream buffer back to the upstream release flow. This is a
 *     structural change: a new edge is spliced into the graph. Expected
 *     signature: I down sharply, T ~flat, OE flat.
 *
 *   - **Elevate** — *move the upper collar* up by `magnitude` (buy more
 *     capacity). OE rises because the constrained resource now processes more
 *     flow (the engine's OE = flow through collared stocks); the spec also calls
 *     for adding the capacity's declared cost, which a full `system:` block
 *     would supply. Expected signature: T up, OE up, I up.
 *
 * This module is pure: every function is a referentially transparent
 * projection over `(graph, intervention, options)`. It holds no state and
 * imports the engine only for the deterministic operating-point estimate and
 * the pre/post runners. All UI-side capping ("only 4% headroom remains") is
 * computed here so it can be unit-tested without the DOM.
 *
 * Per the architecture rule, an intervention is NEVER auto-applied to the
 * shared `Graph`. `applyTypedIntervention` returns a *new* graph (for structural
 * changes) and/or a new initial state; the caller threads those through the
 * engine for the hypothetical "post" run and diffs against the unmodified
 * "pre" run.
 */

import type { Edge, Graph, Node } from "@/model/types";
import {
  degreesOfFreedom,
  deriveTioe,
  equilibrium,
  initialState,
  run,
  type EngineOptions,
  type SimState,
  type TioeSnapshot,
} from "@/sim";
import type { IntegratorOptions } from "./simulate";
import { DEFAULT_INTEGRATOR_OPTIONS } from "./simulate";

/** The three ToC intervention classes that map onto collar operations. */
export type InterventionType = "exploit" | "subordinate" | "elevate";

/**
 * A typed intervention. `type` selects the collar operation; the remaining
 * fields parameterise it. Fields not relevant to a given type are ignored.
 */
export interface TypedIntervention {
  type: InterventionType;
  /** The constrained node (the node whose collar the intervention concerns). */
  target: string;
  /**
   * Exploit: physical units to raise the operating point by (already capped to
   * headroom by `clampExploitMagnitude` before reaching the engine).
   * Elevate: physical units to raise the upper collar by.
   * Subordinate: strength of the rope edge to add (>= 0).
   */
  magnitude: number;
  /**
   * Subordinate only: the downstream buffer and the upstream release flow the
   * rope connects. The rope is a negative-polarity information edge
   * `buffer -> release`. Ignored for exploit/elevate.
   */
  rope?: { buffer: string; release: string };
}

/** Sign-of-change for one TA aggregate, as a direction enum. */
export type Direction = "up" | "down" | "flat";

/**
 * The expected T/I/OE signature for an intervention type (the prediction).
 * Each aggregate carries the set of *allowed* observed directions (spec §4.1
 * gives ranges, e.g. Exploit I is "flat or down"). An observed direction
 * outside the allowed set is a disagreement (spec §4.2).
 */
export interface ExpectedSignature {
  T: Direction[];
  I: Direction[];
  OE: Direction[];
}

/** Observed sign of the post-vs-pre delta on one aggregate. */
export interface ObservedSignature {
  T: Direction;
  I: Direction;
  OE: Direction;
}

/** Per-agreement flags: true where observed direction is in the allowed set. */
export interface SignatureAgreement {
  T: boolean;
  I: boolean;
  OE: boolean;
}

/** The TA decision ratios (spec §4.3). */
export interface TaRatios {
  /** ΔT / ΔOE. null when |ΔOE| is below the noise floor (don't divide ~0). */
  dT_dOE: number | null;
  /** ΔT / ΔI. null when |ΔI| is below the noise floor. */
  dT_dI: number | null;
  /** ΔT per unit of constraint time = ΔT / horizon (constraint time = run length). */
  dT_per_constraint_time: number;
  /**
   * Payback horizon: first index where cumulative ΔT first meets or exceeds
   * cumulative ΔOE. null when it does not pay back within the horizon.
   */
  payback_horizon: number | null;
}

/** J-curve (worse-before-better) summary (spec §4.4). */
export interface JCurve {
  /** Minimum of (post − pre) T over the horizon — the depth of the dip. */
  depth: number;
  /** How many steps T stays negative before crossing over to >= 0. 0 when no dip. */
  duration: number;
  /** True when a worse-before-better dip was detected (depth < 0 and duration > 0). */
  detected: boolean;
}

/** Degrees-of-freedom change across an intervention (spec §4.5). */
export interface DofChange {
  /** Free nodes in the pre run's final state. */
  before: number;
  /** Free nodes in the post run's final state. */
  after: number;
  /** after − before. */
  delta: number;
  /** Total nodes (denominator for "X of Y"). */
  total: number;
}

export interface TypedSimulationResult {
  pre: TioeSnapshot[];
  post: TioeSnapshot[];
  /** Elapsed model time per sample. */
  times: number[];
  expected: ExpectedSignature;
  observed: ObservedSignature;
  agreement: SignatureAgreement;
  ratios: TaRatios;
  jCurve: JCurve;
  dof: DofChange;
  /** End-of-horizon deltas. */
  deltaT: number;
  deltaI: number;
  deltaOE: number;
  /** The intervention that was run. */
  intervention: TypedIntervention;
  options: IntegratorOptions;
}

// ---------------------------------------------------------------------------
// Expected signatures (the prediction, by type)
// ---------------------------------------------------------------------------

const SIGNATURES: Record<InterventionType, ExpectedSignature> = {
  // Exploit: T up; I flat-or-down (recover idle time frees inventory); OE flat
  // (the collar, and thus the capacity cost, does not move).
  exploit: { T: ["up"], I: ["down", "flat"], OE: ["flat"] },
  // Subordinate: I down sharply; T ~flat; OE flat (no new capacity bought).
  subordinate: { T: ["flat"], I: ["down"], OE: ["flat"] },
  // Elevate: T up; OE up (the moved collar adds capacity cost); I up (more
  // flow through the now-larger constraint raises in-system mass).
  elevate: { T: ["up"], I: ["up"], OE: ["up"] },
};

/** The predicted T/I/OE allowed directions for an intervention type. Pure. */
export function expectedSignature(type: InterventionType): ExpectedSignature {
  return {
    T: [...SIGNATURES[type].T],
    I: [...SIGNATURES[type].I],
    OE: [...SIGNATURES[type].OE],
  };
}

// ---------------------------------------------------------------------------
// Headroom — the Exploit cap (spec §4.1)
// ---------------------------------------------------------------------------

/**
 * Operating-point headroom on the target node's upper collar, in physical
 * units: `upper - equilibrium[target]`. This is the maximum an Exploit
 * intervention can reclaim — the slider must stop here. Returns null when the
 * target has no upper collar (Exploit not applicable) or the node is absent.
 *
 * The operating point is the engine's deterministic equilibrium estimate
 * (see `equilibrium` in `src/sim/engine.ts`): a converging system's true
 * steady state, or the mean around which an oscillating system deviates.
 */
export function operatingHeadroom(
  graph: Graph,
  opts: EngineOptions,
  nodeId: string,
): number | null {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node || !node.collar || node.collar.upper === undefined) return null;
  const eq = equilibrium(graph, opts);
  const op = eq[nodeId] ?? node.initial_value;
  return node.collar.upper - op;
}

/**
 * Clamp an Exploit magnitude to the available headroom. Returns the clamped
 * magnitude (>= 0) and the headroom it was clamped against, so the UI can show
 * "Only X% headroom remains." Returns null when Exploit is not applicable
 * (no upper collar), in which case the UI disables the control.
 */
export function clampExploitMagnitude(
  graph: Graph,
  opts: EngineOptions,
  target: string,
  magnitude: number,
): { magnitude: number; headroom: number } | null {
  const hr = operatingHeadroom(graph, opts, target);
  if (hr === null) return null;
  const cap = Math.max(0, hr);
  const clamped = Math.max(0, Math.min(magnitude, cap));
  return { magnitude: clamped, headroom: cap };
}

// ---------------------------------------------------------------------------
// Apply an intervention to (graph, state) — pure, returns modified copies
// ---------------------------------------------------------------------------

/** A graph+state pair produced by applying a typed intervention. Pure. */
export interface AppliedIntervention {
  graph: Graph;
  state: SimState;
}

/**
 * Apply a typed intervention to produce the modified (graph, initial-state)
 * pair for the "post" run. The input `graph` and `state` are NOT mutated.
 *
 * - **Exploit**: the graph is unchanged; the target's value is raised by the
 *   (already-clamped) magnitude. The collar does not move.
 * - **Subordinate**: a new rope edge `buffer -> release` (negative polarity,
 *   information delay) is spliced into a *copy* of the graph; the state's
 *   queue map is extended for the new edge (empty — no pre-seeded material).
 * - **Elevate**: a *copy* of the graph has the target's `collar.upper` raised
 *   by `magnitude`; the state is unchanged (the operating point stays; the
 *   wall moved).
 */
export function applyTypedIntervention(
  graph: Graph,
  state: SimState,
  iv: TypedIntervention,
  opts: EngineOptions,
): AppliedIntervention {
  switch (iv.type) {
    case "exploit":
      return applyExploit(graph, state, iv);
    case "subordinate":
      return applySubordinate(graph, state, iv, opts);
    case "elevate":
      return applyElevate(graph, state, iv);
  }
}

function applyExploit(graph: Graph, state: SimState, iv: TypedIntervention): AppliedIntervention {
  // The collar does not move. Raise the operating point by the magnitude
  // (the caller is responsible for clamping to headroom via
  // `clampExploitMagnitude`). The engine's clamp keeps the value <= upper, so
  // an over-large exploit simply pins at the collar — but the UI caps it.
  const values = { ...state.values };
  const cur = values[iv.target] ?? 0;
  values[iv.target] = cur + iv.magnitude;
  return { graph, state: { ...state, values } };
}

function applyElevate(graph: Graph, state: SimState, iv: TypedIntervention): AppliedIntervention {
  // Move the upper collar up by magnitude. The wall moves; the operating point
  // is unchanged (it rises to the new collar only if the system was pinning
  // it — i.e. the constraint was the bottleneck). A node without an upper
  // collar gains one at `magnitude` above its current value (Elevate installs
  // a ceiling where there was none).
  //
  // OE rises under Elevate (spec §4.1: "add the cost to capacity_costs"). A
  // declared `capacity_cost` is scaled by the collar ratio (more installed
  // capacity costs proportionally more); absent a declared cost, Elevate
  // installs one equal to `magnitude` so OE is non-zero and rising.
  const nodes = graph.nodes.map((n): Node => {
    if (n.id !== iv.target) return n;
    const collar = n.collar ? { ...n.collar } : {};
    const oldUpper = collar.upper;
    const base = oldUpper ?? state.values[iv.target] ?? n.initial_value;
    const newUpper = base + iv.magnitude;
    collar.upper = newUpper;
    let capacity_cost = n.capacity_cost;
    if (capacity_cost !== undefined) {
      capacity_cost = oldUpper !== undefined && oldUpper > 0
        ? capacity_cost * (newUpper / oldUpper)
        : capacity_cost + iv.magnitude;
    } else {
      capacity_cost = iv.magnitude;
    }
    return { ...n, collar, capacity_cost };
  });
  return { graph: { ...graph, nodes }, state };
}

function applySubordinate(
  graph: Graph,
  state: SimState,
  iv: TypedIntervention,
  opts: EngineOptions,
): AppliedIntervention {
  const rope = iv.rope;
  // Without a rope target, Subordinate is a no-op structural change.
  if (!rope) return { graph, state };
  // Don't add a duplicate rope edge (idempotent re-application).
  const existing = graph.edges.find(
    (e) => e.source === rope.buffer && e.target === rope.release && e.polarity === "-",
  );
  if (existing) {
    // Tighten: bump the existing rope's strength by the magnitude.
    const edges = graph.edges.map((e): Edge =>
      e.id === existing.id ? { ...e, strength: e.strength + iv.magnitude } : e,
    );
    return { graph: { ...graph, edges }, state };
  }
  const id = `rope_${rope.buffer}_${rope.release}`;
  const ropeEdge: Edge = {
    id,
    source: rope.buffer,
    target: rope.release,
    polarity: "-",
    delay: { type: "information", magnitude: 1 },
    strength: Math.max(0, iv.magnitude),
  };
  const edges = [...graph.edges, ropeEdge];
  // The new delayed edge needs an (empty) queue so the engine sees it.
  const delayQueues = { ...state.delayQueues };
  const slots = Math.max(1, Math.round(ropeEdge.delay.magnitude / opts.dt));
  delayQueues[id] = new Array<number>(slots).fill(0);
  return { graph: { ...graph, edges }, state: { ...state, delayQueues } };
}

// ---------------------------------------------------------------------------
// Simulation — pre/post over the engine, with full analysis
// ---------------------------------------------------------------------------

/**
 * Run a pre/post simulation of a typed intervention and derive the full
 * Phase-4 analysis: expected vs observed signature, TA ratios, J-curve, and
 * DoF change. Pure: same inputs -> identical output.
 */
export function simulateTyped(
  graph: Graph,
  iv: TypedIntervention,
  opts: IntegratorOptions = DEFAULT_INTEGRATOR_OPTIONS,
  steps = 200,
): TypedSimulationResult {
  const engineOpts: EngineOptions = { dt: opts.dt, integrator: opts.method };
  const start = initialState(graph, engineOpts);

  const preStates = run(graph, start, engineOpts, steps);
  const pre = preStates.map((s) => deriveTioe(graph, s));
  const times = preStates.map((s) => s.t);

  const applied = applyTypedIntervention(graph, start, iv, engineOpts);
  const postStates = run(applied.graph, applied.state, engineOpts, steps);
  const post = postStates.map((s) => deriveTioe(applied.graph, s));

  const expected = expectedSignature(iv.type);
  const observed = observeSignature(pre, post);
  const agreement = {
    T: expected.T.includes(observed.T),
    I: expected.I.includes(observed.I),
    OE: expected.OE.includes(observed.OE),
  };

  const preEnd = pre[pre.length - 1];
  const postEnd = post[post.length - 1];
  const deltaT = postEnd.T - preEnd.T;
  const deltaI = postEnd.I - preEnd.I;
  const deltaOE = postEnd.OE - preEnd.OE;

  const ratios = taRatios(pre, post, steps);
  const jCurve = detectJCurve(pre, post);
  const dof = dofChange(graph, preStates, postStates);

  return {
    pre,
    post,
    times,
    expected,
    observed,
    agreement,
    ratios,
    jCurve,
    dof,
    deltaT,
    deltaI,
    deltaOE,
    intervention: iv,
    options: opts,
  };
}

// ---------------------------------------------------------------------------
// Analysis helpers — all pure
// ---------------------------------------------------------------------------

/** Threshold below which a delta is reported as "flat" (noise floor). */
const FLAT_EPSILON = 1e-6;

function directionOf(delta: number): Direction {
  if (delta > FLAT_EPSILON) return "up";
  if (delta < -FLAT_EPSILON) return "down";
  return "flat";
}

function observeSignature(pre: TioeSnapshot[], post: TioeSnapshot[]): ObservedSignature {
  const n = Math.min(pre.length, post.length);
  const last = Math.max(0, n - 1);
  return {
    T: directionOf(post[last].T - pre[last].T),
    I: directionOf(post[last].I - pre[last].I),
    OE: directionOf(post[last].OE - pre[last].OE),
  };
}

/**
 * TA decision ratios (spec §4.3). ΔT/ΔOE and ΔT/ΔI are end-of-horizon deltas;
 * where the denominator is below the noise floor the ratio is null and the
 * caller should rank rather than quote an unstable absolute. ΔT per unit of
 * constraint time uses the horizon as the constraint-time proxy. Payback
 * horizon is the first index where cumulative ΔT meets or exceeds cumulative
 * ΔOE, or null when it does not pay back within the horizon.
 */
export function taRatios(pre: TioeSnapshot[], post: TioeSnapshot[], steps: number): TaRatios {
  const n = Math.min(pre.length, post.length);
  const last = Math.max(0, n - 1);
  const dT = post[last].T - pre[last].T;
  const dI = post[last].I - pre[last].I;
  const dOE = post[last].OE - pre[last].OE;

  const dT_dOE = Math.abs(dOE) <= FLAT_EPSILON ? null : dT / dOE;
  const dT_dI = Math.abs(dI) <= FLAT_EPSILON ? null : dT / dI;
  const constraintTime = steps > 0 ? steps : 1;
  const dT_per_constraint_time = dT / constraintTime;

  let payback: number | null = null;
  let cumT = 0;
  let cumOE = 0;
  for (let i = 0; i < n; i++) {
    cumT += post[i].T - pre[i].T;
    cumOE += post[i].OE - pre[i].OE;
    if (cumOE <= FLAT_EPSILON) continue; // no OE to pay back against
    if (cumT >= cumOE) {
      payback = i;
      break;
    }
  }

  return { dT_dOE, dT_dI, dT_per_constraint_time, payback_horizon: payback };
}

/**
 * J-curve (worse-before-better) detector (spec §4.4). Computes the depth
 * (minimum of post−pre T) and duration (steps T stays negative before first
 * crossing to >= 0). Falls straight out of the pre/post runs.
 */
export function detectJCurve(pre: TioeSnapshot[], post: TioeSnapshot[]): JCurve {
  const n = Math.min(pre.length, post.length);
  let depth = 0;
  let duration = 0;
  for (let i = 0; i < n; i++) {
    const d = post[i].T - pre[i].T;
    if (d < 0) {
      depth = Math.min(depth, d);
      duration++;
    } else if (duration > 0) {
      // Crossed over to >= 0 after a dip — stop counting.
      break;
    }
  }
  return { depth, duration, detected: depth < -FLAT_EPSILON && duration > 0 };
}

/** Degrees-of-freedom change between the pre and post runs' final states. */
export function dofChange(graph: Graph, preStates: SimState[], postStates: SimState[]): DofChange {
  const total = graph.nodes.length;
  const before = degreesOfFreedom(graph, preStates[preStates.length - 1]);
  const after = degreesOfFreedom(graph, postStates[postStates.length - 1]);
  return { before, after, delta: after - before, total };
}

export type { IntegratorOptions };
