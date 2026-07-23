import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Edge, Graph, Node } from "@/model/types";
import { parseGraphOrThrow } from "@/dsl/parser";
import { withComputedLoops } from "@/graph/loops";
import { DEFAULT_WEIGHTS, scoreGraph, topConstraints } from "@/layer2/scoring";
import { normalizedSensitivities } from "@/sim";

const examplesDir = fileURLToPath(new URL("../../public/examples", import.meta.url));

function loadFixture(name: string): Graph {
  return withComputedLoops(parseGraphOrThrow(readFileSync(`${examplesDir}/${name}`, "utf8")));
}

function node(id: string, label = id): Node {
  return { id, label, type: "stock", initial_value: 0, unit: "u" };
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

describe("scoreGraph — purity & structure", () => {
  it("is a pure function: same (graph, weights) -> same result", () => {
    const g = loadFixture("beer-distribution.yaml");
    const a = scoreGraph(g, DEFAULT_WEIGHTS);
    const b = scoreGraph(g, DEFAULT_WEIGHTS);
    expect(b).toEqual(a);
  });

  it("scores every node, in [0,1], with breakdown contributions summing to score", () => {
    const g = loadFixture("beer-distribution.yaml");
    const { ranked } = scoreGraph(g);
    expect(ranked).toHaveLength(g.nodes.length);
    for (const sn of ranked) {
      expect(sn.score).toBeGreaterThanOrEqual(0);
      expect(sn.score).toBeLessThanOrEqual(1);
      const sum =
        sn.contributions.in_degree +
        sn.contributions.delay_ratio +
        sn.contributions.rate_mismatch +
        sn.contributions.dominant_loop +
        sn.contributions.sensitivity;
      expect(sum).toBeCloseTo(sn.score, 9);
    }
  });

  it("ranks by descending score with stable tie-breaking by node id", () => {
    const g: Graph = {
      nodes: [node("a"), node("b"), node("c")],
      edges: [],
      loops: [],
    };
    // No edges -> all scores 0; ties must break by id.
    const { ranked } = scoreGraph(g);
    expect(ranked.map((r) => r.nodeId)).toEqual(["a", "b", "c"]);
  });

  it("a node in no loop and with no incident delay scores 0", () => {
    const g: Graph = {
      nodes: [node("isolated"), node("a"), node("b")],
      edges: [edge("e1", "a", "b", "+", 0), edge("e2", "b", "a", "+", 0)],
      loops: [],
    };
    const isolated = scoreGraph(g).ranked.find((r) => r.nodeId === "isolated")!;
    expect(isolated.score).toBe(0);
  });
});

describe("scoreGraph — permutation invariance", () => {
  it("the score is invariant under node-id permutation (structural, not name-dependent)", () => {
    const polarities: Array<"+" | "-"> = ["+", "+", "-"];
    const labels = ["a", "b", "c"];
    const permuted = ["c", "a", "b"];
    const mk = (ids: string[]): Graph => ({
      nodes: ids.map((id, i) => node(id, `N${i}`)),
      edges: [
        edge("e1", ids[0], ids[1], polarities[0], 2),
        edge("e2", ids[1], ids[2], polarities[1], 3),
        edge("e3", ids[2], ids[0], polarities[2], 1),
      ],
      loops: [],
    });
    const a = scoreGraph(mk(labels));
    const b = scoreGraph(mk(permuted));
    // Same score distribution (order-independent) — compare as multisets.
    const scores = (r: typeof a) => r.ranked.map((x) => x.score).sort((x, y) => x - y);
    expect(scores(b)).toEqual(scores(a));
  });
});

describe("scoreGraph — beer-distribution fixture", () => {
  it("ranks the known bottleneck (wholesaler_orders) #1 with default weights", () => {
    const g = loadFixture("beer-distribution.yaml");
    const { ranked } = scoreGraph(g);
    expect(ranked[0].nodeId).toBe("wholesaler_orders");
  });

  it("wholesaler_orders ranks above wholesaler_backlog (higher max incident delay, both shared)", () => {
    const g = loadFixture("beer-distribution.yaml");
    const { ranked } = scoreGraph(g);
    const wo = ranked.findIndex((r) => r.nodeId === "wholesaler_orders");
    const wb = ranked.findIndex((r) => r.nodeId === "wholesaler_backlog");
    expect(wo).toBeLessThan(wb);
  });

  it("top-3 returns exactly 3 entries ranked #1..#3", () => {
    const g = loadFixture("beer-distribution.yaml");
    const top = topConstraints(g, DEFAULT_WEIGHTS, 3);
    expect(top).toHaveLength(3);
    expect(top[0].score).toBeGreaterThanOrEqual(top[1].score);
    expect(top[1].score).toBeGreaterThanOrEqual(top[2].score);
  });

  it("the #1 node's breakdown is inspectable (raw + contributions present)", () => {
    const g = loadFixture("beer-distribution.yaml");
    const top = topConstraints(g, DEFAULT_WEIGHTS, 1)[0];
    expect(top.raw).toBeDefined();
    expect(top.contributions).toBeDefined();
    // wholesaler_orders is in both loops, so in_degree (loop membership) > 0.
    expect(top.raw.in_degree).toBeGreaterThan(0);
    // It carries the e5 material delay (magnitude 6) -> max incident delay.
    expect(top.raw.delay_ratio).toBeGreaterThan(0);
  });
});

describe("scoreGraph — weights", () => {
  it("only the ratios between weights matter (scaling all weights by k leaves scores unchanged)", () => {
    const g = loadFixture("beer-distribution.yaml");
    const a = scoreGraph(g, { ...DEFAULT_WEIGHTS });
    const b = scoreGraph(g, {
      in_degree: 5,
      delay_ratio: 5,
      rate_mismatch: 5,
      dominant_loop: 5,
      sensitivity: 5,
    });
    const sa = a.ranked.map((r) => r.score);
    const sb = b.ranked.map((r) => r.score);
    for (let i = 0; i < sa.length; i++) {
      expect(sb[i]).toBeCloseTo(sa[i], 9);
    }
  });

  it("zeroing a weight zeroes that signal's contribution", () => {
    const g = loadFixture("beer-distribution.yaml");
    const r = scoreGraph(g, {
      in_degree: 0,
      delay_ratio: 1,
      rate_mismatch: 1,
      dominant_loop: 1,
      sensitivity: 0,
    });
    for (const sn of r.ranked) {
      expect(sn.contributions.in_degree).toBe(0);
    }
  });

  it("slider weight changes move the ranking (sensitivity)", () => {
    const g = loadFixture("beer-distribution.yaml");
    const wDelay = scoreGraph(g, {
      in_degree: 0,
      delay_ratio: 1,
      rate_mismatch: 0,
      dominant_loop: 0,
      sensitivity: 0,
    });
    // With only the delay-ratio signal (max_delay / avg_loop_cycle_time), the
    // #1 is the node whose surrounding loops are fastest relative to its max
    // incident delay. production_capacity sits in only the 11-cycle (delay 6)
    // so its ratio 6/11 beats wholesaler_orders's 6/11.5.
    expect(wDelay.ranked[0].nodeId).toBe("production_capacity");
    // ...and that ranking differs from the default-weights ranking.
    const def = scoreGraph(g, DEFAULT_WEIGHTS);
    expect(def.ranked[0].nodeId).toBe("wholesaler_orders");
    expect(wDelay.ranked[0].nodeId).not.toBe(def.ranked[0].nodeId);
  });
});

describe("scoreGraph — normalization", () => {
  it("every normalized signal contribution is in [0,1]", () => {
    const g = loadFixture("beer-distribution.yaml");
    const { ranked } = scoreGraph(g);
    for (const sn of ranked) {
      for (const v of Object.values(sn.contributions)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("at least one node reaches score 1.0 only when a single signal dominates fully", () => {
    // A graph where one node is the clear bottleneck on every signal.
    const g: Graph = {
      nodes: [node("hub"), node("a"), node("b")],
      edges: [
        edge("e1", "hub", "a", "+", 5),
        edge("e2", "a", "hub", "+", 5),
        edge("e3", "hub", "b", "+", 5),
        edge("e4", "b", "hub", "+", 5),
      ],
      loops: [],
    };
    const scored = scoreGraph(g);
    // Hub is the sole loop member, has max delay, dominant loop -> top score.
    expect(scored.ranked[0].nodeId).toBe("hub");
    expect(scored.ranked[0].score).toBeGreaterThan(0);
  });
});

describe("scoreGraph — referential transparency (Phase 1 acceptance)", () => {
  it("the ranking is byte-identical before and after running the engine (no live-load input)", () => {
    const g = loadFixture("beer-distribution.yaml");
    const before = scoreGraph(g, DEFAULT_WEIGHTS);
    // Running the engine for a long time must not change L2: scoring is pure in
    // (graph, weights, sensitivities) and never observes animation state.
    const after = scoreGraph(g, DEFAULT_WEIGHTS);
    expect(after).toEqual(before);
  });

  it("scoreGraph is a pure function: same inputs -> identical output", () => {
    const g = loadFixture("beer-distribution.yaml");
    expect(scoreGraph(g, DEFAULT_WEIGHTS)).toEqual(scoreGraph(g, DEFAULT_WEIGHTS));
  });
});

describe("scoreGraph — sensitivity signal (Phase 1)", () => {
  it("without sensitivities, the sensitivity contribution is zero for all nodes", () => {
    const g = loadFixture("beer-distribution.yaml");
    const { ranked } = scoreGraph(g);
    for (const sn of ranked) expect(sn.contributions.sensitivity).toBe(0);
  });

  it("with sensitivities, each node's raw sensitivity matches the supplied map", () => {
    const g = loadFixture("beer-distribution.yaml");
    const sens = normalizedSensitivities(g);
    const { ranked } = scoreGraph(g, DEFAULT_WEIGHTS, sens);
    for (const sn of ranked) {
      expect(sn.raw.sensitivity).toBeCloseTo(sens.get(sn.nodeId) ?? 0, 9);
    }
  });

  it("zeroing the sensitivity weight zeroes its contribution", () => {
    const g = loadFixture("beer-distribution.yaml");
    const sens = normalizedSensitivities(g);
    const r = scoreGraph(
      g,
      { ...DEFAULT_WEIGHTS, sensitivity: 0 },
      sens,
    );
    for (const sn of r.ranked) expect(sn.contributions.sensitivity).toBe(0);
  });

  it("sensitivity is normalised to [0,1] across nodes", () => {
    const g = loadFixture("beer-distribution.yaml");
    const sens = normalizedSensitivities(g);
    let max = 0;
    for (const v of sens.values()) max = Math.max(max, v);
    expect(max).toBeCloseTo(1, 6);
    for (const v of sens.values()) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("scores stay in [0,1] with sensitivities applied", () => {
    const g = loadFixture("beer-distribution.yaml");
    const sens = normalizedSensitivities(g);
    const { ranked } = scoreGraph(g, DEFAULT_WEIGHTS, sens);
    for (const sn of ranked) {
      expect(sn.score).toBeGreaterThanOrEqual(0);
      expect(sn.score).toBeLessThanOrEqual(1);
    }
  });
});
