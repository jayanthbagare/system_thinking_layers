import { describe, expect, it } from "vitest";
import type { Edge, Graph, Node } from "@/model/types";
import { withComputedLoops } from "@/graph/loops";
import { loadSession, saveSession } from "@/io/session";
import type { Weights } from "@/layer2/scoring";

function node(id: string): Node {
  return { id, label: id, type: "stock", tioe_class: "none", initial_value: 0, unit: "u" };
}

function edge(id: string, source: string, target: string): Edge {
  return { id, source, target, polarity: "+", delay: { type: "none", magnitude: 0 }, strength: 1 };
}

const weights: Weights = {
  in_degree: 1,
  delay_ratio: 2,
  rate_mismatch: 0.5,
  dominant_loop: 1.5,
  sensitivity: 1,
};

const graph: Graph = withComputedLoops({
  nodes: [node("a"), node("b")],
  edges: [edge("e1", "a", "b"), edge("e2", "b", "a")],
  loops: [],
});

describe("session save/load round-trip", () => {
  it("is lossless: load(save(x)) preserves graph and weights", () => {
    const json = saveSession(graph, weights);
    const loaded = loadSession(json);
    expect(loaded.version).toBe(1);
    expect(loaded.graph.nodes).toEqual(graph.nodes);
    expect(loaded.graph.edges).toEqual(graph.edges);
    expect(loaded.graph.loops).toEqual(graph.loops);
    expect(loaded.weights).toEqual(weights);
  });

  it("includes a savedAt timestamp", () => {
    const json = saveSession(graph, weights);
    const loaded = loadSession(json);
    expect(loaded.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rejects an unsupported version", () => {
    const bad = JSON.stringify({ version: 99, graph: { nodes: [], edges: [], loops: [] }, weights });
    expect(() => loadSession(bad)).toThrow("unsupported session version");
  });

  it("rejects a session with no graph", () => {
    const bad = JSON.stringify({ version: 1, weights });
    expect(() => loadSession(bad)).toThrow("missing graph");
  });

  it("strips prototype-pollution keys before validation", () => {
    // A graph with proto keys and a complete node should load OK after stripping.
    const good = JSON.stringify({
      version: 1,
      graph: {
        nodes: [
          {
            id: "a",
            label: "A",
            type: "stock",
            tioe_class: "none",
            initial_value: 0,
            unit: "u",
            __proto__: { evil: true },
            constructor: { prototype: "bad" },
          },
        ],
        edges: [],
        loops: [],
      },
      weights,
    });
    const loaded = loadSession(good);
    expect(loaded.graph.nodes[0]).not.toHaveProperty("evil");
    expect(loaded.graph.nodes[0]).not.toHaveProperty("constructor");
  });

  it("preserves ABM verdicts written on nodes", () => {
    const g: Graph = {
      nodes: [
        { ...node("a"), abm_verdict: { status: "validated", detail: "ok", macro: "held" } },
        node("b"),
      ],
      edges: [edge("e1", "a", "b")],
      loops: [],
    };
    const json = saveSession(g, weights);
    const loaded = loadSession(json);
    expect(loaded.graph.nodes[0].abm_verdict).toEqual({
      status: "validated",
      detail: "ok",
      macro: "held",
    });
  });
});
