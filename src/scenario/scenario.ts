/**
 * Phase 9 — Scenario tray (spec §9.1).
 *
 * "Pin scenario" captures the current intervention (type, target, magnitude,
 * or structural diff) as a card with its full metric set, so options are
 * comparable side by side on the same axes: ΔT, ΔI, ΔOE, ΔT/ΔOE, ΔT/ΔI, ΔDoF,
 * leverage tier, J-curve depth, constraint-after (predicted and observed), and
 * robustness verdict.
 *
 * Everything here is pure and deterministic: a card is a referentially
 * transparent projection over `(graph, intervention, settings, weights,
 * sensitivities)`. The tray is an ordered list of cards plus a chosen id. No
 * state, no side effects, no DOM — the UI layer (main.ts / the L3 panel) owns
 * the mutable tray and threads it through session save/load.
 *
 * Per the architecture rules: a scenario is an annotation over the graph, never
 * a parallel structure. The metrics are derived from the same engine and the
 * same pure functions Layers 2 and 3 already use; pinning a scenario never
 * mutates the working `Graph`.
 */

import type { Graph } from "@/model/types";
import type { Weights } from "@/layer2/scoring";
import { predictedConstraint, observedConstraint } from "@/layer2/migration";
import {
  simulateTyped,
  leverageTier,
  type TypedIntervention,
} from "@/layer3/intervention";
import {
  applyTypedIntervention,
  type AppliedIntervention,
} from "@/layer3/intervention";
import {
  initialState,
  type EngineOptions,
  type IntegratorMethod,
} from "@/sim";
import {
  runMonteCarlo,
  type StabilityVerdict,
} from "@/sim/robustness";
import type { LeverageTier } from "@/layer3/structural";
import { deriveLoops } from "@/graph/loops";

/** Robustness verdict attached to a card (spec §9.1). Omitted when not run. */
export type RobustnessVerdict = StabilityVerdict;

/**
 * A pinned scenario: one intervention + its full metric set, captured at pin
 * time. All fields are plain JSON-serialisable so the tray round-trips through
 * session save/load losslessly (spec §9.3).
 */
export interface ScenarioCard {
  /** Deterministic id, assigned by the caller (e.g. "s1", "s2"). */
  id: string;
  /** Human-readable label, default derived from the intervention. */
  label: string;
  /** The intervention that was pinned. */
  intervention: TypedIntervention;
  /** End-of-horizon ΔT (post − pre). */
  deltaT: number;
  /** End-of-horizon ΔI. */
  deltaI: number;
  /** End-of-horizon ΔOE. */
  deltaOE: number;
  /** ΔT / ΔOE, or null when |ΔOE| is below the noise floor. */
  dT_dOE: number | null;
  /** ΔT / ΔI, or null when |ΔI| is below the noise floor. */
  dT_dI: number | null;
  /** First step where cumulative ΔT meets/exceeds cumulative ΔOE, or null. */
  paybackHorizon: number | null;
  /** Degrees-of-freedom change across the intervention. */
  dof: { before: number; after: number; delta: number; total: number };
  /** Leverage tier (1=Parameter … 6=Rules). */
  tier: LeverageTier;
  /** J-curve (worse-before-better) summary. */
  jCurve: { depth: number; duration: number; detected: boolean };
  /** Predicted (L2 #1) constraint on the post-intervention graph. */
  predictedAfter: string | null;
  /** Observed (highest pinned fraction) constraint on the post-intervention graph. */
  observedAfter: string | null;
  /** Robustness verdict for the post-intervention graph, if run. Omitted otherwise. */
  robustnessVerdict?: RobustnessVerdict;
  /** Engine settings at pin time (provenance for the ADR export). */
  dt: number;
  integrator: IntegratorMethod;
  steps: number;
  /** ISO timestamp of when the card was pinned (provenance). */
  pinnedAt: string;
}

/** The scenario tray: an ordered list of cards plus a chosen id (spec §9.1). */
export interface ScenarioTray {
  cards: ScenarioCard[];
  /** The id of the chosen (decided) card, or null when none is chosen. */
  chosenId: string | null;
}

/** An empty tray. Pure. */
export function emptyTray(): ScenarioTray {
  return { cards: [], chosenId: null };
}

/** Options for `pinScenario`. All inputs that affect the card's contents. */
export interface PinScenarioOptions {
  /** Deterministic id for the new card (caller-assigned, e.g. "s3"). */
  id: string;
  /** Optional label; defaults to `scenarioLabel(graph, iv)`. */
  label?: string;
  /** ISO timestamp recorded as `pinnedAt` (provenance). */
  pinnedAt: string;
  /** Engine settings for the pre/post run. */
  engine: EngineOptions;
  /** Horizon (steps) for the pre/post run. */
  steps: number;
  /** Layer 2 weights — for the post-intervention predicted constraint. */
  weights: Weights;
  /** Cached sensitivities — for the post-intervention predicted constraint. */
  sensitivities?: Map<string, number>;
  /**
   * If > 0, run a seeded Monte Carlo on the post-intervention graph and attach
   * the observed-constraint verdict. Default 0 (skip — keep pin fast). The UI
   * may pass a modest N (e.g. 50) so the robustness column is populated.
   */
  robustnessN?: number;
  /** RNG seed for the Monte Carlo run. Default 42. */
  robustnessSeed?: number;
}

/**
 * Pin a scenario: run the typed intervention's pre/post simulation, derive the
 * full Phase-4 metric set, compute the constraint-after (predicted + observed)
 * on the post-intervention graph, and (optionally) a robustness verdict.
 *
 * Pure: same inputs → identical card. Does NOT mutate the input graph; the
 * post-intervention graph is a throwaway copy used only to read the
 * constraint-after.
 */
export function pinScenario(
  graph: Graph,
  iv: TypedIntervention,
  opts: PinScenarioOptions,
): ScenarioCard {
  const sim = simulateTyped(graph, iv, { dt: opts.engine.dt, method: opts.engine.integrator }, opts.steps);

  // Post-intervention graph (throwaway): apply the intervention, re-derive loops
  // (structural changes may add/remove cycles), then read both constraints.
  const applied: AppliedIntervention = applyTypedIntervention(
    graph,
    initialState(graph, opts.engine),
    iv,
    opts.engine,
  );
  const postGraph = withLoops(applied.graph);
  const pred = predictedConstraint(postGraph, opts.weights, opts.sensitivities);
  const obs = observedConstraint(postGraph, opts.engine, opts.steps);

  let robustnessVerdict: RobustnessVerdict | undefined;
  const n = opts.robustnessN ?? 0;
  if (n > 0) {
    const report = runMonteCarlo(postGraph, opts.weights, opts.sensitivities, {
      n,
      seed: opts.robustnessSeed ?? 42,
      engine: opts.engine,
      steps: opts.steps,
    });
    robustnessVerdict = report.observedVerdict;
  }

  return {
    id: opts.id,
    label: opts.label ?? scenarioLabel(graph, iv),
    intervention: iv,
    deltaT: sim.deltaT,
    deltaI: sim.deltaI,
    deltaOE: sim.deltaOE,
    dT_dOE: sim.ratios.dT_dOE,
    dT_dI: sim.ratios.dT_dI,
    paybackHorizon: sim.ratios.payback_horizon,
    dof: { ...sim.dof },
    tier: leverageTier(iv),
    jCurve: { ...sim.jCurve },
    predictedAfter: pred.nodeId,
    observedAfter: obs.nodeId,
    ...(robustnessVerdict !== undefined ? { robustnessVerdict } : {}),
    dt: opts.engine.dt,
    integrator: opts.engine.integrator,
    steps: opts.steps,
    pinnedAt: opts.pinnedAt,
  };
}

/** Re-derive loops on a graph (structural changes may add/remove cycles). */
function withLoops(graph: Graph): Graph {
  const { loops } = deriveLoops(graph);
  return { ...graph, loops };
}

/** Append a card to a tray. Pure: returns a new tray. */
export function addCard(tray: ScenarioTray, card: ScenarioCard): ScenarioTray {
  return { ...tray, cards: [...tray.cards, card] };
}

/** Remove a card by id (and clear the chosen id if it was chosen). Pure. */
export function removeCard(tray: ScenarioTray, id: string): ScenarioTray {
  return {
    cards: tray.cards.filter((c) => c.id !== id),
    chosenId: tray.chosenId === id ? null : tray.chosenId,
  };
}

/** Mark a card as the decision (or null to clear). Pure. */
export function chooseCard(tray: ScenarioTray, id: string | null): ScenarioTray {
  if (id !== null && !tray.cards.some((c) => c.id === id)) return tray;
  return { ...tray, chosenId: id };
}

/** Find a card by id. Pure. */
export function getCard(tray: ScenarioTray, id: string): ScenarioCard | undefined {
  return tray.cards.find((c) => c.id === id);
}

/**
 * A default human-readable label for a scenario, derived from the intervention.
 * E.g. "Exploit on A (Δ20)", "Elevate on A (Δ50)", "Subordinate A→B (×1.0)",
 * "Collapse delay on e2 (×0.3)".
 */
export function scenarioLabel(graph: Graph, iv: TypedIntervention): string {
  const typeLabel = iv.type.charAt(0).toUpperCase() + iv.type.slice(1);
  const target = graph.nodes.find((n) => n.id === iv.target)?.label ?? iv.target;
  switch (iv.type) {
    case "exploit":
    case "elevate":
      return `${typeLabel} on ${target} (Δ${iv.magnitude})`;
    case "subordinate": {
      const buf = iv.rope ? graph.nodes.find((n) => n.id === iv.rope!.buffer)?.label ?? iv.rope!.buffer : "";
      const rel = iv.rope ? graph.nodes.find((n) => n.id === iv.rope!.release)?.label ?? iv.rope!.release : "";
      return `${typeLabel} ${rel}←${buf} (×${iv.magnitude})`;
    }
    case "structural": {
      if (!iv.edit) return `${typeLabel} on ${target}`;
      const e = iv.edit;
      switch (e.kind) {
        case "collapseDelay":
          return `Collapse delay on ${e.edgeId} (×${e.factor})`;
        case "changeDelayType":
          return `Change delay type on ${e.edgeId} → ${e.delayType}`;
        case "flipPolarity":
          return `Flip polarity on ${e.edgeId}`;
        case "splitNode":
          return `Split ${target} → ${e.newId}`;
        case "addEdge":
          return `Add edge ${e.edge.id}`;
        case "deleteEdge":
          return `Delete edge ${e.edgeId}`;
      }
    }
  }
}

/** Next available sequential id ("s1", "s2", …) for a tray. Pure. */
export function nextScenarioId(tray: ScenarioTray): string {
  let n = tray.cards.length + 1;
  let candidate = `s${n}`;
  const ids = new Set(tray.cards.map((c) => c.id));
  while (ids.has(candidate)) {
    n++;
    candidate = `s${n}`;
  }
  return candidate;
}
