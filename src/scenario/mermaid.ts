/**
 * Phase 9 — Graph → Mermaid (spec §9.2 context).
 *
 * Renders a `Graph` as a Mermaid `flowchart` so the ADR's Context section is
 * self-contained Markdown that renders on GitHub (and pastes into Confluence).
 * The diagram shows structure only — nodes (shaped by type), edges (labelled
 * with polarity and delay) — never computed state. Collars and ranges live in
 * the accompanying node/edge table in the export, not the diagram.
 *
 * Pure: same graph → identical string. No DOM, no state.
 */

import type { Graph, Node } from "@/model/types";

/** Sanitise an arbitrary id into a Mermaid-safe identifier (prefix `n_`). */
function mermaidId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_]/g, "_");
  const safe = /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
  return `n_${safe}`;
}

/** Escape a label for use inside a Mermaid quoted string. */
function escLabel(s: string): string {
  // Mermaid uses `<br/>` for line breaks inside labels; escape double quotes
  // and backslashes so the quoted label parses.
  return s.replace(/\\/g, "\\\\").replace(/"/g, "'").replace(/<br\/?>/g, " ");
}

/** Mermaid node shape by `Node.type`. */
function nodeShape(n: Node): string {
  const label = `${escLabel(n.label)}<br/><small>${n.type}${n.boundary ? " · boundary" : ""}</small>`;
  switch (n.type) {
    case "stock":
      return `["${label}"]`;
    case "flow":
      return `("${label}")`;
    case "auxiliary":
      return `{{"${label}"}}`;
  }
}

/** Edge label: polarity symbol plus delay magnitude/type when present. */
function edgeLabel(polarity: "+" | "-", delay: { type: string; magnitude: number }): string {
  const sym = polarity === "+" ? "+" : "−";
  if (delay.magnitude > 0) return `${sym} · ${delay.magnitude} ${delay.type}`;
  return sym;
}

/**
 * Render a `Graph` as a Mermaid `flowchart TD` string (without the surrounding
 * fenced-code block — the caller wraps it). GitHub renders this inside a
 * ` ```mermaid ` block.
 */
export function graphToMermaid(graph: Graph): string {
  const lines: string[] = ["flowchart TD"];
  for (const n of graph.nodes) {
    lines.push(`    ${mermaidId(n.id)}${nodeShape(n)}`);
  }
  for (const e of graph.edges) {
    const label = edgeLabel(e.polarity, e.delay);
    lines.push(`    ${mermaidId(e.source)} -->|"${label}"| ${mermaidId(e.target)}`);
  }
  return lines.join("\n");
}
