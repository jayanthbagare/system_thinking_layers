/**
 * Phase 9 — Decision-record export (spec §9.2).
 *
 * Turns an explored scenario tray into a self-contained ADR-shaped Markdown
 * document that renders on GitHub and pastes into Confluence. Six sections, per
 * the spec:
 *
 *   1. Context          — graph as Mermaid + node/edge tables (collars in units)
 *   2. Constraint       — predicted and observed, per-signal breakdown, verdict
 *   3. Options          — one section per pinned scenario, full metric set, tier
 *   4. Decision          — the chosen scenario, marked by the user
 *   5. Consequences      — migration, DoF change, J-curve, payback
 *   6. Provenance        — model file, engine settings, seed, timestamp, version
 *
 * Pure: same inputs → identical string (the caller supplies `generatedAt` so
 * the timestamp is part of the input, not a hidden side effect). Heavy work
 * (Monte Carlo for the constraint-identified verdict) is opt-in via
 * `robustnessN`; with the default 0 the section reports the verdict was not run.
 */

import type { Graph, Node, Edge } from "@/model/types";
import type { Weights, ScoredNode } from "@/layer2/scoring";
import { scoreGraph, DEFAULT_WEIGHTS } from "@/layer2/scoring";
import {
  predictedConstraint,
  observedConstraint,
  detectCycle,
  stepSummary,
  type MigrationTrail,
} from "@/layer2/migration";
import { runMonteCarlo, verdictMessage } from "@/sim/robustness";
import { TIER_LABELS } from "@/layer3/structural";
import { serializeGraphYaml } from "@/dsl/parser";
import type { EngineOptions } from "@/sim";
import type { ScenarioTray, ScenarioCard } from "./scenario";
import { graphToMermaid } from "./mermaid";

/** Options for `exportDecisionRecord`. All provenance is caller-supplied. */
export interface ExportOptions {
  weights: Weights;
  /** Cached sensitivities for the base graph (used by the predicted constraint). */
  sensitivities?: Map<string, number>;
  engine: EngineOptions;
  steps: number;
  /** The migration trail (applied interventions) — for the Consequences section. */
  migrationTrail?: MigrationTrail;
  /** The authored model as YAML text (provenance). Omit to skip the fenced block. */
  modelYaml?: string;
  /** Tool version string (provenance). */
  toolVersion?: string;
  /** ISO timestamp for the document (provenance). */
  generatedAt: string;
  /**
   * If > 0, run a seeded Monte Carlo on the base graph and report the
   * constraint-identified robustness verdict. Default 0 (verdict not run).
   */
  robustnessN?: number;
  /** RNG seed for the Monte Carlo run. Default 42. */
  robustnessSeed?: number;
}

/** ADR-shaped decision record as Markdown. Pure. */
export function exportDecisionRecord(graph: Graph, tray: ScenarioTray, opts: ExportOptions): string {
  const out: string[] = [];
  out.push("# Decision Record — Constraint Intervention", "");
  out.push(`_Generated ${opts.generatedAt} by Layers${opts.toolVersion ? ` v${opts.toolVersion}` : ""}.`, "");
  out.push("Directional model — trust ratios and ranks over absolute numbers._", "");

  // 1. Context
  out.push("## 1. Context", "");
  out.push("### Diagram", "");
  out.push("```mermaid");
  out.push(graphToMermaid(graph));
  out.push("```", "");
  out.push("### Nodes", "");
  out.push(nodeTable(graph.nodes));
  out.push("### Edges", "");
  out.push(edgeTable(graph, graph.edges), "");

  // 2. Constraint identified
  out.push("## 2. Constraint identified", "");
  {
    const pred = predictedConstraint(graph, opts.weights, opts.sensitivities);
    const obs = observedConstraint(graph, opts.engine, opts.steps);
    out.push(`- **Predicted** (L2 structural #1): ${labelOf(graph, pred.nodeId)} _(score ${fmt(pred.value)})_`);
    out.push(`- **Observed** (highest pinned fraction under load): ${labelOf(graph, obs.nodeId)}${obs.nodeId ? ` _(${(obs.fraction * 100).toFixed(0)}% pinned)_` : ""}`);
    const { ranked } = scoreGraph(graph, opts.weights, opts.sensitivities);
    const top: ScoredNode | undefined = ranked[0];
    if (top) {
      out.push("", "**Per-signal breakdown (predicted #1):**", "");
      out.push(breakdownTable(top.contributions, top.raw));
    }
    const n = opts.robustnessN ?? 0;
    if (n > 0) {
      const report = runMonteCarlo(graph, opts.weights, opts.sensitivities, {
        n,
        seed: opts.robustnessSeed ?? 42,
        engine: opts.engine,
        steps: opts.steps,
      });
      out.push("", "**Robustness verdict:**", "");
      out.push(`- Predicted: ${verdictMessage(report.predictedVerdict)}`);
      out.push(`- Observed: ${verdictMessage(report.observedVerdict)}`);
      out.push(`- N=${report.n}, ${report.declaredCount} declared / ${report.guessedCount} guessed`);
    } else {
      out.push("", "_Robustness verdict not run (set `robustnessN` to compute)._");
    }
    out.push("");
  }

  // 3. Options considered
  out.push("## 3. Options considered", "");
  if (tray.cards.length === 0) {
    out.push("_No scenarios pinned._", "");
  } else {
    out.push("### Comparison", "");
    out.push(comparisonTable(graph, tray.cards));
    for (const card of tray.cards) {
      out.push(`### ${card.id} — ${card.label}`, "");
      out.push(cardDetail(graph, card));
    }
  }

  // 4. Decision
  out.push("## 4. Decision", "");
  if (tray.chosenId) {
    const chosen = tray.cards.find((c) => c.id === tray.chosenId);
    if (chosen) {
      out.push(`**Chosen: ${chosen.id} — ${chosen.label}.**`);
      out.push("");
      out.push("Rationale: _(to be completed by the architect.)_", "");
    } else {
      out.push(`_Chosen id \`${tray.chosenId}\` not found in the tray._`, "");
    }
  } else {
    out.push("_No scenario chosen yet._", "");
  }

  // 5. Consequences
  out.push("## 5. Consequences", "");
  if (opts.migrationTrail && opts.migrationTrail.length > 0) {
    out.push("**Constraint migration trail:**", "");
    for (const step of opts.migrationTrail) {
      out.push(`${step.index}. ${stepSummary(step, graph)}`);
    }
    const cycle = detectCycle(opts.migrationTrail);
    if (cycle && cycle.detected) {
      out.push("");
      out.push(
        `> **Cycle detected:** ${cycle.length} intervention(s), net ΔT ${fmtSigned(cycle.netDeltaT)}, ` +
          `ΔOE ${fmtSigned(cycle.netDeltaOE)}. The constraint returned to ${labelOf(graph, cycle.node)}.`,
      );
    }
  } else {
    out.push("_No interventions applied — the working graph is unchanged._");
  }
  if (tray.chosenId) {
    const chosen = tray.cards.find((c) => c.id === tray.chosenId);
    if (chosen) {
      out.push("");
      out.push("**Chosen scenario consequences:**", "");
      out.push(`- Degrees of freedom: ${chosen.dof.before} → ${chosen.dof.after} of ${chosen.dof.total} (Δ ${fmtSigned(chosen.dof.delta)})`);
      out.push(`- J-curve: ${chosen.jCurve.detected ? `dip ${fmt(chosen.jCurve.depth)} for ${chosen.jCurve.duration} steps` : "no worse-before-better dip"}`);
      out.push(`- Payback horizon: ${chosen.paybackHorizon === null ? "does not pay back within horizon" : `step ${chosen.paybackHorizon}`}`);
      out.push(`- Constraint after: predicted ${labelOf(graph, chosen.predictedAfter)}, observed ${labelOf(graph, chosen.observedAfter)}`);
    }
  }
  out.push("");

  // 6. Provenance
  out.push("## 6. Provenance", "");
  out.push("| Field | Value |");
  out.push("|---|---|");
  out.push(`| Engine — dt | ${opts.engine.dt} |`);
  out.push(`| Engine — integrator | ${opts.engine.integrator} |`);
  out.push(`| Engine — steps | ${opts.steps} |`);
  out.push(`| Weights | ${formatWeights(opts.weights)} |`);
  out.push(`| Robustness seed | ${opts.robustnessSeed ?? 42} |`);
  out.push(`| Tool version | ${opts.toolVersion ?? "dev"} |`);
  out.push(`| Generated at | ${opts.generatedAt} |`);
  if (opts.modelYaml !== undefined) {
    out.push("", "### Model", "");
    out.push("```yaml");
    out.push(opts.modelYaml);
    out.push("```");
  } else {
    out.push("", "### Model", "");
    out.push("```yaml");
    out.push(serializeGraphYaml(graph));
    out.push("```");
  }
  out.push("");
  return out.join("\n");
}

// --- helpers ---------------------------------------------------------------

function labelOf(graph: Graph, id: string | null): string {
  if (!id) return "—";
  return graph.nodes.find((n) => n.id === id)?.label ?? id;
}

function fmt(v: number): string {
  return (Math.abs(v) < 1e-9 ? 0 : v).toFixed(2);
}

function fmtSigned(v: number): string {
  return `${v >= 0 ? "+" : ""}${fmt(v)}`;
}

function fmtRatio(v: number | null): string {
  return v === null ? "n/a" : v.toFixed(2);
}

function collarStr(n: Node): string {
  if (!n.collar) return "—";
  const parts: string[] = [];
  if (n.collar.lower !== undefined) parts.push(`lower ${n.collar.lower}`);
  if (n.collar.upper !== undefined) parts.push(`upper ${n.collar.upper}`);
  if (n.collar.approach) parts.push(n.collar.approach);
  return parts.length ? parts.join(", ") : "—";
}

function nodeTable(nodes: Node[]): string {
  const rows: string[] = ["| id | label | type | boundary | initial_value | unit | collar |", "|---|---|---|---|---|---|---|"];
  for (const n of nodes) {
    rows.push(
      `| ${n.id} | ${n.label} | ${n.type} | ${n.boundary ? "yes" : ""} | ${n.initial_value} | ${n.unit || "—"} | ${collarStr(n)} |`,
    );
  }
  return rows.join("\n") + "\n";
}

function edgeTable(graph: Graph, edges: Edge[]): string {
  const rows: string[] = ["| id | source → target | polarity | delay | strength | range |", "|---|---|---|---|---|---|"];
  for (const e of edges) {
    const s = labelOf(graph, e.source);
    const t = labelOf(graph, e.target);
    const delay = e.delay.magnitude > 0 ? `${e.delay.magnitude} ${e.delay.type}` : "none";
    const range = e.range
      ? [
          e.range.strength ? `strength [${e.range.strength[0]}, ${e.range.strength[1]}]` : "",
          e.range.delay_magnitude ? `delay [${e.range.delay_magnitude[0]}, ${e.range.delay_magnitude[1]}]` : "",
        ]
          .filter(Boolean)
          .join("; ")
      : "—";
    rows.push(`| ${e.id} | ${s} → ${t} | ${e.polarity} | ${delay} | ${e.strength} | ${range} |`);
  }
  return rows.join("\n") + "\n";
}

function breakdownTable(contributions: ScoredNode["contributions"], raw: ScoredNode["raw"]): string {
  const rows: string[] = ["| signal | contribution | raw |", "|---|---|---|"];
  const keys = Object.keys(contributions) as (keyof ScoredNode["contributions"])[];
  for (const key of keys) {
    rows.push(`| ${key} | ${fmt(contributions[key])} | ${fmt(raw[key])} |`);
  }
  return rows.join("\n") + "\n";
}

function comparisonTable(graph: Graph, cards: ScenarioCard[]): string {
  const head = [
    "| id | scenario | tier | ΔT | ΔI | ΔOE | ΔT/ΔOE | ΔT/ΔI | ΔDoF | J-curve | pred-after | obs-after | verdict |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const c of cards) {
    head.push(
      [
        c.id,
        c.label,
        `T${c.tier} ${TIER_LABELS[c.tier]}`,
        fmtSigned(c.deltaT),
        fmtSigned(c.deltaI),
        fmtSigned(c.deltaOE),
        fmtRatio(c.dT_dOE),
        fmtRatio(c.dT_dI),
        fmtSigned(c.dof.delta),
        c.jCurve.detected ? `dip ${fmt(c.jCurve.depth)}` : "—",
        labelOf(graph, c.predictedAfter),
        labelOf(graph, c.observedAfter),
        c.robustnessVerdict ?? "—",
      ].join(" | "),
    );
  }
  return head.join("\n") + "\n";
}

function cardDetail(graph: Graph, c: ScenarioCard): string {
  const lines: string[] = [];
  lines.push(`- Intervention: ${interventionStr(graph, c.intervention)}`);
  lines.push(`- Leverage tier: T${c.tier} — ${TIER_LABELS[c.tier]}`);
  lines.push(`- ΔT ${fmtSigned(c.deltaT)}, ΔI ${fmtSigned(c.deltaI)}, ΔOE ${fmtSigned(c.deltaOE)}`);
  lines.push(`- ΔT/ΔOE ${fmtRatio(c.dT_dOE)}, ΔT/ΔI ${fmtRatio(c.dT_dI)}`);
  lines.push(`- Degrees of freedom: ${c.dof.before} → ${c.dof.after} of ${c.dof.total} (Δ ${fmtSigned(c.dof.delta)})`);
  lines.push(
    `- J-curve: ${c.jCurve.detected ? `worse-before-better, dip ${fmt(c.jCurve.depth)} for ${c.jCurve.duration} steps` : "no dip"}`,
  );
  lines.push(`- Payback horizon: ${c.paybackHorizon === null ? "not within horizon" : `step ${c.paybackHorizon}`}`);
  lines.push(`- Constraint after: predicted ${labelOf(graph, c.predictedAfter)}, observed ${labelOf(graph, c.observedAfter)}`);
  if (c.robustnessVerdict) lines.push(`- Robustness (observed): ${verdictMessage(c.robustnessVerdict)}`);
  lines.push(`- Engine: dt ${c.dt}, ${c.integrator}, ${c.steps} steps; pinned ${c.pinnedAt}`);
  lines.push("");
  return lines.join("\n");
}

function interventionStr(graph: Graph, iv: ScenarioCard["intervention"]): string {
  const typeLabel = iv.type.charAt(0).toUpperCase() + iv.type.slice(1);
  const target = labelOf(graph, iv.target);
  switch (iv.type) {
    case "exploit":
    case "elevate":
      return `${typeLabel} on ${target} (Δ ${iv.magnitude})`;
    case "subordinate": {
      const buf = iv.rope ? labelOf(graph, iv.rope.buffer) : "?";
      const rel = iv.rope ? labelOf(graph, iv.rope.release) : "?";
      return `${typeLabel}: rope ${rel} ← ${buf} (× ${iv.magnitude})`;
    }
    case "structural": {
      if (!iv.edit) return `${typeLabel} on ${target}`;
      const e = iv.edit;
      switch (e.kind) {
        case "collapseDelay":
          return `Collapse delay on ${e.edgeId} (× ${e.factor})`;
        case "changeDelayType":
          return `Change delay type on ${e.edgeId} → ${e.delayType}`;
        case "flipPolarity":
          return `Flip polarity on ${e.edgeId}`;
        case "splitNode":
          return `Split ${target} → ${e.newId}`;
        case "addEdge":
          return `Add edge ${e.edge.id}`;
        case "deleteEdge":
          return `Delete edge ${e.edgeId}`;
      }
    }
  }
}

function formatWeights(w: Weights): string {
  return Object.entries(w)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

export { DEFAULT_WEIGHTS };
