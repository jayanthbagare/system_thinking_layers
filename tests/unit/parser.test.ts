import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseGraph, parseGraphOrThrow, serializeGraph, serializeGraphYaml, ParseError } from "@/dsl/parser";

const examplesDir = fileURLToPath(new URL("../../public/examples", import.meta.url));

function loadFixture(name: string): string {
  return readFileSync(`${examplesDir}/${name}`, "utf8");
}

describe("parseGraph", () => {
  it("parses the beer-distribution fixture into a valid graph", () => {
    const { graph, issues } = parseGraph(loadFixture("beer-distribution.yaml"));
    expect(issues).toEqual([]);
    expect(graph).not.toBeNull();
    expect(graph!.nodes).toHaveLength(6);
    expect(graph!.edges).toHaveLength(7);
    expect(graph!.loops).toEqual([]); // computed in Phase 2, never authored
  });

  it("parses node collars authored in the fixture (physical units)", () => {
    const { graph, issues } = parseGraph(loadFixture("beer-distribution.yaml"));
    expect(issues).toEqual([]);
    const capacity = graph!.nodes.find((n) => n.id === "production_capacity")!;
    expect(capacity.collar).toBeDefined();
    expect(capacity.collar!.lower).toBe(0);
    expect(capacity.collar!.upper).toBe(120);
    // Backlogs have lower: 0 but no upper (unbounded above).
    const backlog = graph!.nodes.find((n) => n.id === "retailer_backlog")!;
    expect(backlog.collar).toBeDefined();
    expect(backlog.collar!.lower).toBe(0);
    expect(backlog.collar!.upper).toBeUndefined();
    // Uncollared nodes have no collar block.
    const demand = graph!.nodes.find((n) => n.id === "customer_demand")!;
    expect(demand.collar).toBeUndefined();
  });

  it("parses optional collars and omits them when absent", () => {
    const yaml = `
nodes:
  - id: a
    initial_value: 50
    collar: { lower: 0, upper: 100 }
  - id: b
edges: []
`;
    const { graph, issues } = parseGraph(yaml);
    expect(issues).toEqual([]);
    expect(graph!.nodes[0].collar).toEqual({ lower: 0, upper: 100 });
    expect(graph!.nodes[1].collar).toBeUndefined();
  });

  it("fires collar_ambiguous_units for legacy flat collar fields", () => {
    const yaml = `
nodes:
  - id: a
    initial_value: 50
    lower_collar: 0.2
    upper_collar: 0.9
edges: []
`;
    const { graph, issues } = parseGraph(yaml);
    expect(graph).toBeNull();
    expect(issues.some((i) => i.code === "collar_ambiguous_units" && i.ref === "a")).toBe(true);
  });

  it("accepts JSON as well as YAML", () => {
    const json = JSON.stringify({
      nodes: [{ id: "a", label: "A", type: "stock", tioe_class: "T", initial_value: 1, unit: "u" }],
      edges: [],
    });
    const { graph, issues } = parseGraph(json);
    expect(issues).toEqual([]);
    expect(graph!.nodes).toHaveLength(1);
  });

  it("applies sensible defaults for omitted optional fields", () => {
    const minimal = `
nodes:
  - id: a
  - id: b
edges:
  - id: e1
    source: a
    target: b
`;
    const { graph, issues } = parseGraph(minimal);
    expect(issues).toEqual([]);
    expect(graph!.nodes[0].type).toBe("auxiliary");
    expect(graph!.nodes[0].tioe_class).toBe("none");
    expect(graph!.edges[0].strength).toBe(1);
    expect(graph!.edges[0].delay.type).toBe("none");
  });

  it("collects all violations and never throws", () => {
    const bad = `
nodes:
  - id: a
    type: widget
    tioe_class: Z
  - id: a
edges:
  - id: e1
    source: a
    target: ghost
    polarity: "?"
    delay: { type: fast, magnitude: -1 }
    strength: -3
`;
    const { graph, issues } = parseGraph(bad);
    expect(graph).toBeNull();
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("duplicate_node_id");
    expect(codes).toContain("invalid_node_type");
    expect(codes).toContain("invalid_tioe_class");
    expect(codes).toContain("edge_unknown_target");
    expect(codes).toContain("invalid_polarity");
    expect(codes).toContain("invalid_delay_type");
    expect(codes).toContain("negative_delay");
    expect(codes).toContain("negative_strength");
  });

  it("parseGraphOrThrow throws ParseError carrying the issues", () => {
    expect(() => parseGraphOrThrow("nodes: []\nedges: []\n  - oops")).toThrow(ParseError);
  });

  it("round-trips: Graph -> JSON -> Graph is lossless", () => {
    const original = parseGraphOrThrow(loadFixture("beer-distribution.yaml"));
    const serialized = serializeGraph(original);
    const reparsed = parseGraphOrThrow(serialized);
    expect(reparsed).toEqual(original);
  });

  it("strips prototype-pollution keys", () => {
    const malicious = `
nodes:
  - id: a
    __proto__:
      polluted: true
    constructor:
      prototype: evil
`;
    const { graph, issues } = parseGraph(malicious);
    expect(issues).toEqual([]);
    expect(graph!.nodes[0]).not.toHaveProperty("polluted");
  });

  it("rejects empty input without throwing", () => {
    const { graph, issues } = parseGraph("");
    expect(graph).toBeNull();
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe("serializeGraphYaml", () => {
  it("round-trips: Graph -> YAML -> Graph is lossless for the beer fixture", () => {
    const original = parseGraphOrThrow(loadFixture("beer-distribution.yaml"));
    const yaml = serializeGraphYaml(original);
    const reparsed = parseGraphOrThrow(yaml);
    expect(reparsed).toEqual(original);
  });

  it("emits collars and delay as readable inline YAML", () => {
    const original = parseGraphOrThrow(loadFixture("beer-distribution.yaml"));
    const yaml = serializeGraphYaml(original);
    expect(yaml).toContain("collar: { lower: 0, upper: 120 }");
    expect(yaml).toContain("delay: { type: information, magnitude: 2 }");
    expect(yaml).toContain("strength: 1.3");
    // Loops are never serialized (computed, never authored).
    expect(yaml).not.toContain("loops:");
  });

  it("omits optional fields when absent", () => {
    const minimal = parseGraphOrThrow(`
nodes:
  - id: a
edges: []
`);
    const yaml = serializeGraphYaml(minimal);
    expect(yaml).not.toContain("collar");
    expect(yaml).not.toContain("pin");
    expect(yaml).not.toContain("agent_binding");
  });
});
