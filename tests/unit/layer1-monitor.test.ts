// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseGraphOrThrow } from "@/dsl/parser";
import { withComputedLoops } from "@/graph/loops";
import { Layer1Renderer } from "@/layer1/renderer";
import type { Graph } from "@/model/types";

function load(path: string): Graph {
  return withComputedLoops(parseGraphOrThrow(readFileSync(path, "utf8")));
}

// jsdom lacks SVGAnimatedLength; d3-zoom reads svg.viewBox.baseVal.width/height
// during the renderer constructor's initial transform. Patch the property.
function makeSvg(w: number, h: number): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  Object.defineProperty(svg, "viewBox", {
    configurable: true,
    get: () => ({
      baseVal: { width: w, height: h, x: 0, y: 0 },
      animVal: { width: w, height: h },
    }),
  });
  Object.defineProperty(svg, "clientWidth", { configurable: true, get: () => w });
  Object.defineProperty(svg, "clientHeight", { configurable: true, get: () => h });
  return svg;
}

function mount(graph: Graph): { host: HTMLElement } {
  const host = document.createElement("aside");
  const r = new Layer1Renderer(makeSvg(800, 600), { width: 800, height: 600, monitorHost: host });
  r.render(graph);
  return { host };
}

describe("Layer1Renderer — live node monitor mode", () => {
  it("shows a sparkline card per node (all mode) for the 6-node beer fixture", () => {
    const { host } = mount(load("public/examples/beer-distribution.yaml"));
    expect(host.querySelector('[data-role="monitor-node-select"]')).toBeNull();
    expect(host.querySelectorAll(".node-monitor-card").length).toBe(6);
  });

  it("shows a sparkline card per node (all mode) for the 7-node agentic fixture", () => {
    // Regression: a 7-node graph hit the single-node threshold and collapsed to
    // one card tracking nodes[0] (a flat boundary flow), making the monitor look
    // empty. The threshold now lets ≤8-node graphs show every node.
    const { host } = mount(load("public/examples/agentic-verification-loop.yaml"));
    expect(host.querySelector('[data-role="monitor-node-select"]')).toBeNull();
    expect(host.querySelectorAll(".node-monitor-card").length).toBe(7);
  });

  it("shows a sparkline card per node (all mode) for the 8-node CI/CD fixture", () => {
    const { host } = mount(load("public/examples/cicd-pipeline.yaml"));
    expect(host.querySelector('[data-role="monitor-node-select"]')).toBeNull();
    expect(host.querySelectorAll(".node-monitor-card").length).toBe(8);
  });
});