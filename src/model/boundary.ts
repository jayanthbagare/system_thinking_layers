/**
 * System boundary computation (Phase 3).
 *
 * The system boundary defines which nodes are the system's ports — the
 * interface with its environment (market demand, supplier inputs, customer
 * outputs). Everything NOT on the boundary is "inside the system." T/I/OE
 * are derived from this inside/outside distinction (see `deriveTioe` in the
 * engine), replacing the hand-authored `tioe_class` tag.
 *
 * Auto-derivation: if no node has `boundary: true`, exogenous nodes (those
 * with no incoming edges) are treated as boundary. This is the common case —
 * a supply chain model has a customer-demand node with no incoming edges.
 *
 * If the author marks ANY node with `boundary: true`, the explicit set is
 * used and auto-derivation does not run. This lets the author include a
 * sink node (no outgoing edges) as boundary, or exclude an exogenous node
 * from the boundary if its semantics call for it.
 */

import type { Graph } from "./types";

/** Compute the set of boundary node IDs from a graph. Pure. */
export function computeBoundary(graph: Graph): Set<string> {
  const explicit = graph.nodes.filter((n) => n.boundary === true);
  if (explicit.length > 0) {
    return new Set(explicit.map((n) => n.id));
  }
  // Auto-derive: exogenous nodes (no incoming edges) are boundary.
  const incoming = new Set<string>();
  for (const e of graph.edges) incoming.add(e.target);
  const boundary = new Set<string>();
  for (const n of graph.nodes) {
    if (!incoming.has(n.id)) boundary.add(n.id);
  }
  return boundary;
}

/** True if `nodeId` is inside the system (not on the boundary). Pure. */
export function isInside(graph: Graph, nodeId: string): boolean {
  return !computeBoundary(graph).has(nodeId);
}

/** Edges crossing the boundary outward: source inside, target on boundary. */
export function outboundEdges(graph: Graph, boundary: Set<string>): import("./types").Edge[] {
  return graph.edges.filter((e) => !boundary.has(e.source) && boundary.has(e.target));
}

/** Edges crossing the boundary inward: source on boundary, target inside. */
export function inboundEdges(graph: Graph, boundary: Set<string>): import("./types").Edge[] {
  return graph.edges.filter((e) => boundary.has(e.source) && !boundary.has(e.target));
}
