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
 */

import type { Graph } from "@/model/types";
import { parseGraphOrThrow } from "@/dsl/parser";
import { withComputedLoops } from "@/graph/loops";

/**
 * Parse a YAML/JSON model string into a validated Graph with computed loops.
 * Throws `ParseError` (carrying the full issue list) on invalid input.
 */
export function loadGraphYaml(input: string): Graph {
  return withComputedLoops(parseGraphOrThrow(input));
}

/**
 * Read a `.yaml`/`.json` file selected by the user and parse it into a Graph.
 * Rejects with `ParseError` if the file is not a valid model.
 */
export function uploadGraphYaml(file: File): Promise<Graph> {
  return file.text().then((text) => loadGraphYaml(text));
}
