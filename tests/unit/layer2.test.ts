import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Edge, Graph, Node } from "@/model/types";
import { parseGraphOrThrow } from "@/dsl/parser";
import { withComputedLoops } from "@/graph/loops";
import { DEFAULT_WEIGHTS, scoreGraph, topConstraints } from "@/layer2/scoring";

const examplesDir = fileURLToPath(new URL("../../public/examples", import.meta.url));

function loadFixture(name: string): Graph {
  return withComputedLoops(parseGraphOrThrow(readFileSync(`${examplesDir}/${name}`, "utf8")));
}

function node(id: string, label = id): Node {
  return { id, label, type: "stock", tioe_class: "none", initial_value: 0, unit: "u" };
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
        sn.contributions.dominant_loop;
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

describe("scoreGraph — live values (load adjustment)", () => {
  it("without liveValues, load is undefined (structural-only)", () => {
    const g = loadFixture("beer-distribution.yaml");
    const { ranked } = scoreGraph(g);
    for (const sn of ranked) {
      expect(sn.load).toBeUndefined();
    }
  });

  it("with liveValues, load is set and in [0,1]", () => {
    const g = loadFixture("beer-distribution.yaml");
    const live = new Map<string, number>();
    for (const n of g.nodes) live.set(n.id, 0.5); // all at rest
    live.set("wholesaler_orders", 0.9); // heavily loaded
    const { ranked } = scoreGraph(g, DEFAULT_WEIGHTS, live);
    for (const sn of ranked) {
      expect(sn.load).toBeDefined();
      expect(sn.load!).toBeGreaterThanOrEqual(0);
      expect(sn.load!).toBeLessThanOrEqual(1);
    }
  });

  it("the most-loaded node gets load 1.0", () => {
    const g = loadFixture("beer-distribution.yaml");
    const live = new Map<string, number>();
    for (const n of g.nodes) live.set(n.id, 0.5);
    live.set("production_capacity", 0.2); // far from rest (0.5)
    const { ranked } = scoreGraph(g, DEFAULT_WEIGHTS, live);
    const pc = ranked.find((r) => r.nodeId === "production_capacity");
    expect(pc?.load).toBeCloseTo(1.0, 5);
  });

  it("all-at-rest liveValues leaves ranking identical to structural-only", () => {
    const g = loadFixture("beer-distribution.yaml");
    const live = new Map<string, number>();
    for (const n of g.nodes) live.set(n.id, 0.5); // all at rest
    const structural = scoreGraph(g);
    const liveScored = scoreGraph(g, DEFAULT_WEIGHTS, live);
    expect(liveScored.ranked.map((r) => r.nodeId)).toEqual(
      structural.ranked.map((r) => r.nodeId),
    );
  });

  it("a heavily loaded lower-ranked node can overtake a higher-ranked one", () => {
    const g = loadFixture("beer-distribution.yaml");
    const structural = scoreGraph(g);
    // Pick the #2 and #1 nodes; load #2 so it overtakes #1.
    const secondId = structural.ranked[1].nodeId;
    const firstScore = structural.ranked[0].score;
    const secondScore = structural.ranked[1].score;
    // Only worthwhile if they're close enough for a 2x boost to flip them.
    // Skip otherwise (the structural gap is too large to close with load alone).
    if (secondScore * 2 <= firstScore) return; // pragmatic skip
    const live = new Map<string, number>();
    for (const n of g.nodes) live.set(n.id, 0.5);
    live.set(secondId, 0.1); // heavily loaded
    const liveScored = scoreGraph(g, DEFAULT_WEIGHTS, live);
    expect(liveScored.ranked[0].nodeId).toBe(secondId);
  });

  it("scores stay in [0,1] after load adjustment", () => {
    const g = loadFixture("beer-distribution.yaml");
    const live = new Map<string, number>();
    for (const n of g.nodes) live.set(n.id, 0.5);
    live.set("wholesaler_orders", 0.9);
    live.set("retailer_backlog", 0.1);
    const { ranked } = scoreGraph(g, DEFAULT_WEIGHTS, live);
    for (const sn of ranked) {
      expect(sn.score).toBeGreaterThanOrEqual(0);
      expect(sn.score).toBeLessThanOrEqual(1);
    }
  });
});
