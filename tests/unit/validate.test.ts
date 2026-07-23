import { describe, expect, it } from "vitest";
import { isValid, validate } from "@/model/validate";
import type { Graph, Node, Edge } from "@/model/types";

function n(partial: Partial<Node>): Node {
  return {
    id: partial.id ?? "n1",
    label: partial.label ?? "n1",
    type: partial.type ?? "stock",
    tioe_class: partial.tioe_class ?? "none",
    initial_value: partial.initial_value ?? 0,
    unit: partial.unit ?? "u",
    ...("pin" in partial ? { pin: partial.pin } : {}),
    ...("lower_collar" in partial ? { lower_collar: partial.lower_collar } : {}),
    ...("upper_collar" in partial ? { upper_collar: partial.upper_collar } : {}),
    ...("agent_binding" in partial ? { agent_binding: partial.agent_binding } : {}),
  };
}

function e(partial: Partial<Edge>): Edge {
  return {
    id: partial.id ?? "e1",
    source: partial.source ?? "n1",
    target: partial.target ?? "n2",
    polarity: partial.polarity ?? "+",
    delay: partial.delay ?? { type: "none", magnitude: 0 },
    strength: partial.strength ?? 1,
  };
}

function graph(nodes: Node[], edges: Edge[]): Graph {
  return { nodes, edges, loops: [] };
}

describe("validate", () => {
  it("accepts a minimal valid graph", () => {
    const g = graph([n({ id: "a" }), n({ id: "b" })], [e({ source: "a", target: "b" })]);
    expect(validate(g)).toEqual([]);
    expect(isValid(g)).toBe(true);
  });

  it("rejects duplicate node ids", () => {
    const g = graph([n({ id: "a" }), n({ id: "a" })], []);
    const issues = validate(g);
    expect(issues.some((i) => i.code === "duplicate_node_id")).toBe(true);
  });

  it("rejects duplicate edge ids", () => {
    const g = graph(
      [n({ id: "a" }), n({ id: "b" })],
      [e({ id: "x", source: "a", target: "b" }), e({ id: "x", source: "b", target: "a" })],
    );
    expect(validate(g).some((i) => i.code === "duplicate_edge_id")).toBe(true);
  });

  it("rejects edges referencing unknown nodes", () => {
    const g = graph([n({ id: "a" })], [e({ source: "a", target: "ghost" })]);
    const codes = validate(g).map((i) => i.code);
    expect(codes).toContain("edge_unknown_target");
  });

  it("rejects self-loops", () => {
    const g = graph([n({ id: "a" })], [e({ source: "a", target: "a" })]);
    expect(validate(g).some((i) => i.code === "edge_self_loop")).toBe(true);
  });

  it("rejects duplicate source->target pairs", () => {
    const g = graph(
      [n({ id: "a" }), n({ id: "b" })],
      [e({ id: "e1", source: "a", target: "b" }), e({ id: "e2", source: "a", target: "b" })],
    );
    expect(validate(g).some((i) => i.code === "duplicate_edge")).toBe(true);
  });

  it("rejects invalid node type and tioe_class", () => {
    const bad = n({ id: "a", type: "widget" as Node["type"], tioe_class: "Z" as Node["tioe_class"] });
    const codes = validate(graph([bad], [])).map((i) => i.code);
    expect(codes).toContain("invalid_node_type");
    expect(codes).toContain("invalid_tioe_class");
  });

  it("rejects invalid polarity and delay type", () => {
    const bad = e({
      polarity: "!" as Edge["polarity"],
      delay: { type: "fast" as Edge["delay"]["type"], magnitude: 1 },
    });
    const codes = validate(graph([n({ id: "a" }), n({ id: "b" })], [bad])).map((i) => i.code);
    expect(codes).toContain("invalid_polarity");
    expect(codes).toContain("invalid_delay_type");
  });

  it("rejects negative delay and strength", () => {
    const bad = e({ delay: { type: "material", magnitude: -1 }, strength: -2 });
    const codes = validate(graph([n({ id: "a" }), n({ id: "b" })], [bad])).map((i) => i.code);
    expect(codes).toContain("negative_delay");
    expect(codes).toContain("negative_strength");
  });

  it("collects ALL violations, not just the first", () => {
    const g = graph(
      [n({ id: "a", type: "bad" as Node["type"] }), n({ id: "a", tioe_class: "Z" as Node["tioe_class"] })],
      [],
    );
    expect(validate(g).length).toBeGreaterThan(1);
  });

  it("accepts optional collars within [0,1]", () => {
    const g = graph([n({ id: "a", lower_collar: 0.2, upper_collar: 0.9 })], []);
    expect(validate(g)).toEqual([]);
  });

  it("accepts collars at the 0 and 1 extremes", () => {
    const g = graph([n({ id: "a", lower_collar: 0, upper_collar: 1 })], []);
    expect(validate(g)).toEqual([]);
  });

  it("rejects collars outside [0,1]", () => {
    const g = graph([n({ id: "a", lower_collar: -0.1, upper_collar: 1.2 })], []);
    const codes = validate(g).map((i) => i.code);
    expect(codes).toContain("collar_out_of_bounds");
  });

  it("rejects lower_collar above upper_collar", () => {
    const g = graph([n({ id: "a", lower_collar: 0.8, upper_collar: 0.2 })], []);
    expect(validate(g).some((i) => i.code === "collar_lower_above_upper")).toBe(true);
  });

  it("accepts a single collar bound without the other", () => {
    const g = graph([n({ id: "a", upper_collar: 0.7 })], []);
    expect(validate(g)).toEqual([]);
  });
});
