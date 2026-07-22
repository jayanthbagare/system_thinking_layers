import { describe, expect, it } from "vitest";
import type { Edge, Loop } from "@/model/types";
import {
  delayBadge,
  delayHashMarks,
  delayHashMarksDouble,
  edgeGeometry,
  hasDelay,
  loopCentroid,
  loopLabel,
  polaritySymbol,
  shortenToCircleBounds,
  type Point,
} from "@/layer1/layout";

function edge(polarity: "+" | "-", delayType: Edge["delay"]["type"], magnitude: number): Edge {
  return {
    id: "e",
    source: "a",
    target: "b",
    polarity,
    delay: { type: delayType, magnitude },
    strength: 1,
  };
}

describe("edgeGeometry", () => {
  it("computes path, midpoint, unit direction, and length", () => {
    const g = edgeGeometry({ x: 0, y: 0 }, { x: 10, y: 0 });
    expect(g.path).toBe("M0,0 L10,0");
    expect(g.midpoint).toEqual({ x: 5, y: 0 });
    expect(g.direction).toEqual({ x: 1, y: 0 });
    expect(g.length).toBe(10);
  });

  it("returns a unit direction even for zero-length edges (guards divide-by-zero)", () => {
    const g = edgeGeometry({ x: 3, y: 3 }, { x: 3, y: 3 });
    expect(g.length).toBe(1); // guarded to 1
    expect(g.midpoint).toEqual({ x: 3, y: 3 });
  });

  it("handles a diagonal edge", () => {
    const g = edgeGeometry({ x: 0, y: 0 }, { x: 3, y: 4 });
    expect(g.length).toBe(5);
    expect(g.direction).toEqual({ x: 0.6, y: 0.8 });
  });
});

describe("shortenToCircleBounds", () => {
  it("trims both endpoints inward by their radii along the edge direction", () => {
    const { source, target } = shortenToCircleBounds(
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      2,
      3,
    );
    expect(source).toEqual({ x: 2, y: 0 });
    expect(target).toEqual({ x: 7, y: 0 });
  });

  it("leaves the direction unchanged for diagonal edges", () => {
    const { source, target } = shortenToCircleBounds(
      { x: 0, y: 0 },
      { x: 3, y: 4 },
      0,
      0,
    );
    expect(source).toEqual({ x: 0, y: 0 });
    expect(target).toEqual({ x: 3, y: 4 });
  });
});

describe("delayHashMarks", () => {
  it("places two perpendicular hash points past the midpoint", () => {
    const g = edgeGeometry({ x: 0, y: 0 }, { x: 100, y: 0 });
    const [a, b] = delayHashMarks(g);
    // midpoint x = 50, plus offset 6 -> cx = 56. perp of (1,0) is (0,1).
    expect(a.x).toBeCloseTo(56);
    expect(a.y).toBeCloseTo(6);
    expect(b.x).toBeCloseTo(56);
    expect(b.y).toBeCloseTo(-6);
  });

  it("double-hash returns four points (two strokes)", () => {
    const g = edgeGeometry({ x: 0, y: 0 }, { x: 100, y: 0 });
    const [a1, a2, b1, b2] = delayHashMarksDouble(g);
    // Second hash sits further along than the first.
    expect(b1.x).toBeGreaterThan(a1.x);
    expect(b2.x).toBeGreaterThan(a2.x);
  });
});

describe("delay decoration predicates", () => {
  it("hasDelay is false for delay.type none or magnitude 0", () => {
    expect(hasDelay(edge("+", "none", 0))).toBe(false);
    expect(hasDelay(edge("+", "material", 0))).toBe(false);
    expect(hasDelay(edge("+", "none", 5))).toBe(false);
  });

  it("hasDelay is true for material/information/perception with positive magnitude", () => {
    expect(hasDelay(edge("+", "material", 1))).toBe(true);
    expect(hasDelay(edge("-", "information", 2))).toBe(true);
    expect(hasDelay(edge("+", "perception", 0.5))).toBe(true);
  });

  it("delayBadge formats integers without decimals and floats to 1 dp", () => {
    expect(delayBadge(edge("+", "material", 3))).toBe("3");
    expect(delayBadge(edge("+", "material", 2.5))).toBe("2.5");
  });
});

describe("loop helpers", () => {
  const positions = new Map<string, Point>([
    ["a", { x: 0, y: 0 }],
    ["b", { x: 4, y: 0 }],
    ["c", { x: 2, y: 4 }],
  ]);
  const loop: Loop = {
    id: "R1",
    nodes: ["a", "b", "c"],
    edges: ["e1", "e2", "e3"],
    sign: "reinforcing",
    dominant_delay: 2,
    cycle_time: 5,
  };

  it("loopCentroid is the mean of node positions", () => {
    expect(loopCentroid(loop, positions)).toEqual({ x: 2, y: 4 / 3 });
  });

  it("loopCentroid returns {0,0} when no positions are known", () => {
    expect(loopCentroid(loop, new Map())).toEqual({ x: 0, y: 0 });
  });

  it("loopLabel echoes the loop id", () => {
    expect(loopLabel(loop)).toBe("R1");
  });
});

describe("polaritySymbol", () => {
  it("renders + as a plus and - as a Unicode minus", () => {
    expect(polaritySymbol(edge("+", "none", 0))).toBe("+");
    expect(polaritySymbol(edge("-", "none", 0))).toBe("\u2212");
  });
});
