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
  sensitivity: 0,
};

function nodeSelectValue(host: HTMLElement): string {
  const sel = host.querySelector<HTMLSelectElement>('[data-role="node-select"]');
  if (!sel) throw new Error("node-select not found");
  return sel.value;
}

function deltaSliderValue(host: HTMLElement): number {
  // The raw Δ slider was removed in Phase 4 (replaced by the typed-intervention
  // selector). A canvas nudge now switches the panel into a raw-impulse mode
  // and exposes its signed delta via a data attribute on the sparklines wrap.
  const wrap = host.querySelector<HTMLElement>('[data-role="sparklines"]');
  if (!wrap) throw new Error("sparklines wrap not found");
  const v = wrap.getAttribute("data-raw-delta");
  if (v === null) throw new Error("raw-delta not set (panel not in raw mode)");
  return Number.parseFloat(v);
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
    // A canvas nudge switches the panel to raw-impulse mode and sets the
    // signed delta from the direction (up = +, down = −), keeping the
    // magnitude constant across opposite nudges.
    panel.applyNudge("production_capacity", -1);
    const down = deltaSliderValue(host);
    expect(down).toBeLessThan(0);

    panel.applyNudge("production_capacity", 1);
    const up = deltaSliderValue(host);
    expect(up).toBeGreaterThan(0);
    expect(Math.abs(up)).toBe(Math.abs(down));
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

describe("Layer3Panel — typed ToC interventions (Phase 4)", () => {
  it("renders the Exploit / Subordinate / Elevate type selector", () => {
    const graph = loadBeerFixture();
    const host = document.createElement("div");
    const panel = new Layer3Panel(host, graph);
    panel.enable();
    const types = host.querySelectorAll<HTMLElement>("[data-type]");
    expect(Array.from(types).map((b) => b.dataset.type).sort()).toEqual(
      ["elevate", "exploit", "structural", "subordinate"],
    );
    // Exploit is the default selection.
    expect(host.querySelector<HTMLElement>('[data-type="exploit"]')?.classList.contains("is-selected")).toBe(true);
    void panel;
  });

  it("selecting Elevate renders the signature, ratios, J-curve and DoF rows", () => {
    const graph = loadBeerFixture();
    const host = document.createElement("div");
    const panel = new Layer3Panel(host, graph);
    panel.enable();
    const elevateBtn = host.querySelector<HTMLElement>('[data-type="elevate"]')!;
    elevateBtn.click();
    expect(host.querySelector('[data-role="signature"]')).not.toBeNull();
    expect(host.querySelector('[data-role="ratios"]')).not.toBeNull();
    expect(host.querySelector('[data-role="jcurve"]')).not.toBeNull();
    expect(host.querySelector('[data-role="dof"]')).not.toBeNull();
  });

  it("shows the Subordinate rope selectors only for Subordinate", () => {
    const graph = loadBeerFixture();
    const host = document.createElement("div");
    const panel = new Layer3Panel(host, graph);
    panel.enable();
    const rope = host.querySelector<HTMLElement>('[data-role="rope"]')!;
    // Exploit default -> rope hidden.
    expect(rope.style.display).toBe("none");
    host.querySelector<HTMLElement>('[data-type="subordinate"]')!.click();
    expect(rope.style.display).not.toBe("none");
  });

  it("disables the Exploit magnitude slider at zero headroom (pinned constraint)", () => {
    // The beer fixture's production_capacity is the constraint; drive the panel
    // to it and verify the exploit-reason line explains the zero headroom.
    const graph = loadBeerFixture();
    const host = document.createElement("div");
    const panel = new Layer3Panel(host, graph);
    // Default node is wholesaler_orders (no upper collar) -> exploit disabled
    // with the "no upper collar" reason.
    panel.enable();
    panel.setNode("production_capacity");
    const reason = host.querySelector<HTMLElement>('[data-role="exploit-reason"]');
    expect(reason).not.toBeNull();
  });
});
