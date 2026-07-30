/**
 * Layers application entry point.
 *
 * Phases 1–6: Layer 1 CLD, Layer 2 constraint overlay, Layer 3 T/I/OE
 * simulation, ABM companion view, layer switcher, session save/load.
 *
 * Per spec §6: one active overlay at a time. The layer switcher enforces this;
 * the side panels' enable/disable methods are the contract. The ABM companion
 * is a separate pane, not an overlay.
 */

import { parseGraphOrThrow } from "@/dsl/parser";
import { withComputedLoops } from "@/graph/loops";
import { Layer1Renderer, type MigrationArc } from "@/layer1";
import { Layer2Panel, type MigrationTrail, recordMigrationStep } from "@/layer2";
import { Layer3Panel } from "@/layer3";
import type { TypedIntervention } from "@/layer3";
import { AbmPanel } from "@/abm";
import { LayerSwitcher, ThemeSwitcher, type LayerControl } from "@/ui";
import { downloadSession, downloadGraphYaml, downloadProvenance, uploadSession, loadGraphWithProvenance } from "@/io";
import { serializeGraphYaml } from "@/dsl/parser";
import { DEFAULT_ENGINE_OPTIONS } from "@/sim";
import { hasProvenance, ProvenanceDetailPanel } from "@/provenance";
import {
  pinScenario,
  nextScenarioId,
  addCard,
  removeCard,
  chooseCard,
  exportDecisionRecord,
  emptyTray,
  type ScenarioTray,
} from "@/scenario";
import type { DEFAULT_WEIGHTS } from "@/layer2/scoring";
import type { Graph, Node } from "@/model/types";
import type { NodeEditPatch } from "@/layer1";
// Vite ?raw import bundles the fixture as a string — no node:fs at runtime,
// keeping the app client-side only (per spec: no backend).
import beerFixture from "./fixtures/beer-distribution.yaml?raw";
import "./styles.css";

type Weights = typeof DEFAULT_WEIGHTS;

/** Apply a NodeEditPatch to an existing node, preserving unedited optional fields. */
function applyPatch(node: Node, patch: NodeEditPatch): Node {
  const { pin, clearPin, agent_binding: _ab, clearAgentBinding, collar, clearCollar, ...rest } = patch;
  void _ab;
  const next: Node = { ...node, ...rest };
  if (clearCollar) {
    const { collar: _c, ...noCollar } = next;
    void _c;
    return finishPatch(noCollar, pin, clearPin, clearAgentBinding);
  }
  if (collar) next.collar = collar;
  return finishPatch(next, pin, clearPin, clearAgentBinding);
}

function finishPatch(
  node: Node,
  pin: { x: number; y: number } | undefined,
  clearPin: boolean | undefined,
  clearAgentBinding: boolean | undefined,
): Node {
  let next = node;
  if (clearPin) {
    const { pin: _drop, ...noPin } = next;
    void _drop;
    next = noPin;
  } else if (pin) {
    next.pin = pin;
  }
  return clearAgentBinding ? stripAgentBinding(next) : next;
}

function stripAgentBinding(node: Node): Node {
  const { agent_binding: _drop, ...rest } = node;
  void _drop;
  return rest;
}

function main(): void {
  const root = document.getElementById("root");
  if (!root) return;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.setAttribute("class", "layer1-canvas");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Causal loop diagram");
  root.append(svg);

  const graph = withComputedLoops(parseGraphOrThrow(beerFixture));

  // Shared mutable weights (view parameter, not model state).
  let weights: Weights = {
    in_degree: 1,
    delay_ratio: 1,
    rate_mismatch: 1,
    dominant_loop: 1,
    sensitivity: 1,
  };

  // --- Live node monitor host (Layer 1 view; renderer owns its content) --
  const monitorHost = document.createElement("aside");
  monitorHost.setAttribute("aria-label", "Live node monitor");
  monitorHost.className = "node-monitor-host";
  root.append(monitorHost);

  // Loom spec item 6 — provenance detail panel (read-only evidence trail; the
  // P3 override channel is wired in Phase 3). Declared before the renderer so
  // the renderer's onElementClick callback can close over it.
  const provenanceDetail = new ProvenanceDetailPanel(graph, {
    onOverride: (nodeId: string, tioeClass: "T" | "I" | "OE" | "none") => {
      // Loom spec item 9 — read-modify-write. Write the correction onto the
      // node's provenance in the single source of truth, re-derive the
      // unclassified count, refresh the affected views, and download the
      // corrected `provenance.json` (the Loom intermediate file).
      const idx = graph.nodes.findIndex((n: Node) => n.id === nodeId);
      if (idx < 0) return;
      const node = graph.nodes[idx];
      const prov = node.provenance ? { ...node.provenance, tioeClass } : { tioeClass };
      graph.nodes[idx] = { ...node, provenance: prov };
      // Re-derive the model-level unclassified count (omit the key when 0,
      // per exactOptionalPropertyTypes: never assign undefined to an optional).
      if (graph.provenance) {
        const count = graph.nodes.filter((n) => n.provenance?.tioeClass === "none").length;
        const { unclassifiedCount: _drop, ...rest } = graph.provenance;
        void _drop;
        graph.provenance = count > 0 ? { ...rest, unclassifiedCount: count } : rest;
      }
      renderer.render(graph);
      l2.invalidate();
      l2.setWeights(weights);
      l3.refreshProvenance();
      abm.refresh();
      downloadProvenance(graph);
    },
  });

  const renderer = new Layer1Renderer(svg, {
    width: window.innerWidth,
    height: window.innerHeight,
    monitorHost,
    onPin: (nodeId: string, pin: { x: number; y: number } | null) => {
      const idx = graph.nodes.findIndex((n: Node) => n.id === nodeId);
      if (idx < 0) return;
      const { pin: _drop, ...rest } = graph.nodes[idx];
      void _drop;
      graph.nodes[idx] = pin ? { ...rest, pin } : rest;
    },
    onNudge: (nodeId: string, direction: number) => {
      // Drive the Layer 3 intervention from the canvas nudge so the
      // sparklines re-simulate from what the user is poking at; the L3
      // delta's sign follows the nudge direction (up = +, down = −). The L1
      // nudge and the L3 Δ both call the same engine impulse (Phase 1), so a
      // canvas nudge and an equivalent L3 Δ produce the same trajectory.
      l3.applyNudge(nodeId, direction);
    },
    onEditNode: (nodeId: string, patch: NodeEditPatch) => {
      // Apply the validated edit to the in-memory Graph (single source of
      // truth), re-render the canvas, refresh the side panels, and write the
      // result back to YAML (spec §2: edit mode writes back to the yaml).
      const idx = graph.nodes.findIndex((n: Node) => n.id === nodeId);
      if (idx < 0) return;
      const updated = applyPatch(graph.nodes[idx], patch);
      graph.nodes[idx] = updated;
      renderer.render(graph);
      // A graph edit invalidates the cached sensitivities (the engine's
      // dynamics changed), then re-scores with the new structure.
      l2.invalidate();
      l2.setWeights(weights);
      l3.setWeights(weights);
      downloadGraphYaml(graph);
    },
    onStep: (dof: number, total: number) => {
      dofLabel.textContent = `DoF: ${dof} of ${total}`;
    },
    onElementClick: (kind: "node" | "edge", id: string) => {
      // Loom spec item 6 — open the provenance detail panel when the clicked
      // element carries attached provenance. No-op for hand-authored elements.
      provenanceDetail.open(kind, id);
    },
  });
  renderer.render(graph);

  // --- Side panels -------------------------------------------------------
  const l2Host = document.createElement("aside");
  l2Host.setAttribute("aria-label", "Constraint overlay");
  l2Host.className = "side-panel side-panel--l2";
  root.append(l2Host);
  const l2 = new Layer2Panel(l2Host, graph, renderer, {
    topK: 3,
    onRescore: (w: Weights) => {
      weights = w;
      // Propagate the new weights to Layer 3 so its default intervention
      // node follows the (possibly changed) Layer 2 top constraint.
      l3.setWeights(w);
    },
  });

  const l3Host = document.createElement("aside");
  l3Host.setAttribute("aria-label", "T/I/OE simulation");
  l3Host.className = "side-panel side-panel--l3";
  root.append(l3Host);
  // Phase 5 migration trail — the ordered list of applied interventions.
  let migrationTrail: MigrationTrail = [];
  // Phase 9 scenario tray — pinned interventions for side-by-side comparison
  // and ADR export. Owned here (so it round-trips through session save/load).
  let scenarioTray: ScenarioTray = emptyTray();
  const l3 = new Layer3Panel(l3Host, graph, {
    onApply: (iv: TypedIntervention) => {
      // Record the migration step (computes before/after constraints + deltas).
      const sens = l2.getSensitivities();
      const { nextGraph, step } = recordMigrationStep(
        graph,
        iv,
        DEFAULT_ENGINE_OPTIONS,
        weights,
        sens,
        500,
      );
      step.index = migrationTrail.length;
      migrationTrail = [...migrationTrail, step];
      // Apply the new graph to the working Graph in place.
      graph.nodes = nextGraph.nodes;
      graph.edges = nextGraph.edges;
      graph.loops = nextGraph.loops;
      // Re-render and refresh panels.
      renderer.render(graph);
      l2.invalidate();
      l2.setWeights(weights);
      l2.setMigrationTrail(migrationTrail);
      // Draw migration arcs on the canvas (observed constraint movement).
      const arcs: MigrationArc[] = migrationTrail
        .filter((s) => s.observedBefore && s.observedAfter && s.observedBefore !== s.observedAfter)
        .map((s, i) => ({
          from: s.observedBefore!,
          to: s.observedAfter!,
          recency: (i + 1) / migrationTrail.length,
        }));
      renderer.drawMigrationArcs(arcs);
      downloadGraphYaml(graph);
    },
    onPinScenario: (iv: TypedIntervention) => {
      // Capture the current typed intervention as a comparable card. Pure
      // `pinScenario` derives the full metric set + constraint-after from the
      // current working graph; the card is appended to the tray.
      const sens = l2.getSensitivities();
      const id = nextScenarioId(scenarioTray);
      const card = pinScenario(graph, iv, {
        id,
        pinnedAt: new Date().toISOString(),
        engine: DEFAULT_ENGINE_OPTIONS,
        steps: 500,
        weights,
        sensitivities: sens,
        robustnessN: 50,
      });
      scenarioTray = addCard(scenarioTray, card);
      l3.setTray(scenarioTray);
    },
    onChooseScenario: (id: string | null) => {
      scenarioTray = chooseCard(scenarioTray, id);
      l3.setTray(scenarioTray);
    },
    onRemoveScenario: (id: string) => {
      scenarioTray = removeCard(scenarioTray, id);
      l3.setTray(scenarioTray);
    },
    onExportDecisionRecord: () => {
      const sens = l2.getSensitivities();
      const md = exportDecisionRecord(graph, scenarioTray, {
        weights,
        sensitivities: sens,
        engine: DEFAULT_ENGINE_OPTIONS,
        steps: 500,
        migrationTrail,
        modelYaml: serializeGraphYaml(graph),
        toolVersion: "1.0",
        generatedAt: new Date().toISOString(),
        robustnessN: 50,
      });
      const blob = new Blob([md], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "decision-record.md";
      a.click();
      URL.revokeObjectURL(url);
    },
  });

  const abmHost = document.createElement("aside");
  abmHost.setAttribute("aria-label", "ABM companion view");
  abmHost.className = "side-panel side-panel--abm";
  root.append(abmHost);
  const abm = new AbmPanel(abmHost, graph, {
    onVerdict: () => {
      // Verdict is already written onto the Graph's node by the panel.
    },
  });
  void abm;

  // --- Layer switcher (spec §6: one overlay at a time) ------------------
  const switcherHost = document.createElement("nav");
  switcherHost.className = "layer-switcher-host";
  root.append(switcherHost);
  const switcher = new LayerSwitcher(switcherHost);

  // --- Theme switcher (Light / System / Dark) ----------------------------
  const themeHost = document.createElement("nav");
  themeHost.className = "theme-switcher-host";
  root.append(themeHost);
  const themeSwitcher = new ThemeSwitcher(themeHost);
  themeSwitcher.mount();
  void themeSwitcher;
  // Re-render the canvas when the theme changes so JS-computed SVG colors
  // (value circles, monitor sparklines) re-resolve against the new tokens.
  window.addEventListener("layers:theme", () => {
    renderer.render(graph);
  });

  // Layer 1 is always active (the CLD itself); overlays toggle on top.
  const l1Ctrl: LayerControl = {
    id: "layer1",
    label: "L1: CLD",
    enable: () => {
      l2.disable();
      l3.disable();
      renderer.applyHeat(null);
      monitorHost.classList.add("is-active");
    },
    disable: () => {
      monitorHost.classList.remove("is-active");
    },
  };
  const l2Ctrl: LayerControl = {
    id: "layer2",
    label: "L2: Constraints",
    enable: () => {
      l3.disable();
      monitorHost.classList.remove("is-active");
      l2.enable();
    },
    disable: () => l2.disable(),
  };
  const l3Ctrl: LayerControl = {
    id: "layer3",
    label: "L3: T/I/OE",
    enable: () => {
      l2.disable();
      monitorHost.classList.remove("is-active");
      renderer.applyHeat(null);
      l3.enable();
    },
    disable: () => l3.disable(),
  };
  const abmCtrl: LayerControl = {
    id: "abm",
    label: "ABM",
    enable: () => {
      l2.disable();
      l3.disable();
      monitorHost.classList.remove("is-active");
      renderer.applyHeat(null);
      abmHost.classList.add("is-active");
    },
    disable: () => abmHost.classList.remove("is-active"),
  };
  switcher.register(l1Ctrl);
  switcher.register(l2Ctrl);
  switcher.register(l3Ctrl);
  switcher.register(abmCtrl);
  // Start with Layer 2 active (the most informative default for a new user).
  switcher.switchTo("layer2");

  // --- Loopy-style play controls (spec §2 live simulation) ------------
  const playBar = document.createElement("div");
  playBar.className = "play-bar";
  playBar.setAttribute("role", "toolbar");
  playBar.setAttribute("aria-label", "Simulation");
  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.textContent = "Pause";
  playBtn.classList.add("is-active");
  playBtn.addEventListener("click", () => {
    if (renderer.isPlaying()) {
      renderer.pause();
      playBtn.textContent = "Play";
      playBtn.classList.remove("is-active");
    } else {
      renderer.play();
      playBtn.textContent = "Pause";
      playBtn.classList.add("is-active");
    }
  });
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.textContent = "Reset";
  resetBtn.addEventListener("click", () => renderer.resetLoopy());
  const hint = document.createElement("span");
  hint.className = "play-hint";
  hint.textContent = "Hover a node, click ▲/▼ to nudge it";
  const dofLabel = document.createElement("span");
  dofLabel.className = "play-dof";
  dofLabel.textContent = `DoF: ${graph.nodes.length} of ${graph.nodes.length}`;
  playBar.append(playBtn, resetBtn, dofLabel, hint);
  root.append(playBar);

  // --- Session save/load (Phase 6) --------------------------------------
  const ioHost = document.createElement("div");
  ioHost.className = "io-bar";
  ioHost.setAttribute("role", "toolbar");
  ioHost.setAttribute("aria-label", "Session");
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Save session";
  saveBtn.addEventListener("click", () => downloadSession(graph, weights, scenarioTray));
  const loadBtn = document.createElement("button");
  loadBtn.type = "button";
  loadBtn.textContent = "Load session";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "application/json,.json";
  fileInput.style.display = "none";
  loadBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) {
      uploadSession(file)
        .then((session) => {
          // Replace graph contents in place (the renderer/panels hold the ref).
          graph.nodes = session.graph.nodes;
          graph.edges = session.graph.edges;
          graph.loops = session.graph.loops;
          weights = session.weights;
          scenarioTray = session.tray ?? emptyTray();
          l2.setWeights(weights);
          renderer.render(graph);
          l3.setWeights(weights);
          l3.setTray(scenarioTray);
        })
        .catch((err: unknown) => {
          window.alert(`Failed to load session: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
  });
  // Upload a YAML model file as a new scenario across L1/L2/L3 (and ABM).
  // Resets weights, scenario tray, and migration trail because a freshly
  // loaded model has no associated session state (mirrors `loadGraphYaml`).
  // Accepts a `provenance.json` Loom sidecar alongside the YAML (Loom spec
  // item 1): selecting both attaches provenance to the loaded model. With no
  // sidecar the path is identical to today — backward compatible.
  const provenanceStatus = document.createElement("span");
  provenanceStatus.className = "provenance-status";
  provenanceStatus.dataset.role = "provenance-status";
  const uploadBtn = document.createElement("button");
  uploadBtn.type = "button";
  uploadBtn.textContent = "Upload scenario";
  const yamlInput = document.createElement("input");
  yamlInput.type = "file";
  yamlInput.accept = "text/yaml,.yaml,.yml,application/json,.json";
  yamlInput.multiple = true;
  yamlInput.style.display = "none";
  uploadBtn.addEventListener("click", () => yamlInput.click());

  // Centralised swap-and-refresh: replaces the in-memory Graph contents in
  // place (renderer/panels hold the ref) and re-scores everything. Used by
  // scenario upload, session load, and attach-provenance.
  function applyLoadedGraph(next: Graph, provIssues: string[] = []): void {
    graph.nodes = next.nodes;
    graph.edges = next.edges;
    graph.loops = next.loops;
    // Graph-level provenance rides on the Graph object itself; carry it over
    // so Layer 3 / ABM / the detail panel can read it.
    if (next.provenance !== undefined) {
      (graph as { provenance?: unknown }).provenance = next.provenance;
    } else {
      delete (graph as { provenance?: unknown }).provenance;
    }
    weights = {
      in_degree: 1,
      delay_ratio: 1,
      rate_mismatch: 1,
      dominant_loop: 1,
      sensitivity: 1,
    };
    scenarioTray = emptyTray();
    migrationTrail = [];
    renderer.drawMigrationArcs([]);
    renderer.render(graph);
    l2.invalidate();
    l2.setWeights(weights);
    l2.setMigrationTrail(migrationTrail);
    l3.setWeights(weights);
    l3.setTray(scenarioTray);
    abm.refresh();
    // Surface provenance presence + any non-fatal sidecar issues.
    const hasProv = hasProvenance(graph);
    provenanceStatus.textContent = hasProv
      ? `Provenance attached${provIssues.length > 0 ? ` (${provIssues.length} warning${provIssues.length > 1 ? "s" : ""})` : ""}`
      : provIssues.length > 0
        ? provIssues[0]
        : "";
    provenanceStatus.classList.toggle("is-active", hasProv);
  }

  yamlInput.addEventListener("change", () => {
    const files = Array.from(yamlInput.files ?? []);
    if (files.length === 0) return;
    // The YAML/JSON model is the file whose name ends in .yaml/.yml (or the
    // first file if none match). A `provenance.json` sidecar is any .json
    // file named provenance.json (or the sole .json when a yaml is present).
    const isYaml = (f: File) => /\.(yaml|yml)$/i.test(f.name);
    const isProv = (f: File) => /provenance.*\.json$/i.test(f.name) || (/\.json$/i.test(f.name) && !isYaml(f));
    const yamlFile = files.find(isYaml) ?? files.find((f) => !isProv(f)) ?? files[0];
    const provFile = files.find(isProv);
    Promise.all([yamlFile.text(), provFile ? provFile.text() : Promise.resolve(undefined)])
      .then(([yamlText, sidecar]) => {
        const { graph: next, provenanceIssues } = loadGraphWithProvenance(yamlText, sidecar);
        applyLoadedGraph(next, provenanceIssues.map((i) => i.message));
      })
      .catch((err: unknown) => {
        window.alert(`Failed to load scenario: ${err instanceof Error ? err.message : String(err)}`);
      });
  });

  // Attach (or replace) a Loom `provenance.json` sidecar onto the model that is
  // already loaded, without reloading the YAML. Lets a user keep their working
  // graph and enrich it with mined structure after the fact.
  const attachBtn = document.createElement("button");
  attachBtn.type = "button";
  attachBtn.textContent = "Attach provenance";
  attachBtn.title = "Load a provenance.json Loom sidecar onto the current model.";
  const provInput = document.createElement("input");
  provInput.type = "file";
  provInput.accept = "application/json,.json";
  provInput.style.display = "none";
  attachBtn.addEventListener("click", () => provInput.click());
  provInput.addEventListener("change", () => {
    const file = provInput.files?.[0];
    if (!file) return;
    file
      .text()
      .then((sidecar) => {
        const { graph: next, provenanceIssues } = loadGraphWithProvenance(
          serializeGraphYaml(graph),
          sidecar,
        );
        applyLoadedGraph(next, provenanceIssues.map((i) => i.message));
      })
      .catch((err: unknown) => {
        window.alert(`Failed to attach provenance: ${err instanceof Error ? err.message : String(err)}`);
      });
  });

  ioHost.append(saveBtn, loadBtn, fileInput, uploadBtn, yamlInput, attachBtn, provInput, provenanceStatus);
  root.append(ioHost);

  // --- Resize ------------------------------------------------------------
  window.addEventListener("resize", () => {
    renderer.refresh();
  });
}

main();
