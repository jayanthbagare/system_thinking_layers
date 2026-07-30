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
 * Provenance attached by a Loom sidecar (`provenance.json`). This is external
 * evidence about how a node or edge was produced — it is NOT computed graph
 * state and the validator never constrains it. Every field is optional because
 * real Loom output drifts; the loader is tolerant of missing keys (see the
 * discrepancy note: the reference document assumed `unit_value`,
 * `causal_support`, `tioe_class`, etc. — the loader accepts both snake_case
 * and camelCase and maps them here).
 *
 * Backward compatibility: when no sidecar is present, this field is omitted
 * entirely and the application behaves exactly as it does for a hand-authored
 * model (per the Loom integration spec: "nothing here changes the experience
 * for a person who never touches Loom at all").
 */
export interface Provenance {
  /** True for mined/inferred structure; false (or omitted) for human-confirmed. */
  mined?: boolean;
  /** The Loom stage that produced this element (e.g. "causal_discovery"). */
  stage?: string;
  /** Mining confidence in this element, 0..1. */
  confidence?: number;
  /** Statistical p-value of the supporting test, when reported. */
  pValue?: number;
  /** Plain-English reasoning carried from Loom's `tioe_suggestions.md`. */
  reasoning?: string;
  /**
   * Loom's suggested T/I/OE class for a node. Note: this repo DERIVES T/I/OE
   * from the system boundary + topology (the hand-authored `tioe_class` tag
   * is deprecated and rejected by the validator). This field is Loom's
   * *suggestion* — a provenance artefact surfaced in the UI, never a model
   * tag. `"none"` is Loom's honest "could not classify" default and renders
   * as a distinctly neutral state (Loom spec item 7).
   */
  tioeClass?: "T" | "I" | "OE" | "none";
  /** Dollars-per-physical-unit conversion factor (Loom spec item 4). */
  unitValue?: number;
  /** Whether causal evidence supports this edge. */
  causalSupport?: boolean;
  /** Whether structural evidence supports this edge. */
  structuralSupport?: boolean;
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
  /**
   * Operating expense the constrained resource consumes per unit of model
   * time, regardless of utilization — the cost of *having* the capacity (a
   * declared capacity cost, Phase 4). When present, `deriveTioe` counts this
   * node's contribution to OE as `capacity_cost` (so Exploit, which keeps the
   * collar fixed, holds OE flat, and Elevate, which moves the collar, raises
   * OE proportionally). When absent, OE falls back to the flow through the
   * collared stock (the Phase 3 utilization proxy). Omit for an unbounded node.
   */
  capacity_cost?: number;
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
  /**
   * Loom sidecar provenance. Attached by the sidecar-aware import when a
   * `provenance.json` is loaded alongside this model; omitted otherwise.
   * Validator-ignorable, never constrained. See `Provenance`.
   */
  provenance?: Provenance;
  /**
   * Forward-compatible extension point (Loom spec item 10): an arbitrary,
   * validator-ignorable object so future provenance can live in the core YAML
   * rather than always requiring a sidecar. Decide-the-shape-now; nothing
   * consumes it yet. Omitted when absent.
   */
  meta?: Record<string, unknown>;
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
  /** Loom sidecar provenance for this edge. See `Node.provenance`. */
  provenance?: Provenance;
  /** Forward-compatible extension point (Loom spec item 10). See `Node.meta`. */
  meta?: Record<string, unknown>;
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
  /**
   * Model-level Loom provenance (the part of `provenance.json` that is not
   * per-element: the model's real time unit, the `tioe_suggestions.md` text,
   * and the count of unclassified nodes). Attached by the sidecar-aware import;
   * omitted when no sidecar is present. Survives loop re-derivation (it rides
   * on `Graph`, not on the computed `loops`).
   */
  provenance?: GraphProvenance;
}

/**
 * Model-level Loom provenance. The per-element fields live on `Node`/`Edge`;
 * this carries the model-wide artefacts the Loom spec surfaces near Layer 3
 * and the ABM view.
 */
export interface GraphProvenance {
  /** Real time unit the model's time axis is expressed in (e.g. "1 week"). */
  timeUnit?: string;
  /** The `tioe_suggestions.md` body, for the "suggestions available" nudge. */
  tioeSuggestionsMd?: string;
  /** Count of nodes Loom could not confidently classify (`tioeClass: none`). */
  unclassifiedCount?: number;
  /** Whether a `tioe_suggestions.md` sidecar was present. */
  hasSuggestions?: boolean;
}
