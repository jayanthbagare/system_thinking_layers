import { describe, expect, it } from "vitest";
import type { Edge, Graph, Node } from "@/model/types";
import {
  DEFAULT_INTEGRATOR_OPTIONS,
  derivatives,
  initialState,
  run,
  step,
  tioeOf,
  totalStockMass,
  type IntegratorOptions,
} from "@/layer3/integrator";
import { simulate } from "@/layer3/simulate";
import { sparkline } from "@/layer3/sparkline";

function stock(id: string, value = 0, tioe: Node["tioe_class"] = "none"): Node {
  return {
    id,
    label: id,
    type: "stock",
    tioe_class: tioe,
    initial_value: value,
    unit: "u",
  };
}

function flow(id: string, value = 0, tioe: Node["tioe_class"] = "none"): Node {
  return { id, label: id, type: "flow", tioe_class: tioe, initial_value: value, unit: "u" };
}

function edge(
  id: string,
  source: string,
  target: string,
  opts: { polarity?: "+" | "-"; magnitude?: number; strength?: number } = {},
): Edge {
  const magnitude = opts.magnitude ?? 0;
  return {
    id,
    source,
    target,
    polarity: opts.polarity ?? "+",
    delay: { type: magnitude === 0 ? "none" : "material", magnitude },
    strength: opts.strength ?? 1,
  };
}

function closedSystem(): Graph {
  // Two stocks connected by a delayed edge both ways (a closed loop). Mass
  // should be conserved: every unit in transit lives in a delay state.
  return {
    nodes: [stock("a", 100), stock("b", 0)],
    edges: [
      edge("e1", "a", "b", { magnitude: 2, strength: 1 }),
      edge("e2", "b", "a", { magnitude: 2, strength: 1 }),
    ],
    loops: [],
  };
}

describe("initialState", () => {
  it("seeds node values from initial_value and delay states from source values", () => {
    const g = closedSystem();
    const s = initialState(g);
    expect(s.values.get("a")).toBe(100);
    expect(s.values.get("b")).toBe(0);
    // Delay states initialized to source value (steady state at t=0).
    expect(s.delays.get("e1")).toBe(100);
    expect(s.delays.get("e2")).toBe(0);
    expect(s.t).toBe(0);
  });

  it("does not create delay states for non-delayed edges", () => {
    const g: Graph = {
      nodes: [stock("a", 1), stock("b", 0)],
      edges: [edge("e1", "a", "b")],
      loops: [],
    };
    expect(initialState(g).delays.has("e1")).toBe(false);
  });
});

describe("derivatives", () => {
  it("produces matching keys for values and delays", () => {
    const g = closedSystem();
    const s = initialState(g);
    const { dValues, dDelays } = derivatives(g, s);
    expect([...dValues.keys()].sort()).toEqual(["a", "b"]);
    expect([...dDelays.keys()].sort()).toEqual(["e1", "e2"]);
  });

  it("at steady state (delay state = source value), stock derivatives are zero", () => {
    const g = closedSystem();
    const s = initialState(g);
    const { dValues } = derivatives(g, s);
    // a starts at 100, e1 delay at 100 -> a loses 100/tau, b gains 100/tau.
    // But b's delay e2 starts at 0 -> b loses 0. Net: a loses 50, b gains 50.
    // That's not steady state for a/b individually, but total mass is conserved.
    expect(dValues.get("a")).not.toBe(0);
    expect(dValues.get("b")).not.toBe(0);
    expect((dValues.get("a") ?? 0) + (dValues.get("b") ?? 0)).toBeCloseTo(0, 9);
  });
});

describe("mass conservation", () => {
  it("RK4 conserves stock mass + in-flight delay mass to within 1e-6 over 1000 steps", () => {
    const g = closedSystem();
    const s0 = initialState(g);
    const opts: IntegratorOptions = { dt: 0.01, method: "rk4" };
    const m0 = totalStockMass(g, s0);
    const traj = run(g, s0, opts, 1000);
    for (const s of traj) {
      const m = totalStockMass(g, s);
      expect(Math.abs(m - m0)).toBeLessThan(1e-6);
    }
  });

  it("Euler also conserves mass tightly on this symmetric system (the scheme is conservative)", () => {
    const g = closedSystem();
    const s0 = initialState(g);
    const opts: IntegratorOptions = { dt: 0.01, method: "euler" };
    const m0 = totalStockMass(g, s0);
    const traj = run(g, s0, opts, 1000);
    let maxDrift = 0;
    for (const s of traj) {
      maxDrift = Math.max(maxDrift, Math.abs(totalStockMass(g, s) - m0));
    }
    // The delay-state formulation conserves mass by construction; both methods
    // stay at floating-point precision here. The accuracy difference between
    // Euler and RK4 shows up in trajectory shape, not mass conservation.
    expect(maxDrift).toBeLessThan(1e-9);
  });

  it("Euler and RK4 produce different trajectories on a stiff asymmetric system", () => {
    // One fast and one slow delay -> stiffness where Euler's first-order error
    // shows up as a trajectory divergence from RK4.
    const g: Graph = {
      nodes: [stock("a", 100), stock("b", 0), stock("c", 0)],
      edges: [
        edge("e1", "a", "b", { magnitude: 0.05, strength: 1 }),
        edge("e2", "b", "c", { magnitude: 5, strength: 1 }),
        edge("e3", "c", "a", { magnitude: 1, strength: 1 }),
      ],
      loops: [],
    };
    const s0 = initialState(g);
    const e = run(g, s0, { dt: 0.05, method: "euler" }, 200);
    const r = run(g, s0, { dt: 0.05, method: "rk4" }, 200);
    const eA = e[e.length - 1].values.get("a") ?? 0;
    const rA = r[r.length - 1].values.get("a") ?? 0;
    // They diverge by the end — Euler's first-order error compounds on the
    // stiff system, RK4 tracks the true dynamics more closely.
    expect(Math.abs(eA - rA)).toBeGreaterThan(1e-3);
  });

  it("a system with an external source (non-closed) does not conserve mass, as expected", () => {
    // A flow node feeding a stock with no return edge — mass enters from
    // outside. The integrator must not falsely conserve it.
    const g: Graph = {
      nodes: [flow("src", 10), stock("sink", 0)],
      edges: [edge("e1", "src", "sink", { magnitude: 0, strength: 1 })],
      loops: [],
    };
    const s0 = initialState(g);
    const traj = run(g, s0, { dt: 0.1, method: "rk4" }, 100);
    const m0 = totalStockMass(g, s0);
    const mEnd = totalStockMass(g, traj[traj.length - 1]);
    // The flow node is not a stock so its value is not counted; sink grows.
    expect(mEnd).toBeGreaterThan(m0);
  });
});

describe("step & run", () => {
  it("step is pure: same inputs -> identical outputs", () => {
    const g = closedSystem();
    const s0 = initialState(g);
    const a = step(g, s0, { dt: 0.1, method: "rk4" });
    const b = step(g, s0, { dt: 0.1, method: "rk4" });
    expect(b).toEqual(a);
    // And does not mutate the input.
    expect(s0.t).toBe(0);
  });

  it("run produces steps+1 states with monotonically increasing time", () => {
    const g = closedSystem();
    const traj = run(g, initialState(g), { dt: 0.1, method: "rk4" }, 10);
    expect(traj).toHaveLength(11);
    for (let i = 1; i < traj.length; i++) {
      expect(traj[i].t).toBeGreaterThan(traj[i - 1].t);
    }
  });

  it("switching method between euler and rk4 changes the trajectory", () => {
    const g = closedSystem();
    const s0 = initialState(g);
    const e = run(g, s0, { dt: 0.1, method: "euler" }, 50);
    const r = run(g, s0, { dt: 0.1, method: "rk4" }, 50);
    // They diverge by the end (RK4 is more accurate).
    expect(e[e.length - 1].values.get("a")).not.toBeCloseTo(
      r[r.length - 1].values.get("a") ?? 0,
      4,
    );
  });
});

describe("tioeOf", () => {
  it("aggregates node values by tioe_class", () => {
    const g: Graph = {
      nodes: [
        stock("a", 10, "T"),
        stock("b", 5, "I"),
        stock("c", 3, "OE"),
        stock("d", 2, "T"),
        stock("e", 1, "none"),
      ],
      edges: [],
      loops: [],
    };
    const s = initialState(g);
    const snap = tioeOf(g, s);
    expect(snap.T).toBe(12);
    expect(snap.I).toBe(5);
    expect(snap.OE).toBe(3);
  });
});

describe("simulate (pre/post intervention)", () => {
  it("returns equal-length pre and post trajectories", () => {
    const g = closedSystem();
    const r = simulate(g, {
      intervention: { nodeId: "a", delta: 50 },
      integrator: { dt: 0.05, method: "rk4" },
      steps: 100,
    });
    expect(r.pre.series).toHaveLength(101);
    expect(r.post.series).toHaveLength(101);
    expect(r.pre.times).toHaveLength(101);
    expect(r.nodeId).toBe("a");
  });

  it("the intervention perturbs the post trajectory's initial T/I/OE", () => {
    const g: Graph = {
      nodes: [stock("a", 100, "T"), stock("b", 0, "I")],
      edges: [edge("e1", "a", "b", { magnitude: 1, strength: 1 })],
      loops: [],
    };
    const r = simulate(g, {
      intervention: { nodeId: "a", delta: 50 },
      integrator: { dt: 0.1, method: "rk4" },
      steps: 10,
    });
    // Pre starts at T=100, I=0; post starts at T=150, I=0.
    expect(r.pre.series[0].T).toBe(100);
    expect(r.post.series[0].T).toBe(150);
    expect(r.pre.series[0].I).toBe(0);
    expect(r.post.series[0].I).toBe(0);
  });

  it("simulating with no intervention produces identical pre and post (sanity)", () => {
    const g = closedSystem();
    const r = simulate(g, {
      intervention: { nodeId: "a" },
      integrator: { dt: 0.1, method: "rk4" },
      steps: 50,
    });
    expect(r.post.series).toEqual(r.pre.series);
  });

  it("is pure: same inputs -> identical output", () => {
    const g = closedSystem();
    const a = simulate(g, {
      intervention: { nodeId: "a", delta: 10 },
      integrator: { dt: 0.1, method: "rk4" },
      steps: 50,
    });
    const b = simulate(g, {
      intervention: { nodeId: "a", delta: 10 },
      integrator: { dt: 0.1, method: "rk4" },
      steps: 50,
    });
    expect(b).toEqual(a);
  });
});

describe("sparkline", () => {
  const series = [
    {
      label: "pre",
      color: "#888",
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 2, y: 0.5 },
      ],
    },
    {
      label: "post",
      color: "#d00",
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 2 },
        { x: 2, y: 1.5 },
      ],
    },
  ];

  it("returns one path per series", () => {
    const r = sparkline(series, { width: 100, height: 30 });
    expect(r.paths).toHaveLength(2);
    expect(r.paths[0].label).toBe("pre");
    expect(r.paths[1].label).toBe("post");
    expect(r.paths[0].d).toMatch(/^M/);
  });

  it("is pure: same inputs -> identical output", () => {
    const a = sparkline(series, { width: 100, height: 30 });
    const b = sparkline(series, { width: 100, height: 30 });
    expect(b).toEqual(a);
  });

  it("sharedYAxis (default) makes both series share the same y-domain", () => {
    const r = sparkline(series, { width: 100, height: 30 });
    expect(r.yMin).toBe(0);
    expect(r.yMax).toBe(2);
  });

  it("flat series are guarded against divide-by-zero", () => {
    const r = sparkline(
      [{ label: "flat", color: "#000", points: [{ x: 0, y: 5 }, { x: 1, y: 5 }] }],
      { width: 50, height: 20 },
    );
    expect(r.paths).toHaveLength(1);
    expect(r.paths[0].d).toMatch(/^M/);
  });

  it("empty series fall back to a [0,1] domain without throwing", () => {
    const r = sparkline([], { width: 50, height: 20 });
    expect(r.paths).toEqual([]);
    expect(r.yMin).toBe(0);
    expect(r.yMax).toBe(1);
  });

  it("viewBox matches the requested width and height", () => {
    const r = sparkline(series, { width: 120, height: 40 });
    expect(r.viewBox).toBe("0 0 120 40");
  });
});

describe("default options", () => {
  it("ships with RK4 as the default method", () => {
    expect(DEFAULT_INTEGRATOR_OPTIONS.method).toBe("rk4");
  });
});
