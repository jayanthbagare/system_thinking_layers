/**
 * Loom spec item 5 — ABM-validation priority ranking.
 *
 * When a Loom sidecar is attached, surface a ranked "worth checking first"
 * list for the ABM companion view: elements with low mining confidence or a
 * support mismatch (causal vs structural support disagreeing on an edge) come
 * first. This does not auto-launch anything — it is a sorted suggestion, the
 * starting point a person opens the ABM view with.
 *
 * Pure: a projection over `Graph`. Nodes and edges are scored by a small
 * priority function and sorted descending. Nodes/edges without provenance are
 * omitted (there is nothing to validate against Loom for them).
 */

import type { Graph, Provenance } from "@/model/types";

export interface AbmPriorityEntry {
  kind: "node" | "edge";
  id: string;
  label: string;
  /** Higher = more worth checking first. */
  priority: number;
  /** Human-readable reason for the ranking. */
  reason: string;
  /** The element's confidence, when reported. */
  confidence: number | null;
}

/** A confidence threshold below which an element is "low confidence". */
const LOW_CONFIDENCE = 0.7;

/** Rank nodes and edges by ABM-validation priority. Pure. */
export function rankAbmPriority(graph: Graph): AbmPriorityEntry[] {
  const entries: AbmPriorityEntry[] = [];

  for (const n of graph.nodes) {
    const p = n.provenance;
    if (!p) continue;
    const priority = nodePriority(p);
    if (priority <= 0) continue;
    entries.push({
      kind: "node",
      id: n.id,
      label: n.label,
      priority,
      reason: nodeReason(p),
      confidence: p.confidence ?? null,
    });
  }

  for (const e of graph.edges) {
    const p = e.provenance;
    if (!p) continue;
    const priority = edgePriority(p);
    if (priority <= 0) continue;
    const s = graph.nodes.find((x) => x.id === e.source)?.label ?? e.source;
    const t = graph.nodes.find((x) => x.id === e.target)?.label ?? e.target;
    entries.push({
      kind: "edge",
      id: e.id,
      label: `${e.id}: ${s} \u2192 ${t}`,
      priority,
      reason: edgeReason(p),
      confidence: p.confidence ?? null,
    });
  }

  entries.sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1));
  return entries;
}

/** A node's priority: low confidence, or Loom declined to classify it. */
function nodePriority(p: Provenance): number {
  let priority = 0;
  if (p.confidence !== undefined) {
    if (p.confidence < LOW_CONFIDENCE) priority += (LOW_CONFIDENCE - p.confidence) / LOW_CONFIDENCE + 0.5;
  }
  if (p.tioeClass === "none") priority += 0.4;
  return priority;
}
function nodeReason(p: Provenance): string {
  const parts: string[] = [];
  if (p.confidence !== undefined && p.confidence < LOW_CONFIDENCE) {
    parts.push(`low confidence (${p.confidence.toFixed(2)})`);
  }
  if (p.tioeClass === "none") parts.push("unclassified");
  return parts.length > 0 ? `Loom: ${parts.join(", ")}` : "flagged for review";
}

/** An edge's priority: low confidence, or a causal/structural support mismatch. */
function edgePriority(p: Provenance): number {
  let priority = 0;
  if (p.confidence !== undefined && p.confidence < LOW_CONFIDENCE) {
    priority += (LOW_CONFIDENCE - p.confidence) / LOW_CONFIDENCE + 0.5;
  }
  // Support mismatch: one support flag is true and the other explicitly false.
  if (p.causalSupport !== undefined && p.structuralSupport !== undefined && p.causalSupport !== p.structuralSupport) {
    priority += 0.6;
  }
  return priority;
}
function edgeReason(p: Provenance): string {
  const parts: string[] = [];
  if (p.confidence !== undefined && p.confidence < LOW_CONFIDENCE) {
    parts.push(`low confidence (${p.confidence.toFixed(2)})`);
  }
  if (p.causalSupport !== undefined && p.structuralSupport !== undefined && p.causalSupport !== p.structuralSupport) {
    parts.push("causal/structural support mismatch");
  }
  return parts.length > 0 ? `Loom: ${parts.join(", ")}` : "flagged for review";
}
