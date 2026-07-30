/**
 * Loom sidecar provenance — types.
 *
 * The reference document this implements assumed file/field names
 * (`provenance.json`, `unit_value`, `causal_support`, `tioe_class`, …). The
 * loader is deliberately tolerant of both camelCase and snake_case keys so it
 * tracks whatever a real Loom output actually contains. The internal shape
 * (`Provenance` on `Node`/`Edge`, `GraphProvenance` on `Graph`) is the
 * canonical one the rest of the app reads.
 */

import type { GraphProvenance, Provenance } from "@/model/types";

/** A per-element provenance entry as it can appear in `provenance.json`. */
export interface RawProvenanceEntry {
  mined?: boolean;
  stage?: string;
  confidence?: number;
  pValue?: number;
  p_value?: number;
  reasoning?: string;
  tioeClass?: "T" | "I" | "OE" | "none";
  tioe_class?: "T" | "I" | "OE" | "none";
  unitValue?: number;
  unit_value?: number;
  causalSupport?: boolean;
  causal_support?: boolean;
  structuralSupport?: boolean;
  structural_support?: boolean;
}

/** The shape of `provenance.json` as the loader accepts it. */
export interface ProvenanceFile {
  timeUnit?: string;
  time_unit?: string;
  window?: string;
  tioeSuggestionsMd?: string;
  tioe_suggestions?: string;
  tioe_suggestions_md?: string;
  nodes?: Record<string, RawProvenanceEntry>;
  edges?: Record<string, RawProvenanceEntry>;
}

/** A normalised per-element provenance entry (camelCase, canonical). */
export type NormalizedEntry = Provenance;

/** A normalised model-level provenance bundle. */
export type NormalizedGraph = GraphProvenance;

/** Issues raised while attaching a sidecar to a graph. Non-fatal: a mismatched
 * id is skipped (with a warning) rather than aborting the load. */
export interface ProvenanceIssue {
  message: string;
  ref?: string;
}

/** The result of attaching a sidecar to a graph. */
export interface AttachResult {
  graph: import("@/model/types").Graph;
  issues: ProvenanceIssue[];
}
