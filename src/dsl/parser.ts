import yaml from "js-yaml";
import type { Graph, Node, Edge, NodeType, TioeClass, Polarity, DelayType } from "@/model/types";
import { validate, type ValidationIssue } from "@/model/validate";

/**
 * DSL parser: author graph structure in a human-friendly YAML/JSON format before
 * wiring up visuals (per spec §2: "author structure before wiring visuals").
 *
 * The DSL deliberately maps onto the Graph model with sensible defaults so that
 * minimal fixtures stay terse. The parser:
 *   - accepts YAML or JSON,
 *   - fills defaults (e.g. missing strength -> 1, missing delay -> none/0),
 *   - strips prototype-pollution keys (__proto__, constructor, prototype),
 *   - collects ALL violations before throwing, so authors fix everything at once.
 *
 * Loops are NOT authored — they are computed (src/graph, Phase 2). The parser
 * always emits `loops: []` and rejects any `loops:` section in the DSL.
 */

export class ParseError extends Error {
  issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super(`Graph parse failed with ${issues.length} issue(s):\n` + formatIssues(issues));
    this.name = "ParseError";
    this.issues = issues;
  }
}

export interface ParseResult {
  /** The validated Graph, or null if parsing failed. */
  graph: Graph | null;
  /** Structured issues. Empty when parsing succeeds. */
  issues: ValidationIssue[];
}

/** Parse a YAML or JSON string into a validated Graph. Never throws. */
export function parseGraph(input: string): ParseResult {
  const raw = safeLoad(input);
  if (raw === null) {
    return { graph: null, issues: [{ code: "missing_node_field", message: "empty input" }] };
  }
  if (typeof raw !== "object") {
    return {
      graph: null,
      issues: [{ code: "missing_node_field", message: "top-level value must be an object" }],
    };
  }
  const cleaned = stripProtoKeys(raw);
  const graph = normalize(cleaned as Record<string, unknown>);
  const issues = validate(graph);
  return { graph: issues.length === 0 ? graph : null, issues };
}

/** Parse a YAML or JSON string, throwing on failure. */
export function parseGraphOrThrow(input: string): Graph {
  const { graph, issues } = parseGraph(input);
  if (graph === null) throw new ParseError(issues);
  return graph;
}

/** Serialize a Graph back to JSON for round-trip save/load. */
export function serializeGraph(graph: Graph): string {
  return JSON.stringify(graph, null, 2);
}

/**
 * Serialize a Graph to YAML in the authoring format used by the fixtures, so an
 * in-app edit can be written back to a `.yaml` file and re-parsed losslessly.
 * Loops are never emitted (computed, never authored). Optional fields (collars,
 * pin, agent_binding) are omitted when absent so the output stays clean.
 */
export function serializeGraphYaml(graph: Graph): string {
  const lines: string[] = [];
  lines.push("nodes:");
  for (const n of graph.nodes) {
    lines.push(`  - id: ${yamlScalar(n.id)}`);
    lines.push(`    label: ${yamlScalar(n.label)}`);
    lines.push(`    type: ${yamlScalar(n.type)}`);
    lines.push(`    tioe_class: ${yamlScalar(n.tioe_class)}`);
    lines.push(`    initial_value: ${num(n.initial_value)}`);
    lines.push(`    unit: ${yamlScalar(n.unit)}`);
    if (n.lower_collar !== undefined) lines.push(`    lower_collar: ${num(n.lower_collar)}`);
    if (n.upper_collar !== undefined) lines.push(`    upper_collar: ${num(n.upper_collar)}`);
    if (n.pin) {
      lines.push(`    pin: { x: ${num(n.pin.x)}, y: ${num(n.pin.y)} }`);
    }
    if (n.agent_binding) {
      lines.push(`    agent_binding: { rule_id: ${yamlScalar(n.agent_binding.rule_id)} }`);
    }
  }
  lines.push("edges:");
  for (const e of graph.edges) {
    lines.push(`  - id: ${yamlScalar(e.id)}`);
    lines.push(`    source: ${yamlScalar(e.source)}`);
    lines.push(`    target: ${yamlScalar(e.target)}`);
    lines.push(`    polarity: ${yamlScalar(e.polarity)}`);
    lines.push(`    delay: { type: ${yamlScalar(e.delay.type)}, magnitude: ${num(e.delay.magnitude)} }`);
    lines.push(`    strength: ${num(e.strength)}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Format a number without trailing ".0" for integers (cleaner YAML). */
function num(v: number): string {
  return Number.isInteger(v) ? String(v) : String(v);
}

/** Quote a scalar only when needed (strings with special chars / colons). */
function yamlScalar(v: string): string {
  if (v === "") return '""';
  // Quote if it contains a YAML-significant char or leading/trailing space.
  if (/[:#{}[\],&*!|>'"%@` \n]/.test(v) || v !== v.trim()) {
    return JSON.stringify(v);
  }
  return v;
}

function safeLoad(input: string): unknown {
  try {
    return yaml.load(input, { schema: yaml.CORE_SCHEMA, json: true });
  } catch {
    return null;
  }
}

function stripProtoKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripProtoKeys);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    out[k] = stripProtoKeys(v);
  }
  return out;
}

interface RawNode {
  id?: string;
  label?: string;
  type?: string;
  tioe_class?: string;
  initial_value?: number;
  unit?: string;
  lower_collar?: number;
  upper_collar?: number;
  agent_binding?: { rule_id?: string };
  pin?: { x?: number; y?: number };
}

interface RawEdge {
  id?: string;
  source?: string;
  target?: string;
  polarity?: string;
  delay?: { type?: string; magnitude?: number };
  delay_type?: string;
  delay_magnitude?: number;
  strength?: number;
}

interface RawGraph {
  nodes?: RawNode[];
  edges?: RawEdge[];
  loops?: unknown;
}

function normalize(raw: Record<string, unknown>): Graph {
  const g = raw as RawGraph;
  const nodes = Array.isArray(g.nodes) ? g.nodes.map(normalizeNode) : [];
  const edges = Array.isArray(g.edges) ? g.edges.map(normalizeEdge) : [];
  return { nodes, edges, loops: [] };
}

function normalizeNode(r: RawNode): Node {
  const pin =
    r.pin && typeof r.pin.x === "number" && typeof r.pin.y === "number"
      ? { x: r.pin.x, y: r.pin.y }
      : undefined;
  const agent_binding =
    r.agent_binding && typeof r.agent_binding.rule_id === "string"
      ? { rule_id: r.agent_binding.rule_id }
      : undefined;
  const lower_collar =
    typeof r.lower_collar === "number" && !Number.isNaN(r.lower_collar) ? r.lower_collar : undefined;
  const upper_collar =
    typeof r.upper_collar === "number" && !Number.isNaN(r.upper_collar) ? r.upper_collar : undefined;
  return {
    id: r.id ?? "",
    label: r.label ?? r.id ?? "",
    type: (r.type as NodeType) ?? "auxiliary",
    tioe_class: (r.tioe_class as TioeClass) ?? "none",
    initial_value: r.initial_value ?? 0,
    unit: r.unit ?? "",
    ...(pin ? { pin } : {}),
    ...(lower_collar !== undefined ? { lower_collar } : {}),
    ...(upper_collar !== undefined ? { upper_collar } : {}),
    ...(agent_binding ? { agent_binding } : {}),
  };
}

function normalizeEdge(r: RawEdge): Edge {
  const delayType = (r.delay?.type ?? r.delay_type ?? "none") as DelayType;
  const delayMag = r.delay?.magnitude ?? r.delay_magnitude ?? 0;
  return {
    id: r.id ?? "",
    source: r.source ?? "",
    target: r.target ?? "",
    polarity: (r.polarity as Polarity) ?? "+",
    delay: { type: delayType, magnitude: delayMag },
    strength: r.strength ?? 1,
  };
}

function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((i) => `  - [${i.code}] ${i.message}`).join("\n");
}
