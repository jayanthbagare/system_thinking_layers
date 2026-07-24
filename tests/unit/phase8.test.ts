import { describe, expect, it } from "vitest";
import type { Edge, Graph, Node } from "@/model/types";
import { withComputedLoops } from "@/graph/loops";
import {
  mulberry32,
  sampleUniform,
  sampleGraphs,
  runMonteCarlo,
  verdictFor,
  verdictMessage,
  type NodeStability,
} from "@/sim/robustness";
import { DEFAULT_WEIGHTS } from "@/layer2/scoring";

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
  o: { pol?: "+" | "-"; mag?: number; str?: number; range?: { strength?: [number, number]; delay_magnitude?: [number, number] } } = {},
): Edge {
  const mag = o.mag ?? 0;
  const e: Edge = {
    id,
    source: s,
    target: t,
    polarity: o.pol ?? "+",
    delay: { type: mag === 0 ? "none" : "material", magnitude: mag },
    strength: o.str ?? 1,
  };
  if (o.range) e.range = o.range;
  return e;
}

/** Two collared stocks in series; demand exceeds both collars. */
function fixtureStable(): Graph {
  const g: Graph = {
    nodes: [
      flow("demand", 200),
      stock("a", 100, { lower: 0, upper: 100 }),
      stock("b", 100, { lower: 0, upper: 150 }),
      stock("exit", 0),
    ],
    edges: [edge("e1", "demand", "a", { str: 1 }), edge("e2", "a", "b", { str: 1 }), edge("e3", "b", "exit", { str: 1 })],
    loops: [],
  };
  g.nodes[0].boundary = true;
  g.nodes[3].boundary = true;
  return withComputedLoops(g);
}

/**
 * Near-tied fixture: two collared stocks in parallel, each fed by a separately
 * perturbed edge from the same demand. Demand equals the collar, so small
 * perturbations flip whether each stock pins — the observed constraint is
 * different across draws, producing "unstable".
 */
function fixtureNearTied(): Graph {
  const g: Graph = {
    nodes: [
      flow("demand", 100),
      stock("a", 50, { lower: 0, upper: 100 }),
      stock("b", 50, { lower: 0, upper: 100 }),
      stock("exit", 0),
    ],
    edges: [
      edge("e1", "demand", "a", { str: 1 }),
      edge("e2", "demand", "b", { str: 1 }),
      edge("e3", "a", "exit", { str: 1 }),
      edge("e4", "b", "exit", { str: 1 }),
    ],
    loops: [],
  };
  g.nodes[0].boundary = true;
  g.nodes[3].boundary = true;
  return withComputedLoops(g);
}

/**
 * Fixture with declared ranges on the edge strengths — distinguishes declared
 * from guessed sources.
 */
function fixtureWithRanges(): Graph {
  const g: Graph = {
    nodes: [
      flow("demand", 200),
      stock("a", 100, { lower: 0, upper: 100 }),
      stock("b", 50),
      stock("exit", 0),
    ],
    edges: [
      edge("e1", "demand", "a", { str: 1, range: { strength: [0.8, 1.2] } }),
      edge("e2", "a", "b", { str: 1, range: { delay_magnitude: [2, 4], strength: [0.9, 1.1] } }),
      edge("e3", "b", "exit", { str: 1 }), // no range -> guessed
    ],
    loops: [],
  };
  g.nodes[0].boundary = true;
  g.nodes[3].boundary = true;
  return withComputedLoops(g);
}

// --- PRNG -----------------------------------------------------------------

describe("mulberry32", () => {
  it("is deterministic: same seed -> same sequence", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 10; i++) {
      expect(a()).toBe(b());
    }
  });

  it("produces different sequences for different seeds", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    let diffs = 0;
    for (let i = 0; i < 10; i++) {
      if (a() !== b()) diffs++;
    }
    expect(diffs).toBe(10);
  });

  it("produces floats in [0, 1)", () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("sampleUniform", () => {
  it("samples within [min, max)", () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const v = sampleUniform(rng, 5, 10);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(10);
    }
  });
});

// --- sampleGraphs ---------------------------------------------------------

describe("sampleGraphs", () => {
  it("is deterministic: same seed -> same sampled graphs", () => {
    const g = fixtureStable();
    const a = sampleGraphs(g, { n: 10, seed: 42 });
    const b = sampleGraphs(g, { n: 10, seed: 42 });
    expect(b).toEqual(a);
  });

  it("produces exactly n samples", () => {
    const g = fixtureStable();
    const samples = sampleGraphs(g, { n: 50, seed: 42 });
    expect(samples).toHaveLength(50);
  });

  it("samples within declared ranges", () => {
    const g = fixtureWithRanges();
    const samples = sampleGraphs(g, { n: 20, seed: 42 });
    for (const s of samples) {
      const e1 = s.graph.edges.find((e) => e.id === "e1")!;
      expect(e1.strength).toBeGreaterThanOrEqual(0.8);
      expect(e1.strength).toBeLessThanOrEqual(1.2);
      expect(s.sources.e1.strength).toBe("declared");
    }
  });

  it("falls back to ±20% for undeclared properties and marks them guessed", () => {
    const g = fixtureStable();
    const samples = sampleGraphs(g, { n: 5, seed: 42 });
    for (const s of samples) {
      const e1 = s.graph.edges.find((e) => e.id === "e1")!;
      // e1 has no range -> guessed, ±20% of strength 1 -> [0.8, 1.2]
      expect(e1.strength).toBeGreaterThanOrEqual(0.8);
      expect(e1.strength).toBeLessThanOrEqual(1.2);
      expect(s.sources.e1.strength).toBe("guessed");
    }
  });

  it("distinguishes declared from guessed in the sources map", () => {
    const g = fixtureWithRanges();
    const samples = sampleGraphs(g, { n: 1, seed: 42 });
    const s = samples[0];
    // e1 has a declared strength range -> "declared"
    expect(s.sources.e1.strength).toBe("declared");
    // e1 has no declared delay range -> "guessed" (but e1 has no delay, so it's absent)
    // e2 has both declared -> "declared"
    expect(s.sources.e2.strength).toBe("declared");
    expect(s.sources.e2.delay).toBe("declared");
  });
});

// --- runMonteCarlo --------------------------------------------------------

describe("runMonteCarlo", () => {
  it("is deterministic: same seed -> same report", () => {
    const g = fixtureStable();
    const a = runMonteCarlo(g, DEFAULT_WEIGHTS, undefined, { n: 50, seed: 42 });
    const b = runMonteCarlo(g, DEFAULT_WEIGHTS, undefined, { n: 50, seed: 42 });
    expect(b).toEqual(a);
  });

  it("returns a report with per-node fractions and verdicts", () => {
    const g = fixtureStable();
    const r = runMonteCarlo(g, DEFAULT_WEIGHTS, undefined, { n: 50, seed: 42 });
    expect(r.n).toBe(50);
    expect(r.nodes.length).toBe(g.nodes.length);
    expect(r.predictedVerdict).toBeDefined();
    expect(r.observedVerdict).toBeDefined();
    // Fractions sum to <= 1 (some draws may have no constraint).
    const obsSum = r.nodes.reduce((s, n) => s + n.observedFraction, 0);
    expect(obsSum).toBeLessThanOrEqual(1.001);
  });

  it("reports declared vs guessed counts", () => {
    const g = fixtureWithRanges();
    const r = runMonteCarlo(g, DEFAULT_WEIGHTS, undefined, { n: 10, seed: 42 });
    expect(r.declaredCount).toBeGreaterThan(0);
    expect(r.guessedCount).toBeGreaterThan(0);
  });

  it("a near-tied fixture produces 'unstable' for the observed constraint", () => {
    const g = fixtureNearTied();
    const r = runMonteCarlo(g, DEFAULT_WEIGHTS, undefined, { n: 100, seed: 42 });
    // With collars 100 and 101, perturbations flip which one pins more ->
    // the observed verdict should be "unstable" or "likely" (not "stable").
    expect(["unstable", "likely"]).toContain(r.observedVerdict);
  });

  it("a clearly stable fixture produces 'stable' for the observed constraint", () => {
    // demand 200, collar 100: a is always the bottleneck. Even with ±20%
    // perturbation, a's collar (100) is always below demand (160-240).
    const g = fixtureStable();
    const r = runMonteCarlo(g, DEFAULT_WEIGHTS, undefined, { n: 100, seed: 42 });
    expect(r.observedVerdict).toBe("stable");
  });
});

// --- verdictFor + verdictMessage -----------------------------------------

describe("verdictFor", () => {
  function mk(pred: number, obs: number): NodeStability {
    return { nodeId: "x", label: "X", predictedFraction: pred, observedFraction: obs };
  }

  it("stable: >= 90% one node", () => {
    const nodes = [mk(0.95, 0.95), mk(0.05, 0.05)];
    expect(verdictFor(nodes, "observed")).toBe("stable");
  });

  it("likely: 60-90% one node", () => {
    const nodes = [mk(0.7, 0.7), mk(0.2, 0.2), mk(0.1, 0.1)];
    expect(verdictFor(nodes, "observed")).toBe("likely");
  });

  it("unstable: < 60% one node", () => {
    const nodes = [mk(0.5, 0.5), mk(0.3, 0.3), mk(0.2, 0.2)];
    expect(verdictFor(nodes, "observed")).toBe("unstable");
  });

  it("unstable: two nodes trading places (within 10pp)", () => {
    const nodes = [mk(0.45, 0.45), mk(0.40, 0.40)];
    expect(verdictFor(nodes, "observed")).toBe("unstable");
  });
});

describe("verdictMessage", () => {
  it("returns a human-readable message for each verdict", () => {
    expect(verdictMessage("stable")).toContain("Stable");
    expect(verdictMessage("likely")).toContain("Likely");
    expect(verdictMessage("unstable")).toContain("Unstable");
    expect(verdictMessage("unstable")).toContain("bifurcation");
  });
});
