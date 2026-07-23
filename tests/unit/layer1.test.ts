import { describe, expect, it } from "vitest";
import type { Edge, Loop } from "@/model/types";
import {
  arrowHead,
  delayBadge,
  delayHashMarks,
  delayHashMarksDouble,
  edgeGeometry,
  hasDelay,
  heatColor,
  heatRadius,
  loopCentroid,
  loopLabel,
  polaritySymbol,
  shortenToCircleBounds,
  valueRadiusFraction,
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
    // midpoint x = 50, plus offset 14 -> cx = 64. perp of (1,0) is (0,1).
    expect(a.x).toBeCloseTo(64);
    expect(a.y).toBeCloseTo(6);
    expect(b.x).toBeCloseTo(64);
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

describe("heatColor & heatRadius", () => {
  it("heatColor is pure and deterministic", () => {
    expect(heatColor(0.5)).toBe(heatColor(0.5));
  });

  it("heatColor clamps out-of-range inputs to [0,1]", () => {
    expect(heatColor(-1)).toBe(heatColor(0));
    expect(heatColor(2)).toBe(heatColor(1));
    expect(heatColor(NaN)).toBe(heatColor(0));
  });

  it("heatColor shifts hue from cool (low score) to red (high score)", () => {
    const cool = heatColor(0);
    const hot = heatColor(1);
    // The cool end starts at hue 210 (blue); the hot end at hue 0 (red).
    expect(cool).toContain("hsl(210");
    expect(hot).toContain("hsl(0");
  });

  it("heatRadius scales between 0.85x and 1.5x of base, clamped", () => {
    expect(heatRadius(20, 0)).toBeCloseTo(20 * 0.85, 6);
    expect(heatRadius(20, 1)).toBeCloseTo(20 * 1.5, 6);
    expect(heatRadius(20, 0.5)).toBeCloseTo(20 * (0.85 + 0.65 * 0.5), 6);
    // Out-of-range clamps to the endpoints.
    expect(heatRadius(20, -5)).toBe(heatRadius(20, 0));
    expect(heatRadius(20, 99)).toBe(heatRadius(20, 1));
  });

  it("heatRadius is monotonic non-decreasing in score", () => {
    const r0 = heatRadius(25, 0);
    const r1 = heatRadius(25, 0.5);
    const r2 = heatRadius(25, 1);
    expect(r0).toBeLessThanOrEqual(r1);
    expect(r1).toBeLessThanOrEqual(r2);
  });
});

describe("arrowHead", () => {
  it("places the tip at the target and wings behind it, perpendicular to the edge", () => {
    const geom = edgeGeometry({ x: 0, y: 0 }, { x: 10, y: 0 });
    const [tip, left, right] = arrowHead(geom, { x: 10, y: 0 }, 4);
    expect(tip).toEqual({ x: 10, y: 0 });
    // direction is +x, perp is +y/-y; wings sit back at x = 10 - 4 = 6.
    expect(left.x).toBeCloseTo(6);
    expect(right.x).toBeCloseTo(6);
    expect(left.y).toBeCloseTo(-right.y);
  });

  it("orients along a diagonal edge", () => {
    const geom = edgeGeometry({ x: 0, y: 0 }, { x: 3, y: 4 });
    const [tip, left, right] = arrowHead(geom, { x: 3, y: 4 }, 5);
    expect(tip).toEqual({ x: 3, y: 4 });
    // Both wings sit behind the tip along the (0.6, 0.8) direction.
    expect(left.x).toBeLessThan(tip.x);
    expect(right.x).toBeLessThan(tip.x);
    // Wings are symmetric about the edge axis: midpoint of wings is on-axis.
    const mx = (left.x + right.x) / 2;
    const my = (left.y + right.y) / 2;
    expect(mx).toBeCloseTo(tip.x - 0.6 * 5, 5);
    expect(my).toBeCloseTo(tip.y - 0.8 * 5, 5);
  });
});

describe("valueRadiusFraction", () => {
  it("maps the [0,1] interior linearly to [0.1, 0.9]", () => {
    expect(valueRadiusFraction(0)).toBeCloseTo(0.1, 6);
    expect(valueRadiusFraction(0.5)).toBeCloseTo(0.5, 6);
    expect(valueRadiusFraction(1)).toBeCloseTo(0.9, 6);
  });

  it("is asymptotic outside [0,1] and never reaches 0 or 1", () => {
    expect(valueRadiusFraction(-5)).toBeGreaterThan(0);
    expect(valueRadiusFraction(-5)).toBeLessThan(0.1);
    expect(valueRadiusFraction(5)).toBeLessThan(1);
    expect(valueRadiusFraction(5)).toBeGreaterThan(0.9);
  });

  it("is monotonic non-decreasing across the interior", () => {
    expect(valueRadiusFraction(0.2)).toBeLessThanOrEqual(valueRadiusFraction(0.8));
  });
});
