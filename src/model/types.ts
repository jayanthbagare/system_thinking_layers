// The single source of truth for the Layers application.
//
// Per the architecture spec (prompt.md §1): all three layers read from this
// model; Layer 2 and 3 add computed fields; the ABM companion writes validation
// results back onto it. Everything downstream is an annotation on top of this
// graph, never a parallel structure.

/** Stock-flow semantics, not just a CLD box. */
export type NodeType = "stock" | "flow" | "auxiliary";

/** How a collar bound is enforced at the boundary. */
export type CollarApproach = "hard" | "soft";

/**
 * A physical bound on a node's value, in the same units as `initial_value`.
 * A collar says "the system cannot go there" — it is enforced inside the
 * simulation engine, not as a display clamp. Each bound is optional
 * independently: a node with only `upper` has no lower limit, and vice versa.
 */
export interface Collar {
  /** Physical lower bound. The engine clamps the value to >= lower. */
  lower?: number;
  /** Physical upper bound. The engine clamps the value to <= upper. */
  upper?: number;
  /** `hard` (default) clips at the boundary; `soft` ramps transfer to zero in
   * the top 10% of the span (Phase 7). Phase 2 enforces `hard` only. */
  approach?: CollarApproach;
}

/** Reference to an ABM rule; present only if the node has an ABM companion. */
export interface AgentRuleRef {
  /** Id of the rule definition (see src/abm in Phase 5). */
  rule_id: string;
}

/**
 * Authored uncertainty on an edge's static properties (Phase 8 sampler). NOT
 * enforced by the engine — it declares "I don't know this number precisely,"
 * distinct from a collar which declares "the system cannot go there."
 */
export interface EdgeRange {
  /** [min, max] range for the edge's `strength`. */
  strength?: [number, number];
  /** [min, max] range for the edge's `delay.magnitude`. */
  delay_magnitude?: [number, number];
}

export interface Node {
  id: string;
  label: string;
  type: NodeType;
  /**
   * When `true`, this node is part of the system boundary — the interface
   * between the system and its environment (market demand, supplier inputs,
   * customer outputs). Boundary nodes are NOT part of the system's interior;
   * they are the system's ports. T/I/OE are derived from the boundary +
   * topology (Phase 3), replacing the hand-authored `tioe_class` tag.
   *
   * Auto-derivation: if no node has `boundary: true`, nodes with no incoming
   * edges (exogenous drivers) are treated as boundary. This is the common
   * case — most models have a demand/supply driver that is exogenous.
   */
  boundary?: boolean;
  initial_value: number;
  unit: string;
  /**
   * Physical collar on this node's value, in the same units as
   * `initial_value`. Enforced inside the simulation engine (Phase 2): the
   * value is clamped to [lower, upper] with anti-windup and backpressure.
   * Omit for an unbounded node.
   */
  collar?: Collar;
  /** Present only if this node has an ABM companion. Omit when absent. */
  agent_binding?: AgentRuleRef;
  /**
   * Manual layout pin. View-derived but stored on the model so a pinned
   * layout survives save/load (see spec §2). Omit for auto-layout.
   */
  pin?: { x: number; y: number };
  /**
   * ABM validation verdict written back by the companion view (Phase 5).
   * Omit until an ABM run has reported on this node.
   */
  abm_verdict?: AbmVerdict;
}

export type DelayType = "none" | "material" | "information" | "perception";

export interface EdgeDelay {
  type: DelayType;
  /** In model time units. */
  magnitude: number;
}

export type Polarity = "+" | "-";

export interface Edge {
  id: string;
  source: string;
  target: string;
  polarity: Polarity;
  delay: EdgeDelay;
  /** Relative influence weight, for simulation. */
  strength: number;
  /** Authored uncertainty on static properties (Phase 8). Not engine-enforced. */
  range?: EdgeRange;
}

export type LoopSign = "reinforcing" | "balancing";

/** Computed, never authored. Derived via cycle enumeration (src/graph). */
export interface Loop {
  id: string;
  nodes: string[];
  edges: string[];
  sign: LoopSign;
  /** Max delay in the loop. */
  dominant_delay: number;
  /** Sum of delays around the loop. */
  cycle_time: number;
}

/** Validation verdict written by the ABM companion onto the bound node. */
export interface AbmVerdict {
  /** "validated" = macro structure reproduced; "flagged" = mismatch. */
  status: "validated" | "flagged";
  /** Human-readable explanation of what matched or mismatched. */
  detail: string;
  /** Last run's aggregate verdict on macro structure stability. */
  macro: "held" | "weakened" | "bifurcated";
}

export interface Graph {
  nodes: Node[];
  edges: Edge[];
  /** Derived via cycle enumeration, never hand-authored. */
  loops: Loop[];
}
