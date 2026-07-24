/**
 * Phase 8 — Robustness of constraint identity (spec Phase 8).
 *
 * A point estimate of the constraint is a weak input to an architecture
 * decision; its stability is a strong one. This module samples declared
 * `range:` uncertainties (§2.2) via Monte Carlo and reports how often each
 * node is the #1 constraint — separately for predicted (score) and observed
 * (pinned fraction). Declared ranges are distinguished from tool-guessed
 * ±X% so the user sees how much of the reported uncertainty is their
 * statement versus the tool's guess.
 *
 * All functions are pure and deterministic given the same seed. The heavy
 * lifting runs in a Web Worker (see `worker.ts` / `client.ts`); this module
 * is the framework-agnostic core, unit-tested without the DOM.
 */

import type { Edge, Graph } from "@/model/types";
import { type Weights } from "@/layer2/scoring";
import { observedConstraint, predictedConstraint } from "@/layer2/migration";
import {
  DEFAULT_ENGINE_OPTIONS,
  type EngineOptions,
} from "@/sim";
import type { SensitivityOptions } from "@/sim/sensitivity";

// ---------------------------------------------------------------------------
// Seeded PRNG — deterministic, no crypto
// ---------------------------------------------------------------------------

/**
 * Mulberry32: a fast, well-distributed seeded PRNG. Returns a function that
 * produces floats in [0, 1). Same seed -> same sequence, every time, on every
 * platform. This is the determinism guarantee the spec requires.
 */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function (): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sample a uniform float in [min, max) using the provided RNG. */
export function sampleUniform(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

// ---------------------------------------------------------------------------
// Sampled graph — perturb edges within declared or guessed ranges
// ---------------------------------------------------------------------------

/** Properties that were sampled from a declared `range:` vs a tool guess. */
export type SamplingSource = "declared" | "guessed";

/** A single Monte Carlo draw: a perturbed graph + which properties were declared. */
export interface SampledGraph {
  graph: Graph;
  /** edge id -> { strength: "declared" | "guessed", delay: "declared" | "guessed" } */
  sources: Record<string, { strength?: SamplingSource; delay?: SamplingSource }>;
}

export interface SamplerOptions {
  /** Number of draws. Default 200 (spec §8.1). */
  n?: number;
  /** RNG seed. Same seed -> same draws. Default 42. */
  seed?: number;
  /** Fall-back perturbation for properties without a declared range (spec: default 20%). */
  guessedFraction?: number;
  /** Engine options for the observed-constraint runs. */
  engine?: EngineOptions;
  /** Sensitivity options for the predicted-constraint computation. */
  sensitivity?: SensitivityOptions;
  /** Steps for the observed-constraint run. */
  steps?: number;
}

export const DEFAULT_SAMPLER_OPTIONS: Required<Omit<SamplerOptions, "sensitivity">> = {
  n: 200,
  seed: 42,
  guessedFraction: 0.2,
  engine: DEFAULT_ENGINE_OPTIONS,
  steps: 500,
};

/**
 * Generate `n` perturbed graphs from the base graph. For each edge with a
 * declared `range.strength` or `range.delay_magnitude`, sample within the
 * declared range. For edges without a declared range, fall back to
 * ±`guessedFraction` (default 20%) and mark the property as "guessed" so the
 * user can see how much of the reported uncertainty is their statement versus
 * the tool's guess (spec §8.1).
 *
 * Pure: same (graph, opts) -> same sampled graphs.
 */
export function sampleGraphs(graph: Graph, opts: SamplerOptions = {}): SampledGraph[] {
  const o = { ...DEFAULT_SAMPLER_OPTIONS, ...opts };
  const rng = mulberry32(o.seed);
  const out: SampledGraph[] = [];
  for (let i = 0; i < o.n; i++) {
    out.push(sampleOne(graph, rng, o.guessedFraction));
  }
  return out;
}

function sampleOne(
  graph: Graph,
  rng: () => number,
  guessedFraction: number,
): SampledGraph {
  const sources: SampledGraph["sources"] = {};
  const edges = graph.edges.map((e): Edge => {
    const src: { strength?: SamplingSource; delay?: SamplingSource } = {};
    const next: Edge = { ...e };
    // Strength
    if (e.range?.strength) {
      const [min, max] = e.range.strength;
      next.strength = sampleUniform(rng, min, max);
      src.strength = "declared";
    } else {
      const base = e.strength;
      const lo = base * (1 - guessedFraction);
      const hi = base * (1 + guessedFraction);
      next.strength = sampleUniform(rng, Math.max(0, lo), hi);
      src.strength = "guessed";
    }
    // Delay magnitude
    if (e.range?.delay_magnitude) {
      const [min, max] = e.range.delay_magnitude;
      next.delay = { ...next.delay, magnitude: sampleUniform(rng, min, max) };
      src.delay = "declared";
    } else if (e.delay.magnitude > 0) {
      const base = e.delay.magnitude;
      const lo = base * (1 - guessedFraction);
      const hi = base * (1 + guessedFraction);
      next.delay = { ...next.delay, magnitude: sampleUniform(rng, Math.max(0, lo), hi) };
      src.delay = "guessed";
    }
    sources[e.id] = src;
    return next;
  });
  return { graph: { ...graph, edges }, sources };
}

// ---------------------------------------------------------------------------
// Stability report
// ---------------------------------------------------------------------------

/** Per-node stability: fraction of draws where it was #1. */
export interface NodeStability {
  nodeId: string;
  label: string;
  /** Fraction of draws (0..1) where this node was the #1 predicted constraint. */
  predictedFraction: number;
  /** Fraction of draws (0..1) where this node was the #1 observed constraint. */
  observedFraction: number;
}

export type StabilityVerdict = "stable" | "likely" | "unstable";

export interface RobustnessReport {
  /** Per-node stability, sorted by observedFraction descending. */
  nodes: NodeStability[];
  /** Verdict for the predicted constraint. */
  predictedVerdict: StabilityVerdict;
  /** Verdict for the observed constraint. */
  observedVerdict: StabilityVerdict;
  /** Number of draws. */
  n: number;
  /** Which edge properties were sampled from declared ranges vs guessed. */
  declaredCount: number;
  guessedCount: number;
}

/**
 * Run a Monte Carlo robustness analysis. For each draw:
 *   - Sample a perturbed graph (declared ranges where present, ±20% otherwise)
 *   - Compute the predicted constraint (L2 #1)
 *   - Compute the observed constraint (pinned fraction)
 * Tally per-node #1 fractions and issue a verdict (spec §8.2):
 *   - >= 90% one node -> "Stable. Act on it."
 *   - 60–90% -> "Likely, but check the runner-up."
 *   - < 60%, or two nodes trading places -> "Unstable. You are near a bifurcation."
 *
 * Pure: same (graph, weights, opts) -> same report.
 */
export function runMonteCarlo(
  graph: Graph,
  weights: Weights,
  sensitivities: Map<string, number> | undefined,
  opts: SamplerOptions = {},
): RobustnessReport {
  const o = { ...DEFAULT_SAMPLER_OPTIONS, ...opts };
  const samples = sampleGraphs(graph, opts);
  const predictedCounts = new Map<string, number>();
  const observedCounts = new Map<string, number>();
  let declaredCount = 0;
  let guessedCount = 0;

  for (const s of samples) {
    // Predicted: L2 #1 on the perturbed graph.
    const pred = predictedConstraint(s.graph, weights, sensitivities);
    if (pred.nodeId) {
      predictedCounts.set(pred.nodeId, (predictedCounts.get(pred.nodeId) ?? 0) + 1);
    }
    // Observed: highest pinned fraction on the perturbed graph.
    const obs = observedConstraint(s.graph, o.engine, o.steps);
    if (obs.nodeId) {
      observedCounts.set(obs.nodeId, (observedCounts.get(obs.nodeId) ?? 0) + 1);
    }
    // Tally declared vs guessed.
    for (const src of Object.values(s.sources)) {
      if (src.strength === "declared") declaredCount++;
      else if (src.strength === "guessed") guessedCount++;
      if (src.delay === "declared") declaredCount++;
      else if (src.delay === "guessed") guessedCount++;
    }
  }

  const nodes: NodeStability[] = graph.nodes.map((n) => ({
    nodeId: n.id,
    label: n.label,
    predictedFraction: (predictedCounts.get(n.id) ?? 0) / o.n,
    observedFraction: (observedCounts.get(n.id) ?? 0) / o.n,
  }));
  nodes.sort((a, b) => b.observedFraction - a.observedFraction || b.predictedFraction - a.predictedFraction);

  const predictedVerdict = verdictFor(nodes, "predicted");
  const observedVerdict = verdictFor(nodes, "observed");

  return { nodes, predictedVerdict, observedVerdict, n: o.n, declaredCount, guessedCount };
}

/**
 * Verdict for a constraint identity (predicted or observed), based on the
 * fraction of draws the #1 node won (spec §8.2):
 *   - >= 90% -> "stable"
 *   - 60–90% -> "likely"
 *   - < 60%, or the top two are within 10% of each other -> "unstable"
 */
export function verdictFor(
  nodes: NodeStability[],
  kind: "predicted" | "observed",
): StabilityVerdict {
  const sorted = [...nodes].sort(
    (a, b) => b[kind === "predicted" ? "predictedFraction" : "observedFraction"] - a[kind === "predicted" ? "predictedFraction" : "observedFraction"],
  );
  const top = sorted[0];
  if (!top) return "unstable";
  const frac = kind === "predicted" ? top.predictedFraction : top.observedFraction;
  if (frac >= 0.9) return "stable";
  if (frac >= 0.6) {
    // Check if the runner-up is close (within 10 percentage points -> "unstable").
    const runner = sorted[1];
    if (runner) {
      const rFrac = kind === "predicted" ? runner.predictedFraction : runner.observedFraction;
      if (frac - rFrac < 0.1) return "unstable";
    }
    return "likely";
  }
  return "unstable";
}

/** A human-readable verdict message (spec §8.2). */
export function verdictMessage(verdict: StabilityVerdict): string {
  switch (verdict) {
    case "stable":
      return "Stable. Act on it.";
    case "likely":
      return "Likely, but check the runner-up.";
    case "unstable":
      return "Unstable. You are near a bifurcation in the constraint landscape — optimising either node is a bet on parameters you do not actually know. Reduce uncertainty before spending.";
  }
}
