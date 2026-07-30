/**
 * Loom sidecar provenance — loader.
 *
 * `parseProvenance` turns a `provenance.json` string into a normalised
 * `ProvenanceFile`, accepting both camelCase and snake_case keys (the
 * reference document's assumed names may drift from real Loom output).
 * `attachProvenance` merges a parsed sidecar onto a graph: per-element
 * provenance is written onto matching `Node`/`Edge.provenance` (single source
 * of truth — it rides on the model, not a parallel structure), and the
 * model-level fields land on `Graph.provenance`.
 *
 * Backward compatibility: when the sidecar is absent nothing here runs, and the
 * graph is untouched. Mismatched ids are skipped with a warning rather than
 * aborting, so a partially-matching sidecar still enriches what it can.
 *
 * Pure: neither function mutates its input graph. `attachProvenance` returns a
 * new graph (nodes/edges arrays rebuilt; provenance preserved through loop
 * re-derivation because it lives on elements, not on `loops`).
 */

import type { Edge, Graph, Node } from "@/model/types";
import {
  type AttachResult,
  type NormalizedEntry,
  type NormalizedGraph,
  type ProvenanceFile,
  type ProvenanceIssue,
  type RawProvenanceEntry,
} from "./types";

/** Parse a `provenance.json` string. Throws on invalid JSON. */
export function parseProvenance(input: string): ProvenanceFile {
  const raw = JSON.parse(input);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("provenance.json must be a JSON object");
  }
  return raw as ProvenanceFile;
}

/** Normalise a raw per-element entry to the canonical `Provenance` shape. */
export function normalizeEntry(raw: RawProvenanceEntry | undefined): NormalizedEntry | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const entry: NormalizedEntry = {};
  if (typeof raw.mined === "boolean") entry.mined = raw.mined;
  if (typeof raw.stage === "string") entry.stage = raw.stage;
  const conf = raw.confidence;
  if (typeof conf === "number" && !Number.isNaN(conf)) entry.confidence = conf;
  const p = raw.pValue ?? raw.p_value;
  if (typeof p === "number" && !Number.isNaN(p)) entry.pValue = p;
  if (typeof raw.reasoning === "string") entry.reasoning = raw.reasoning;
  const tioe = raw.tioeClass ?? raw.tioe_class;
  if (tioe === "T" || tioe === "I" || tioe === "OE" || tioe === "none") entry.tioeClass = tioe;
  const uv = raw.unitValue ?? raw.unit_value;
  if (typeof uv === "number" && !Number.isNaN(uv)) entry.unitValue = uv;
  if (typeof raw.causalSupport === "boolean") entry.causalSupport = raw.causalSupport;
  else if (typeof raw.causal_support === "boolean") entry.causalSupport = raw.causal_support;
  if (typeof raw.structuralSupport === "boolean") entry.structuralSupport = raw.structuralSupport;
  else if (typeof raw.structural_support === "boolean") entry.structuralSupport = raw.structural_support;
  // Omit the field entirely when no recognised key was present.
  return Object.keys(entry).length === 0 ? undefined : entry;
}

/** Normalise the model-level fields of a sidecar. */
export function normalizeGraphProvenance(file: ProvenanceFile): NormalizedGraph {
  const out: NormalizedGraph = {};
  const tu = file.timeUnit ?? file.time_unit ?? file.window;
  if (typeof tu === "string") out.timeUnit = tu;
  const md = file.tioeSuggestionsMd ?? file.tioe_suggestions_md ?? file.tioe_suggestions;
  if (typeof md === "string") {
    out.tioeSuggestionsMd = md;
    out.hasSuggestions = true;
  }
  return out;
}

/**
 * Count nodes Loom could not confidently classify (`tioeClass: "none"`). Used
 * by the "N nodes unclassified — suggestions available" nudge (Loom spec item
 * 7). Pure.
 */
export function countUnclassified(graph: Graph): number {
  let n = 0;
  for (const node of graph.nodes) {
    if (node.provenance?.tioeClass === "none") n++;
  }
  return n;
}

/**
 * Attach a parsed sidecar to a graph, returning a new graph with provenance
 * on the matching nodes/edges and model-level provenance on the graph. Pure:
 * the input graph is not mutated. Mismatched ids are skipped with a warning.
 */
export function attachProvenance(graph: Graph, file: ProvenanceFile): AttachResult {
  const issues: ProvenanceIssue[] = [];
  const nodeEntries = file.nodes ?? {};
  const edgeEntries = file.edges ?? {};

  const nodes = graph.nodes.map((n: Node): Node => {
    const raw = nodeEntries[n.id];
    const prov = normalizeEntry(raw);
    if (raw !== undefined && prov === undefined) {
      issues.push({ message: `node "${n.id}" sidecar entry had no recognised fields`, ref: n.id });
    }
    return prov ? { ...n, provenance: prov } : n;
  });

  const edges = graph.edges.map((e: Edge): Edge => {
    const raw = edgeEntries[e.id];
    const prov = normalizeEntry(raw);
    if (raw !== undefined && prov === undefined) {
      issues.push({ message: `edge "${e.id}" sidecar entry had no recognised fields`, ref: e.id });
    }
    return prov ? { ...e, provenance: prov } : e;
  });

  // Warn about sidecar ids that match no graph element (likely drift between
  // the model and its sidecar). Non-fatal.
  for (const id of Object.keys(nodeEntries)) {
    if (!nodes.some((n) => n.id === id)) {
      issues.push({ message: `sidecar node id "${id}" not found in the model`, ref: id });
    }
  }
  for (const id of Object.keys(edgeEntries)) {
    if (!edges.some((e) => e.id === id)) {
      issues.push({ message: `sidecar edge id "${id}" not found in the model`, ref: id });
    }
  }

  const graphProv = normalizeGraphProvenance(file);
  graphProv.unclassifiedCount = countUnclassified({ ...graph, nodes });
  if (graphProv.unclassifiedCount === 0) delete graphProv.unclassifiedCount;

  // Only attach model-level provenance when there is something to say.
  const hasGraphProv =
    graphProv.timeUnit !== undefined ||
    graphProv.tioeSuggestionsMd !== undefined ||
    graphProv.unclassifiedCount !== undefined ||
    graphProv.hasSuggestions === true;
  const nextGraph: Graph = {
    ...graph,
    nodes,
    edges,
    ...(hasGraphProv ? { provenance: graphProv } : {}),
  };
  return { graph: nextGraph, issues };
}

/** True iff any node or edge carries attached provenance. Pure. */
export function hasProvenance(graph: Graph): boolean {
  if (graph.provenance !== undefined) return true;
  for (const n of graph.nodes) if (n.provenance) return true;
  for (const e of graph.edges) if (e.provenance) return true;
  return false;
}

/**
 * Rebuild a `provenance.json`-shaped file from the provenance attached to a
 * graph (Loom spec item 9 — read-modify-write). The output uses the
 * snake_case keys the loader also accepts, so a corrected file round-trips
 * losslessly through `parseProvenance`/`attachProvenance`. Pure.
 */
export function buildProvenanceFile(graph: Graph): ProvenanceFile {
  const file: ProvenanceFile = {};
  const gp = graph.provenance;
  if (gp?.timeUnit !== undefined) file.time_unit = gp.timeUnit;
  if (gp?.tioeSuggestionsMd !== undefined) file.tioe_suggestions_md = gp.tioeSuggestionsMd;
  const nodes: Record<string, RawProvenanceEntry> = {};
  for (const n of graph.nodes) {
    if (n.provenance) nodes[n.id] = toRawEntry(n.provenance);
  }
  const edges: Record<string, RawProvenanceEntry> = {};
  for (const e of graph.edges) {
    if (e.provenance) edges[e.id] = toRawEntry(e.provenance);
  }
  if (Object.keys(nodes).length > 0) file.nodes = nodes;
  if (Object.keys(edges).length > 0) file.edges = edges;
  return file;
}

/** Reverse `normalizeEntry`: canonical provenance → snake_case raw entry. */
function toRawEntry(p: NormalizedEntry): RawProvenanceEntry {
  const out: RawProvenanceEntry = {};
  if (p.mined !== undefined) out.mined = p.mined;
  if (p.stage !== undefined) out.stage = p.stage;
  if (p.confidence !== undefined) out.confidence = p.confidence;
  if (p.pValue !== undefined) out.p_value = p.pValue;
  if (p.reasoning !== undefined) out.reasoning = p.reasoning;
  if (p.tioeClass !== undefined) out.tioe_class = p.tioeClass;
  if (p.unitValue !== undefined) out.unit_value = p.unitValue;
  if (p.causalSupport !== undefined) out.causal_support = p.causalSupport;
  if (p.structuralSupport !== undefined) out.structural_support = p.structuralSupport;
  return out;
}

/** Serialize a graph's provenance back to a `provenance.json` string. Pure. */
export function serializeProvenance(graph: Graph): string {
  return JSON.stringify(buildProvenanceFile(graph), null, 2);
}
