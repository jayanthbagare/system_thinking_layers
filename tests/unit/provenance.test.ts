import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseGraphOrThrow } from "@/dsl/parser";
import { withComputedLoops } from "@/graph/loops";
import { loadGraphYaml, loadGraphWithProvenance } from "@/io/yaml";
import {
  attachProvenance,
  countUnclassified,
  hasProvenance,
  parseProvenance,
  unitValueSummary,
  scaleTioeSnapshot,
} from "@/provenance";
import type { Graph } from "@/model/types";
import type { TioeSnapshot } from "@/sim";

const yamlText = readFileSync("tests/fixtures/loom/order-backlog.yaml", "utf8");
const provText = readFileSync("tests/fixtures/loom/provenance.json", "utf8");

function baseGraph(): Graph {
  return withComputedLoops(parseGraphOrThrow(yamlText));
}

describe("provenance loader", () => {
  it("parses the sidecar (camelCase and snake_case tolerant)", () => {
    const file = parseProvenance(provText);
    expect(file.timeUnit).toBe("1 week");
    expect(file.nodes?.order_backlog.unit_value).toBe(12.5);
    expect(file.nodes?.order_backlog.tioe_class).toBe("I");
    expect(file.edges?.d2.causal_support).toBe(true);
  });

  it("attaches per-element provenance onto matching nodes/edges", () => {
    const g = baseGraph();
    const { graph, issues } = attachProvenance(g, parseProvenance(provText));
    expect(issues).toEqual([]);
    const backlog = graph.nodes.find((n) => n.id === "order_backlog")!;
    expect(backlog.provenance?.mined).toBe(true);
    expect(backlog.provenance?.confidence).toBeCloseTo(0.91);
    expect(backlog.provenance?.unitValue).toBe(12.5);
    expect(backlog.provenance?.tioeClass).toBe("I");
    const d3 = graph.edges.find((e) => e.id === "d3")!;
    expect(d3.provenance?.structuralSupport).toBe(true);
  });

  it("attaches model-level provenance onto the graph", () => {
    const g = baseGraph();
    const { graph } = attachProvenance(g, parseProvenance(provText));
    expect(graph.provenance?.timeUnit).toBe("1 week");
    expect(graph.provenance?.unclassifiedCount).toBe(1); // customer_demand
    expect(graph.provenance?.hasSuggestions).toBe(true);
  });

  it("is backward compatible: no sidecar leaves the graph untouched", () => {
    const g = baseGraph();
    const before = JSON.stringify(g);
    const { graph, provenanceIssues } = loadGraphWithProvenance(yamlText, undefined);
    expect(provenanceIssues).toEqual([]);
    expect(hasProvenance(graph)).toBe(false);
    // A hand-authored model with no sidecar behaves exactly as `loadGraphYaml`.
    expect(JSON.stringify(graph)).toBe(JSON.stringify(loadGraphYaml(yamlText)));
    expect(JSON.stringify(g)).toBe(before); // input not mutated
  });

  it("warns (non-fatally) on mismatched sidecar ids", () => {
    const g = baseGraph();
    const file = parseProvenance(provText);
    file.nodes = { ...file.nodes, ghost: { mined: true, confidence: 0.5 } };
    const { issues } = attachProvenance(g, file);
    expect(issues.some((i) => i.ref === "ghost")).toBe(true);
  });

  it("tolerates an empty sidecar (no recognised fields)", () => {
    const g = baseGraph();
    const entry = { junk: 1 } as unknown as import("@/provenance").RawProvenanceEntry;
    const { graph } = attachProvenance(g, { nodes: { order_backlog: entry } });
    const backlog = graph.nodes.find((n) => n.id === "order_backlog")!;
    expect(backlog.provenance).toBeUndefined();
  });
});

describe("unit_value scaling (Loom spec item 4)", () => {
  it("summary reports a single shared unit_value when all agree", () => {
    const g = attachProvenance(baseGraph(), parseProvenance(provText)).graph;
    const s = unitValueSummary(g);
    expect(s.present).toBe(true);
    expect(s.single).toBe(12.5);
    expect(s.withUnit).toBe(2);
    expect(s.withoutUnit).toBe(1); // customer_demand has no unit_value
  });

  it("scaleTioeSnapshot multiplies physical quantities by unit_value", () => {
    const phys: TioeSnapshot = { T: 100, I: 50, OE: 10 };
    expect(scaleTioeSnapshot(phys, 12.5)).toEqual({ T: 1250, I: 625, OE: 125 });
  });

  it("does not scale the engine: a no-sidecar model stays in physical units", () => {
    // The engine (deriveTioe) is untouched by provenance; scaling is a view
    // concern only. With no sidecar there is nothing to scale by.
    const g = baseGraph();
    const s = unitValueSummary(g);
    expect(s.present).toBe(false);
    expect(s.single).toBeUndefined();
  });
});

describe("unclassified count (Loom spec item 7)", () => {
  it("counts nodes Loom could not classify (tioeClass none)", () => {
    const g = attachProvenance(baseGraph(), parseProvenance(provText)).graph;
    expect(countUnclassified(g)).toBe(1);
    const demand = g.nodes.find((n) => n.id === "customer_demand")!;
    expect(demand.provenance?.tioeClass).toBe("none");
  });
});
