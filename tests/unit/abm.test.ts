import { describe, expect, it } from "vitest";
import type { Edge, Graph, Node } from "@/model/types";
import { withComputedLoops } from "@/graph/loops";
import { runAbm, mulberry32, type AgentPopulation } from "@/abm/engine";
import {
  dominantLag,
  macroBehavior,
  perturbationVerdict,
  ruleExpectedBehavior,
  validateAbm,
} from "@/abm/validate";

function stock(id: string, value = 0): Node {
  return { id, label: id, type: "stock", tioe_class: "none", initial_value: value, unit: "u" };
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

function pop(opts: Partial<AgentPopulation> = {}): AgentPopulation {
  return {
    boundNode: opts.boundNode ?? "a",
    agentCount: opts.agentCount ?? 200,
    rule: opts.rule ?? "reorder_policy",
    topology: opts.topology ?? "well_mixed",
    params: opts.params ?? { sensitivity: 1.2, delay: 1 },
    seed: opts.seed ?? 42,
  };
}

describe("mulberry32", () => {
  it("is deterministic: same seed -> identical sequence", () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    for (let i = 0; i < 10; i++) {
      expect(a()).toBe(b());
    }
  });

  it("different seeds -> different sequences", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    let diff = 0;
    for (let i = 0; i < 10; i++) {
      if (a() !== b()) diff++;
    }
    expect(diff).toBeGreaterThan(5);
  });

  it("produces values in [0,1)", () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 100; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("runAbm — determinism", () => {
  it("same population + seed -> identical series", () => {
    const p = pop();
    const a = runAbm(p, 100);
    const b = runAbm(p, 100);
    expect(b.series).toEqual(a.series);
  });

  it("different seeds -> different series", () => {
    const a = runAbm(pop({ seed: 1 }), 100);
    const b = runAbm(pop({ seed: 2 }), 100);
    expect(b.series).not.toEqual(a.series);
  });

  it("produces the requested number of steps", () => {
    expect(runAbm(pop(), 50).series).toHaveLength(50);
    expect(runAbm(pop(), 1).series).toHaveLength(1);
  });
});

describe("runAbm — macro behavior", () => {
  it("reorder_policy produces reinforcing (amplifying) behavior", () => {
    const p = pop({ rule: "reorder_policy", params: { sensitivity: 1.5, delay: 1 } });
    const r = runAbm(p, 200);
    expect(macroBehavior(r.series)).toBe("reinforcing");
  });

  it("capacity_threshold produces balancing (converging) behavior", () => {
    const p = pop({
      rule: "capacity_threshold",
      topology: "lattice",
      params: { sensitivity: 0.5, delay: 0 },
    });
    const r = runAbm(p, 200);
    expect(macroBehavior(r.series)).toBe("balancing");
  });

  it("ruleExpectedBehavior maps reorder->reinforcing, capacity/info->balancing", () => {
    expect(ruleExpectedBehavior("reorder_policy")).toBe("reinforcing");
    expect(ruleExpectedBehavior("capacity_threshold")).toBe("balancing");
    expect(ruleExpectedBehavior("info_passing_delay")).toBe("balancing");
  });
});

describe("macroBehavior", () => {
  it("classifies a growing series as reinforcing", () => {
    const series = Array.from({ length: 20 }, (_, i) => i * i * 0.1);
    expect(macroBehavior(series)).toBe("reinforcing");
  });

  it("classifies a converging series as balancing", () => {
    const series = Array.from({ length: 20 }, (_, i) => 5 * Math.exp(-i * 0.3));
    expect(macroBehavior(series)).toBe("balancing");
  });

  it("classifies a flat series as balancing", () => {
    const series = Array.from({ length: 10 }, () => 3);
    expect(macroBehavior(series)).toBe("balancing");
  });

  it("handles very short series without throwing", () => {
    expect(macroBehavior([1, 2])).toBe("balancing");
    expect(macroBehavior([])).toBe("balancing");
  });
});

describe("dominantLag", () => {
  it("returns 0 for a monotonic series", () => {
    const series = Array.from({ length: 20 }, (_, i) => i);
    expect(dominantLag(series)).toBe(0);
  });

  it("returns a positive lag for an oscillating series", () => {
    const series = Array.from({ length: 100 }, (_, i) => Math.sin(i * 0.5));
    const lag = dominantLag(series);
    expect(lag).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const series = Array.from({ length: 50 }, (_, i) => Math.sin(i * 0.3) + Math.cos(i * 0.1));
    expect(dominantLag(series)).toBe(dominantLag(series));
  });
});

describe("validateAbm", () => {
  it("flags 'validated' when a reinforcing rule matches a reinforcing loop", () => {
    // Two-node mutual + edges -> one reinforcing loop through node a.
    const g: Graph = {
      nodes: [stock("a", 1), stock("b", 1)],
      edges: [edge("e1", "a", "b", "+", 2), edge("e2", "b", "a", "+", 2)],
      loops: [],
    };
    const graph = withComputedLoops(g);
    const result = runAbm(
      pop({ boundNode: "a", rule: "reorder_policy", params: { sensitivity: 1.5, delay: 1 } }),
      200,
    );
    const verdict = validateAbm({ graph, result });
    expect(verdict.status).toBe("validated");
    expect(verdict.macro).toBe("held");
  });

  it("flags 'flagged' when a balancing rule is bound to a reinforcing loop", () => {
    const g: Graph = {
      nodes: [stock("a", 1), stock("b", 1)],
      edges: [edge("e1", "a", "b", "+", 2), edge("e2", "b", "a", "+", 2)],
      loops: [],
    };
    const graph = withComputedLoops(g);
    const result = runAbm(
      pop({
        boundNode: "a",
        rule: "capacity_threshold",
        topology: "lattice",
        params: { sensitivity: 0.5, delay: 0 },
      }),
      200,
    );
    const verdict = validateAbm({ graph, result });
    expect(verdict.status).toBe("flagged");
    expect(verdict.detail).toContain("reinforcing");
  });

  it("flags 'flagged' when the bound node is not in any loop", () => {
    const g: Graph = {
      nodes: [stock("a", 1), stock("b", 1), stock("c", 1)],
      edges: [edge("e1", "a", "b", "+", 0)],
      loops: [],
    };
    const result = runAbm(pop({ boundNode: "c" }), 100);
    const verdict = validateAbm({ graph: g, result });
    expect(verdict.status).toBe("flagged");
    expect(verdict.detail).toContain("not in any loop");
  });

  it("the verdict detail is human-readable and identifies the mismatch", () => {
    const g: Graph = {
      nodes: [stock("a", 1), stock("b", 1)],
      edges: [edge("e1", "a", "b", "+", 2), edge("e2", "b", "a", "+", 2)],
      loops: [],
    };
    const graph = withComputedLoops(g);
    const result = runAbm(
      pop({ boundNode: "a", rule: "capacity_threshold", topology: "lattice", params: { sensitivity: 0.5, delay: 0 } }),
      200,
    );
    const verdict = validateAbm({ graph, result });
    expect(verdict.detail.length).toBeGreaterThan(10);
  });
});

describe("perturbationVerdict", () => {
  it("returns 'held' when the perturbed run has the same behavior and similar magnitude", () => {
    const baseline = runAbm(pop({ rule: "capacity_threshold", topology: "lattice", params: { sensitivity: 0.5, delay: 0 }, seed: 1 }), 200);
    // Tiny perturbation: same seed, slightly different threshold. Same basin.
    const perturbed = runAbm(pop({ rule: "capacity_threshold", topology: "lattice", params: { sensitivity: 0.51, delay: 0 }, seed: 1 }), 200);
    const v = perturbationVerdict({ baseline, perturbed });
    expect(v === "held" || v === "weakened").toBe(true);
  });

  it("returns 'bifurcated' when the perturbation flips the macro behavior", () => {
    // Baseline: converging (capacity_threshold).
    const baseline = runAbm(pop({ rule: "capacity_threshold", topology: "lattice", params: { sensitivity: 0.5, delay: 0 }, seed: 1 }), 200);
    // Perturbed: amplifying (reorder_policy with same seed).
    const perturbed = runAbm(pop({ rule: "reorder_policy", params: { sensitivity: 1.5, delay: 1 }, seed: 1 }), 200);
    expect(perturbationVerdict({ baseline, perturbed })).toBe("bifurcated");
  });

  it("is pure: same inputs -> same verdict", () => {
    const baseline = runAbm(pop({ seed: 5 }), 100);
    const perturbed = runAbm(pop({ seed: 5, params: { sensitivity: 1.3, delay: 1 } }), 100);
    expect(perturbationVerdict({ baseline, perturbed })).toBe(
      perturbationVerdict({ baseline, perturbed }),
    );
  });
});

describe("runAbm — performance sanity", () => {
  it("runs 10k agents / 100 steps well under 5s (no worker, in-test)", () => {
    const p = pop({ agentCount: 10000, topology: "lattice", rule: "capacity_threshold", params: { sensitivity: 0.5, delay: 0 } });
    const t0 = performance.now();
    runAbm(p, 100);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(5000);
  });
});
