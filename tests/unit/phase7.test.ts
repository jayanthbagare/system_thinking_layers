import { describe, expect, it } from "vitest";
import type { Edge, Graph, Node } from "@/model/types";
import {
  initialState,
  step,
  softInflowFactor,
  littleLaw,
  utilisationW,
  utilisationCurve,
  type EngineOptions,
} from "@/sim/engine";

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

const opts = (over: Partial<EngineOptions> = {}): EngineOptions => ({
  dt: 0.1,
  integrator: "rk4",
  ...over,
});

// --- softInflowFactor -----------------------------------------------------

describe("softInflowFactor", () => {
  it("returns 1 for hard collars (no scaling)", () => {
    const n = stock("a", 50, { lower: 0, upper: 100, approach: "hard" });
    expect(softInflowFactor(n, 50)).toBe(1);
    expect(softInflowFactor(n, 99)).toBe(1);
  });

  it("returns 1 below the soft zone (bottom 90%)", () => {
    const n = stock("a", 50, { lower: 0, upper: 100, approach: "soft" });
    // Soft zone starts at 90 (upper - 10% of span). Below 90 -> factor 1.
    expect(softInflowFactor(n, 50)).toBeCloseTo(1, 6);
    expect(softInflowFactor(n, 89)).toBeCloseTo(1, 6);
  });

  it("ramps smoothly to 0 at the upper boundary", () => {
    const n = stock("a", 50, { lower: 0, upper: 100, approach: "soft" });
    // At 90: factor = 1 (start of the ramp)
    expect(softInflowFactor(n, 90)).toBeCloseTo(1, 6);
    // At 100: factor = 0 (the ceiling)
    expect(softInflowFactor(n, 100)).toBeCloseTo(0, 6);
    // At 95 (midway): factor = 0.5 (half-cosine midpoint)
    expect(softInflowFactor(n, 95)).toBeCloseTo(0.5, 1);
  });

  it("is continuously differentiable at the zone boundary", () => {
    const n = stock("a", 50, { lower: 0, upper: 100, approach: "soft" });
    // Just below and just above the soft start: the factor transitions
    // smoothly (no discontinuity). The half-cosine has derivative 0 at both
    // endpoints, matching the flat factor=1 below the zone.
    const below = softInflowFactor(n, 89.99);
    const at = softInflowFactor(n, 90);
    const above = softInflowFactor(n, 90.01);
    expect(Math.abs(below - at)).toBeLessThan(1e-3);
    expect(Math.abs(at - above)).toBeLessThan(1e-3);
  });

  it("returns 1 for unbounded nodes", () => {
    const n = stock("a", 50);
    expect(softInflowFactor(n, 50)).toBe(1);
  });
});

// --- soft approach in the engine -----------------------------------------

describe("soft collar approach in the engine", () => {
  it("soft: approaches the ceiling asymptotically (no hard kink)", () => {
    // src(100) -> sink(0, upper=50, soft). Under hard, sink hits 50 and pins.
    // Under soft, sink approaches 50 but the rate of approach slows near the
    // ceiling — the transfer is ramped to zero. The stock still reaches the
    // collar eventually (the ceiling is still the ceiling), but smoothly.
    const g: Graph = {
      nodes: [flow("src", 100), stock("sink", 0, { lower: 0, upper: 50, approach: "soft" })],
      edges: [edge("e1", "src", "sink", { str: 1 })],
      loops: [],
    };
    const o = opts({ dt: 0.01 });
    let s = initialState(g, o);
    for (let i = 0; i < 5000; i++) s = step(g, s, o);
    // The stock is close to the ceiling (within a few units) but may not pin
    // exactly at 50 because soft scaling reduces the inflow near the boundary.
    expect(s.values.sink).toBeGreaterThan(40);
    expect(s.values.sink).toBeLessThanOrEqual(50);
  });

  it("hard: clips exactly at the boundary (the kink)", () => {
    const g: Graph = {
      nodes: [flow("src", 100), stock("sink", 0, { lower: 0, upper: 50, approach: "hard" })],
      edges: [edge("e1", "src", "sink", { str: 1 })],
      loops: [],
    };
    const o = opts({ dt: 0.01 });
    let s = initialState(g, o);
    for (let i = 0; i < 500; i++) s = step(g, s, o);
    expect(s.values.sink).toBe(50);
    expect(s.pinned.sink).toBe("upper");
  });
});

// --- Little's Law ---------------------------------------------------------

describe("littleLaw", () => {
  it("computes L, lambda, W, rho for internal stocks", () => {
    // demand(100, boundary) -> backlog(50, stock, collar upper 100) -> exit(0, boundary)
    const g: Graph = {
      nodes: [flow("demand", 100), stock("backlog", 50, { lower: 0, upper: 100 }), stock("exit", 0)],
      edges: [edge("e1", "demand", "backlog", { str: 1 }), edge("e2", "backlog", "exit", { str: 1 })],
      loops: [],
    };
    g.nodes[0].boundary = true;
    g.nodes[2].boundary = true;
    const s = initialState(g, opts());
    const entries = littleLaw(g, s);
    expect(entries).toHaveLength(1); // only "backlog" is an internal stock
    const e = entries[0];
    expect(e.nodeId).toBe("backlog");
    // L = stock value (50) + queue mass (e1 is non-delayed -> no queue -> 0) = 50
    expect(e.L).toBeCloseTo(50, 6);
    // lambda = outgoing rate = |edgeRate(e2)| = 1 * backlog_value = 50
    expect(e.lambda).toBeCloseTo(50, 6);
    // W = L / lambda = 50 / 50 = 1
    expect(e.W).toBeCloseTo(1, 6);
    // rho = current / upper = 50 / 100 = 0.5
    expect(e.rho).toBeCloseTo(0.5, 6);
  });

  it("includes queue contents in L", () => {
    // demand(100, boundary) -> [delay 1] -> backlog(0, stock, collar upper 200)
    // Queue has slots * rate*dt of material. dt=0.25, delay=1 -> 4 slots, each
    // 100*0.25 = 25. Queue mass = 100.
    const g: Graph = {
      nodes: [flow("demand", 100), stock("backlog", 0, { lower: 0, upper: 200 })],
      edges: [edge("e1", "demand", "backlog", { mag: 1, str: 1 })],
      loops: [],
    };
    g.nodes[0].boundary = true;
    const o = opts({ dt: 0.25 });
    const s = initialState(g, o);
    const entries = littleLaw(g, s);
    const e = entries[0];
    // L = stock (0) + queue mass (4 * 25 = 100) = 100
    expect(e.L).toBeCloseTo(100, 6);
  });

  it("returns null W when lambda is zero (no outflow)", () => {
    const g: Graph = {
      nodes: [flow("demand", 100), stock("backlog", 50, { lower: 0, upper: 100 })],
      edges: [edge("e1", "demand", "backlog")],
      loops: [],
    };
    g.nodes[0].boundary = true;
    const entries = littleLaw(g, initialState(g, opts()));
    expect(entries[0].W).toBeNull();
  });

  it("returns null rho for unbounded stocks", () => {
    const g: Graph = {
      nodes: [flow("demand", 100), stock("backlog", 50), stock("exit", 0)],
      edges: [edge("e1", "demand", "backlog"), edge("e2", "backlog", "exit")],
      loops: [],
    };
    g.nodes[0].boundary = true;
    g.nodes[2].boundary = true;
    const entries = littleLaw(g, initialState(g, opts()));
    expect(entries[0].rho).toBeNull();
  });

  it("skips boundary stocks", () => {
    const g: Graph = {
      nodes: [flow("demand", 100), stock("exit", 0)],
      edges: [edge("e1", "demand", "exit")],
      loops: [],
    };
    g.nodes[0].boundary = true;
    g.nodes[1].boundary = true;
    const entries = littleLaw(g, initialState(g, opts()));
    expect(entries).toHaveLength(0);
  });
});

// --- Utilisation curve ----------------------------------------------------

describe("utilisationW", () => {
  it("returns rho/(1-rho) for rho in [0,1)", () => {
    expect(utilisationW(0)).toBeCloseTo(0, 6);
    expect(utilisationW(0.5)).toBeCloseTo(1, 6);
    expect(utilisationW(0.8)).toBeCloseTo(4, 6);
    expect(utilisationW(0.9)).toBeCloseTo(9, 6);
    expect(utilisationW(0.95)).toBeCloseTo(19, 6);
  });

  it("returns null for rho >= 1 (beyond the knee)", () => {
    expect(utilisationW(1)).toBeNull();
    expect(utilisationW(1.5)).toBeNull();
  });

  it("returns null for negative rho", () => {
    expect(utilisationW(-0.1)).toBeNull();
  });

  it("produces a disproportionately larger W at higher rho (the knee)", () => {
    // rho 0.2 -> 0.4: W goes from 0.25 to 0.667 (2.67x)
    const wLow = utilisationW(0.2)!;
    const wMid = utilisationW(0.4)!;
    // rho 0.4 -> 0.8: W goes from 0.667 to 4 (6x)
    const wHigh = utilisationW(0.8)!;
    const midToHighRatio = wHigh / wMid;
    const lowToMidRatio = wMid / wLow;
    // The jump from 0.4->0.8 is much larger than 0.2->0.4
    expect(midToHighRatio).toBeGreaterThan(lowToMidRatio * 2);
  });
});

describe("utilisationCurve", () => {
  it("returns n points (rho never reaches 1)", () => {
    const curve = utilisationCurve(50);
    expect(curve.length).toBe(50); // 0, 1/50, ..., 49/50=0.98 — all < 1
    for (const p of curve) {
      expect(p.rho).toBeGreaterThanOrEqual(0);
      expect(p.rho).toBeLessThan(1);
    }
  });
});
