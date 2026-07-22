import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseGraph, parseGraphOrThrow, serializeGraph, ParseError } from "@/dsl/parser";

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
