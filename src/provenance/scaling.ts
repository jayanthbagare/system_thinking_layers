/**
 * Loom `unit_value` dollar scaling for Layer 3 (Loom spec item 4).
 *
 * The engine runs in **physical units** (per `sim/engine.ts`); `deriveTioe`
 * produces T/I/OE in those physical units. Loom's `unit_value` is
 * dollars-per-physical-unit. The Layer 3 *display* must, when a `unit_value`
 * is attached, show the simulated physical quantity multiplied by it — never
 * the raw physical quantity dressed up as dollars.
 *
 * This is a pure view-layer projection: the engine is untouched (it stays the
 * single dynamical source of truth in physical units). The panel asks
 * `unitValueSummary` whether a dollar display is honest, and if so multiplies
 * the physical T/I/OE snapshots by the shared `unit_value`. When nodes lack a
 * `unit_value` the panel labels the trajectory as physical units, so the two
 * cases are never visually confused (Loom spec item 4, last sentence).
 *
 * Honesty rule: an aggregate T/I/OE series can only be dollar-scaled by a
 * single scalar when all contributing nodes share the same `unit_value`. If
 * nodes carry *different* `unit_value`s, scaling the aggregate by any one of
 * them would be a false precision — so `single` is undefined and the panel
 * falls back to physical units with a note. The common synthetic case (one
 * product, one price) satisfies the cross-repo integration test (item 11).
 */

import type { Graph } from "@/model/types";
import type { TioeSnapshot } from "@/sim";

export interface UnitValueSummary {
  /** True iff at least one node carries a `unit_value`. */
  present: boolean;
  /** Distinct `unit_value`s found across nodes. */
  distinct: number[];
  /** The single shared `unit_value`, when all nodes that have one agree. */
  single: number | undefined;
  /** How many nodes carry a `unit_value`. */
  withUnit: number;
  /** How many nodes lack a `unit_value`. */
  withoutUnit: number;
}

/** Summarise the `unit_value` situation across a graph. Pure. */
export function unitValueSummary(graph: Graph): UnitValueSummary {
  const seen = new Set<number>();
  let withUnit = 0;
  let withoutUnit = 0;
  for (const n of graph.nodes) {
    const uv = n.provenance?.unitValue;
    if (typeof uv === "number" && !Number.isNaN(uv)) {
      seen.add(uv);
      withUnit++;
    } else {
      withoutUnit++;
    }
  }
  const distinct = [...seen].sort((a, b) => a - b);
  const single = distinct.length === 1 ? distinct[0] : undefined;
  return { present: withUnit > 0, distinct, single, withUnit, withoutUnit };
}

/**
 * Scale a physical T/I/OE snapshot into dollars by `unitValue`. Pure. Returns
 * a new snapshot; the input is untouched. Used by the Layer 3 panel only when
 * `unitValueSummary.single` is defined.
 */
export function scaleTioeSnapshot(snapshot: TioeSnapshot, unitValue: number): TioeSnapshot {
  return {
    T: snapshot.T * unitValue,
    I: snapshot.I * unitValue,
    OE: snapshot.OE * unitValue,
  };
}
