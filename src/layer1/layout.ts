/**
 * Pure geometry helpers for the Layer 1 CLD renderer.
 *
 * These functions are framework-agnostic and unit-tested directly. The D3
 * renderer in `renderer.ts` consumes them so that the visual logic (delay hash
 * positions, loop centroids, arrow geometry) is decoupled from DOM/SVG wiring
 * and stays deterministic and inspectable.
 *
 * Per the architecture rule: these are pure views over `Graph` — they hold no
 * state of their own. The only mutable state in Layer 1 is the running D3 force
 * simulation, whose ephemeral positions are not part of the model. Manual pins
 * ARE part of the model (Node.pin) and are read here as fixed inputs.
 */

import type { Edge, Loop } from "@/model/types";

export interface Point {
  x: number;
  y: number;
}

export interface EdgeGeometry {
  /** SVG path `d` attribute for the edge line. */
  path: string;
  /** Midpoint of the edge — used for polarity labels and delay badges. */
  midpoint: Point;
  /** Unit direction (source -> target), used to orient hash marks. */
  direction: Point;
  /** Length of the edge in pixels. */
  length: number;
}

/**
 * Compute the geometry of a straight edge between two points. Layer 1 uses
 * straight edges (curved edges would obscure polarity and delay marks per
 * spec §2 — the diagram must stay readable as a thinking tool).
 */
export function edgeGeometry(source: Point, target: Point): EdgeGeometry {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy) || 1;
  const direction = { x: dx / length, y: dy / length };
  return {
    path: `M${source.x},${source.y} L${target.x},${target.y}`,
    midpoint: { x: source.x + dx / 2, y: source.y + dy / 2 },
    direction,
    length,
  };
}

/**
 * Shorten an edge so it starts/ends at the boundary of node circles of the
 * given radii, rather than at the node centers. Keeps arrowheads outside the
 * node fill.
 */
export function shortenToCircleBounds(
  source: Point,
  target: Point,
  sourceRadius: number,
  targetRadius: number,
): { source: Point; target: Point } {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return {
    source: { x: source.x + ux * sourceRadius, y: source.y + uy * sourceRadius },
    target: { x: target.x - ux * targetRadius, y: target.y - uy * targetRadius },
  };
}

/**
 * Positions of the two hash marks drawn on a delayed edge (spec §2: "delay
 * edges rendered with a double-hash mark"). The hashes sit just past the
 * midpoint, perpendicular to the edge, so they don't overlap the polarity
 * label.
 */
export function delayHashMarks(geom: EdgeGeometry): [Point, Point] {
  const { midpoint, direction } = geom;
  // Perpendicular vector (rotated +90 degrees).
  const perp = { x: -direction.y, y: direction.x };
  const offset = 6; // distance of the hash midpoint from the edge midpoint
  const halfLen = 6; // half-length of each hash stroke
  const cx = midpoint.x + direction.x * offset;
  const cy = midpoint.y + direction.y * offset;
  return [
    { x: cx + perp.x * halfLen, y: cy + perp.y * halfLen },
    { x: cx - perp.x * halfLen, y: cy - perp.y * halfLen },
  ];
}

/**
 * The second hash mark sits a few pixels further along the edge than the first
 * so the pair reads as a deliberate double-hash, not a single tick.
 */
export function delayHashMarksDouble(geom: EdgeGeometry): [Point, Point, Point, Point] {
  const [a1, a2] = delayHashMarks(geom);
  const { midpoint, direction } = geom;
  const perp = { x: -direction.y, y: direction.x };
  const offset = 16;
  const halfLen = 6;
  const cx = midpoint.x + direction.x * offset;
  const cy = midpoint.y + direction.y * offset;
  const b1 = { x: cx + perp.x * halfLen, y: cy + perp.y * halfLen };
  const b2 = { x: cx - perp.x * halfLen, y: cy - perp.y * halfLen };
  return [a1, a2, b1, b2];
}

/**
 * Centroid of a loop's nodes — used to place the R1/B1 label. Computed as the
 * mean of node positions (not the polygon centroid) which is good enough for
 * label placement and avoids degenerate cases for non-convex loop shapes.
 */
export function loopCentroid(loop: Loop, positions: Map<string, Point>): Point {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const id of loop.nodes) {
    const p = positions.get(id);
    if (p) {
      sx += p.x;
      sy += p.y;
      n++;
    }
  }
  return n === 0 ? { x: 0, y: 0 } : { x: sx / n, y: sy / n };
}

/**
 * The display label for a loop ("R1", "B2", ...). Sourced from the loop's id,
 * which `deriveLoops` assigns deterministically.
 */
export function loopLabel(loop: Loop): string {
  return loop.id;
}

/**
 * The display symbol for an edge's polarity — "+" for reinforcing links, "−"
 * (Unicode minus, visually wider) for balancing links.
 */
export function polaritySymbol(edge: Edge): string {
  return edge.polarity === "+" ? "+" : "\u2212";
}

/**
 * Returns true if an edge should render with delay decoration. Edges with
 * `delay.type === "none"` OR magnitude 0 carry no delay mark; everything else
 * does (material / information / perception delays all get the double-hash).
 */
export function hasDelay(edge: Edge): boolean {
  return edge.delay.type !== "none" && edge.delay.magnitude > 0;
}

/**
 * Format the delay magnitude badge text. Trims to a sensible precision so the
 * badge stays compact on the canvas.
 */
export function delayBadge(edge: Edge): string {
  const m = edge.delay.magnitude;
  return Number.isInteger(m) ? String(m) : m.toFixed(1);
}
