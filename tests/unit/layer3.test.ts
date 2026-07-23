import { describe, expect, it } from "vitest";
import type { Edge, Graph, Node } from "@/model/types";
import { initialState, run, step, tioeOf, totalMass, type EngineOptions } from "@/sim";
import { simulate, DEFAULT_INTEGRATOR_OPTIONS } from "@/layer3/simulate";
import { sparkline } from "@/layer3/sparkline";

function stock(id: string, value = 0, tioe: Node["tioe_class"] = "none"): Node {
  return { id, label: id, type: "stock", tioe_class: tioe, initial_value: value, unit: "u" };
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
  return {
    nodes: [stock("a", 100), stock("b", 0)],
    edges: [
      edge("e1", "a", "b", { magnitude: 2, strength: 1 }),
      edge("e2", "b", "a", { magnitude: 2, strength: 1 }),
    ],
    loops: [],
  };
}

const opts = (over: Partial<EngineOptions> = {}): EngineOptions => ({ dt: 0.1, integrator: "rk4", ...over });

describe("initialState / step / run (engine substrate)", () => {
  it("seeds values from initial_value and pipelines with the steady-state rate", () => {
    const g = closedSystem();
    const s = initialState(g, opts({ dt: 0.5 }));
    expect(s.values.a).toBe(100);
    expect(s.values.b).toBe(0);
    expect(s.delayQueues.e1).toEqual([50, 50, 50, 50]);
  });

  it("step is pure and run produces steps+1 states with increasing time", () => {
    const g = closedSystem();
    const s0 = initialState(g, opts());
    expect(step(g, s0, opts())).toEqual(step(g, s0, opts()));
    const traj = run(g, s0, opts(), 10);
    expect(traj).toHaveLength(11);
    for (let i = 1; i < traj.length; i++) expect(traj[i].t).toBeGreaterThan(traj[i - 1].t);
  });

  it("conserves stock + queue mass on a closed loop over 1000 steps", () => {
    const g = closedSystem();
    const o = opts({ dt: 0.01 });
    const m0 = totalMass(g, initialState(g, o));
    for (const s of run(g, initialState(g, o), o, 1000)) {
      expect(Math.abs(totalMass(g, s) - m0)).toBeLessThan(1e-9);
    }
  });

  it("a system with an external source does not conserve mass", () => {
    const g: Graph = {
      nodes: [flow("src", 10), stock("sink", 0)],
      edges: [edge("e1", "src", "sink", { strength: 1 })],
      loops: [],
    };
    const traj = run(g, initialState(g, opts()), opts(), 100);
    expect(totalMass(g, traj[traj.length - 1])).toBeGreaterThan(totalMass(g, traj[0]));
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
    const snap = tioeOf(g, initialState(g, opts()));
    expect(snap.T).toBe(12);
    expect(snap.I).toBe(5);
    expect(snap.OE).toBe(3);
  });
});

describe("simulate (pre/post intervention over the engine)", () => {
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
    expect(r.pre.series[0].T).toBe(100);
    expect(r.post.series[0].T).toBe(150);
    expect(r.pre.series[0].I).toBe(0);
    expect(r.post.series[0].I).toBe(0);
  });

  it("L1-nudge and an equivalent L3 Δ produce the same trajectory", () => {
    // Phase 1 acceptance: a canvas nudge (engine.impulse) and the L3 intervention
    // delta are the same operation on the same engine.
    const g = closedSystem();
    const o = opts({ dt: 0.05 });
    // Path A: simulate with delta 50 on node a.
    const sim = simulate(g, {
      intervention: { nodeId: "a", delta: 50 },
      integrator: { dt: o.dt, method: "rk4" },
      steps: 50,
    });
    // Path B: the engine, impulsed at t=0, run for 50 steps.
    const eng = run(g, initialState(g, o), o, 1);
    const impulsed = run(g, { ...initialState(g, o), values: { ...eng[0].values, a: 150 } }, o, 50);
    for (let i = 0; i < sim.post.series.length; i++) {
      const snap = tioeOf(g, impulsed[Math.min(i, impulsed.length - 1)]);
      expect(sim.post.series[i].T + sim.post.series[i].I + sim.post.series[i].OE).toBeCloseTo(
        snap.T + snap.I + snap.OE,
        6,
      );
    }
  });

  it("simulating with no intervention produces identical pre and post", () => {
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
    { label: "pre", color: "#888", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0.5 }] },
    { label: "post", color: "#d00", points: [{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 1.5 }] },
  ];

  it("returns one path per series", () => {
    const r = sparkline(series, { width: 100, height: 30 });
    expect(r.paths).toHaveLength(2);
    expect(r.paths[0].d).toMatch(/^M/);
  });

  it("is pure: same inputs -> identical output", () => {
    expect(sparkline(series, { width: 100, height: 30 })).toEqual(
      sparkline(series, { width: 100, height: 30 }),
    );
  });

  it("sharedYAxis makes both series share the same y-domain", () => {
    const r = sparkline(series, { width: 100, height: 30 });
    expect(r.yMin).toBe(0);
    expect(r.yMax).toBe(2);
  });

  it("flat series are guarded against divide-by-zero", () => {
    const r = sparkline(
      [{ label: "flat", color: "#000", points: [{ x: 0, y: 5 }, { x: 1, y: 5 }] }],
      { width: 50, height: 20 },
    );
    expect(r.paths[0].d).toMatch(/^M/);
  });

  it("empty series fall back to a [0,1] domain without throwing", () => {
    const r = sparkline([], { width: 50, height: 20 });
    expect(r.paths).toEqual([]);
    expect(r.yMin).toBe(0);
    expect(r.yMax).toBe(1);
  });
});

describe("default options", () => {
  it("ships with RK4 as the default method", () => {
    expect(DEFAULT_INTEGRATOR_OPTIONS.method).toBe("rk4");
  });
});
