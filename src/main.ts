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
import { Layer1Renderer } from "@/layer1";
import { Layer2Panel } from "@/layer2";
import { Layer3Panel } from "@/layer3";
import { AbmPanel } from "@/abm";
import { LayerSwitcher, type LayerControl } from "@/ui";
import { downloadSession, downloadGraphYaml, uploadSession } from "@/io";
import type { DEFAULT_WEIGHTS } from "@/layer2/scoring";
import type { Node } from "@/model/types";
import type { NodeEditPatch } from "@/layer1";
// Vite ?raw import bundles the fixture as a string — no node:fs at runtime,
// keeping the app client-side only (per spec: no backend).
import beerFixture from "./fixtures/beer-distribution.yaml?raw";
import "./styles.css";

type Weights = typeof DEFAULT_WEIGHTS;

/** Apply a NodeEditPatch to an existing node, preserving unedited optional fields. */
function applyPatch(node: Node, patch: NodeEditPatch): Node {
  const { pin, clearPin, agent_binding: _ab, clearAgentBinding, ...rest } = patch;
  void _ab;
  const next: Node = { ...node, ...rest };
  if (clearPin) {
    const { pin: _drop, ...noPin } = next;
    void _drop;
    return clearAgentBinding ? stripAgentBinding(noPin) : noPin;
  }
  if (pin) next.pin = pin;
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
  const l3 = new Layer3Panel(l3Host, graph);

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
  playBar.append(playBtn, resetBtn, hint);
  root.append(playBar);

  // --- Session save/load (Phase 6) --------------------------------------
  const ioHost = document.createElement("div");
  ioHost.className = "io-bar";
  ioHost.setAttribute("role", "toolbar");
  ioHost.setAttribute("aria-label", "Session");
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Save session";
  saveBtn.addEventListener("click", () => downloadSession(graph, weights));
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
          l2.setWeights(weights);
          renderer.render(graph);
          l3.setWeights(weights);
        })
        .catch((err: unknown) => {
          window.alert(`Failed to load session: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
  });
  ioHost.append(saveBtn, loadBtn, fileInput);
  root.append(ioHost);

  // --- Resize ------------------------------------------------------------
  window.addEventListener("resize", () => {
    renderer.refresh();
  });
}

main();
