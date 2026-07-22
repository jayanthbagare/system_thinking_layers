/**
 * Pure sparkline renderer (spec §4: "three sparklines ... not a big dashboard").
 *
 * Takes one or more series of numbers and returns an SVG path string plus axis
 * extents. No DOM, no D3 — the caller drops the path into an `<svg>`. This
 * keeps the component unit-testable and framework-agnostic.
 *
 * Each sparkline shows T, I, or OE pre vs. post intervention: the pre line in a
 * neutral color, the post line in an accent, so the directional delta reads at
 * a glance.
 */

export interface SparklinePoint {
  x: number;
  y: number;
}

export interface SparklineSeries {
  /** Series label, e.g. "pre" or "post". */
  label: string;
  points: SparklinePoint[];
  /** CSS color for the stroke. */
  color: string;
}

export interface SparklineOptions {
  width: number;
  height: number;
  /** Padding inside the viewBox. */
  padding?: number;
  /**
   * If true, all series share a single y-axis (so pre/post are comparable).
   * Default true — required for the pre/post delta to be visually honest.
   */
  sharedYAxis?: boolean;
}

export interface SparklineResult {
  /** One `<path d="...">` per series. */
  paths: { label: string; color: string; d: string }[];
  /** The y-domain used, for optional axis ticks. */
  yMin: number;
  yMax: number;
  /** The x-domain used. */
  xMin: number;
  xMax: number;
  /** viewBox string ready to drop on an <svg>. */
  viewBox: string;
}

/** Compute sparkline paths from raw series. Pure. */
export function sparkline(series: SparklineSeries[], opts: SparklineOptions): SparklineResult {
  const padding = opts.padding ?? 4;
  const sharedY = opts.sharedYAxis ?? true;

  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  for (const s of series) {
    for (const p of s.points) {
      if (p.x < xMin) xMin = p.x;
      if (p.x > xMax) xMax = p.x;
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    }
  }
  if (!Number.isFinite(xMin)) {
    xMin = 0;
    xMax = 1;
  }
  if (!Number.isFinite(yMin)) {
    yMin = 0;
    yMax = 1;
  }
  // Guard against a flat series (yMin === yMax).
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  }

  const innerW = opts.width - 2 * padding;
  const innerH = opts.height - 2 * padding;
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;

  const sx = (x: number) => padding + ((x - xMin) / xRange) * innerW;
  const sy = (y: number) => opts.height - padding - ((y - yMin) / yRange) * innerH;

  // If series have independent y-axes (sharedY=false), each normalizes to its
  // own [min,max]. Pre/post comparison should use sharedY=true so the delta is
  // honest; the flag exists only for independent signals (e.g. T vs. OE on one
  // chart, which we don't do — each T/I/OE gets its own sparkline).
  const perSeriesBounds = new Map<string, { yMin: number; yMax: number }>();
  if (!sharedY) {
    for (const s of series) {
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      for (const p of s.points) {
        if (p.y < lo) lo = p.y;
        if (p.y > hi) hi = p.y;
      }
      if (!Number.isFinite(lo)) {
        lo = 0;
        hi = 1;
      }
      if (lo === hi) {
        lo -= 1;
        hi += 1;
      }
      perSeriesBounds.set(s.label, { yMin: lo, yMax: hi });
    }
  }

  const paths = series.map((s) => {
    const bounds = perSeriesBounds.get(s.label);
    const lo = bounds?.yMin ?? yMin;
    const hi = bounds?.yMax ?? yMax;
    const range = hi - lo || 1;
    const yFn = bounds
      ? (y: number) => opts.height - padding - ((y - lo) / range) * innerH
      : sy;
    const d = s.points
      .map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x).toFixed(2)},${yFn(p.y).toFixed(2)}`)
      .join(" ");
    return { label: s.label, color: s.color, d };
  });

  return {
    paths,
    yMin,
    yMax,
    xMin,
    xMax,
    viewBox: `0 0 ${opts.width} ${opts.height}`,
  };
}
