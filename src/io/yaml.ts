/**
 * YAML model file IO — load and parse a `.yaml`/`.json` authoring file into a
 * validated `Graph` (the single source of truth).
 *
 * Unlike `session.ts` (which round-trips the full session JSON: graph +
 * weights + scenario tray), this is for **authoring**: the file holds only
 * the model (`nodes`/`edges`). Weights reset to defaults, the scenario tray
 * and migration trail clear, because a freshly loaded model has no associated
 * session state. The caller owns that reset (see `main.ts`).
 *
 * Reuses the DSL parser (`parseGraphOrThrow`, which collects ALL violations
 * before throwing) and re-derives loops from edges (loops are computed,
 * never authored or trusted from the file).
 *
 * Loom sidecar (spec item 1): `loadGraphYaml` is unchanged — a hand-authored
 * model with no sidecar behaves exactly as before. `loadGraphWithProvenance`
 * additionally attaches a parsed `provenance.json` sidecar onto the loaded
 * graph (per-element provenance on `Node`/`Edge`, model-level on `Graph`).
 * When the sidecar is absent or empty the result is identical to
 * `loadGraphYaml` — backward compatible.
 */

import type { Graph } from "@/model/types";
import { parseGraphOrThrow } from "@/dsl/parser";
import { withComputedLoops } from "@/graph/loops";
import { attachProvenance, parseProvenance, type ProvenanceFile } from "@/provenance";

/**
 * Parse a YAML/JSON model string into a validated Graph with computed loops.
 * Throws `ParseError` (carrying the full issue list) on invalid input.
 */
export function loadGraphYaml(input: string): Graph {
  return withComputedLoops(parseGraphOrThrow(input));
}

/**
 * Parse a YAML/JSON model string, then attach a Loom `provenance.json` sidecar
 * if one is provided and non-empty. Returns the graph plus any non-fatal
 * sidecar issues (mismatched ids are skipped, not fatal). Throws `ParseError`
 * if the model itself is invalid. With no sidecar this is exactly
 * `loadGraphYaml`.
 */
export function loadGraphWithProvenance(
  input: string,
  sidecar?: string,
): { graph: Graph; provenanceIssues: import("@/provenance").ProvenanceIssue[] } {
  const base = loadGraphYaml(input);
  if (sidecar === undefined || sidecar.trim() === "") {
    return { graph: base, provenanceIssues: [] };
  }
  let file: ProvenanceFile;
  try {
    file = parseProvenance(sidecar);
  } catch (err) {
    return {
      graph: base,
      provenanceIssues: [
        {
          message: `provenance.json ignored: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
  const { graph, issues } = attachProvenance(base, file);
  // Re-derive loops on the enriched graph so nothing downstream assumes loops
  // were computed on the pre-attachment shape (provenance rides on elements,
  // not edges, so loops are unchanged — but the call keeps the invariant).
  return { graph: withComputedLoops(graph), provenanceIssues: issues };
}

/**
 * Read a `.yaml`/`.json` file selected by the user and parse it into a Graph.
 * Rejects with `ParseError` if the file is not a valid model.
 */
export function uploadGraphYaml(file: File): Promise<Graph> {
  return file.text().then((text) => loadGraphYaml(text));
}
