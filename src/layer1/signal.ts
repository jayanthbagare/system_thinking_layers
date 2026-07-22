/**
 * Layer 1 — loopy-style signal-propagation engine (spec §2, after ncase/loopy).
 *
 * A discrete, event-based simulation that mirrors how ncase.me/loopy models
 * systems: each node holds a normalized `value`; nudging a node emits a
 * "signal" (a delta) onto every outgoing edge. Signals travel along edges
 * (a `position` in [0,1]) at a fixed speed; when one arrives at the target,
 * its delta is multiplied by the edge's signed `strength` (polarity `+` adds,
 * `-` subtracts) and applied to the target's value, which then re-emits the
 * (already-scaled) delta onward. This produces the characteristic pulses
 * circulating around loops — reinforcing loops amplify, balancing loops
 * dampen.
 *
 * This module is pure: `step` and `nudge` return new states and never mutate.
 * The same `(state, graph, speed)` always yields the same next state, so it
 * is unit-testable and can be stepped deterministically from the renderer's
 * animation loop. It holds no parallel model state — node values live only
 * here as a view-layer animation, never on `Graph`.
 */

import type { Edge, Graph } from "@/model/types";

/** A pulse traveling along a single edge, from source (0) to target (1). */
export interface Signal {
  edgeId: string;
  /** Progress along the edge, 0..1. */
  position: number;
  /** The value delta being carried. */
  delta: number;
}

/** Mutable-only-by-copy simulation state. */
export interface LoopyState {
  /** Normalized node value (loopy: ~0..1, 0.5 = rest). May drift beyond. */
  values: Map<string, number>;
  /** All in-flight signals across every edge. */
  signals: Signal[];
}

/** Hard caps keep the animation bounded (mirrors loopy's MAX_SIGNALS). */
export const MAX_SIGNALS = 200;
export const MAX_SIGNALS_PER_EDGE = 12;

/** Default normalized rest value, matching loopy's `Node.defaultValue`. */
export const REST_VALUE = 0.5;
/** Nudge applied per click, matching loopy's hard-coded 0.33. */
export const NUDGE_DELTA = 0.33;

/**
 * Build the initial state: every node at its rest value, no signals. Node
 * values are normalized (not the graph's `initial_value` in model units) so
 * the propagation math stays scale-free — this is an animation, not a
 * quantitative forecast (Layer 3 owns quantitative simulation per spec §4).
 */
export function initialLoopyState(graph: Graph): LoopyState {
  const values = new Map<string, number>();
  for (const n of graph.nodes) values.set(n.id, REST_VALUE);
  return { values, signals: [] };
}

/** Reset values to rest and clear all signals. */
export function resetLoopyState(state: LoopyState, graph: Graph): LoopyState {
  void state;
  return initialLoopyState(graph);
}

/** Outgoing edges of a node, in stable (graph) order. */
export function outgoingEdges(graph: Graph, nodeId: string): Edge[] {
  return graph.edges.filter((e) => e.source === nodeId);
}

/**
 * Nudge a node's value by `delta` and emit a signal onto each outgoing edge.
 * Pure: returns a new state. The emitted signal carries the raw `delta`
 * (edge strength/polarity are applied on delivery, not on emission — same as
 * loopy).
 */
export function nudge(
  state: LoopyState,
  graph: Graph,
  nodeId: string,
  delta: number,
): LoopyState {
  const values = new Map(state.values);
  values.set(nodeId, (values.get(nodeId) ?? REST_VALUE) + delta);
  const signals = state.signals.slice();
  for (const e of outgoingEdges(graph, nodeId)) {
    if (signals.length >= MAX_SIGNALS) break;
    if (countOnEdge(signals, e.id) >= MAX_SIGNALS_PER_EDGE) continue;
    signals.push({ edgeId: e.id, position: 0, delta });
  }
  return { values, signals };
}

/**
 * Advance one step. `speed` is the fraction of an edge a signal traverses per
 * step (e.g. 0.04). Signals that reach position >= 1 are delivered: their
 * delta is scaled by the edge's signed strength, applied to the target node,
 * and then re-emitted onto the target's outgoing edges. Delivered and
 * in-flight signals are partitioned deterministically.
 */
export function step(state: LoopyState, graph: Graph, speed: number): LoopyState {
  const edgeById = new Map(graph.edges.map((e): [string, Edge] => [e.id, e]));
  const values = new Map(state.values);
  const inFlight: Signal[] = [];
  const deliveries: { nodeId: string; delta: number }[] = [];

  for (const s of state.signals) {
    const np = s.position + speed;
    if (np >= 1) {
      const e = edgeById.get(s.edgeId);
      if (e) {
        const sign = e.polarity === "+" ? 1 : -1;
        const delivered = s.delta * sign * e.strength;
        deliveries.push({ nodeId: e.target, delta: delivered });
      }
    } else {
      inFlight.push({ edgeId: s.edgeId, position: np, delta: s.delta });
    }
  }

  // Apply deliveries to target values, then re-emit each onward. Re-emission
  // uses the already-scaled delta (matching loopy: strength applies once, at
  // delivery, and the same delta keeps circulating).
  let signals = inFlight;
  for (const d of deliveries) {
    values.set(d.nodeId, (values.get(d.nodeId) ?? REST_VALUE) + d.delta);
    for (const e of outgoingEdges(graph, d.nodeId)) {
      if (signals.length >= MAX_SIGNALS) break;
      if (countOnEdge(signals, e.id) >= MAX_SIGNALS_PER_EDGE) continue;
      signals = [...signals, { edgeId: e.id, position: 0, delta: d.delta }];
    }
  }

  return { values, signals };
}

function countOnEdge(signals: Signal[], edgeId: string): number {
  let n = 0;
  for (const s of signals) if (s.edgeId === edgeId) n++;
  return n;
}
