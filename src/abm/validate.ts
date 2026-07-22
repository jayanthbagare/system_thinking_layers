/**
 * Phase 5 — ABM validation (spec §5).
 *
 * Compares the aggregate time-series from `runAbm` against the bound node's
 * loop polarity and delay. Produces an `AbmVerdict` that gets written back onto
 * the `Node` (single source of truth) — "validated" if the macro behavior
 * matches, "flagged" with the specific mismatch otherwise.
 *
 * Macro behavior detection:
 *   - reinforcing: the series' variance or amplitude grows over time
 *     (amplification — a bullwhip).
 *   - balancing: the series converges toward a stable equilibrium
 *     (variance shrinks, mean stabilizes).
 *
 * Delay check: the dominant response lag (first zero-crossing of the
 * autocovariance, or the rise time of the step response) is compared to the
 * bound node's loop cycle_time. Within a tolerance factor -> delay match.
 *
 * Perturbation verdict (macro stability):
 *   - held: same macro behavior as the baseline run.
 *   - weakened: same behavior but less pronounced (e.g. slower amplification,
 *     or convergence with more residual oscillation).
 *   - bifurcated: behavior flipped (converging -> amplifying or vice versa).
 */

import type { AbmVerdict, Graph, Loop } from "@/model/types";
import { deriveLoops } from "@/graph/loops";
import type { AbmResult, AgentPopulation, RuleKind } from "./engine";

export type MacroBehavior = "reinforcing" | "balancing";

export interface ValidationInput {
  graph: Graph;
  result: AbmResult;
}

export interface PerturbationInput {
  baseline: AbmResult;
  perturbed: AbmResult;
}

/** Compute the macro behavior of an ABM aggregate series. Pure. */
export function macroBehavior(series: number[]): MacroBehavior {
  if (series.length < 4) return "balancing"; // too short to tell; default safe.
  const half = Math.floor(series.length / 2);
  const firstHalf = series.slice(0, half);
  const secondHalf = series.slice(half);
  const firstVar = variance(firstHalf);
  const secondVar = variance(secondHalf);
  const firstAmp = amplitude(firstHalf);
  const secondAmp = amplitude(secondHalf);
  // Drift: only counts as reinforcing if the mean is *growing* (moving away
  // from the initial equilibrium), not shrinking (which is convergence).
  const firstMean = mean(firstHalf);
  const secondMean = mean(secondHalf);
  const driftRatio = firstMean !== 0 ? (secondMean - firstMean) / Math.abs(firstMean) : 0;
  const grows =
    secondVar > firstVar * 1.15 ||
    secondAmp > firstAmp * 1.15 ||
    driftRatio > 0.15;
  return grows ? "reinforcing" : "balancing";
}

/** Estimate the dominant response lag of a series (in steps). Pure. */
export function dominantLag(series: number[]): number {
  if (series.length < 4) return 0;
  const m = mean(series);
  const centered = series.map((v) => v - m);
  // If the series is monotonic (at most one sign change in centered values —
  // crossing the mean once), there is no oscillation to measure a lag from.
  let signChanges = 0;
  for (let i = 1; i < centered.length; i++) {
    if (centered[i - 1] < 0 && centered[i] >= 0) signChanges++;
    else if (centered[i - 1] > 0 && centered[i] <= 0) signChanges++;
  }
  if (signChanges <= 1) return 0;
  // Autocovariance: for each lag k, compute the correlation of the series
  // with itself shifted by k. The first lag where autocovariance crosses
  // zero is a proxy for the oscillation period / response time.
  const maxLag = Math.min(series.length - 1, 50);
  for (let k = 1; k < maxLag; k++) {
    let cov = 0;
    let count = 0;
    for (let i = 0; i + k < series.length; i++) {
      cov += centered[i] * centered[i + k];
      count++;
    }
    cov = count > 0 ? cov / count : 0;
    // First sign change (zero-crossing) approximates the half-period.
    if (cov < 0) return k;
  }
  // No zero-crossing within range: return the lag of maximum autocovariance.
  let bestLag = 0;
  let bestCov = -Infinity;
  for (let k = 1; k < maxLag; k++) {
    let cov = 0;
    let count = 0;
    for (let i = 0; i + k < series.length; i++) {
      cov += centered[i] * centered[i + k];
      count++;
    }
    cov = count > 0 ? cov / count : 0;
    if (cov > bestCov) {
      bestCov = cov;
      bestLag = k;
    }
  }
  return bestLag;
}

/**
 * Validate an ABM result against the bound node's loops. Returns the verdict
 * to write onto `Node.abm_verdict`.
 */
export function validateAbm(input: ValidationInput): AbmVerdict {
  const { graph, result } = input;
  const loops = deriveLoops(graph).loops;
  const boundLoops = loops.filter((l) => l.nodes.includes(result.population.boundNode));
  const actual = macroBehavior(result.series);

  if (boundLoops.length === 0) {
    return {
      status: "flagged",
      detail: "Bound node is not in any loop; cannot validate macro structure.",
      macro: "held",
    };
  }

  // Polarity check: does the rule's expected behavior match the loop sign?
  const expectedRuleBehavior = ruleExpectedBehavior(result.population.rule);
  const loopSigns = new Set(boundLoops.map((l) => l.sign));
  const hasMatchingLoop = [...loopSigns].some(
    (sign) => sign === expectedRuleBehavior,
  );

  // Does the actual aggregate match the expected behavior?
  const actualMatchesExpected = actual === expectedRuleBehavior;

  const mismatches: string[] = [];
  if (!hasMatchingLoop) {
    mismatches.push(
      `rule "${result.population.rule}" expects ${expectedRuleBehavior} behavior but the bound node's loops are [${[...loopSigns].join(", ")}]`,
    );
  }
  if (!actualMatchesExpected) {
    mismatches.push(
      `aggregate is ${actual} but rule expected ${expectedRuleBehavior}`,
    );
  }

  // Delay check: compare the dominant lag to the loop's cycle_time. Skip when
  // the series is monotonic (lag 0) — there's no oscillation to time.
  const lag = dominantLag(result.series);
  const avgCycleTime = avg(boundLoops.map((l) => l.cycle_time));
  const delayTolerance = 2.0;
  if (
    lag > 0 &&
    avgCycleTime > 0 &&
    (lag < avgCycleTime / delayTolerance || lag > avgCycleTime * delayTolerance)
  ) {
    mismatches.push(
      `response lag ${lag.toFixed(1)} does not match loop cycle_time ${avgCycleTime.toFixed(1)}`,
    );
  }

  const status: AbmVerdict["status"] = mismatches.length === 0 ? "validated" : "flagged";
  const detail = status === "validated"
    ? `Aggregate ${actual} behavior matches loop [${[...loopSigns].join(", ")}]; lag ${lag.toFixed(1)} vs cycle_time ${avgCycleTime.toFixed(1)}.`
    : mismatches.join("; ");

  return { status, detail, macro: "held" };
}

/**
 * Compare a perturbed run to the baseline. Returns the macro stability verdict.
 */
export function perturbationVerdict(input: PerturbationInput): AbmVerdict["macro"] {
  const baseBehavior = macroBehavior(input.baseline.series);
  const pertBehavior = macroBehavior(input.perturbed.series);
  if (baseBehavior !== pertBehavior) return "bifurcated";

  // Same behavior — is it weakened? Compare amplitude/variance.
  const baseVar = variance(input.baseline.series);
  const pertVar = variance(input.perturbed.series);
  const baseAmp = amplitude(input.baseline.series);
  const pertAmp = amplitude(input.perturbed.series);
  // Weakened: same direction but materially less pronounced.
  const weakened =
    baseBehavior === "reinforcing"
      ? pertVar < baseVar * 0.6 || pertAmp < baseAmp * 0.6
      : pertVar > baseVar * 1.5 || pertAmp > baseAmp * 1.5;
  return weakened ? "weakened" : "held";
}

/** The macro behavior a rule is expected to produce. */
export function ruleExpectedBehavior(rule: RuleKind): MacroBehavior {
  switch (rule) {
    case "reorder_policy":
      return "reinforcing";
    case "capacity_threshold":
      return "balancing";
    case "info_passing_delay":
      return "balancing";
  }
}

// --- stats helpers ------------------------------------------------------

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / xs.length;
}

function amplitude(xs: number[]): number {
  if (xs.length === 0) return 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of xs) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return hi - lo;
}

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : mean(xs);
}

export type { AgentPopulation, Loop };
