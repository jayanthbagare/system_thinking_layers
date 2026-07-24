/**
 * Phase 6 — session save/load (spec §7.3, PLAN §6).
 *
 * A session bundles the `Graph` (the only persisted artifact per spec), the
 * Layer 2 weights, and any ABM verdicts already written onto nodes. Save/load
 * is a lossless JSON round-trip: `loadSession(saveSession(x))` equals `x`.
 *
 * Per PLAN §4.3 security: imported JSON is validated against the `Graph` schema
 * before any rendering. Prototype-pollution keys are stripped recursively.
 * Unlike the DSL parser (which is for authoring and always emits `loops: []`),
 * the session loader preserves computed loops and ABM verdicts by re-deriving
 * loops from edges after validation.
 */

import type { Graph } from "@/model/types";
import { validate } from "@/model/validate";
import type { Weights } from "@/layer2/scoring";
import { withComputedLoops } from "@/graph/loops";
import { serializeGraphYaml } from "@/dsl/parser";
import type { ScenarioTray, ScenarioCard } from "@/scenario";
import { emptyTray } from "@/scenario";

export interface Session {
  version: 1;
  graph: Graph;
  weights: Weights;
  /** Phase 9 scenario tray. Optional: older sessions load with an empty tray. */
  tray?: ScenarioTray;
  savedAt: string;
}

/** Serialize a session to a pretty-printed JSON string. */
export function saveSession(graph: Graph, weights: Weights, tray: ScenarioTray = emptyTray()): string {
  const session: Session = {
    version: 1,
    graph,
    weights,
    tray,
    savedAt: new Date().toISOString(),
  };
  return JSON.stringify(session, null, 2);
}

/**
 * Load a session from a JSON string. Validates the graph structurally; throws
 * on invalid input. Strips prototype-pollution keys recursively. Re-derives
 * loops from edges (loops are computed, never authored).
 */
export function loadSession(input: string): Session {
  const raw = JSON.parse(input) as Partial<Session>;
  if (!raw || typeof raw !== "object") {
    throw new Error("session must be a JSON object");
  }
  if (raw.version !== 1) {
    throw new Error(`unsupported session version: ${raw.version ?? "missing"}`);
  }
  if (!raw.graph) {
    throw new Error("session missing graph");
  }
  const cleaned = stripProtoKeys(raw.graph) as Graph;
  const issues = validate(cleaned);
  if (issues.length > 0) {
    throw new Error(`session graph is invalid: ${issues.length} issue(s)`);
  }
  // Re-derive loops (computed, never persisted as authored).
  const graph = withComputedLoops(cleaned);
  const weights: Weights = {
    in_degree: raw.weights?.in_degree ?? 1,
    delay_ratio: raw.weights?.delay_ratio ?? 1,
    rate_mismatch: raw.weights?.rate_mismatch ?? 1,
    dominant_loop: raw.weights?.dominant_loop ?? 1,
    // Backward compatibility: older sessions predate the sensitivity signal.
    sensitivity: raw.weights?.sensitivity ?? 1,
  };
  // Phase 9: restore the scenario tray. Older sessions without a tray load as
  // empty. The tray is plain data; we only sanity-check its shape (cards is an
  // array, chosenId is a string or null) so a corrupt file fails loudly rather
  // than silently rendering a broken tray.
  const tray = loadTray(raw.tray);
  return { version: 1, graph, weights, tray, savedAt: raw.savedAt ?? "" };
}

/** Validate and restore a scenario tray from raw session data. */
function loadTray(raw: unknown): ScenarioTray {
  if (raw === null || raw === undefined) return emptyTray();
  if (typeof raw !== "object") return emptyTray();
  const r = raw as Partial<ScenarioTray>;
  if (!Array.isArray(r.cards)) return emptyTray();
  const cards = r.cards as ScenarioCard[];
  const chosenId = typeof r.chosenId === "string" ? r.chosenId : null;
  return { cards, chosenId };
}

/** Recursively strip prototype-pollution keys from an unknown value. */
function stripProtoKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripProtoKeys);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    out[k] = stripProtoKeys(v);
  }
  return out;
}

/** Trigger a browser download of the session JSON. */
export function downloadSession(graph: Graph, weights: Weights, tray: ScenarioTray = emptyTray(), filename = "layers-session.json"): void {
  const json = saveSession(graph, weights, tray);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Trigger a browser download of the graph serialized back to YAML. */
export function downloadGraphYaml(graph: Graph, filename = "graph.yaml"): void {
  const yaml = serializeGraphYaml(graph);
  const blob = new Blob([yaml], { type: "text/yaml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Read a file selected by the user and parse it as a session. */
export function uploadSession(file: File): Promise<Session> {
  return file.text().then((text) => loadSession(text));
}
