import { describe, expect, it } from "vitest";
import { isValid, validate } from "@/model/validate";
import type { Graph, Node, Edge } from "@/model/types";

function n(partial: Partial<Node>): Node {
  return {
    id: partial.id ?? "n1",
    label: partial.label ?? "n1",
    type: partial.type ?? "stock",
    initial_value: partial.initial_value ?? 0,
    unit: partial.unit ?? "u",
    ...(partial.boundary !== undefined ? { boundary: partial.boundary } : {}),
    ...("pin" in partial ? { pin: partial.pin } : {}),
    ...("collar" in partial ? { collar: partial.collar } : {}),
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

  it("rejects invalid node type", () => {
    const bad = n({ id: "a", type: "widget" as Node["type"] });
    const codes = validate(graph([bad], [])).map((i) => i.code);
    expect(codes).toContain("invalid_node_type");
  });

  it("rejects non-boolean boundary", () => {
    const raw = { id: "a", label: "a", type: "stock", boundary: "yes", initial_value: 0, unit: "u" };
    const codes = validate({ nodes: [raw], edges: [], loops: [] }).map((i) => i.code);
    expect(codes).toContain("invalid_boundary");
  });

  it("fires tioe_class_deprecated for legacy tioe_class field", () => {
    const raw = {
      id: "a",
      label: "a",
      type: "stock",
      tioe_class: "T",
      initial_value: 0,
      unit: "u",
    };
    const issues = validate({ nodes: [raw], edges: [], loops: [] });
    expect(issues.some((i) => i.code === "tioe_class_deprecated" && i.ref === "a")).toBe(true);
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
      [n({ id: "a", type: "bad" as Node["type"] }), n({ id: "a", type: "bad" as Node["type"] })],
      [],
    );
    expect(validate(g).length).toBeGreaterThan(1);
  });

  it("accepts a physical collar block with lower and upper in the node's own units", () => {
    const g = graph([n({ id: "a", initial_value: 50, collar: { lower: 0, upper: 120 } })], []);
    expect(validate(g)).toEqual([]);
  });

  it("accepts a collar with only a lower bound (unbounded above)", () => {
    const g = graph([n({ id: "a", initial_value: 50, collar: { lower: 0 } })], []);
    expect(validate(g)).toEqual([]);
  });

  it("accepts a collar with only an upper bound (unbounded below)", () => {
    const g = graph([n({ id: "a", initial_value: 50, collar: { upper: 120 } })], []);
    expect(validate(g)).toEqual([]);
  });

  it("rejects collar.lower >= collar.upper", () => {
    const g = graph([n({ id: "a", initial_value: 50, collar: { lower: 80, upper: 80 } })], []);
    expect(validate(g).some((i) => i.code === "collar_lower_above_upper")).toBe(true);
  });

  it("rejects initial_value above collar.upper", () => {
    const g = graph([n({ id: "a", initial_value: 150, collar: { lower: 0, upper: 120 } })], []);
    expect(validate(g).some((i) => i.code === "collar_initial_out_of_range")).toBe(true);
  });

  it("rejects initial_value below collar.lower", () => {
    const g = graph([n({ id: "a", initial_value: -10, collar: { lower: 0, upper: 120 } })], []);
    expect(validate(g).some((i) => i.code === "collar_initial_out_of_range")).toBe(true);
  });

  it("fires collar_ambiguous_units for legacy flat lower_collar/upper_collar fields", () => {
    const raw = {
      id: "a",
      label: "a",
      type: "stock",
      initial_value: 50,
      unit: "u",
      lower_collar: 0.2,
      upper_collar: 0.9,
    };
    const issues = validate({ nodes: [raw], edges: [], loops: [] });
    expect(issues.some((i) => i.code === "collar_ambiguous_units" && i.ref === "a")).toBe(true);
  });

  it("fires collar_ambiguous_units even when only one legacy field is present", () => {
    const raw = {
      id: "a",
      label: "a",
      type: "stock",
      initial_value: 50,
      unit: "u",
      upper_collar: 0.9,
    };
    const issues = validate({ nodes: [raw], edges: [], loops: [] });
    expect(issues.some((i) => i.code === "collar_ambiguous_units")).toBe(true);
  });

  it("accepts a collar with approach: hard or soft", () => {
    const g1 = graph([n({ id: "a", initial_value: 50, collar: { lower: 0, upper: 100, approach: "hard" } })], []);
    expect(validate(g1)).toEqual([]);
    const g2 = graph([n({ id: "a", initial_value: 50, collar: { lower: 0, upper: 100, approach: "soft" } })], []);
    expect(validate(g2)).toEqual([]);
  });

  it("rejects an invalid collar approach", () => {
    const g = graph([n({ id: "a", initial_value: 50, collar: { lower: 0, upper: 100, approach: "fast" as "hard" } })], []);
    expect(validate(g).some((i) => i.code === "collar_invalid_approach")).toBe(true);
  });
});
