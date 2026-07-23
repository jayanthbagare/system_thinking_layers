import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Edge, Graph, Node } from "@/model/types";
import { deriveLoops, loopsOf, signOf, withComputedLoops } from "@/graph/loops";
import { parseGraphOrThrow } from "@/dsl/parser";

const examplesDir = fileURLToPath(new URL("../../public/examples", import.meta.url));

function loadFixture(name: string): Graph {
  return parseGraphOrThrow(readFileSync(`${examplesDir}/${name}`, "utf8"));
}

function node(id: string, partial: Partial<Node> = {}): Node {
  return {
    id,
    label: partial.label ?? id,
    type: partial.type ?? "stock",
    initial_value: partial.initial_value ?? 0,
    unit: partial.unit ?? "u",
    ...(partial.boundary !== undefined ? { boundary: partial.boundary } : {}),
    ...(partial.pin ? { pin: partial.pin } : {}),
    ...(partial.agent_binding ? { agent_binding: partial.agent_binding } : {}),
    ...(partial.collar ? { collar: partial.collar } : {}),
  };
}

function edge(
  id: string,
  source: string,
  target: string,
  polarity: "+" | "-" = "+",
  magnitude = 0,
): Edge {
  return {
    id,
    source,
    target,
    polarity,
    delay: { type: magnitude === 0 ? "none" : "material", magnitude },
    strength: 1,
  };
}

describe("signOf", () => {
  it("is reinforcing with zero or an even number of `-` edges", () => {
    expect(signOf([edge("e", "a", "b", "+")])).toBe("reinforcing");
    expect(signOf([edge("e1", "a", "b", "+"), edge("e2", "b", "a", "+")])).toBe("reinforcing");
    expect(signOf([edge("e1", "a", "b", "-"), edge("e2", "b", "c", "-"), edge("e3", "c", "a", "+")])).toBe(
      "reinforcing",
    );
  });

  it("is balancing with an odd number of `-` edges", () => {
    expect(signOf([edge("e", "a", "b", "-")])).toBe("balancing");
    expect(signOf([edge("e1", "a", "b", "+"), edge("e2", "b", "c", "-"), edge("e3", "c", "a", "+")])).toBe(
      "balancing",
    );
  });

  it("an empty edge list is reinforcing (zero negatives)", () => {
    expect(signOf([])).toBe("reinforcing");
  });
});

describe("deriveLoops — structure", () => {
  it("returns an empty list for an acyclic graph", () => {
    const g: Graph = {
      nodes: [node("a"), node("b"), node("c")],
      edges: [edge("e1", "a", "b"), edge("e2", "b", "c")],
      loops: [],
    };
    expect(deriveLoops(g).loops).toEqual([]);
  });

  it("derives a single reinforcing loop from a two-node mutual + edge", () => {
    const g: Graph = {
      nodes: [node("a"), node("b")],
      edges: [edge("e1", "a", "b", "+", 0), edge("e2", "b", "a", "+", 3)],
      loops: [],
    };
    const { loops } = deriveLoops(g);
    expect(loops).toHaveLength(1);
    const l = loops[0];
    expect(l.sign).toBe("reinforcing");
    expect(l.cycle_time).toBe(3);
    expect(l.dominant_delay).toBe(3);
    expect(l.nodes).toHaveLength(2);
    expect(new Set(l.edges)).toEqual(new Set(["e1", "e2"]));
  });

  it("computes cycle_time as the sum of edge delays and dominant_delay as the max", () => {
    const g: Graph = {
      nodes: [node("a"), node("b"), node("c")],
      edges: [
        edge("e1", "a", "b", "+", 2),
        edge("e2", "b", "c", "+", 5),
        edge("e3", "c", "a", "+", 1),
      ],
      loops: [],
    };
    const { loops } = deriveLoops(g);
    expect(loops).toHaveLength(1);
    expect(loops[0].cycle_time).toBe(8);
    expect(loops[0].dominant_delay).toBe(5);
  });

  it("labels loops R1/B1/R2... with stable ids ordered by canonical node sequence", () => {
    const g: Graph = {
      nodes: [node("a"), node("b"), node("c"), node("d"), node("e")],
      edges: [
        edge("e1", "a", "b", "+", 1), // R loop a-b
        edge("e2", "b", "a", "+", 1),
        edge("e3", "c", "d", "-", 1), // B loop c-d
        edge("e4", "d", "c", "+", 1),
        edge("e5", "a", "e", "+", 1), // R loop a-e
        edge("e6", "e", "a", "+", 1),
      ],
      loops: [],
    };
    const loops = loopsOf(g);
    const ids = loops.map((l) => l.id);
    expect(ids).toContain("R1");
    expect(ids).toContain("R2");
    expect(ids).toContain("B1");
    // loopsOf sorts ids with numeric-aware collation; "B" precedes "R" alphabetically.
    expect(ids).toEqual(["B1", "R1", "R2"]);
  });

  it("is deterministic and id-stable across repeated derivation", () => {
    const g: Graph = {
      nodes: [node("a"), node("b"), node("c")],
      edges: [
        edge("e1", "a", "b", "-", 2),
        edge("e2", "b", "c", "+", 3),
        edge("e3", "c", "a", "+", 1),
      ],
      loops: [],
    };
    const a = deriveLoops(g);
    const b = deriveLoops(g);
    expect(b.loops).toEqual(a.loops);
    expect(b.loops[0].id).toBe("B1");
  });
});

describe("deriveLoops — beer-distribution fixture", () => {
  it("detects every elementary cycle and assigns R/B ids", () => {
    const g = loadFixture("beer-distribution.yaml");
    const { loops } = deriveLoops(g);
    expect(loops.length).toBeGreaterThan(0);
    // All ids are well-formed R<digit> or B<digit>.
    for (const l of loops) {
      expect(l.id).toMatch(/^[RB]\d+$/);
      expect(l.sign).toBe(l.id.startsWith("R") ? "reinforcing" : "balancing");
    }
    // No duplicate ids.
    expect(new Set(loops.map((l) => l.id)).size).toBe(loops.length);
  });

  it("every reported loop is a real, closed cycle in the graph", () => {
    const g = loadFixture("beer-distribution.yaml");
    const { loops } = deriveLoops(g);
    const edgeById = new Map(g.edges.map((e) => [e.id, e]));
    for (const l of loops) {
      // The nodes form a closed walk via the listed edges, in order.
      const edgeObjs = l.edges.map((eid) => edgeById.get(eid)!);
      expect(edgeObjs).toHaveLength(l.nodes.length);
      for (let i = 0; i < l.nodes.length; i++) {
        const src = l.nodes[i];
        const tgt = l.nodes[(i + 1) % l.nodes.length];
        expect(edgeObjs[i].source).toBe(src);
        expect(edgeObjs[i].target).toBe(tgt);
      }
    }
  });

  it("every loop's sign matches the XOR of its edge polarities", () => {
    const g = loadFixture("beer-distribution.yaml");
    const { loops } = deriveLoops(g);
    const edgeById = new Map(g.edges.map((e) => [e.id, e]));
    for (const l of loops) {
      const neg = l.edges.map((eid) => edgeById.get(eid)!).filter((e) => e.polarity === "-").length;
      expect(l.sign).toBe(neg % 2 === 0 ? "reinforcing" : "balancing");
    }
  });
});

describe("withComputedLoops", () => {
  it("returns a new graph with recomputed loops and leaves the input untouched", () => {
    const original: Graph = {
      nodes: [node("a"), node("b")],
      edges: [edge("e1", "a", "b", "+", 1), edge("e2", "b", "a", "+", 1)],
      loops: [],
    };
    const recomputed = withComputedLoops(original);
    expect(original.loops).toEqual([]);
    expect(recomputed.loops).toHaveLength(1);
    expect(recomputed.nodes).toBe(original.nodes);
    expect(recomputed.edges).toBe(original.edges);
  });
});

describe("deriveLoops — property tests (invariant checks)", () => {
  it("the score/sign is invariant under node-id permutation", () => {
    // Build a triangle with a fixed polarity pattern; relabel and re-derive.
    const polarities: Array<"+" | "-"> = ["+", "+", "-"];
    const labels = ["a", "b", "c"];
    const permuted = ["c", "a", "b"];
    const mk = (ids: string[]): Graph => ({
      nodes: ids.map((id) => node(id)),
      edges: [
        edge("e1", ids[0], ids[1], polarities[0], 2),
        edge("e2", ids[1], ids[2], polarities[1], 3),
        edge("e3", ids[2], ids[0], polarities[2], 1),
      ],
      loops: [],
    });
    const a = deriveLoops(mk(labels));
    const b = deriveLoops(mk(permuted));
    expect(a.loops).toHaveLength(1);
    expect(b.loops).toHaveLength(1);
    expect(a.loops[0].sign).toBe(b.loops[0].sign);
    expect(a.loops[0].cycle_time).toBe(b.loops[0].cycle_time);
    expect(a.loops[0].dominant_delay).toBe(b.loops[0].dominant_delay);
  });

  it("flipping one edge polarity flips the loop sign", () => {
    const g = (polarity: "+" | "-"): Graph => ({
      nodes: [node("a"), node("b"), node("c")],
      edges: [
        edge("e1", "a", "b", "+", 1),
        edge("e2", "b", "c", "+", 1),
        edge("e3", "c", "a", polarity, 1),
      ],
      loops: [],
    });
    expect(deriveLoops(g("+")).loops[0].sign).toBe("reinforcing");
    expect(deriveLoops(g("-")).loops[0].sign).toBe("balancing");
  });

  it("never reports more cycles than 2^|E| (sanity bound)", () => {
    const g: Graph = {
      nodes: [node("a"), node("b"), node("c")],
      edges: [
        edge("e1", "a", "b", "+", 1),
        edge("e2", "b", "c", "+", 1),
        edge("e3", "c", "a", "+", 1),
      ],
      loops: [],
    };
    const { loops } = deriveLoops(g);
    expect(loops.length).toBeLessThanOrEqual(2 ** g.edges.length);
  });
});
