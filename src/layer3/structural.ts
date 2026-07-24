/**
 * Layer 3 — structural interventions (spec Phase 6).
 *
 * Architects change **topology**, not just parameters. Caching, async,
 * batch→stream, removing an approval handoff, adding backpressure — all edge
 * or delay operations, not deltas on a value. This module makes structural
 * edits first-class: a pure `applyStructuralEdit` that returns a new graph
 * with loops re-derived, plus a **leverage tier** annotation (spec §6.3) that
 * categorises every intervention by how much it moves T/I/OE per unit of OE.
 *
 * The leverage ladder (spec §6.3):
 *
 *   1 — Parameter   : numbers within existing bounds (Exploit, strength changes)
 *   2 — Bound       : where the walls are (Elevate — moving a collar)
 *   3 — Buffer      : stock sizes relative to flow (buffer sizing)
 *   4 — Delay       : length of feedback lag (collapse delay, change delay type)
 *   5 — Structure   : add/remove/rewire feedback (add rope, delete edge, split node)
 *   6 — Rules       : polarity, the goal node itself (flip polarity, change goal_node)
 *
 * Collars gave us a clean tier 2 that did not exist in the original ladder:
 * moving a wall is categorically distinct from moving within the walls. ToC's
 * Exploit-before-Elevate discipline is exactly the claim that tier 1 must be
 * exhausted before tier 2 is paid for.
 *
 * All functions are pure. `applyStructuralEdit` never mutates the input graph;
 * it returns a new one with `loops` re-derived (structural changes may add or
 * remove cycles). Splitting a collared node requires the caller to specify
 * where the collar goes — the pure logic never guesses (spec §6.1: "prompt,
 * do not guess").
 */

import type { DelayType, Edge, EdgeDelay, Graph, Node } from "@/model/types";
import { deriveLoops } from "@/graph/loops";

/** The six leverage tiers from spec §6.3. */
export type LeverageTier = 1 | 2 | 3 | 4 | 5 | 6;

export const TIER_LABELS: Record<LeverageTier, string> = {
  1: "Parameter",
  2: "Bound",
  3: "Buffer",
  4: "Delay",
  5: "Structure",
  6: "Rules",
};

/**
 * A structural edit descriptor. Each variant is one architect-facing topology
 * operation. Carried by a `TypedIntervention` of type `"structural"` and
 * applied to a *copy* of the graph by `applyStructuralEdit`.
 */
export type StructuralEdit =
  /** Add a new edge to the graph (tier 5 — Structure). */
  | { kind: "addEdge"; edge: Edge }
  /** Remove an edge by id (tier 5 — Structure). */
  | { kind: "deleteEdge"; edgeId: string }
  /**
   * Collapse an edge's delay by a `factor` (0 = remove the delay entirely,
   * 0.5 = halve it). Tier 4 — Delay. This is caching / async / colocation:
   * shortening the feedback lag, the most common architect lever.
   */
  | { kind: "collapseDelay"; edgeId: string; factor: number }
  /** Change an edge's delay type (tier 4 — Delay). */
  | { kind: "changeDelayType"; edgeId: string; delayType: DelayType }
  /** Flip an edge's polarity + ↔ − (tier 6 — Rules). */
  | { kind: "flipPolarity"; edgeId: string }
  /**
   * Split a node into two in series with a delay between them (tier 5 —
   * Structure). The original node keeps its incoming edges; the new node
   * inherits the original's outgoing edges, and a new edge (original → new)
   * carries the specified delay. Collars on the original must be explicitly
   * reassigned via `collarTo`: `"original"` keeps the collar on the original,
   * `"new"` moves it to the new node, omitted = neither has a collar. The
   * pure logic never guesses (spec §6.1: "prompt, do not guess").
   */
  | {
      kind: "splitNode";
      nodeId: string;
      newId: string;
      newLabel: string;
      delay: EdgeDelay;
      /** Where the original node's collar goes after the split. */
      collarTo?: "original" | "new";
    };

/** The leverage tier for a structural edit kind. Pure. */
export function structuralEditTier(edit: StructuralEdit): LeverageTier {
  switch (edit.kind) {
    case "collapseDelay":
    case "changeDelayType":
      return 4;
    case "addEdge":
    case "deleteEdge":
    case "splitNode":
      return 5;
    case "flipPolarity":
      return 6;
  }
}

/**
 * Apply a structural edit to a graph, returning a new graph with loops
 * re-derived. Pure: never mutates the input.
 */
export function applyStructuralEdit(graph: Graph, edit: StructuralEdit): Graph {
  let next: Graph;
  switch (edit.kind) {
    case "addEdge":
      next = { ...graph, edges: [...graph.edges, edit.edge] };
      break;
    case "deleteEdge":
      next = { ...graph, edges: graph.edges.filter((e) => e.id !== edit.edgeId) };
      break;
    case "collapseDelay":
      next = {
        ...graph,
        edges: graph.edges.map((e) =>
          e.id === edit.edgeId
            ? { ...e, delay: { ...e.delay, magnitude: e.delay.magnitude * edit.factor } }
            : e,
        ),
      };
      break;
    case "changeDelayType":
      next = {
        ...graph,
        edges: graph.edges.map((e) =>
          e.id === edit.edgeId ? { ...e, delay: { ...e.delay, type: edit.delayType } } : e,
        ),
      };
      break;
    case "flipPolarity":
      next = {
        ...graph,
        edges: graph.edges.map((e) =>
          e.id === edit.edgeId ? { ...e, polarity: e.polarity === "+" ? "-" : "+" } : e,
        ),
      };
      break;
    case "splitNode": {
      const original = graph.nodes.find((n) => n.id === edit.nodeId);
      if (!original) return graph;
      // The new node inherits the original's type, unit, and initial_value.
      // The collar goes where `collarTo` says; the other node has none.
      // Per `exactOptionalPropertyTypes`, we build each node with conditional
      // spread rather than assigning `undefined` to optional fields.
      const collarTo = edit.collarTo ?? "none";
      const keepOnOriginal = collarTo === "original";
      const moveToNew = collarTo === "new";
      // New node: gets the collar if `collarTo === "new"`.
      const newNode: Node = {
        id: edit.newId,
        label: edit.newLabel,
        type: original.type,
        initial_value: original.initial_value,
        unit: original.unit,
        ...(moveToNew && original.collar ? { collar: original.collar } : {}),
        ...(moveToNew && original.capacity_cost !== undefined ? { capacity_cost: original.capacity_cost } : {}),
      };
      // Original node: keeps the collar if `collarTo === "original"`; loses
      // it otherwise. Strip collar + capacity_cost via destructuring.
      const { collar: _c, capacity_cost: _cc, ...stripped } = original;
      void _c;
      void _cc;
      const updatedOriginal: Node = {
        ...stripped,
        ...(keepOnOriginal && original.collar ? { collar: original.collar } : {}),
        ...(keepOnOriginal && original.capacity_cost !== undefined ? { capacity_cost: original.capacity_cost } : {}),
      };
      // Re-wire: original keeps incoming; new node inherits outgoing; a new
      // edge original -> new carries the delay.
      const splitterEdge: Edge = {
        id: `split_${edit.nodeId}_${edit.newId}`,
        source: edit.nodeId,
        target: edit.newId,
        polarity: "+",
        delay: edit.delay,
        strength: 1,
      };
      const edges = graph.edges.map((e): Edge =>
        e.source === edit.nodeId ? { ...e, source: edit.newId } : e,
      );
      next = {
        ...graph,
        nodes: [...graph.nodes.map((n) => (n.id === edit.nodeId ? updatedOriginal : n)), newNode],
        edges: [...edges, splitterEdge],
      };
      break;
    }
  }
  // Re-derive loops — a structural change may add or remove cycles.
  const { loops } = deriveLoops(next);
  return { ...next, loops };
}
