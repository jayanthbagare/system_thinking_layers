/**
 * Derive `Loop[]` from a `Graph` by enumerating elementary cycles (Johnson's
 * algorithm, see `cycles.ts`) and annotating each with its sign, cycle time,
 * and dominant delay.
 *
 * This is the *only* function that produces `Loop[]`. Per the architecture
 * rule, loops are always computed from edges, never hand-authored: the DSL
 * parser emits `loops: []` and `validate()` re-derives the sign to catch
 * hand-authored drift. Loops are stable: for a given `(nodes, edges)` the
 * output is deterministic and independent of dict insertion order.
 */

import type { Edge, Graph, Loop, LoopSign } from "@/model/types";
import { findCycles, type Adjacency } from "./cycles";

export interface DerivedLoops {
  /** Newly derived loops, ordered by their canonical cycle node sequence. */
  loops: Loop[];
  /** Stable map from a loop's `nodes` key to its `id` (R1/B1...). */
  idByKey: Map<string, string>;
}

/** Derive all loops from a Graph. Pure: same input -> same output. */
export function deriveLoops(graph: Graph): DerivedLoops {
  const nodeIds = graph.nodes.map((n) => n.id);
  const adj = buildAdjacency(graph.edges, nodeIds);
  const edgeByEndpoints = new Map<string, Edge>();
  for (const e of graph.edges) edgeByEndpoints.set(edgeKey(e.source, e.target), e);

  const rawCycles = findCycles(nodeIds, adj);

  // Deduplicate defensively: findCycles already returns each elementary cycle
  // once (anchored at its lowest-indexed node), but a duplicate check keeps the
  // output robust to future changes in the enumerator.
  const seen = new Set<string>();
  const loops: Loop[] = [];
  for (const nodeSeq of rawCycles) {
    const key = nodeSeq.join("->");
    if (seen.has(key)) continue;
    seen.add(key);
    loops.push(buildLoop(nodeSeq, edgeByEndpoints, loops.length));
  }

  // Stable, content-addressed ids: R/B prefix by sign, then a 1-based ordinal
  // ordered by the canonical node sequence so ids are deterministic across
  // runs. We assign ordinals within each sign class separately.
  assignLoopIds(loops);

  const idByKey = new Map<string, string>();
  for (const l of loops) idByKey.set(l.nodes.join("->"), l.id);
  return { loops, idByKey };
}

/** Convenience: return just the loops, ordered by id. */
export function loopsOf(graph: Graph): Loop[] {
  return deriveLoops(graph).loops.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** Return a fresh `Graph` with recomputed loops. Does not mutate the input. */
export function withComputedLoops(graph: Graph): Graph {
  return { ...graph, loops: loopsOf(graph) };
}

function buildAdjacency(edges: Edge[], nodeIds: string[]): Adjacency {
  const adj: Adjacency = new Map();
  for (const id of nodeIds) adj.set(id, []);
  for (const e of edges) {
    const list = adj.get(e.source);
    if (list) list.push(e.target);
  }
  return adj;
}

function buildLoop(
  nodeSeq: string[],
  edgeByEndpoints: Map<string, Edge>,
  _index: number,
): Loop {
  const edges: Edge[] = [];
  for (let i = 0; i < nodeSeq.length; i++) {
    const src = nodeSeq[i];
    const tgt = nodeSeq[(i + 1) % nodeSeq.length];
    const e = edgeByEndpoints.get(edgeKey(src, tgt));
    // findCycles only walks real edges, so this lookup must succeed.
    if (e) edges.push(e);
  }

  const sign = signOf(edges);
  const cycleTime = edges.reduce((sum, e) => sum + e.delay.magnitude, 0);
  const dominantDelay = edges.reduce((m, e) => Math.max(m, e.delay.magnitude), 0);

  // Temporary id; replaced with a stable R/B ordinal after all loops are known.
  return {
    id: `${sign === "reinforcing" ? "R" : "B"}?`,
    nodes: [...nodeSeq],
    edges: edges.map((e) => e.id),
    sign,
    dominant_delay: dominantDelay,
    cycle_time: cycleTime,
  };
}

/** Even number of `-` edges -> reinforcing; odd -> balancing. */
export function signOf(edges: Pick<Edge, "polarity">[]): LoopSign {
  let neg = 0;
  for (const e of edges) if (e.polarity === "-") neg++;
  return neg % 2 === 0 ? "reinforcing" : "balancing";
}

function assignLoopIds(loops: Loop[]): void {
  // Sort by canonical node sequence so ordinals are deterministic regardless of
  // the order findCycles happens to emit. The anchor (lowest-indexed node) is
  // already first in each sequence, so lexicographic-by-index comparison is well
  // defined; we sort by the node sequence strings here for stability.
  const order = [...loops].sort((a, b) => {
    const ka = a.nodes.join("->");
    const kb = b.nodes.join("->");
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  let rCount = 0;
  let bCount = 0;
  for (const l of order) {
    l.id = l.sign === "reinforcing" ? `R${++rCount}` : `B${++bCount}`;
  }
}

function edgeKey(source: string, target: string): string {
  return `${source}->${target}`;
}
