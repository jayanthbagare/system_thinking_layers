/**
 * Layer 2 — constraint positioning overlay (spec §3).
 *
 * The constraint score is a *pure* function of `(Graph, weights)`. Same inputs ->
 * same output, no hidden state, no reliance on dict insertion order. This is the
 * single source of the heat overlay and the ranked side panel; Layer 1 only
 * colors/sizes nodes by the score, it never re-derives it.
 *
 * Per the spec, the score is a weighted sum of four signals:
 *
 *   score(node) = w1 * norm(in_degree)                 // loop membership count
 *               + w2 * norm(max_delay / avg_loop_ct)   // relative delay pile-up
 *               + w3 * norm(rate_mismatch_at_node)      // fast R vs slow B meet
 *               + w4 * norm(dominant_loop_membership)   // longest cycle-time loop
 *
 * Normalization is divide-by-max across nodes (the top node gets 1.0); a signal
 * that is zero everywhere stays zero. The final score is rescaled by the weight
 * sum so it stays in [0, 1] regardless of the weight magnitudes — only the
 * *ratios* between weights matter, which is what the slider sensitivity test
 * in the spec is about.
 *
 * Architecture rule: this module holds no state. `scoreGraph` is referentially
 * transparent; callers may memoize but the module itself does not.
 */

import type { Edge, Graph, Loop, Node } from "@/model/types";
import { deriveLoops } from "@/graph/loops";

/**
 * The five signal ids. The first four are structural (pure functions of the
 * graph); the fifth, `sensitivity`, is derived from the simulation engine
 * (Phase 1 §1.3) and passed into `scoreGraph` pre-computed so the scorer itself
 * stays referentially transparent. A node's sensitivity measures how much a
 * unit impulse there perturbs the whole system — the principled, deterministic
 * replacement for the removed live-load reweighting.
 */
export type SignalId =
  | "in_degree"
  | "delay_ratio"
  | "rate_mismatch"
  | "dominant_loop"
  | "sensitivity";

/** Exposed slider weights. Defaults are equal (any positive value works since
 * only ratios matter); 1 is chosen so the raw breakdown reads naturally. */
export interface Weights {
  in_degree: number;
  delay_ratio: number;
  rate_mismatch: number;
  dominant_loop: number;
  sensitivity: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  in_degree: 1,
  delay_ratio: 1,
  rate_mismatch: 1,
  dominant_loop: 1,
  sensitivity: 1,
};

/** Per-node signal values (raw, pre-normalization) — the "why" behind a score. */
export interface SignalBreakdown {
  in_degree: number;
  delay_ratio: number;
  rate_mismatch: number;
  dominant_loop: number;
  sensitivity: number;
}

/** A scored node: the full inspectable breakdown plus the final score. */
export interface ScoredNode {
  nodeId: string;
  label: string;
  /** Final score in [0,1]. */
  score: number;
  /** Normalized signal contributions (each in [0,1]) — sums to `score`. */
  contributions: SignalBreakdown;
  /** Raw signal values before normalization, for the detailed "why" panel. */
  raw: SignalBreakdown;
}

export interface ScoreResult {
  /** All nodes ranked by descending score (ties broken by node id for stability). */
  ranked: ScoredNode[];
  /** The weights used — echoed back so the panel can render sliders faithfully. */
  weights: Weights;
}

/**
 * Compute the constraint score for every node. Pure: a referentially
 * transparent function of `(graph, weights, sensitivities)`. Same inputs -> same
 * output, no hidden state, no reliance on dict insertion order, no dependence
 * on animation state.
 *
 * `sensitivities` (engine-derived, normalised to [0,1] across nodes) is an
 * explicit input rather than computed here, so the scorer never imports the
 * engine and never observes live animation state. When omitted, the
 * sensitivity signal is treated as zero everywhere (equivalent to a zeroed
 * weight) — the structural four signals still rank the graph.
 */
export function scoreGraph(
  graph: Graph,
  weights: Weights = DEFAULT_WEIGHTS,
  sensitivities?: Map<string, number>,
): ScoreResult {
  const loops = deriveLoops(graph).loops;

  const rawByNode = new Map<string, SignalBreakdown>();
  for (const n of graph.nodes) {
    rawByNode.set(n.id, computeRawSignals(n, graph.edges, loops, sensitivities));
  }

  // Normalize each signal across nodes (divide-by-max).
  const norms = normalizeAcrossNodes(rawByNode);

  const wSum =
    weights.in_degree +
    weights.delay_ratio +
    weights.rate_mismatch +
    weights.dominant_loop +
    weights.sensitivity;
  const safeW = wSum > 0 ? wSum : 1;

  const ranked: ScoredNode[] = graph.nodes.map((n) => {
    const raw = rawByNode.get(n.id)!;
    const norm = norms.get(n.id)!;
    const contributions: SignalBreakdown = {
      in_degree: (weights.in_degree * norm.in_degree) / safeW,
      delay_ratio: (weights.delay_ratio * norm.delay_ratio) / safeW,
      rate_mismatch: (weights.rate_mismatch * norm.rate_mismatch) / safeW,
      dominant_loop: (weights.dominant_loop * norm.dominant_loop) / safeW,
      sensitivity: (weights.sensitivity * norm.sensitivity) / safeW,
    };
    const score =
      contributions.in_degree +
      contributions.delay_ratio +
      contributions.rate_mismatch +
      contributions.dominant_loop +
      contributions.sensitivity;
    return { nodeId: n.id, label: n.label, score, contributions, raw };
  });

  ranked.sort((a, b) => b.score - a.score || (a.nodeId < b.nodeId ? -1 : 1));
  return { ranked, weights };
}

/** Top-k ranked constraints. Pure projection over `scoreGraph` output. */
export function topConstraints(
  graph: Graph,
  weights: Weights,
  k = 3,
  sensitivities?: Map<string, number>,
): ScoredNode[] {
  return scoreGraph(graph, weights, sensitivities).ranked.slice(0, k);
}

// --- per-node raw signals ------------------------------------------------

function computeRawSignals(
  node: Node,
  edges: Edge[],
  loops: Loop[],
  sensitivities?: Map<string, number>,
): SignalBreakdown {
  const incident = edges.filter((e) => e.source === node.id || e.target === node.id);
  const maxDelay = incident.reduce((m, e) => Math.max(m, e.delay.magnitude), 0);

  const memberLoops = loops.filter((l) => l.nodes.includes(node.id));
  const inDegree = memberLoops.length;

  const avgLoopCt =
    memberLoops.length > 0
      ? memberLoops.reduce((s, l) => s + l.cycle_time, 0) / memberLoops.length
      : 0;
  // Relative delay pile-up: a long delay is worse when the surrounding loops
  // are fast (small cycle time). Guards divide-by-zero.
  const delayRatio = avgLoopCt > 0 ? maxDelay / avgLoopCt : 0;

  const rateMismatch = mismatchAtNode(memberLoops);
  const dominantLoop = dominantLoopShare(memberLoops, loops);
  // Sensitivity is engine-derived and passed in (normalised [0,1]). Zero when
  // not supplied (structural-only scoring) so the signal is inert.
  const sensitivity = sensitivities?.get(node.id) ?? 0;

  return {
    in_degree: inDegree,
    delay_ratio: delayRatio,
    rate_mismatch: rateMismatch,
    dominant_loop: dominantLoop,
    sensitivity,
  };
}

/**
 * Rate mismatch: where a fast reinforcing loop meets a slow balancing loop
 * (spec: "Fast reinforcing loop feeding a slow balancing loop is where inventory
 * or oscillation builds"). Measured as the gap between the average reinforcing
 * loop cycle time and the average balancing loop cycle time among loops the
 * node belongs to. Zero if the node sits in only one polarity class.
 */
function mismatchAtNode(memberLoops: Loop[]): number {
  const reinforcing = memberLoops.filter((l) => l.sign === "reinforcing");
  const balancing = memberLoops.filter((l) => l.sign === "balancing");
  if (reinforcing.length === 0 || balancing.length === 0) return 0;
  const avgR = avgCycleTime(reinforcing);
  const avgB = avgCycleTime(balancing);
  return Math.abs(avgR - avgB);
}

function avgCycleTime(loops: Loop[]): number {
  return loops.length === 0 ? 0 : loops.reduce((s, l) => s + l.cycle_time, 0) / loops.length;
}

/**
 * Dominant-loop membership: the largest cycle-time among loops the node belongs
 * to, divided by the global max loop cycle time. Members of the dominant loop
 * score 1.0; members of faster loops score their fraction. This realizes the
 * spec's "Nodes in the loop with the longest cycle-time score higher" without
 * a brittle binary flag.
 */
function dominantLoopShare(memberLoops: Loop[], allLoops: Loop[]): number {
  if (allLoops.length === 0 || memberLoops.length === 0) return 0;
  const globalMax = allLoops.reduce((m, l) => Math.max(m, l.cycle_time), 0);
  if (globalMax === 0) return 0;
  const nodeMax = memberLoops.reduce((m, l) => Math.max(m, l.cycle_time), 0);
  return nodeMax / globalMax;
}

function normalizeAcrossNodes(
  raw: Map<string, SignalBreakdown>,
): Map<string, SignalBreakdown> {
  const max: SignalBreakdown = {
    in_degree: 0,
    delay_ratio: 0,
    rate_mismatch: 0,
    dominant_loop: 0,
    sensitivity: 0,
  };
  for (const s of raw.values()) {
    max.in_degree = Math.max(max.in_degree, s.in_degree);
    max.delay_ratio = Math.max(max.delay_ratio, s.delay_ratio);
    max.rate_mismatch = Math.max(max.rate_mismatch, s.rate_mismatch);
    max.dominant_loop = Math.max(max.dominant_loop, s.dominant_loop);
    max.sensitivity = Math.max(max.sensitivity, s.sensitivity);
  }

  const out = new Map<string, SignalBreakdown>();
  for (const [id, s] of raw) {
    out.set(id, {
      in_degree: max.in_degree > 0 ? s.in_degree / max.in_degree : 0,
      delay_ratio: max.delay_ratio > 0 ? s.delay_ratio / max.delay_ratio : 0,
      rate_mismatch: max.rate_mismatch > 0 ? s.rate_mismatch / max.rate_mismatch : 0,
      dominant_loop: max.dominant_loop > 0 ? s.dominant_loop / max.dominant_loop : 0,
      sensitivity: max.sensitivity > 0 ? s.sensitivity / max.sensitivity : 0,
    });
  }
  return out;
}
