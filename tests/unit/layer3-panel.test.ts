// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseGraphOrThrow } from "@/dsl/parser";
import { withComputedLoops } from "@/graph/loops";
import { Layer3Panel } from "@/layer3/panel";
import type { Graph } from "@/model/types";
import type { Weights } from "@/layer2/scoring";

function loadBeerFixture(): Graph {
  return withComputedLoops(
    parseGraphOrThrow(readFileSync("public/examples/beer-distribution.yaml", "utf8")),
  );
}

const DELAY_ONLY: Weights = {
  in_degree: 0,
  delay_ratio: 1,
  rate_mismatch: 0,
  dominant_loop: 0,
};

function nodeSelectValue(host: HTMLElement): string {
  const sel = host.querySelector<HTMLSelectElement>('[data-role="node-select"]');
  if (!sel) throw new Error("node-select not found");
  return sel.value;
}

function deltaSliderValue(host: HTMLElement): number {
  const input = host.querySelector<HTMLInputElement>('[data-role="delta"]');
  if (!input) throw new Error("delta slider not found");
  return Number.parseFloat(input.value);
}

describe("Layer3Panel — setWeights follows the Layer 2 top constraint", () => {
  it("defaults the intervention node to the L2 top constraint (#1 = wholesaler_orders)", () => {
    const graph = loadBeerFixture();
    const host = document.createElement("div");
    const panel = new Layer3Panel(host, graph);
    expect(nodeSelectValue(host)).toBe("wholesaler_orders");
    void panel;
  });

  it("re-derives the default node when weights change the #1 constraint", () => {
    const graph = loadBeerFixture();
    const host = document.createElement("div");
    const panel = new Layer3Panel(host, graph);
    expect(nodeSelectValue(host)).toBe("wholesaler_orders");

    // Delay-ratio-only weights make production_capacity the #1 constraint
    // (see tests/unit/layer2.test.ts slider-sensitivity case).
    panel.setWeights(DELAY_ONLY);
    expect(nodeSelectValue(host)).toBe("production_capacity");
  });

  it("leaves a manually chosen node alone when weights change", () => {
    const graph = loadBeerFixture();
    const host = document.createElement("div");
    const panel = new Layer3Panel(host, graph);
    // User explicitly picks a node that is NOT the top constraint.
    panel.setNode("wholesaler_backlog");
    expect(nodeSelectValue(host)).toBe("wholesaler_backlog");

    panel.setWeights(DELAY_ONLY);
    // Manual selection is respected: node unchanged despite #1 moving.
    expect(nodeSelectValue(host)).toBe("wholesaler_backlog");
  });

  it("renders three sparklines when enabled, and re-renders on weight change", () => {
    const graph = loadBeerFixture();
    const host = document.createElement("div");
    const panel = new Layer3Panel(host, graph);
    panel.enable();
    let svgs = host.querySelectorAll("svg.layer3-spark-svg");
    expect(svgs).toHaveLength(3);

    // Switching weights moves the node and re-renders while active.
    panel.setWeights(DELAY_ONLY);
    svgs = host.querySelectorAll("svg.layer3-spark-svg");
    expect(svgs).toHaveLength(3);
    expect(nodeSelectValue(host)).toBe("production_capacity");
  });
});

describe("Layer3Panel — applyNudge drives the intervention from a canvas nudge", () => {
  it("selects the nudged node and re-renders the sparklines", () => {
    const graph = loadBeerFixture();
    const host = document.createElement("div");
    const panel = new Layer3Panel(host, graph);
    panel.enable();
    expect(nodeSelectValue(host)).toBe("wholesaler_orders");

    panel.applyNudge("production_capacity", 1);
    expect(nodeSelectValue(host)).toBe("production_capacity");
    expect(host.querySelectorAll("svg.layer3-spark-svg")).toHaveLength(3);
  });

  it("sets the intervention delta sign from the nudge direction (same magnitude)", () => {
    const graph = loadBeerFixture();
    const host = document.createElement("div");
    const panel = new Layer3Panel(host, graph);
    panel.enable();
    const before = deltaSliderValue(host);

    panel.applyNudge("production_capacity", -1);
    expect(deltaSliderValue(host)).toBe(-Math.abs(before));

    panel.applyNudge("production_capacity", 1);
    expect(deltaSliderValue(host)).toBe(Math.abs(before));
  });

  it("locks the node: a later setWeights no longer auto-follows L2", () => {
    const graph = loadBeerFixture();
    const host = document.createElement("div");
    const panel = new Layer3Panel(host, graph);
    panel.enable();
    panel.applyNudge("wholesaler_backlog", 1);
    expect(nodeSelectValue(host)).toBe("wholesaler_backlog");

    panel.setWeights(DELAY_ONLY);
    expect(nodeSelectValue(host)).toBe("wholesaler_backlog");
  });
});
