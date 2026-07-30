// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { parseGraphOrThrow } from "@/dsl/parser";
import { withComputedLoops } from "@/graph/loops";
import { attachProvenance, parseProvenance, rankAbmPriority, ProvenanceDetailPanel } from "@/provenance";
import type { Graph } from "@/model/types";

const yamlText = readFileSync("tests/fixtures/loom/order-backlog.yaml", "utf8");
const provText = readFileSync("tests/fixtures/loom/provenance.json", "utf8");

function loomGraph(): Graph {
  return attachProvenance(withComputedLoops(parseGraphOrThrow(yamlText)), parseProvenance(provText)).graph;
}
function plainGraph(): Graph {
  return withComputedLoops(parseGraphOrThrow(yamlText));
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("ABM validation priority (Loom spec item 5)", () => {
  it("ranks low-confidence and support-mismatched elements first", () => {
    const entries = rankAbmPriority(loomGraph());
    expect(entries.length).toBeGreaterThan(0);
    // The edge d2 has a structural_support mismatch (causal true, structural
    // false) -> it should rank highly.
    const d2 = entries.find((e) => e.id === "d2");
    expect(d2).toBeDefined();
    expect(d2!.reason).toContain("mismatch");
    // customer_demand is low confidence (0.62) and unclassified -> top node.
    const demand = entries.find((e) => e.id === "customer_demand");
    expect(demand).toBeDefined();
    expect(demand!.reason).toContain("low confidence");
    // The list is sorted by descending priority.
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i - 1].priority).toBeGreaterThanOrEqual(entries[i].priority);
    }
  });

  it("returns nothing for a hand-authored (no-sidecar) model", () => {
    expect(rankAbmPriority(plainGraph())).toEqual([]);
  });
});

describe("provenance detail panel (Loom spec item 6)", () => {
  it("opens for a node with provenance and shows its evidence", () => {
    const panel = new ProvenanceDetailPanel(loomGraph());
    panel.open("node", "order_backlog");
    const dialog = document.body.querySelector("dialog.provenance-modal");
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("Order Backlog");
    expect(dialog!.textContent).toContain("causal_discovery");
    expect(dialog!.textContent).toContain("0.910");
    expect(dialog!.textContent).toContain("Inventory");
    // Reasoning text is surfaced inline.
    expect(dialog!.textContent).toContain("in-system WIP");
    dialog!.remove();
  });

  it("opens for an edge with provenance and shows support flags", () => {
    const panel = new ProvenanceDetailPanel(loomGraph());
    panel.open("edge", "d2");
    const dialog = document.body.querySelector("dialog.provenance-modal");
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("Causal support");
    expect(dialog!.textContent).toContain("Structural support");
    dialog!.remove();
  });

  it("is a no-op for an element without provenance", () => {
    const panel = new ProvenanceDetailPanel(plainGraph());
    panel.open("node", "order_backlog");
    expect(document.body.querySelector("dialog.provenance-modal")).toBeNull();
  });
});

describe("distinct unclassified state (Loom spec item 7)", () => {
  it("marks customer_demand as unclassified (tioeClass none), distinct from T/I/OE", () => {
    const g = loomGraph();
    const demand = g.nodes.find((n) => n.id === "customer_demand")!;
    expect(demand.provenance?.tioeClass).toBe("none");
    // The other nodes are real classes, not none.
    expect(g.nodes.find((n) => n.id === "order_backlog")!.provenance?.tioeClass).toBe("I");
    expect(g.nodes.find((n) => n.id === "production_rate")!.provenance?.tioeClass).toBe("T");
  });

  it("the model-level provenance records an unclassified count + suggestions flag", () => {
    const g = loomGraph();
    expect(g.provenance?.unclassifiedCount).toBe(1);
    expect(g.provenance?.hasSuggestions).toBe(true);
  });
});
