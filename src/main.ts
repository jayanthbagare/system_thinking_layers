/**
 * Layers application entry point.
 *
 * Phase 2 scope: render the beer-distribution fixture as a Layer 1 CLD. Later
 * phases add the layer switcher, side panels, and ABM companion view on top of
 * this same canvas.
 */

import { parseGraphOrThrow } from "@/dsl/parser";
import { withComputedLoops } from "@/graph/loops";
import { Layer1Renderer } from "@/layer1";
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

  // Re-derive loops stay live if edges change; refresh keeps the view in sync.
  window.addEventListener("resize", () => {
    renderer.refresh();
  });
}

main();
