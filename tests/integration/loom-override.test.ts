// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { parseGraph, parseGraphOrThrow, serializeGraphYaml } from "@/dsl/parser";
import { withComputedLoops } from "@/graph/loops";
import {
  attachProvenance,
  buildProvenanceFile,
  parseProvenance,
  serializeProvenance,
} from "@/provenance";

const yamlText = readFileSync("tests/fixtures/loom/order-backlog.yaml", "utf8");
const provText = readFileSync("tests/fixtures/loom/provenance.json", "utf8");

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("Loom spec item 9 — in-app TIOE override (read-modify-write)", () => {
  it("writes an override onto the node's provenance", () => {
    const g = attachProvenance(withComputedLoops(parseGraphOrThrow(yamlText)), parseProvenance(provText)).graph;
    const idx = g.nodes.findIndex((n) => n.id === "customer_demand");
    g.nodes[idx] = { ...g.nodes[idx], provenance: { ...g.nodes[idx].provenance!, tioeClass: "OE" } };
    expect(g.nodes[idx].provenance?.tioeClass).toBe("OE");
  });

  it("serializeProvenance round-trips through the tolerant loader", () => {
    const g = attachProvenance(withComputedLoops(parseGraphOrThrow(yamlText)), parseProvenance(provText)).graph;
    // Override customer_demand from none -> T.
    const idx = g.nodes.findIndex((n) => n.id === "customer_demand");
    g.nodes[idx] = { ...g.nodes[idx], provenance: { ...g.nodes[idx].provenance!, tioeClass: "T" } };
    const rewritten = serializeProvenance(g);
    // The corrected file re-parses and re-attaches with the new class.
    const re = attachProvenance(withComputedLoops(parseGraphOrThrow(yamlText)), parseProvenance(rewritten)).graph;
    expect(re.nodes.find((n) => n.id === "customer_demand")!.provenance?.tioeClass).toBe("T");
    // Everything else is preserved.
    expect(re.nodes.find((n) => n.id === "order_backlog")!.provenance?.unitValue).toBe(12.5);
    expect(re.provenance?.timeUnit).toBe("1 week");
  });

  it("buildProvenanceFile omits elements without provenance", () => {
    const plain = withComputedLoops(parseGraphOrThrow(yamlText));
    const file = buildProvenanceFile(plain);
    expect(file.nodes).toBeUndefined();
    expect(file.edges).toBeUndefined();
  });
});

describe("Loom spec item 10 — optional meta extensibility block", () => {
  it("the parser preserves an authored meta block and the validator ignores it", () => {
    const yaml = `
nodes:
  - id: a
    initial_value: 1
    unit: u
    meta: { source: "essay", confidence: 0.9 }
edges: []
`;
    const { graph, issues } = parseGraph(yaml);
    expect(issues).toEqual([]);
    expect(graph!.nodes[0].meta).toEqual({ source: "essay", confidence: 0.9 });
  });

  it("meta survives a YAML round-trip via serializeGraphYaml", () => {
    const yaml = `
nodes:
  - id: a
    initial_value: 1
    unit: u
    meta: { phase: 2 }
edges: []
`;
    const g = withComputedLoops(parseGraphOrThrow(yaml));
    const out = serializeGraphYaml(g);
    const reparsed = parseGraphOrThrow(out);
    expect(reparsed.nodes[0].meta).toEqual({ phase: 2 });
  });
});
