import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseGraphOrThrow } from "@/dsl/parser";
import { withComputedLoops } from "@/graph/loops";
import type { Edge, Graph, Node } from "@/model/types";
import {
  applyStructuralEdit,
  structuralEditTier,
  TIER_LABELS,
} from "@/layer3/structural";
import { simulateTyped, leverageTier, type TypedIntervention } from "@/layer3/intervention";

// --- fixture builders -----------------------------------------------------

function stock(id: string, value = 0, collar?: Node["collar"]): Node {
  const n: Node = { id, label: id, type: "stock", initial_value: value, unit: "u" };
  if (collar) n.collar = collar;
  return n;
}
function flow(id: string, value = 0): Node {
  return { id, label: id, type: "flow", initial_value: value, unit: "u" };
}
function edge(
  id: string,
  s: string,
  t: string,
  o: { pol?: "+" | "-"; mag?: number; str?: number } = {},
): Edge {
  const mag = o.mag ?? 0;
  return {
    id,
    source: s,
    target: t,
    polarity: o.pol ?? "+",
    delay: { type: mag === 0 ? "none" : "material", magnitude: mag },
    strength: o.str ?? 1,
  };
}

function loadBeer(): Graph {
  return withComputedLoops(
    parseGraphOrThrow(readFileSync("public/examples/beer-distribution.yaml", "utf8")),
  );
}

const OPTS = { dt: 0.1, method: "rk4" as const };

// --- structural edit application -----------------------------------------

describe("applyStructuralEdit", () => {
  it("addEdge: adds the edge and re-derives loops", () => {
    const g: Graph = {
      nodes: [stock("a", 100), stock("b", 0)],
      edges: [edge("e1", "a", "b", { mag: 2 })],
      loops: [],
    };
    const newEdge = edge("e2", "b", "a", { mag: 2 });
    const next = applyStructuralEdit(g, { kind: "addEdge", edge: newEdge });
    expect(next.edges).toHaveLength(2);
    // Adding b->a creates a cycle; loops should now be non-empty.
    expect(next.loops.length).toBeGreaterThan(0);
  });

  it("deleteEdge: removes the edge and re-derives loops", () => {
    const g: Graph = {
      nodes: [stock("a", 100), stock("b", 0)],
      edges: [edge("e1", "a", "b", { mag: 2 }), edge("e2", "b", "a", { mag: 2 })],
      loops: [],
    };
    const next = applyStructuralEdit(g, { kind: "deleteEdge", edgeId: "e2" });
    expect(next.edges).toHaveLength(1);
    expect(next.edges[0].id).toBe("e1");
  });

  it("collapseDelay: multiplies the delay magnitude by the factor", () => {
    const g: Graph = {
      nodes: [stock("a", 100), stock("b", 0)],
      edges: [edge("e1", "a", "b", { mag: 4 })],
      loops: [],
    };
    const next = applyStructuralEdit(g, { kind: "collapseDelay", edgeId: "e1", factor: 0.5 });
    expect(next.edges[0].delay.magnitude).toBeCloseTo(2, 6);
    // factor 0 removes the delay entirely.
    const next2 = applyStructuralEdit(g, { kind: "collapseDelay", edgeId: "e1", factor: 0 });
    expect(next2.edges[0].delay.magnitude).toBe(0);
  });

  it("changeDelayType: changes the delay type", () => {
    const g: Graph = {
      nodes: [stock("a", 100), stock("b", 0)],
      edges: [edge("e1", "a", "b", { mag: 4 })],
      loops: [],
    };
    const next = applyStructuralEdit(g, { kind: "changeDelayType", edgeId: "e1", delayType: "information" });
    expect(next.edges[0].delay.type).toBe("information");
  });

  it("flipPolarity: swaps + and -", () => {
    const g: Graph = {
      nodes: [stock("a", 100), stock("b", 0)],
      edges: [edge("e1", "a", "b", { pol: "+" })],
      loops: [],
    };
    const next = applyStructuralEdit(g, { kind: "flipPolarity", edgeId: "e1" });
    expect(next.edges[0].polarity).toBe("-");
    const next2 = applyStructuralEdit(next, { kind: "flipPolarity", edgeId: "e1" });
    expect(next2.edges[0].polarity).toBe("+");
  });

  it("splitNode: creates a new node, rewires edges, and reassigns the collar", () => {
    const g: Graph = {
      nodes: [
        flow("src", 100),
        stock("mid", 50, { lower: 0, upper: 100 }),
        stock("out", 0),
      ],
      edges: [edge("e1", "src", "mid"), edge("e2", "mid", "out")],
      loops: [],
    };
    const next = applyStructuralEdit(g, {
      kind: "splitNode",
      nodeId: "mid",
      newId: "mid_split",
      newLabel: "Mid (split)",
      delay: { type: "material", magnitude: 2 },
      collarTo: "original",
    });
    // Three nodes now.
    expect(next.nodes).toHaveLength(4);
    // The new node exists.
    const newN = next.nodes.find((n) => n.id === "mid_split");
    expect(newN).toBeDefined();
    expect(newN!.type).toBe("stock");
    // The original keeps its collar.
    const orig = next.nodes.find((n) => n.id === "mid");
    expect(orig!.collar).toBeDefined();
    expect(orig!.collar!.upper).toBe(100);
    // The new node has no collar (collarTo: "original").
    expect(newN!.collar).toBeUndefined();
    // Outgoing edges rewired: e2 now starts from mid_split.
    const e2 = next.edges.find((e) => e.id === "e2");
    expect(e2!.source).toBe("mid_split");
    // A new splitter edge mid -> mid_split was added.
    const splitter = next.edges.find((e) => e.source === "mid" && e.target === "mid_split");
    expect(splitter).toBeDefined();
    expect(splitter!.delay.magnitude).toBe(2);
  });

  it("splitNode: collarTo 'new' moves the collar to the new node", () => {
    const g: Graph = {
      nodes: [stock("mid", 50, { lower: 0, upper: 100 }), stock("out", 0)],
      edges: [edge("e1", "mid", "out")],
      loops: [],
    };
    const next = applyStructuralEdit(g, {
      kind: "splitNode",
      nodeId: "mid",
      newId: "mid_split",
      newLabel: "Mid (split)",
      delay: { type: "material", magnitude: 1 },
      collarTo: "new",
    });
    const orig = next.nodes.find((n) => n.id === "mid");
    const newN = next.nodes.find((n) => n.id === "mid_split");
    expect(orig!.collar).toBeUndefined();
    expect(newN!.collar).toBeDefined();
    expect(newN!.collar!.upper).toBe(100);
  });

  it("does not mutate the input graph", () => {
    const g: Graph = {
      nodes: [stock("a", 100), stock("b", 0)],
      edges: [edge("e1", "a", "b", { mag: 4 })],
      loops: [],
    };
    const before = JSON.stringify(g);
    applyStructuralEdit(g, { kind: "collapseDelay", edgeId: "e1", factor: 0 });
    expect(JSON.stringify(g)).toBe(before);
  });
});

// --- leverage tiers -------------------------------------------------------

describe("structuralEditTier", () => {
  it("collapseDelay is tier 4 (Delay)", () => {
    expect(structuralEditTier({ kind: "collapseDelay", edgeId: "e1", factor: 0 })).toBe(4);
  });
  it("changeDelayType is tier 4 (Delay)", () => {
    expect(structuralEditTier({ kind: "changeDelayType", edgeId: "e1", delayType: "none" })).toBe(4);
  });
  it("addEdge / deleteEdge / splitNode are tier 5 (Structure)", () => {
    expect(structuralEditTier({ kind: "addEdge", edge: edge("e2", "a", "b") })).toBe(5);
    expect(structuralEditTier({ kind: "deleteEdge", edgeId: "e1" })).toBe(5);
    expect(
      structuralEditTier({
        kind: "splitNode",
        nodeId: "a",
        newId: "b",
        newLabel: "B",
        delay: { type: "material", magnitude: 1 },
      }),
    ).toBe(5);
  });
  it("flipPolarity is tier 6 (Rules)", () => {
    expect(structuralEditTier({ kind: "flipPolarity", edgeId: "e1" })).toBe(6);
  });
});

describe("leverageTier", () => {
  it("Exploit is tier 1 (Parameter)", () => {
    const iv: TypedIntervention = { type: "exploit", target: "a", magnitude: 10 };
    expect(leverageTier(iv)).toBe(1);
  });
  it("Elevate is tier 2 (Bound)", () => {
    const iv: TypedIntervention = { type: "elevate", target: "a", magnitude: 50 };
    expect(leverageTier(iv)).toBe(2);
  });
  it("Subordinate is tier 5 (Structure — adds a rope edge)", () => {
    const iv: TypedIntervention = {
      type: "subordinate",
      target: "a",
      magnitude: 1,
      rope: { buffer: "a", release: "b" },
    };
    expect(leverageTier(iv)).toBe(5);
  });
  it("Structural with collapseDelay is tier 4 (Delay)", () => {
    const iv: TypedIntervention = {
      type: "structural",
      target: "e1",
      magnitude: 0,
      edit: { kind: "collapseDelay", edgeId: "e1", factor: 0 },
    };
    expect(leverageTier(iv)).toBe(4);
  });
  it("Structural with flipPolarity is tier 6 (Rules)", () => {
    const iv: TypedIntervention = {
      type: "structural",
      target: "e1",
      magnitude: 0,
      edit: { kind: "flipPolarity", edgeId: "e1" },
    };
    expect(leverageTier(iv)).toBe(6);
  });
});

describe("TIER_LABELS", () => {
  it("labels all six tiers", () => {
    expect(TIER_LABELS[1]).toBe("Parameter");
    expect(TIER_LABELS[2]).toBe("Bound");
    expect(TIER_LABELS[3]).toBe("Buffer");
    expect(TIER_LABELS[4]).toBe("Delay");
    expect(TIER_LABELS[5]).toBe("Structure");
    expect(TIER_LABELS[6]).toBe("Rules");
  });
});

// --- Phase 6 acceptance criteria -----------------------------------------

describe("Phase 6 acceptance: delay collapse reduces oscillation and I", () => {
  it("collapsing the longest delay on the beer fixture reduces I variance and end-of-horizon I", () => {
    const g = loadBeer();
    // e5 (wholesaler_orders -> production_capacity) has the longest delay (6).
    const iv: TypedIntervention = {
      type: "structural",
      target: "e5",
      magnitude: 0,
      edit: { kind: "collapseDelay", edgeId: "e5", factor: 0 },
    };
    const r = simulateTyped(g, iv, OPTS, 200);
    const variance = (arr: number[]) => {
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      return arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
    };
    const preIVar = variance(r.pre.map((s) => s.I));
    const postIVar = variance(r.post.map((s) => s.I));
    expect(postIVar).toBeLessThan(preIVar);
    expect(r.deltaI).toBeLessThan(0);
  });
});

describe("Phase 6 acceptance: split node prompts for collar reassignment", () => {
  it("splitting a collared node with collarTo 'original' keeps the collar on the original", () => {
    const g: Graph = {
      nodes: [stock("cap", 50, { lower: 0, upper: 100 }), stock("out", 0)],
      edges: [edge("e1", "cap", "out")],
      loops: [],
    };
    const next = applyStructuralEdit(g, {
      kind: "splitNode",
      nodeId: "cap",
      newId: "cap_split",
      newLabel: "Cap (split)",
      delay: { type: "material", magnitude: 2 },
      collarTo: "original",
    });
    const orig = next.nodes.find((n) => n.id === "cap");
    const newN = next.nodes.find((n) => n.id === "cap_split");
    expect(orig!.collar).toBeDefined();
    expect(orig!.collar!.upper).toBe(100);
    expect(newN!.collar).toBeUndefined();
  });

  it("splitting a collared node with collarTo 'new' moves the collar", () => {
    const g: Graph = {
      nodes: [stock("cap", 50, { lower: 0, upper: 100 }), stock("out", 0)],
      edges: [edge("e1", "cap", "out")],
      loops: [],
    };
    const next = applyStructuralEdit(g, {
      kind: "splitNode",
      nodeId: "cap",
      newId: "cap_split",
      newLabel: "Cap (split)",
      delay: { type: "material", magnitude: 2 },
      collarTo: "new",
    });
    const orig = next.nodes.find((n) => n.id === "cap");
    const newN = next.nodes.find((n) => n.id === "cap_split");
    expect(orig!.collar).toBeUndefined();
    expect(newN!.collar).toBeDefined();
    expect(newN!.collar!.upper).toBe(100);
  });

  it("no collar is silently dropped or duplicated", () => {
    const g: Graph = {
      nodes: [stock("cap", 50, { lower: 0, upper: 100 }), stock("out", 0)],
      edges: [edge("e1", "cap", "out")],
      loops: [],
    };
    // collarTo "original": only the original has the collar.
    const next = applyStructuralEdit(g, {
      kind: "splitNode",
      nodeId: "cap",
      newId: "cap_split",
      newLabel: "Cap (split)",
      delay: { type: "material", magnitude: 1 },
      collarTo: "original",
    });
    const collared = next.nodes.filter((n) => n.collar !== undefined);
    expect(collared).toHaveLength(1);
    expect(collared[0].id).toBe("cap");
  });
});

describe("Phase 6 acceptance: structural and parameter interventions comparable", () => {
  it("both produce a TypedSimulationResult with the same axes (T, I, OE, ratios, DoF, tier)", () => {
    const g = loadBeer();
    // Parameter: exploit on production_capacity.
    const paramIv: TypedIntervention = { type: "exploit", target: "production_capacity", magnitude: 5 };
    const paramR = simulateTyped(g, paramIv, OPTS, 200);
    expect(paramR.tier).toBe(1);

    // Structural: collapse the longest delay.
    const structIv: TypedIntervention = {
      type: "structural",
      target: "e5",
      magnitude: 0,
      edit: { kind: "collapseDelay", edgeId: "e5", factor: 0 },
    };
    const structR = simulateTyped(g, structIv, OPTS, 200);
    expect(structR.tier).toBe(4);
    // Both have the same set of analysis fields.
    expect(structR.pre.length).toBe(paramR.pre.length);
    expect(structR.ratios).toBeDefined();
    expect(structR.dof).toBeDefined();
    expect(structR.jCurve).toBeDefined();
  });
});
