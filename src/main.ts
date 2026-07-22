/**
 * Layers application entry point.
 *
 * Phase 3 scope: render the beer-distribution fixture as a Layer 1 CLD with the
 * Layer 2 constraint overlay (heat coloring + ranked side panel with weight
 * sliders). Later phases add Layer 3, the ABM companion view, and the layer
 * switcher on top of this same canvas.
 */

import { parseGraphOrThrow } from "@/dsl/parser";
import { withComputedLoops } from "@/graph/loops";
import { Layer1Renderer } from "@/layer1";
import { Layer2Panel } from "@/layer2";
import { Layer3Panel } from "@/layer3";
import type { Node } from "@/model/types";
// Vite ?raw import bundles the fixture as a string — no node:fs at runtime,
// keeping the app client-side only (per spec: no backend).
import beerFixture from "./fixtures/beer-distribution.yaml?raw";
import "./styles.css";

function main(): void {
  const root = document.getElementById("root");
  if (!root) return;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.setAttribute("class", "layer1-canvas");
  root.append(svg);

  const graph = withComputedLoops(parseGraphOrThrow(beerFixture));

  const renderer = new Layer1Renderer(svg, {
    width: window.innerWidth,
    height: window.innerHeight,
    onPin: (nodeId: string, pin: { x: number; y: number } | null) => {
      // Persist the pin onto the Graph's node (single source of truth). A null
      // pin (future: double-click to unpin) clears the key per
      // exactOptionalPropertyTypes.
      const idx = graph.nodes.findIndex((n: Node) => n.id === nodeId);
      if (idx < 0) return;
      const { pin: _drop, ...rest } = graph.nodes[idx];
      void _drop;
      graph.nodes[idx] = pin ? { ...rest, pin } : rest;
    },
  });
  renderer.render(graph);

  // Layer 2 overlay: side panel owns the weight sliders and re-applies heat on
  // the canvas without re-running the force layout.
  const panelHost = document.createElement("aside");
  panelHost.setAttribute("aria-label", "Constraint overlay");
  panelHost.className = "side-panel side-panel--l2";
  root.append(panelHost);
  const panel = new Layer2Panel(panelHost, graph, renderer, { topK: 3 });
  panel.enable();

  // Layer 3 overlay: T/I/OE simulation panel. Defaults its intervention node to
  // the Layer 2 top-ranked constraint (spec: "what moving the constraint does").
  const l3Host = document.createElement("aside");
  l3Host.setAttribute("aria-label", "T/I/OE simulation");
  l3Host.className = "side-panel side-panel--l3";
  root.append(l3Host);
  const l3 = new Layer3Panel(l3Host, graph);
  l3.enable();

  // Re-derive loops stay live if edges change; refresh keeps the view in sync.
  window.addEventListener("resize", () => {
    renderer.refresh();
  });
}

main();
