import { describe, expect, it } from "vitest";
import type { Edge, Graph, Node } from "@/model/types";
import {
  applyTypedIntervention,
  clampExploitMagnitude,
  detectJCurve,
  dofChange,
  expectedSignature,
  operatingHeadroom,
  simulateTyped,
  type TypedIntervention,
} from "@/layer3/intervention";
import { initialState, run } from "@/sim/engine";
import type { TioeSnapshot } from "@/sim";

// --- fixture builders -----------------------------------------------------

function stock(id: string, value = 0, collar?: Node["collar"], cap?: number): Node {
  const n: Node = { id, label: id, type: "stock", initial_value: value, unit: "u" };
  if (collar) n.collar = collar;
  if (cap !== undefined) n.capacity_cost = cap;
  return n;
}
function flow(id: string, value = 0, collar?: Node["collar"], cap?: number): Node {
  const n: Node = { id, label: id, type: "flow", initial_value: value, unit: "u" };
  if (collar) n.collar = collar;
  if (cap !== undefined) n.capacity_cost = cap;
  return n;
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

const OPTS = { dt: 0.1, method: "rk4" as const };
const ENGINE = { dt: 0.1, integrator: "rk4" as const };

/**
 * Fixture A — Exploit on a flow constraint held at its operating point.
 * The constraint (no incoming) is engine-held at its value; its outflow IS the
 * outbound throughput T. A declared capacity_cost makes OE fixed (collar-based),
 * so Exploit (collar unchanged) holds OE flat while T rises toward the collar.
 */
function fixtureA(): Graph {
  const g: Graph = {
    nodes: [flow("constraint", 90, { lower: 0, upper: 120 }, 50), stock("exit", 0)],
    edges: [edge("e1", "constraint", "exit", { str: 1 })],
    loops: [],
  };
  g.nodes[1].boundary = true;
  return g;
}

/**
 * Fixture B — Elevate on a pinned stock constraint. Demand (200) exceeds the
 * collar (120), so the constraint is pinned at 120 and IS the bottleneck
 * limiting T to 120. Headroom is zero (Exploit disabled). Elevate raises the
 * collar (and scales the capacity cost), letting T and OE rise.
 */
function fixtureB(): Graph {
  const g: Graph = {
    nodes: [
      flow("demand", 200),
      stock("constraint", 120, { lower: 0, upper: 120 }, 50),
      stock("exit", 0),
    ],
    edges: [edge("e1", "demand", "constraint", { str: 1 }), edge("e2", "constraint", "exit", { str: 1 })],
    loops: [],
  };
  g.nodes[0].boundary = true;
  g.nodes[2].boundary = true;
  return g;
}

/**
 * Fixture J — a J-curve. `cap` is a 1st-order stock (fed and drained equally,
 * so an impulse decays back to equilibrium). A flow `signal` mirrors cap and
 * negatively feeds B's inflow. Exploit impulses cap up; while cap is elevated B
 * drains (T dips below pre); as cap decays, B recovers — worse-before-better.
 */
function fixtureJ(): Graph {
  const g: Graph = {
    nodes: [
      flow("driverCap", 50),
      stock("cap", 50, { lower: 0, upper: 150 }, 10),
      stock("sink", 0),
      flow("signal", 50),
      flow("driverB", 200),
      stock("B", 150),
      stock("exit", 0),
    ],
    edges: [
      edge("e1", "driverCap", "cap", { str: 1 }),
      edge("e2", "cap", "sink", { str: 1 }),
      edge("e3", "cap", "signal", { str: 1 }),
      edge("e4", "driverB", "B", { str: 1 }),
      edge("e5", "signal", "B", { pol: "-", str: 1 }),
      edge("e6", "B", "exit", { str: 1 }),
    ],
    loops: [],
  };
  g.nodes[0].boundary = true;
  g.nodes[4].boundary = true;
  g.nodes[6].boundary = true;
  return g;
}

describe("expectedSignature", () => {
  it("Exploit: T up, I flat-or-down, OE flat", () => {
    const s = expectedSignature("exploit");
    expect(s.T).toEqual(["up"]);
    expect(s.I).toContain("down");
    expect(s.I).toContain("flat");
    expect(s.OE).toEqual(["flat"]);
  });
  it("Elevate: T up, I up, OE up", () => {
    expect(expectedSignature("elevate")).toEqual({
      T: ["up"],
      I: ["up"],
      OE: ["up"],
    });
  });
  it("Subordinate: T flat, I down, OE flat", () => {
    expect(expectedSignature("subordinate")).toEqual({
      T: ["flat"],
      I: ["down"],
      OE: ["flat"],
    });
  });
  it("is pure and returns fresh arrays", () => {
    const a = expectedSignature("exploit");
    a.T.push("down");
    expect(expectedSignature("exploit").T).toEqual(["up"]);
  });
});

describe("Exploit headroom cap (spec §4.1)", () => {
  it("caps the magnitude at the operating-point headroom", () => {
    const g = fixtureA(); // equilibrium constraint = 90, upper = 120 -> headroom 30
    const cap = clampExploitMagnitude(g, ENGINE, "constraint", 999);
    expect(cap).not.toBeNull();
    expect(cap!.magnitude).toBeCloseTo(30, 6);
    expect(cap!.headroom).toBeCloseTo(30, 6);
  });
  it("leaves a within-headroom magnitude unchanged", () => {
    const g = fixtureA();
    const cap = clampExploitMagnitude(g, ENGINE, "constraint", 10);
    expect(cap!.magnitude).toBeCloseTo(10, 6);
  });
  it("disables Exploit (null) when the node has no upper collar", () => {
    const g: Graph = {
      nodes: [stock("uncollared", 90), stock("exit", 0)],
      edges: [edge("e1", "uncollared", "exit")],
      loops: [],
    };
    g.nodes[1].boundary = true;
    expect(clampExploitMagnitude(g, ENGINE, "uncollared", 10)).toBeNull();
    expect(operatingHeadroom(g, ENGINE, "uncollared")).toBeNull();
  });
  it("disables Exploit (zero headroom) when the constraint is pinned at its collar", () => {
    const g = fixtureB(); // equilibrium constraint = 120 = upper -> headroom 0
    const cap = clampExploitMagnitude(g, ENGINE, "constraint", 30);
    expect(cap).not.toBeNull();
    expect(cap!.headroom).toBeCloseTo(0, 6);
    expect(cap!.magnitude).toBe(0);
  });
});

describe("Exploit signature and ratios (Fixture A)", () => {
  const g = fixtureA();
  const iv: TypedIntervention = { type: "exploit", target: "constraint", magnitude: 30 };
  const r = simulateTyped(g, iv, OPTS, 200);

  it("raises T (Exploit -> T up, OE flat)", () => {
    expect(r.observed.T).toBe("up");
    expect(r.observed.OE).toBe("flat");
    expect(r.agreement.T).toBe(true);
    expect(r.agreement.OE).toBe(true);
  });
  it("does not move the collar (OE stays at the declared capacity cost)", () => {
    expect(r.pre.at(-1)!.OE).toBeCloseTo(50, 6);
    expect(r.post.at(-1)!.OE).toBeCloseTo(50, 6);
  });
  it("end-of-horizon deltas are hand-computed", () => {
    expect(r.deltaT).toBeCloseTo(30, 6); // 90 -> 120
    expect(r.deltaOE).toBeCloseTo(0, 6);
  });
  it("ratios are hand-computed (ΔOE ~0 -> null ratios; no payback)", () => {
    expect(r.ratios.dT_dOE).toBeNull();
    expect(r.ratios.dT_dI).toBeNull();
    expect(r.ratios.dT_per_constraint_time).toBeCloseTo(30 / 200, 6);
    expect(r.ratios.payback_horizon).toBeNull();
  });
  it("is pure: same inputs -> identical result", () => {
    expect(simulateTyped(g, iv, OPTS, 200)).toEqual(r);
  });
});

describe("Elevate signature and ratios (Fixture B)", () => {
  const g = fixtureB();
  const iv: TypedIntervention = { type: "elevate", target: "constraint", magnitude: 30 };
  const r = simulateTyped(g, iv, OPTS, 200);

  it("raises T, I and OE (Elevate -> T up, I up, OE up)", () => {
    expect(r.observed.T).toBe("up");
    expect(r.observed.I).toBe("up");
    expect(r.observed.OE).toBe("up");
    expect(r.agreement.T && r.agreement.I && r.agreement.OE).toBe(true);
  });
  it("moves the upper collar (the wall moves, not the operating point)", () => {
    const elevated = applyTypedIntervention(g, initialState(g, ENGINE), iv, ENGINE).graph;
    const node = elevated.nodes.find((n) => n.id === "constraint")!;
    expect(node.collar!.upper).toBeCloseTo(150, 6);
    // capacity cost scaled by the collar ratio 150/120 -> 62.5
    expect(node.capacity_cost).toBeCloseTo(62.5, 6);
  });
  it("end-of-horizon deltas are hand-computed", () => {
    expect(r.deltaT).toBeCloseTo(30, 6); // 120 -> 150
    expect(r.deltaOE).toBeCloseTo(12.5, 6); // 50 -> 62.5
    expect(r.deltaI).toBeCloseTo(30, 6); // inside stock 120 -> 150
  });
  it("ratios are hand-computed", () => {
    expect(r.ratios.dT_dOE).toBeCloseTo(30 / 12.5, 6); // 2.4
    expect(r.ratios.dT_dI).toBeCloseTo(30 / 30, 6); // 1
    expect(r.ratios.dT_per_constraint_time).toBeCloseTo(30 / 200, 6);
    expect(r.ratios.payback_horizon).not.toBeNull();
  });
});

describe("Subordinate adds a rope edge (structural)", () => {
  it("splices a negative-polarity information edge buffer -> release", () => {
    const g: Graph = {
      nodes: [flow("demand", 100), flow("release", 100), stock("buffer", 0), stock("exit", 0)],
      edges: [
        edge("e1", "demand", "release", { str: 1 }),
        edge("e2", "release", "buffer", { str: 1, mag: 2 }),
        edge("e3", "buffer", "exit", { str: 1, mag: 2 }),
      ],
      loops: [],
    };
    g.nodes[0].boundary = true;
    g.nodes[3].boundary = true;
    const iv: TypedIntervention = {
      type: "subordinate",
      target: "buffer",
      magnitude: 1.2,
      rope: { buffer: "buffer", release: "release" },
    };
    const applied = applyTypedIntervention(g, initialState(g, ENGINE), iv, ENGINE);
    const rope = applied.graph.edges.find((e) => e.source === "buffer" && e.target === "release");
    expect(rope).toBeDefined();
    expect(rope!.polarity).toBe("-");
    expect(rope!.delay.type).toBe("information");
    expect(rope!.strength).toBeCloseTo(1.2, 6);
  });
  it("tightens an existing rope rather than duplicating it (idempotent)", () => {
    const g: Graph = {
      nodes: [flow("release", 100), stock("buffer", 0), stock("exit", 0)],
      edges: [
        edge("rope_buffer_release", "buffer", "release", { pol: "-", str: 0.5, mag: 1 }),
        edge("e1", "release", "buffer", { str: 1 }),
        edge("e2", "buffer", "exit", { str: 1 }),
      ],
      loops: [],
    };
    g.nodes[1].boundary = false;
    g.nodes[2].boundary = true;
    g.nodes[0].boundary = true;
    const iv: TypedIntervention = {
      type: "subordinate",
      target: "buffer",
      magnitude: 0.3,
      rope: { buffer: "buffer", release: "release" },
    };
    const applied = applyTypedIntervention(g, initialState(g, ENGINE), iv, ENGINE);
    const ropes = applied.graph.edges.filter((e) => e.source === "buffer" && e.target === "release");
    expect(ropes).toHaveLength(1);
    expect(ropes[0]!.strength).toBeCloseTo(0.8, 6);
  });
});

describe("J-curve detector (spec §4.4)", () => {
  it("detects a worse-before-better dip on a purpose-built fixture", () => {
    const g = fixtureJ();
    const r = simulateTyped(g, { type: "exploit", target: "cap", magnitude: 50 }, OPTS, 200);
    expect(r.jCurve.detected).toBe(true);
    expect(r.jCurve.depth).toBeLessThan(0);
    expect(r.jCurve.duration).toBeGreaterThan(0);
  });
  it("returns no dip when post stays above pre (monotonic improve)", () => {
    const g = fixtureA();
    const r = simulateTyped(g, { type: "exploit", target: "constraint", magnitude: 30 }, OPTS, 200);
    expect(r.jCurve.detected).toBe(false);
    expect(r.jCurve.depth).toBe(0);
    expect(r.jCurve.duration).toBe(0);
  });
  it("detectJCurve is pure on synthetic series", () => {
    const pre: TioeSnapshot[] = [{ T: 100, I: 0, OE: 0 }, { T: 100, I: 0, OE: 0 }, { T: 100, I: 0, OE: 0 }, { T: 100, I: 0, OE: 0 }, { T: 100, I: 0, OE: 0 }];
    const post: TioeSnapshot[] = [{ T: 100, I: 0, OE: 0 }, { T: 90, I: 0, OE: 0 }, { T: 80, I: 0, OE: 0 }, { T: 105, I: 0, OE: 0 }, { T: 120, I: 0, OE: 0 }];
    const j = detectJCurve(pre, post);
    expect(j.detected).toBe(true);
    expect(j.depth).toBe(-20);
    expect(j.duration).toBe(2); // two negatives then crossover to >=0
  });
});

describe("Degrees-of-freedom change (spec §4.5)", () => {
  it("reports before/after free-node counts and total", () => {
    const g = fixtureB();
    const preStates = run(g, initialState(g, ENGINE), ENGINE, 100);
    const iv: TypedIntervention = { type: "elevate", target: "constraint", magnitude: 30 };
    const applied = applyTypedIntervention(g, initialState(g, ENGINE), iv, ENGINE);
    const postStates = run(applied.graph, applied.state, ENGINE, 100);
    const d = dofChange(g, preStates, postStates);
    expect(d.total).toBe(g.nodes.length);
    expect(d.delta).toBe(d.after - d.before);
  });
  it("Exploit on a collared flow that pins at the collar loses a degree of freedom", () => {
    const g = fixtureA();
    // Drive the constraint to its collar (magnitude = full headroom).
    const iv: TypedIntervention = { type: "exploit", target: "constraint", magnitude: 30 };
    const r = simulateTyped(g, iv, OPTS, 200);
    // Two nodes; the constraint pins at 120 (its collar) post-intervention.
    expect(r.dof.total).toBe(2);
    expect(r.dof.after).toBeLessThanOrEqual(r.dof.before);
  });
});

describe("applyTypedIntervention purity", () => {
  it("does not mutate the input graph (Elevate)", () => {
    const g = fixtureB();
    const before = JSON.stringify(g);
    applyTypedIntervention(g, initialState(g, ENGINE), { type: "elevate", target: "constraint", magnitude: 30 }, ENGINE);
    expect(JSON.stringify(g)).toBe(before);
  });
  it("does not mutate the input graph (Subordinate)", () => {
    const g: Graph = {
      nodes: [flow("release", 100), stock("buffer", 0), stock("exit", 0)],
      edges: [edge("e1", "release", "buffer"), edge("e2", "buffer", "exit")],
      loops: [],
    };
    g.nodes[0].boundary = true;
    g.nodes[2].boundary = true;
    const before = JSON.stringify(g);
    applyTypedIntervention(g, initialState(g, ENGINE), { type: "subordinate", target: "buffer", magnitude: 1, rope: { buffer: "buffer", release: "release" } }, ENGINE);
    expect(JSON.stringify(g)).toBe(before);
  });
});
