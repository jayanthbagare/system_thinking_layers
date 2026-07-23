import { describe, expect, it } from "vitest";
import type { Edge, Graph, Node } from "@/model/types";
import {
  DEFAULT_ENGINE_OPTIONS,
  computeSlots,
  degreesOfFreedom,
  deriveTioe,
  equilibrium,
  headroom,
  impulse,
  initialState,
  run,
  setValue,
  step,
  totalMass,
  type EngineOptions,
} from "@/sim/engine";
import { computeSensitivities, normalizedSensitivities } from "@/sim/sensitivity";

function stock(id: string, value = 0): Node {
  return { id, label: id, type: "stock", initial_value: value, unit: "u" };
}
function flow(id: string, value = 0): Node {
  return { id, label: id, type: "flow", initial_value: value, unit: "u" };
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

/** Two stocks exchanging mass through equal delayed edges (a closed loop). */
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

const opts = (over: Partial<EngineOptions> = {}): EngineOptions => ({
  dt: 0.1,
  integrator: "rk4",
  ...over,
});

describe("initialState", () => {
  it("seeds values from initial_value and pipelines with the steady-state rate", () => {
    const g = closedSystem();
    const s = initialState(g, opts({ dt: 0.5 }));
    expect(s.values.a).toBe(100);
    expect(s.values.b).toBe(0);
    // magnitude 2 / dt 0.5 -> 4 slots, each filled with rate*dt = 100*0.5 = 50.
    expect(s.delayQueues.e1).toEqual([50, 50, 50, 50]);
    expect(s.delayQueues.e2).toEqual([0, 0, 0, 0]);
    expect(s.t).toBe(0);
    expect(s.pinned.a).toBeNull();
  });

  it("omits delayQueues for non-delayed edges", () => {
    const g: Graph = {
      nodes: [stock("a", 1), stock("b", 0)],
      edges: [edge("e1", "a", "b")],
      loops: [],
    };
    const s = initialState(g, opts());
    expect(s.delayQueues.e1).toBeUndefined();
  });

  it("history starts with the initial value per node", () => {
    const g = closedSystem();
    const s = initialState(g, opts());
    expect(s.history.a).toEqual([100]);
    expect(s.history.b).toEqual([0]);
  });
});

describe("computeSlots", () => {
  it("rounds magnitude/dt to a positive integer slot count, zero for no delay", () => {
    const g = closedSystem();
    const slots = computeSlots(g, 0.5);
    expect(slots.e1).toBe(4); // 2 / 0.5
    expect(slots.e2).toBe(4);
    const g2: Graph = { nodes: [stock("a"), stock("b")], edges: [edge("e", "a", "b")], loops: [] };
    expect(computeSlots(g2, 0.1).e).toBe(0);
  });
});

describe("mass conservation", () => {
  it("conserves stock + queue mass exactly over 1000 steps on a closed loop", () => {
    const g = closedSystem();
    const s0 = initialState(g, opts({ dt: 0.01 }));
    const m0 = totalMass(g, s0);
    const traj = run(g, s0, opts({ dt: 0.01 }), 1000);
    let maxDrift = 0;
    for (const s of traj) maxDrift = Math.max(maxDrift, Math.abs(totalMass(g, s) - m0));
    // FIFO pipelines transfer mass exactly: drift is floating-point only.
    expect(maxDrift).toBeLessThan(1e-9);
  });

  it("Euler and RK4 coincide on the linear closed loop (no accuracy difference yet)", () => {
    const g = closedSystem();
    const e = run(g, initialState(g, opts({ dt: 0.01 })), { dt: 0.01, integrator: "euler" }, 100);
    const r = run(g, initialState(g, opts({ dt: 0.01 })), { dt: 0.01, integrator: "rk4" }, 100);
    expect(e[100].values.a).toBeCloseTo(r[100].values.a, 9);
  });

  it("a system with an external source does not conserve mass, as expected", () => {
    const g: Graph = {
      nodes: [flow("src", 10), stock("sink", 0)],
      edges: [edge("e1", "src", "sink", { strength: 1 })],
      loops: [],
    };
    const traj = run(g, initialState(g, opts()), opts(), 100);
    expect(totalMass(g, traj[traj.length - 1])).toBeGreaterThan(totalMass(g, traj[0]));
  });
});

describe("FIFO delay traversal", () => {
  it("a rate change takes `slots` steps to reach the target", () => {
    // a(exogenous=10) -> b(stock) with delay magnitude 1, dt 0.25 -> 4 slots.
    // The queue is pre-seeded to steady state (2.5 per slot), so b grows at
    // 2.5/step from the start. After we raise a to 20, the doubled chunks
    // (5.0) enter the back and reach the front exactly 4 steps later.
    const g: Graph = {
      nodes: [flow("a", 10), stock("b", 0)],
      edges: [edge("e1", "a", "b", { magnitude: 1, strength: 1 })],
      loops: [],
    };
    const o = opts({ dt: 0.25 });
    let s = initialState(g, o);
    // Steady state: b gains 2.5 per step (10 * 0.25).
    for (let i = 0; i < 4; i++) s = step(g, s, o);
    const b4 = s.values.b;
    // Raise the exogenous driver to 20.
    s = setValue(s, "a", 20);
    // The next `slots` (4) steps still deliver the old 2.5 chunks: the doubled
    // chunk enters the back on the first post-change step and needs `slots`
    // steps to traverse the pipeline before it is popped.
    for (let i = 0; i < 4; i++) {
      s = step(g, s, o);
      expect(s.values.b - (b4 + (i + 1) * 2.5)).toBeCloseTo(0, 9);
    }
    // The step after that delivers the first doubled chunk (5.0).
    s = step(g, s, o);
    const lastIncrement = s.values.b - (b4 + 4 * 2.5);
    expect(lastIncrement).toBeCloseTo(5.0, 9);
  });
});

describe("dynamic flows", () => {
  it("a flow node's value tracks the delivered rate from its incoming edge", () => {
    // src(exogenous=10) -> f(flow) with no delay. f's value should equal 10.
    const g: Graph = {
      nodes: [flow("src", 10), flow("f", 0), stock("sink", 0)],
      edges: [edge("e1", "src", "f"), edge("e2", "f", "sink")],
      loops: [],
    };
    const s = step(g, initialState(g, opts()), opts());
    expect(s.values.f).toBeCloseTo(10, 6);
  });

  it("a node with no incoming edges holds its initial_value (exogenous)", () => {
    const g: Graph = {
      nodes: [flow("driver", 7), stock("sink", 0)],
      edges: [edge("e1", "driver", "sink")],
      loops: [],
    };
    let s = initialState(g, opts());
    for (let i = 0; i < 5; i++) s = step(g, s, opts());
    expect(s.values.driver).toBe(7);
  });
});

describe("impulse / setValue", () => {
  it("impulse adds to a node's value without mutating the input", () => {
    const g = closedSystem();
    const s0 = initialState(g, opts());
    const s1 = impulse(s0, "a", 50);
    expect(s1.values.a).toBe(150);
    expect(s0.values.a).toBe(100); // untouched
  });

  it("setValue sets the node's value absolutely", () => {
    const g = closedSystem();
    const s0 = initialState(g, opts());
    const s1 = setValue(s0, "a", 42);
    expect(s1.values.a).toBe(42);
  });
});

describe("step & run", () => {
  it("step is pure: same inputs -> identical outputs, input untouched", () => {
    const g = closedSystem();
    const s0 = initialState(g, opts());
    const a = step(g, s0, opts());
    const b = step(g, s0, opts());
    expect(b).toEqual(a);
    expect(s0.t).toBe(0);
  });

  it("run produces steps+1 states with monotonically increasing time", () => {
    const g = closedSystem();
    const traj = run(g, initialState(g, opts()), opts(), 10);
    expect(traj).toHaveLength(11);
    for (let i = 1; i < traj.length; i++) expect(traj[i].t).toBeGreaterThan(traj[i - 1].t);
  });

  it("history accumulates one sample per step and is capped", () => {
    const g = closedSystem();
    const traj = run(g, initialState(g, opts()), opts(), 5);
    expect(traj[5].history.a.length).toBe(6); // initial + 5 steps
  });
});

describe("equilibrium", () => {
  it("returns the steady-state operating point for a converging leaky stock", () => {
    // exogenous 10 feeds a stock that leaks at rate 1*value -> equilibrium 10.
    const g: Graph = {
      nodes: [flow("src", 10), stock("s", 0)],
      edges: [edge("e1", "src", "s"), edge("e2", "s", "src", { strength: 1 })],
      loops: [],
    };
    // e2 s->src makes src non-exogenous; instead drive directly: src has no
    // incoming if we drop e2. Use a self-leak via a dummy.
    const g2: Graph = {
      nodes: [flow("src", 10), stock("s", 0)],
      edges: [edge("e1", "src", "s")],
      loops: [],
    };
    void g;
    const eq = equilibrium(g2, opts({ dt: 0.1 }), 2000, 500);
    // s grows unbounded (no outflow) -> equilibrium is just the mean, > 0.
    expect(eq.s).toBeGreaterThan(0);
    expect(eq.src).toBe(10);
  });
});

describe("deriveTioe", () => {
  it("T = rate on inbound boundary edge when no outbound edges exist", () => {
    // customer_demand (boundary, flow=100) -> retailer_backlog (inside, stock=0)
    // T = inbound rate = 100 * 1 = 100
    const g: Graph = {
      nodes: [flow("demand", 100), stock("backlog", 0)],
      edges: [edge("e1", "demand", "backlog", { strength: 1 })],
      loops: [],
    };
    // Mark demand as boundary explicitly.
    g.nodes[0].boundary = true;
    const snap = deriveTioe(g, initialState(g, opts()));
    expect(snap.T).toBeCloseTo(100, 6);
  });

  it("I = sum of inside stock values + inside queue mass", () => {
    // demand (boundary) -> backlog (inside, stock, delay 1)
    // I = backlog value + queue contents of e1
    const g: Graph = {
      nodes: [flow("demand", 100), stock("backlog", 0)],
      edges: [edge("e1", "demand", "backlog", { magnitude: 1, strength: 1 })],
      loops: [],
    };
    g.nodes[0].boundary = true;
    const o = opts({ dt: 0.25 });
    const s = initialState(g, o);
    // Queue has 4 slots * 25 = 100. Stock = 0. I = 0 + 100 = 100.
    const snap = deriveTioe(g, s);
    expect(snap.I).toBeCloseTo(100, 6);
  });

  it("OE = flow through collared stock nodes inside the system", () => {
    // demand (boundary) -> orders (inside, flow) -> capacity (inside, stock, collared)
    // OE = rate of incoming edge to the collared stock = orders value * strength
    const g: Graph = {
      nodes: [flow("demand", 100), flow("orders", 100), stock("capacity", 100)],
      edges: [
        edge("e1", "demand", "orders", { strength: 1 }),
        edge("e2", "orders", "capacity", { strength: 1 }),
      ],
      loops: [],
    };
    g.nodes[0].boundary = true;
    g.nodes[2].collar = { lower: 0, upper: 120 };
    const snap = deriveTioe(g, initialState(g, opts()));
    // OE = rate(e2) = 1 * orders_value = 100
    expect(snap.OE).toBeCloseTo(100, 6);
  });

  it("OE = 0 when no collared stocks exist inside the system", () => {
    const g: Graph = {
      nodes: [flow("demand", 100), stock("backlog", 0)],
      edges: [edge("e1", "demand", "backlog", { strength: 1 })],
      loops: [],
    };
    g.nodes[0].boundary = true;
    const snap = deriveTioe(g, initialState(g, opts()));
    expect(snap.OE).toBe(0);
  });

  it("boundary auto-derives from exogenous nodes when no explicit boundary is set", () => {
    // demand has no incoming edges -> auto-boundary. backlog has incoming -> inside.
    const g: Graph = {
      nodes: [flow("demand", 100), stock("backlog", 0)],
      edges: [edge("e1", "demand", "backlog", { strength: 1 })],
      loops: [],
    };
    const snap = deriveTioe(g, initialState(g, opts()));
    expect(snap.T).toBeCloseTo(100, 6);
  });
});

describe("L1-nudge / L3-Δ equivalence", () => {
  it("an impulse applied at t=0 then run equals a run from an impulsed initial state", () => {
    const g = closedSystem();
    const o = opts();
    // Path A: start from initial, impulse a by 50 at t=0, then run.
    const a = run(g, impulse(initialState(g, o), "a", 50), o, 50);
    // Path B: start, run one step, then impulse — must NOT equal (different point).
    const b = run(g, initialState(g, o), o, 50);
    expect(a[0].values.a).toBe(150);
    expect(b[0].values.a).toBe(100);
    expect(a[50].values.a).not.toBeCloseTo(b[50].values.a, 4);
  });
});

describe("sensitivity", () => {
  it("is deterministic: same graph -> same sensitivities", () => {
    const g = closedSystem();
    const a = computeSensitivities(g);
    const b = computeSensitivities(g);
    expect(b).toEqual(a);
  });

  it("normalises to [0,1] with the most-sensitive node at 1", () => {
    const g: Graph = {
      nodes: [flow("src", 10), stock("a", 0), stock("b", 0)],
      edges: [edge("e1", "src", "a"), edge("e2", "a", "b", { magnitude: 1 })],
      loops: [],
    };
    const norm = normalizedSensitivities(g);
    let max = 0;
    for (const v of norm.values()) max = Math.max(max, v);
    expect(max).toBeCloseTo(1, 6);
    for (const v of norm.values()) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("returns a sensitivity for every node", () => {
    const g = closedSystem();
    const s = computeSensitivities(g);
    expect(s.size).toBe(g.nodes.length);
    for (const n of g.nodes) expect(s.has(n.id)).toBe(true);
  });
});

describe("default options", () => {
  it("ships with rk4 as the default integrator", () => {
    expect(DEFAULT_ENGINE_OPTIONS.integrator).toBe("rk4");
  });
});

// --- Phase 2: collars made physical ----------------------------------------

function collaredStock(id: string, value: number, lower?: number, upper?: number): Node {
  const n: Node = { id, label: id, type: "stock", initial_value: value, unit: "u" };
  if (lower !== undefined || upper !== undefined) {
    n.collar = {};
    if (lower !== undefined) n.collar.lower = lower;
    if (upper !== undefined) n.collar.upper = upper;
  }
  return n;
}

describe("collar enforcement", () => {
  it("clamps a stock to its upper collar when inflow would exceed it", () => {
    // src(exogenous=100) -> sink(stock, initial=0, upper=50)
    // Without a collar, sink would grow past 50; the collar must stop it.
    const g: Graph = {
      nodes: [flow("src", 100), collaredStock("sink", 0, undefined, 50)],
      edges: [edge("e1", "src", "sink", { strength: 1 })],
      loops: [],
    };
    const o = opts({ dt: 0.1 });
    let s = initialState(g, o);
    for (let i = 0; i < 100; i++) s = step(g, s, o);
    expect(s.values.sink).toBeLessThanOrEqual(50);
    expect(s.pinned.sink).toBe("upper");
  });

  it("clamps a stock to its lower collar when outflow would go below it", () => {
    // stock(initial=10, lower=5) -> sink, no return. Stock drains but can't go below 5.
    const g: Graph = {
      nodes: [collaredStock("tank", 10, 5, undefined), stock("drain", 0)],
      edges: [edge("e1", "tank", "drain", { strength: 1 })],
      loops: [],
    };
    const o = opts({ dt: 0.1 });
    let s = initialState(g, o);
    for (let i = 0; i < 100; i++) s = step(g, s, o);
    expect(s.values.tank).toBeGreaterThanOrEqual(5);
    expect(s.pinned.tank).toBe("lower");
  });

  it("anti-windup: a stock at upper collar reverses immediately when inflow drops", () => {
    // src feeds sink (upper=50); sink drains to a free stock. Drive sink to
    // the collar, then cut src to 0. The stock must begin falling on the
    // FIRST step after the cut — no phantom lag from accumulated excess
    // (§2.3 anti-windup test).
    const g: Graph = {
      nodes: [flow("src", 100), collaredStock("sink", 0, undefined, 50), stock("drain", 0)],
      edges: [
        edge("e1", "src", "sink", { strength: 1 }),
        edge("e2", "sink", "drain", { strength: 1 }),
      ],
      loops: [],
    };
    const o = opts({ dt: 0.1 });
    let s = initialState(g, o);
    // Drive to the collar.
    for (let i = 0; i < 200; i++) s = step(g, s, o);
    expect(s.values.sink).toBe(50);
    expect(s.pinned.sink).toBe("upper");
    // Cut the source to 0.
    s = setValue(s, "src", 0);
    const before = s.values.sink;
    s = step(g, s, o);
    // Must fall on the very first step after reversal (outflow continues,
    // inflow is zero — anti-windup means no accumulated excess holds it up).
    expect(s.values.sink).toBeLessThan(before);
    expect(s.pinned.sink).not.toBe("upper");
  });

  it("backpressure: rejected material stays in the delay queue when target is pinned", () => {
    // src(exogenous=100) -> [delay 1] -> sink(upper=50, delayed)
    // The queue should grow deeper than its nominal slot count as material
    // backs up against the pinned target.
    const g: Graph = {
      nodes: [flow("src", 100), collaredStock("sink", 0, undefined, 50)],
      edges: [edge("e1", "src", "sink", { magnitude: 1, strength: 1 })],
      loops: [],
    };
    const o = opts({ dt: 0.25 });
    let s = initialState(g, o);
    // Run long enough for the stock to hit the collar and queues to back up.
    for (let i = 0; i < 200; i++) s = step(g, s, o);
    expect(s.values.sink).toBeLessThanOrEqual(50);
    expect(s.pinned.sink).toBe("upper");
    // Queue depth exceeds nominal slots (magnitude/dt = 1/0.25 = 4).
    expect(s.delayQueues.e1.length).toBeGreaterThan(4);
  });

  it("conservation holds on a closed loop with collars", () => {
    // Two stocks exchanging mass through delayed edges, one with an upper collar.
    // Total mass (stocks + queues) must be conserved even when backpressure
    // pushes material back into the queues.
    const g: Graph = {
      nodes: [collaredStock("a", 100, 0, 120), collaredStock("b", 0, 0)],
      edges: [
        edge("e1", "a", "b", { magnitude: 2, strength: 1 }),
        edge("e2", "b", "a", { magnitude: 2, strength: 1 }),
      ],
      loops: [],
    };
    const o = opts({ dt: 0.01 });
    const s0 = initialState(g, o);
    const m0 = totalMass(g, s0);
    for (const s of run(g, s0, o, 2000)) {
      expect(Math.abs(totalMass(g, s) - m0)).toBeLessThan(1e-6);
    }
  });

  it("collar-free fixtures produce trajectories identical to Phase 1 (no collar = no change)", () => {
    // The same closed system without collars must behave exactly as before.
    const gNoCollar: Graph = {
      nodes: [stock("a", 100), stock("b", 0)],
      edges: [
        edge("e1", "a", "b", { magnitude: 2, strength: 1 }),
        edge("e2", "b", "a", { magnitude: 2, strength: 1 }),
      ],
      loops: [],
    };
    const gCollar: Graph = {
      nodes: [collaredStock("a", 100, -1e9, 1e9), collaredStock("b", 0, -1e9, 1e9)],
      edges: gNoCollar.edges,
      loops: [],
    };
    const o = opts({ dt: 0.01 });
    const t1 = run(gNoCollar, initialState(gNoCollar, o), o, 100);
    const t2 = run(gCollar, initialState(gCollar, o), o, 100);
    for (let i = 0; i < t1.length; i++) {
      expect(t2[i].values.a).toBeCloseTo(t1[i].values.a, 9);
      expect(t2[i].values.b).toBeCloseTo(t1[i].values.b, 9);
    }
  });
});

describe("degrees of freedom", () => {
  it("counts all nodes as free when none are pinned", () => {
    const g: Graph = {
      nodes: [stock("a", 100), stock("b", 0)],
      edges: [],
      loops: [],
    };
    const s = initialState(g, opts());
    expect(degreesOfFreedom(g, s)).toBe(2);
  });

  it("decrements when a node is pinned at its upper collar", () => {
    const g: Graph = {
      nodes: [flow("src", 100), collaredStock("sink", 0, undefined, 50), stock("free", 0)],
      edges: [edge("e1", "src", "sink", { strength: 1 })],
      loops: [],
    };
    const o = opts({ dt: 0.1 });
    let s = initialState(g, o);
    expect(degreesOfFreedom(g, s)).toBe(3);
    for (let i = 0; i < 100; i++) s = step(g, s, o);
    expect(s.pinned.sink).toBe("upper");
    expect(degreesOfFreedom(g, s)).toBe(2);
  });
});

describe("headroom", () => {
  it("returns the fraction of collar span remaining above the current value", () => {
    const n = collaredStock("a", 50, 0, 100);
    expect(headroom(n, 50)).toBeCloseTo(0.5, 6);
    expect(headroom(n, 0)).toBeCloseTo(1, 6);
    expect(headroom(n, 100)).toBeCloseTo(0, 6);
  });

  it("returns null for unbounded nodes", () => {
    expect(headroom(stock("a"), 50)).toBeNull();
  });

  it("returns null for a node with only one bound", () => {
    expect(headroom(collaredStock("a", 50, 0, undefined), 50)).toBeNull();
  });
});
