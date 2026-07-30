// @vitest-environment jsdom
/**
 * Loom spec item 11 — cross-repo integration test.
 *
 * Loads the shared synthetic order-backlog example both repos use, with its
 * Loom sidecar bundle, and asserts the seam between the two repos actually
 * works: provenance attaches (renders), the time-unit caption appears in
 * Layer 3, `unit_value` scaling is numerically correct in Layer 3's T/I/OE
 * trajectory, and nothing crashes. This is the test that verifies the
 * integration in the round — as opposed to each repo's own suite passing in
 * isolation.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseGraphOrThrow } from "@/dsl/parser";
import { withComputedLoops } from "@/graph/loops";
import { attachProvenance, parseProvenance, hasProvenance, unitValueSummary, scaleTioeSnapshot } from "@/provenance";
import { simulate, deriveTioe } from "@/layer3";
import { initialState, run, DEFAULT_ENGINE_OPTIONS } from "@/sim";
import { Layer3Panel } from "@/layer3/panel";
import type { Graph } from "@/model/types";

const yamlText = readFileSync("tests/fixtures/loom/order-backlog.yaml", "utf8");
const provText = readFileSync("tests/fixtures/loom/provenance.json", "utf8");

function loadLoomBundle(): Graph {
  const base = withComputedLoops(parseGraphOrThrow(yamlText));
  return attachProvenance(base, parseProvenance(provText)).graph;
}

describe("cross-repo Loom integration (item 11)", () => {
  it("attaches provenance from the sidecar bundle onto the model", () => {
    const g = loadLoomBundle();
    expect(hasProvenance(g)).toBe(true);
    expect(g.nodes.find((n) => n.id === "order_backlog")!.provenance?.mined).toBe(true);
    expect(g.provenance?.timeUnit).toBe("1 week");
  });

  it("renders the time-unit caption in Layer 3 without crashing", () => {
    const g = loadLoomBundle();
    const host = document.createElement("div");
    const panel = new Layer3Panel(host, g);
    panel.enable();
    expect(() => panel.enable()).not.toThrow();
    const cap = host.querySelector<HTMLElement>('[data-role="time-unit"]');
    expect(cap).not.toBeNull();
    expect(cap!.textContent).toContain("1 week");
  });

  it("unit_value scaling is numerically correct in the Layer 3 trajectory", () => {
    const g = loadLoomBundle();
    const summary = unitValueSummary(g);
    expect(summary.single).toBe(12.5);
    // Run the physical T/I/OE trajectory from the engine.
    const opts = DEFAULT_ENGINE_OPTIONS;
    const states = run(g, initialState(g, opts), opts, 50);
    const physical = states.map((s) => deriveTioe(g, s));
    // The dollar trajectory must be exactly the physical one × unit_value at
    // every step — never the raw physical quantity dressed up as dollars
    // (Loom spec item 4, the correctness-critical one).
    const dollars = physical.map((s) => scaleTioeSnapshot(s, summary.single!));
    for (let i = 0; i < physical.length; i++) {
      expect(dollars[i].T).toBeCloseTo(physical[i].T * 12.5, 6);
      expect(dollars[i].I).toBeCloseTo(physical[i].I * 12.5, 6);
      expect(dollars[i].OE).toBeCloseTo(physical[i].OE * 12.5, 6);
    }
  });

  it("a hand-authored model (no sidecar) does not crash and shows no provenance UI", () => {
    const g = withComputedLoops(parseGraphOrThrow(yamlText));
    expect(hasProvenance(g)).toBe(false);
    const host = document.createElement("div");
    const panel = new Layer3Panel(host, g);
    expect(() => panel.enable()).not.toThrow();
    expect(host.querySelector('[data-role="time-unit"]')).toBeNull();
    expect(host.querySelector(".layer3-unitscale-group")).toBeNull();
  });
});

void simulate;