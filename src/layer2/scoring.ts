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

/** The four signal ids, matching the spec's w1..w4. */
export type SignalId = "in_degree" | "delay_ratio" | "rate_mismatch" | "dominant_loop";

/** Exposed slider weights. Defaults are equal (any positive value works since
 * only ratios matter); 1 is chosen so the raw breakdown reads naturally. */
export interface Weights {
  in_degree: number;
  delay_ratio: number;
  rate_mismatch: number;
  dominant_loop: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  in_degree: 1,
  delay_ratio: 1,
  rate_mismatch: 1,
  dominant_loop: 1,
};

/** Per-node signal values (raw, pre-normalization) — the "why" behind a score. */
export interface SignalBreakdown {
  in_degree: number;
  delay_ratio: number;
  rate_mismatch: number;
  dominant_loop: number;
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
  /**
   * Current live load factor in [0,1] — how far the node's runtime value has
   * drifted from rest, relative to the most-loaded node. 0 = at rest, 1 =
   * most loaded. Omitted when no live values were supplied (structural-only
   * scoring), so callers can detect whether the score is live-adjusted.
   */
  load?: number;
}

export interface ScoreResult {
  /** All nodes ranked by descending score (ties broken by node id for stability). */
  ranked: ScoredNode[];
  /** The weights used — echoed back so the panel can render sliders faithfully. */
  weights: Weights;
}

/**
 * Rest value matching the Layer 1 loopy simulation's `REST_VALUE` (0.5).
 * Duplicated locally to avoid a cross-layer dependency on `layer1/signal`.
 * A node whose live value equals this is "at rest" (no load).
 */
const REST_VALUE = 0.5;

/**
 * Compute the constraint score for every node. Pure.
 *
 * When `liveValues` is supplied (the current Layer 1 loopy animation state),
 * each node's structural score is multiplied by a **load factor** derived
 * from how far its runtime value has drifted from rest. A heavily loaded node
 * (large deviation) gets a bigger boost, so the ranking reflects *active*
 * bottlenecks — not just structural ones. The existing weights still control
 * which structural signals matter; load only re-weights their product. When
 * `liveValues` is omitted, the score is purely structural (the original behavior).
 */
export function scoreGraph(
  graph: Graph,
  weights: Weights = DEFAULT_WEIGHTS,
  liveValues?: Map<string, number>,
): ScoreResult {
  const loops = deriveLoops(graph).loops;

  const rawByNode = new Map<string, SignalBreakdown>();
  for (const n of graph.nodes) {
    rawByNode.set(n.id, computeRawSignals(n, graph.edges, loops));
  }

  // Normalize each signal across nodes (divide-by-max).
  const norms = normalizeAcrossNodes(rawByNode);

  const wSum =
    weights.in_degree + weights.delay_ratio + weights.rate_mismatch + weights.dominant_loop;
  const safeW = wSum > 0 ? wSum : 1;

  const ranked: ScoredNode[] = graph.nodes.map((n) => {
    const raw = rawByNode.get(n.id)!;
    const norm = norms.get(n.id)!;
    const contributions: SignalBreakdown = {
      in_degree: (weights.in_degree * norm.in_degree) / safeW,
      delay_ratio: (weights.delay_ratio * norm.delay_ratio) / safeW,
      rate_mismatch: (weights.rate_mismatch * norm.rate_mismatch) / safeW,
      dominant_loop: (weights.dominant_loop * norm.dominant_loop) / safeW,
    };
    const score =
      contributions.in_degree +
      contributions.delay_ratio +
      contributions.rate_mismatch +
      contributions.dominant_loop;
    return { nodeId: n.id, label: n.label, score, contributions, raw };
  });

  // When live values are supplied, multiply each structural score by a load
  // factor (1 + normalizedDeviation). A node at rest keeps its structural
  // score; a fully loaded node gets 2×. Then re-normalize so the top is 1.0.
  if (liveValues) {
    let maxDev = 0;
    const devByNode = new Map<string, number>();
    for (const n of graph.nodes) {
      const v = liveValues.get(n.id) ?? REST_VALUE;
      const dev = Math.abs(v - REST_VALUE);
      devByNode.set(n.id, dev);
      if (dev > maxDev) maxDev = dev;
    }
    for (const sn of ranked) {
      const dev = devByNode.get(sn.nodeId) ?? 0;
      const normDev = maxDev > 0 ? dev / maxDev : 0;
      sn.score = sn.score * (1 + normDev);
      sn.load = normDev;
    }
    // Re-normalize to [0,1] (divide by max).
    const maxScore = ranked.reduce((m, sn) => Math.max(m, sn.score), 0);
    if (maxScore > 0) {
      for (const sn of ranked) sn.score /= maxScore;
    }
  }

  ranked.sort((a, b) => b.score - a.score || (a.nodeId < b.nodeId ? -1 : 1));
  return { ranked, weights };
}

/** Top-k ranked constraints. Pure projection over `scoreGraph` output. */
export function topConstraints(graph: Graph, weights: Weights, k = 3): ScoredNode[] {
  return scoreGraph(graph, weights).ranked.slice(0, k);
}

// --- per-node raw signals ------------------------------------------------

function computeRawSignals(node: Node, edges: Edge[], loops: Loop[]): SignalBreakdown {
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

  return {
    in_degree: inDegree,
    delay_ratio: delayRatio,
    rate_mismatch: rateMismatch,
    dominant_loop: dominantLoop,
  };
}

/**
 * Rate mismatch: where a fast reinforcing loop meets a slow balancing loop
 * (spec: "Fast reinforcing loop feeding a slow balancing loop is where inventory
 * or oscillation builds"). Measured as the gap between the average reinforcing
 * loop cycle time and the average balancing loop cycle time among loops the
 * node belongs to, normalized by the global max loop cycle time so it's
 * comparable across graphs. Zero if the node sits in only one polarity class.
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
  };
  for (const s of raw.values()) {
    max.in_degree = Math.max(max.in_degree, s.in_degree);
    max.delay_ratio = Math.max(max.delay_ratio, s.delay_ratio);
    max.rate_mismatch = Math.max(max.rate_mismatch, s.rate_mismatch);
    max.dominant_loop = Math.max(max.dominant_loop, s.dominant_loop);
  }

  const out = new Map<string, SignalBreakdown>();
  for (const [id, s] of raw) {
    out.set(id, {
      in_degree: max.in_degree > 0 ? s.in_degree / max.in_degree : 0,
      delay_ratio: max.delay_ratio > 0 ? s.delay_ratio / max.delay_ratio : 0,
      rate_mismatch: max.rate_mismatch > 0 ? s.rate_mismatch / max.rate_mismatch : 0,
      dominant_loop: max.dominant_loop > 0 ? s.dominant_loop / max.dominant_loop : 0,
    });
  }
  return out;
}
