import { describe, expect, it } from "vitest";
import type { Edge, Graph, Node } from "@/model/types";
import {
  MAX_SIGNALS,
  MAX_SIGNALS_PER_EDGE,
  NUDGE_DELTA,
  REST_VALUE,
  clampToCollar,
  initialLoopyState,
  nudge,
  resetLoopyState,
  step,
  type LoopyState,
} from "@/layer1/signal";

function node(id: string): Node {
  return { id, label: id, type: "stock", tioe_class: "none", initial_value: 0, unit: "u" };
}

/** A node with normalized live-value collars. */
function collaredNode(id: string, lo: number, hi: number): Node {
  return { ...node(id), lower_collar: lo, upper_collar: hi };
}

function edge(
  id: string,
  source: string,
  target: string,
  opts: { polarity?: "+" | "-"; strength?: number } = {},
): Edge {
  return {
    id,
    source,
    target,
    polarity: opts.polarity ?? "+",
    delay: { type: "none", magnitude: 0 },
    strength: opts.strength ?? 1,
  };
}

/** A simple two-node chain: a -> b. */
function chain(): Graph {
  return {
    nodes: [node("a"), node("b")],
    edges: [edge("e1", "a", "b", { strength: 1 })],
    loops: [],
  };
}

describe("initialLoopyState", () => {
  it("starts every node at rest with no signals", () => {
    const g = chain();
    const s = initialLoopyState(g);
    expect(s.values.get("a")).toBe(REST_VALUE);
    expect(s.values.get("b")).toBe(REST_VALUE);
    expect(s.signals).toEqual([]);
  });
});

describe("nudge", () => {
  it("shifts the node value and emits one signal per outgoing edge", () => {
    const g = chain();
    const s0 = initialLoopyState(g);
    const s1 = nudge(s0, g, "a", NUDGE_DELTA);
    expect(s1.values.get("a")).toBeCloseTo(REST_VALUE + NUDGE_DELTA);
    expect(s1.signals).toHaveLength(1);
    expect(s1.signals[0]).toEqual({ edgeId: "e1", position: 0, delta: NUDGE_DELTA });
  });

  it("does not mutate the input state (pure)", () => {
    const g = chain();
    const s0 = initialLoopyState(g);
    const before = s0.values.get("a");
    nudge(s0, g, "a", NUDGE_DELTA);
    expect(s0.values.get("a")).toBe(before);
    expect(s0.signals).toHaveLength(0);
  });

  it("emits nothing for a node with no outgoing edges", () => {
    const g = chain();
    const s1 = nudge(initialLoopyState(g), g, "b", NUDGE_DELTA);
    expect(s1.signals).toHaveLength(0);
    expect(s1.values.get("b")).toBeCloseTo(REST_VALUE + NUDGE_DELTA);
  });

  it("caps signals per edge", () => {
    const g = chain();
    let s = initialLoopyState(g);
    for (let i = 0; i < MAX_SIGNALS_PER_EDGE + 5; i++) {
      s = nudge(s, g, "a", NUDGE_DELTA);
    }
    const onEdge = s.signals.filter((x) => x.edgeId === "e1").length;
    expect(onEdge).toBeLessThanOrEqual(MAX_SIGNALS_PER_EDGE);
  });
});

describe("step", () => {
  it("advances in-flight signals without delivering them prematurely", () => {
    const g = chain();
    const s0 = nudge(initialLoopyState(g), g, "a", NUDGE_DELTA);
    const s1 = step(s0, g, 0.5);
    expect(s1.signals).toHaveLength(1);
    expect(s1.signals[0].position).toBeCloseTo(0.5);
    // Target unchanged until delivery.
    expect(s1.values.get("b")).toBe(REST_VALUE);
  });

  it("delivers on reaching the target, applying signed strength", () => {
    const g: Graph = {
      nodes: [node("a"), node("b")],
      edges: [edge("e1", "a", "b", { strength: 2, polarity: "+" })],
      loops: [],
    };
    let s = nudge(initialLoopyState(g), g, "a", 0.1);
    // Reach the target in one step (speed >= 1).
    s = step(s, g, 1);
    expect(s.signals).toHaveLength(0);
    expect(s.values.get("b")).toBeCloseTo(REST_VALUE + 0.1 * 2);
  });

  it("a negative polarity subtracts at the target", () => {
    const g: Graph = {
      nodes: [node("a"), node("b")],
      edges: [edge("e1", "a", "b", { strength: 1, polarity: "-" })],
      loops: [],
    };
    let s = nudge(initialLoopyState(g), g, "a", 0.2);
    s = step(s, g, 1);
    expect(s.values.get("b")).toBeCloseTo(REST_VALUE - 0.2);
  });

  it("re-emits delivered deltas onto the target's outgoing edges (loop)", () => {
    // a -> b -> a  (a reinforcing two-cycle)
    const g: Graph = {
      nodes: [node("a"), node("b")],
      edges: [edge("e1", "a", "b"), edge("e2", "b", "a")],
      loops: [],
    };
    let s = nudge(initialLoopyState(g), g, "a", 0.1);
    s = step(s, g, 1); // e1 delivered to b; re-emitted onto e2
    expect(s.signals).toHaveLength(1);
    expect(s.signals[0].edgeId).toBe("e2");
    expect(s.signals[0].position).toBeCloseTo(0);
    s = step(s, g, 1); // e2 delivered to a; re-emitted onto e1
    expect(s.signals).toHaveLength(1);
    expect(s.signals[0].edgeId).toBe("e1");
    // Value has propagated all the way around once (nudge +0.1, loop +0.1).
    expect(s.values.get("a")).toBeCloseTo(REST_VALUE + 0.2);
  });

  it("is pure: input state is untouched", () => {
    const g = chain();
    const s0 = nudge(initialLoopyState(g), g, "a", NUDGE_DELTA);
    const snapshot: LoopyState = {
      values: new Map(s0.values),
      signals: s0.signals.map((x) => ({ ...x })),
    };
    step(s0, g, 1);
    expect(s0.values).toEqual(snapshot.values);
    expect(s0.signals).toEqual(snapshot.signals);
  });

  it("caps total signals at MAX_SIGNALS", () => {
    // A tight reinforcing cycle keeps re-emitting; ensure the global cap holds.
    const g: Graph = {
      nodes: [node("a"), node("b"), node("c")],
      edges: [
        edge("e1", "a", "b"),
        edge("e2", "b", "c"),
        edge("e3", "c", "a"),
      ],
      loops: [],
    };
    let s = nudge(initialLoopyState(g), g, "a", 0.1);
    for (let i = 0; i < 5000; i++) s = step(s, g, 1);
    expect(s.signals.length).toBeLessThanOrEqual(MAX_SIGNALS);
  });
});

describe("resetLoopyState", () => {
  it("restores rest values and clears signals", () => {
    const g = chain();
    let s = nudge(initialLoopyState(g), g, "a", NUDGE_DELTA);
    s = step(s, g, 1);
    const r = resetLoopyState(s, g);
    expect(r.values.get("a")).toBe(REST_VALUE);
    expect(r.values.get("b")).toBe(REST_VALUE);
    expect(r.signals).toEqual([]);
  });
});

describe("clampToCollar", () => {
  it("clamps to the upper collar", () => {
    const n = collaredNode("a", 0, 0.6);
    expect(clampToCollar(0.9, n)).toBe(0.6);
  });

  it("clamps to the lower collar", () => {
    const n = collaredNode("a", 0.3, 1);
    expect(clampToCollar(0.1, n)).toBe(0.3);
  });

  it("leaves values within the collar unchanged", () => {
    const n = collaredNode("a", 0.2, 0.8);
    expect(clampToCollar(0.5, n)).toBe(0.5);
  });

  it("is a no-op when no collar is authored", () => {
    expect(clampToCollar(5, node("a"))).toBe(5);
    expect(clampToCollar(-1, undefined)).toBe(-1);
  });
});

describe("collar clamping in the loopy engine", () => {
  it("clamps a nudge that would exceed the upper collar", () => {
    // a -> b, b has a tight upper collar of 0.55 (rest 0.5). A +0.2 nudge
    // delivered to b would reach 0.7 but must clamp to 0.55.
    const g: Graph = {
      nodes: [node("a"), collaredNode("b", 0, 0.55)],
      edges: [edge("e1", "a", "b", { strength: 1, polarity: "+" })],
      loops: [],
    };
    let s = nudge(initialLoopyState(g), g, "a", 0.2);
    s = step(s, g, 1);
    expect(s.values.get("b")).toBeCloseTo(0.55);
  });

  it("clamps a nudge that would fall below the lower collar", () => {
    const g: Graph = {
      nodes: [node("a"), collaredNode("b", 0.45, 1)],
      edges: [edge("e1", "a", "b", { strength: 1, polarity: "-" })],
      loops: [],
    };
    let s = nudge(initialLoopyState(g), g, "a", 0.2);
    s = step(s, g, 1);
    expect(s.values.get("b")).toBeCloseTo(0.45);
  });

  it("clamps the nudged source node itself to its own collar", () => {
    const g: Graph = {
      nodes: [collaredNode("a", 0, 0.6), node("b")],
      edges: [edge("e1", "a", "b")],
      loops: [],
    };
    // Nudge a up by NUDGE_DELTA (0.33) -> 0.83, clamped to 0.6.
    const s = nudge(initialLoopyState(g), g, "a", NUDGE_DELTA);
    expect(s.values.get("a")).toBeCloseTo(0.6);
  });
});
