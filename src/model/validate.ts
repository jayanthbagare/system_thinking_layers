import type {
  Collar,
  CollarApproach,
  Edge,
  EdgeRange,
  Graph,
  Loop,
  LoopSign,
  Node,
  NodeType,
  Polarity,
} from "./types";

/**
 * Structured validation of a candidate Graph.
 *
 * Validation collects EVERY violation (not just the first) so the DSL parser
 * can report all problems in one pass. A Graph is valid iff `validate()` returns
 * an empty list.
 */

export type ValidationCode =
  | "duplicate_node_id"
  | "duplicate_edge_id"
  | "edge_unknown_source"
  | "edge_unknown_target"
  | "edge_self_loop"
  | "duplicate_edge"
  | "missing_node_field"
  | "missing_edge_field"
  | "invalid_node_type"
  | "invalid_boundary"
  | "tioe_class_deprecated"
  | "invalid_polarity"
  | "invalid_delay_type"
  | "negative_delay"
  | "negative_strength"
  | "non_string_id"
  | "loop_not_computed"
  | "loop_unknown_node"
  | "loop_unknown_edge"
  | "loop_sign_mismatch"
  | "loop_not_closed"
  | "collar_ambiguous_units"
  | "collar_lower_above_upper"
  | "collar_initial_out_of_range"
  | "collar_invalid_approach"
  | "capacity_cost_negative"
  | "range_invalid";

export interface ValidationIssue {
  code: ValidationCode;
  message: string;
  /** Id of the offending element, when locatable. */
  ref?: string;
}

const NODE_TYPES = new Set<NodeType>(["stock", "flow", "auxiliary"]);
const POLARITIES = new Set<Polarity>(["+", "-"]);
const DELAY_TYPES = new Set(["none", "material", "information", "perception"]);
const COLLAR_APPROACHES = new Set<CollarApproach>(["hard", "soft"]);

export function validate(graph: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isObject(graph)) {
    issues.push({ code: "missing_node_field", message: "graph must be an object" });
    return issues;
  }
  const g = graph as Partial<Graph>;

  const nodeIds = new Set<string>();
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  for (const n of nodes) {
    issues.push(...validateNode(n, nodeIds));
  }

  const edgeIds = new Set<string>();
  const edges = Array.isArray(g.edges) ? g.edges : [];
  const edgeSet = new Set<string>();
  for (const e of edges) {
    issues.push(...validateEdge(e, edgeIds, nodeIds, edgeSet));
  }

  const loops = Array.isArray(g.loops) ? g.loops : [];
  for (const l of loops) {
    issues.push(...validateLoop(l, nodeIds, edgeIds, edges));
  }

  return issues;
}

export function isValid(graph: unknown): graph is Graph {
  return validate(graph).length === 0;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateNode(node: unknown, seen: Set<string>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isObject(node)) {
    issues.push({ code: "missing_node_field", message: "node must be an object" });
    return issues;
  }
  const n = node as Partial<Node>;
  if (typeof n.id !== "string" || n.id.length === 0) {
    issues.push({ code: "non_string_id", message: "node.id must be a non-empty string" });
    return issues;
  }
  if (seen.has(n.id)) {
    issues.push({ code: "duplicate_node_id", message: `duplicate node id "${n.id}"`, ref: n.id });
  }
  seen.add(n.id);

  if (typeof n.label !== "string") {
    issues.push({ code: "missing_node_field", message: `node "${n.id}" missing label`, ref: n.id });
  }
  if (n.type === undefined || !NODE_TYPES.has(n.type)) {
    issues.push({ code: "invalid_node_type", message: `node "${n.id}" has invalid type`, ref: n.id });
  }
  if (n.boundary !== undefined && typeof n.boundary !== "boolean") {
    issues.push({
      code: "invalid_boundary",
      message: `node "${n.id}" boundary must be a boolean`,
      ref: n.id,
    });
  }
  if (typeof n.initial_value !== "number" || Number.isNaN(n.initial_value)) {
    issues.push({
      code: "missing_node_field",
      message: `node "${n.id}" missing numeric initial_value`,
      ref: n.id,
    });
  }
  if (typeof n.unit !== "string") {
    issues.push({ code: "missing_node_field", message: `node "${n.id}" missing unit`, ref: n.id });
  }
  if (n.pin !== undefined) {
    if (typeof n.pin.x !== "number" || typeof n.pin.y !== "number") {
      issues.push({
        code: "missing_node_field",
        message: `node "${n.id}" has non-numeric pin`,
        ref: n.id,
      });
    }
  }
  // Detect legacy flat collar fields (pre-Phase-2 normalized [0,1] bounds).
  // The spec requires these to be restated in the new `collar:` block with
  // physical units — they are NOT silently reinterpreted.
  const raw = node as Record<string, unknown>;
  if (raw.lower_collar !== undefined || raw.upper_collar !== undefined) {
    issues.push({
      code: "collar_ambiguous_units",
      message: `node "${n.id}" uses legacy flat lower_collar/upper_collar fields. Restate as: collar: { lower: <physical>, upper: <physical> } in the same units as initial_value.`,
      ref: n.id,
    });
  }
  // Detect legacy tioe_class field (pre-Phase-3 hand-authored tag).
  // T/I/OE are now derived from the system boundary + topology, not annotated.
  if (raw.tioe_class !== undefined) {
    issues.push({
      code: "tioe_class_deprecated",
      message: `node "${n.id}" uses the deprecated tioe_class field. T/I/OE are now derived from the system boundary. Remove tioe_class and use boundary: true on nodes that are the system's interface with its environment (exogenous drivers are auto-detected).`,
      ref: n.id,
    });
  }
  // Validate the new collar: block (physical units).
  if (n.collar !== undefined) {
    const c = n.collar as Partial<Collar>;
    const lo = c.lower;
    const hi = c.upper;
    if (lo !== undefined && (typeof lo !== "number" || Number.isNaN(lo))) {
      issues.push({
        code: "collar_ambiguous_units",
        message: `node "${n.id}" collar.lower must be a number`,
        ref: n.id,
      });
    }
    if (hi !== undefined && (typeof hi !== "number" || Number.isNaN(hi))) {
      issues.push({
        code: "collar_ambiguous_units",
        message: `node "${n.id}" collar.upper must be a number`,
        ref: n.id,
      });
    }
    if (
      lo !== undefined &&
      hi !== undefined &&
      typeof lo === "number" &&
      typeof hi === "number" &&
      !Number.isNaN(lo) &&
      !Number.isNaN(hi) &&
      lo >= hi
    ) {
      issues.push({
        code: "collar_lower_above_upper",
        message: `node "${n.id}" collar.lower (${lo}) must be < collar.upper (${hi})`,
        ref: n.id,
      });
    }
    // initial_value must lie within [lower, upper] when bounds are present.
    if (
      typeof n.initial_value === "number" &&
      !Number.isNaN(n.initial_value)
    ) {
      if (lo !== undefined && typeof lo === "number" && n.initial_value < lo) {
        issues.push({
          code: "collar_initial_out_of_range",
          message: `node "${n.id}" initial_value (${n.initial_value}) is below collar.lower (${lo})`,
          ref: n.id,
        });
      }
      if (hi !== undefined && typeof hi === "number" && n.initial_value > hi) {
        issues.push({
          code: "collar_initial_out_of_range",
          message: `node "${n.id}" initial_value (${n.initial_value}) is above collar.upper (${hi})`,
          ref: n.id,
        });
      }
    }
    if (c.approach !== undefined && !COLLAR_APPROACHES.has(c.approach)) {
      issues.push({
        code: "collar_invalid_approach",
        message: `node "${n.id}" collar.approach must be "hard" or "soft"`,
        ref: n.id,
      });
    }
  }
  // Declared capacity cost (Phase 4 OE source). Optional; must be >= 0.
  if (n.capacity_cost !== undefined) {
    if (typeof n.capacity_cost !== "number" || Number.isNaN(n.capacity_cost)) {
      issues.push({
        code: "capacity_cost_negative",
        message: `node "${n.id}" capacity_cost must be a number`,
        ref: n.id,
      });
    } else if (n.capacity_cost < 0) {
      issues.push({
        code: "capacity_cost_negative",
        message: `node "${n.id}" capacity_cost must be >= 0`,
        ref: n.id,
      });
    }
  }
  return issues;
}

function validateEdge(
  edge: unknown,
  seen: Set<string>,
  nodeIds: Set<string>,
  edgeSet: Set<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isObject(edge)) {
    issues.push({ code: "missing_edge_field", message: "edge must be an object" });
    return issues;
  }
  const e = edge as Partial<Edge>;
  if (typeof e.id !== "string" || e.id.length === 0) {
    issues.push({ code: "non_string_id", message: "edge.id must be a non-empty string" });
    return issues;
  }
  if (seen.has(e.id)) {
    issues.push({ code: "duplicate_edge_id", message: `duplicate edge id "${e.id}"`, ref: e.id });
  }
  seen.add(e.id);

  if (typeof e.source !== "string" || !nodeIds.has(e.source)) {
    issues.push({
      code: "edge_unknown_source",
      message: `edge "${e.id}" references unknown source "${e.source}"`,
      ref: e.id,
    });
  }
  if (typeof e.target !== "string" || !nodeIds.has(e.target)) {
    issues.push({
      code: "edge_unknown_target",
      message: `edge "${e.id}" references unknown target "${e.target}"`,
      ref: e.id,
    });
  }
  if (e.source !== undefined && e.target !== undefined && e.source === e.target) {
    issues.push({ code: "edge_self_loop", message: `edge "${e.id}" is a self-loop`, ref: e.id });
  }
  const key = `${e.source}->${e.target}`;
  if (edgeSet.has(key)) {
    issues.push({
      code: "duplicate_edge",
      message: `edge "${e.id}" duplicates existing ${key}`,
      ref: e.id,
    });
  } else {
    edgeSet.add(key);
  }
  if (e.polarity === undefined || !POLARITIES.has(e.polarity)) {
    issues.push({
      code: "invalid_polarity",
      message: `edge "${e.id}" has invalid polarity`,
      ref: e.id,
    });
  }
  if (e.delay === undefined || typeof e.delay.type !== "string") {
    issues.push({
      code: "invalid_delay_type",
      message: `edge "${e.id}" has invalid delay.type`,
      ref: e.id,
    });
  } else if (!DELAY_TYPES.has(e.delay.type)) {
    issues.push({
      code: "invalid_delay_type",
      message: `edge "${e.id}" has invalid delay.type`,
      ref: e.id,
    });
  }
  const mag = e.delay?.magnitude;
  if (typeof mag !== "number" || Number.isNaN(mag)) {
    issues.push({
      code: "missing_edge_field",
      message: `edge "${e.id}" delay.magnitude must be a number`,
      ref: e.id,
    });
  } else if (mag < 0) {
    issues.push({
      code: "negative_delay",
      message: `edge "${e.id}" delay.magnitude must be >= 0`,
      ref: e.id,
    });
  }
  if (typeof e.strength !== "number" || Number.isNaN(e.strength)) {
    issues.push({
      code: "missing_edge_field",
      message: `edge "${e.id}" strength must be a number`,
      ref: e.id,
    });
  } else if (e.strength < 0) {
    issues.push({
      code: "negative_strength",
      message: `edge "${e.id}" strength must be >= 0`,
      ref: e.id,
    });
  }
  // Validate authored uncertainty ranges (Phase 8 sampler; not engine-enforced).
  if (e.range !== undefined) {
    const r = e.range as Partial<EdgeRange>;
    if (r.strength !== undefined) {
      const [min, max] = r.strength;
      if (typeof min !== "number" || typeof max !== "number" || min > max) {
        issues.push({
          code: "range_invalid",
          message: `edge "${e.id}" range.strength must be [min, max] with min <= max`,
          ref: e.id,
        });
      }
    }
    if (r.delay_magnitude !== undefined) {
      const [min, max] = r.delay_magnitude;
      if (typeof min !== "number" || typeof max !== "number" || min > max || min < 0) {
        issues.push({
          code: "range_invalid",
          message: `edge "${e.id}" range.delay_magnitude must be [min, max] with 0 <= min <= max`,
          ref: e.id,
        });
      }
    }
  }
  return issues;
}

function validateLoop(
  loop: unknown,
  nodeIds: Set<string>,
  edgeIds: Set<string>,
  edges: Edge[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isObject(loop)) {
    issues.push({ code: "loop_not_computed", message: "loop must be an object" });
    return issues;
  }
  const l = loop as Partial<Loop>;
  if (typeof l.id !== "string" || l.id.length === 0) {
    issues.push({ code: "non_string_id", message: "loop.id must be a non-empty string" });
    return issues;
  }
  if (!Array.isArray(l.nodes) || !Array.isArray(l.edges)) {
    issues.push({
      code: "loop_not_computed",
      message: `loop "${l.id}" must have nodes and edges arrays`,
      ref: l.id,
    });
    return issues;
  }
  for (const nid of l.nodes) {
    if (!nodeIds.has(nid)) {
      issues.push({
        code: "loop_unknown_node",
        message: `loop "${l.id}" references unknown node "${nid}"`,
        ref: l.id,
      });
    }
  }
  for (const eid of l.edges) {
    if (!edgeIds.has(eid)) {
      issues.push({
        code: "loop_unknown_edge",
        message: `loop "${l.id}" references unknown edge "${eid}"`,
        ref: l.id,
      });
    }
  }
  // Loops must be computed, not authored. The only way a graph may carry loops
  // at load time is if they re-derive correctly from its edges. We verify
  // sign consistency against the actual edge polarities.
  const expected = computeLoopSign(l, edges);
  if (l.sign !== undefined && expected !== undefined && l.sign !== expected) {
    issues.push({
      code: "loop_sign_mismatch",
      message: `loop "${l.id}" sign "${l.sign}" does not match edge polarities ("${expected}")`,
      ref: l.id,
    });
  }
  return issues;
}

function computeLoopSign(loop: Partial<Loop>, edges: Edge[]): LoopSign | undefined {
  if (!Array.isArray(loop.edges)) return undefined;
  let neg = 0;
  let found = 0;
  for (const eid of loop.edges) {
    const e = edges.find((x) => x.id === eid);
    if (!e) return undefined;
    found++;
    if (e.polarity === "-") neg++;
  }
  if (found === 0) return undefined;
  return neg % 2 === 0 ? "reinforcing" : "balancing";
}
