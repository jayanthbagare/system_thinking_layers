// The single source of truth for the Layers application.
//
// Per the architecture spec (prompt.md §1): all three layers read from this
// model; Layer 2 and 3 add computed fields; the ABM companion writes validation
// results back onto it. Everything downstream is an annotation on top of this
// graph, never a parallel structure.

/** Stock-flow semantics, not just a CLD box. */
export type NodeType = "stock" | "flow" | "auxiliary";

/** Layer 3 tag. Throughput / Investment-Inventory / Operating Expense / none. */
export type TioeClass = "T" | "I" | "OE" | "none";

/** Reference to an ABM rule; present only if the node has an ABM companion. */
export interface AgentRuleRef {
  /** Id of the rule definition (see src/abm in Phase 5). */
  rule_id: string;
}

export interface Node {
  id: string;
  label: string;
  type: NodeType;
  tioe_class: TioeClass;
  initial_value: number;
  unit: string;
  /**
   * Normalized [0,1] lower bound (collar) for this node's live loopy value.
   * The loopy animation clamps the node's value to >= lower_collar. Omit (or 0)
   * for no lower clamp. Authored in the YAML alongside upper_collar.
   */
  lower_collar?: number;
  /**
   * Normalized [0,1] upper bound (collar) for this node's live loopy value.
   * The loopy animation clamps the node's value to <= upper_collar. Omit (or 1)
   * for no upper clamp. Must be >= lower_collar.
   */
  upper_collar?: number;
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
