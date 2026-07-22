import { describe, expect, it } from "vitest";
import { findCycles, type Adjacency } from "@/graph/cycles";

function cyclesAsSets(cycles: string[][]): Set<string>[] {
  return cycles.map((c) => new Set(c));
}

/** Helper: assert two cycle multisets are equal (order-independent). */
function expectCyclesEqual(actual: string[][], expected: string[][]): void {
  const a = cyclesAsSets(actual).map((s) => sig(s));
  const b = cyclesAsSets(expected).map((s) => sig(s));
  a.sort();
  b.sort();
  expect(a).toEqual(b);
}

/** Stable signature for a cycle: the rotation starting from the alphabetically
 * smallest node id, joined. */
function sig(cycle: Set<string>): string {
  const ids = [...cycle].sort();
  return ids.join(",");
}

describe("findCycles — golden cases", () => {
  it("returns no cycles for a DAG", () => {
    const adj: Adjacency = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", []],
    ]);
    expect(findCycles(["a", "b", "c"], adj)).toEqual([]);
  });

  it("returns no cycles for an acyclic singleton with no self-edge", () => {
    expect(findCycles(["a"], new Map([["a", []]]))).toEqual([]);
  });

  it("finds a single two-node mutual edge as one loop", () => {
    const adj: Adjacency = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
    ]);
    const cycles = findCycles(["a", "b"], adj);
    expect(cycles).toHaveLength(1);
    expect(new Set(cycles[0])).toEqual(new Set(["a", "b"]));
  });

  it("finds a single triangle", () => {
    const adj: Adjacency = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", ["a"]],
    ]);
    const cycles = findCycles(["a", "b", "c"], adj);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual(["a", "b", "c"]);
  });

  it("finds both loops in a figure-8 (two cycles sharing one node)", () => {
    //     a <-> b,  b <-> c   (shared node b)
    const adj: Adjacency = new Map([
      ["a", ["b"]],
      ["b", ["a", "c"]],
      ["c", ["b"]],
    ]);
    const cycles = findCycles(["a", "b", "c"], adj);
    expectCyclesEqual(cycles, [
      ["a", "b"],
      ["b", "c"],
    ]);
  });

  it("finds two disjoint triangles as separate cycles", () => {
    const adj: Adjacency = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", ["a"]],
      ["d", ["e"]],
      ["e", ["f"]],
      ["f", ["d"]],
    ]);
    const cycles = findCycles(["a", "b", "c", "d", "e", "f"], adj);
    expect(cycles).toHaveLength(2);
    expectCyclesEqual(cycles, [
      ["a", "b", "c"],
      ["d", "e", "f"],
    ]);
  });

  it("finds nested cycles (inner triangle + outer square)", () => {
    // square a -> b -> d -> c -> a, plus diagonal b -> c
    const adj: Adjacency = new Map([
      ["a", ["b"]],
      ["b", ["d", "c"]],
      ["c", ["a"]],
      ["d", ["c"]],
    ]);
    const cycles = findCycles(["a", "b", "c", "d"], adj);
    expectCyclesEqual(cycles, [
      ["a", "b", "c"],
      ["a", "b", "d", "c"],
    ]);
  });

  it("ignores self-loops (no elementary cycle of length 1)", () => {
    const adj: Adjacency = new Map([
      ["a", ["a"]],
      ["b", []],
    ]);
    expect(findCycles(["a", "b"], adj)).toEqual([]);
  });

  it("reports each elementary cycle exactly once (no rotated duplicates)", () => {
    const adj: Adjacency = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", ["a"]],
    ]);
    const cycles = findCycles(["a", "b", "c"], adj);
    // All rotations of [a,b,c] must collapse to a single entry.
    expect(cycles).toHaveLength(1);
  });

  it("ignores successors referencing unknown nodes", () => {
    const adj: Adjacency = new Map([
      ["a", ["b", "ghost"]],
      ["b", ["a"]],
    ]);
    const cycles = findCycles(["a", "b"], adj);
    expect(cycles).toHaveLength(1);
    expect(new Set(cycles[0])).toEqual(new Set(["a", "b"]));
  });

  it("handles a node missing from the adjacency map gracefully", () => {
    const adj: Adjacency = new Map([["a", ["b"]]]);
    expect(findCycles(["a", "b"], adj)).toEqual([]);
  });
});

describe("findCycles — determinism & ordering", () => {
  it("is deterministic across repeated calls", () => {
    const adj: Adjacency = new Map([
      ["a", ["b"]],
      ["b", ["c", "d"]],
      ["c", ["a"]],
      ["d", ["a"]],
    ]);
    const first = findCycles(["a", "b", "c", "d"], adj);
    const second = findCycles(["a", "b", "c", "d"], adj);
    expect(second).toEqual(first);
  });

  it("anchors each cycle at its lowest-indexed (input-order) node", () => {
    // Same cycle, different input orders should still each appear once.
    const adj: Adjacency = new Map([
      ["x", ["y"]],
      ["y", ["z"]],
      ["z", ["x"]],
    ]);
    const cycles = findCycles(["x", "y", "z"], adj);
    expect(cycles).toHaveLength(1);
    expect(cycles[0][0]).toBe("x");
  });
});

describe("findCycles — performance sanity", () => {
  it("enumerates a 50-node pure ring (one cycle) in well under the 50ms budget", () => {
    const N = 50;
    const nodeIds: string[] = [];
    for (let i = 0; i < N; i++) nodeIds.push(`n${i}`);
    const adj: Adjacency = new Map();
    for (const id of nodeIds) adj.set(id, []);
    for (let i = 0; i < N; i++) {
      adj.get(`n${i}`)!.push(`n${(i + 1) % N}`); // single ring
    }
    const t0 = performance.now();
    const cycles = findCycles(nodeIds, adj);
    const dt = performance.now() - t0;
    expect(cycles).toHaveLength(1);
    expect(dt).toBeLessThan(50);
  });

  it("handles k disjoint triangles (exactly k cycles) quickly", () => {
    // Disjoint triangles keep the cycle count linear in the graph size, so this
    // stresses the SCC + blocking machinery without combinatorial blow-up.
    const k = 20;
    const nodeIds: string[] = [];
    const adj: Adjacency = new Map();
    for (let i = 0; i < k; i++) {
      const a = `t${i}a`;
      const b = `t${i}b`;
      const c = `t${i}c`;
      nodeIds.push(a, b, c);
      adj.set(a, [b]);
      adj.set(b, [c]);
      adj.set(c, [a]);
    }
    const t0 = performance.now();
    const cycles = findCycles(nodeIds, adj);
    const dt = performance.now() - t0;
    expect(cycles.length).toBe(k);
    expect(dt).toBeLessThan(50);
  });
});
