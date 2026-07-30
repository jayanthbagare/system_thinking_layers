// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseGraphOrThrow } from "@/dsl/parser";
import { withComputedLoops } from "@/graph/loops";
import { attachProvenance, parseProvenance } from "@/provenance";
import { Layer3Panel } from "@/layer3/panel";
import type { Graph } from "@/model/types";

const yamlText = readFileSync("tests/fixtures/loom/order-backlog.yaml", "utf8");
const provText = readFileSync("tests/fixtures/loom/provenance.json", "utf8");

function loomGraph(): Graph {
  const base = withComputedLoops(parseGraphOrThrow(yamlText));
  return attachProvenance(base, parseProvenance(provText)).graph;
}
function plainGraph(): Graph {
  return withComputedLoops(parseGraphOrThrow(yamlText));
}

describe("Layer3Panel — Loom provenance (Phase 1 acceptance)", () => {
  it("shows the real-time-unit caption when a sidecar time unit is attached", () => {
    const host = document.createElement("div");
    const panel = new Layer3Panel(host, loomGraph());
    panel.enable();
    const cap = host.querySelector<HTMLElement>('[data-role="time-unit"]');
    expect(cap).not.toBeNull();
    expect(cap!.textContent).toContain("1 week");
    void panel;
  });

  it("offers a dollar-scaling toggle when a shared unit_value is present", () => {
    const host = document.createElement("div");
    const panel = new Layer3Panel(host, loomGraph());
    panel.enable();
    const group = host.querySelector<HTMLElement>(".layer3-unitscale-group");
    expect(group).not.toBeNull();
    const dollarsBtn = group!.querySelector<HTMLButtonElement>('[data-unit="dollars"]');
    expect(dollarsBtn).not.toBeNull();
    void panel;
  });

  it("renders no provenance controls for a hand-authored (no-sidecar) model", () => {
    const host = document.createElement("div");
    const panel = new Layer3Panel(host, plainGraph());
    panel.enable();
    expect(host.querySelector('[data-role="time-unit"]')).toBeNull();
    expect(host.querySelector(".layer3-unitscale-group")).toBeNull();
    void panel;
  });
});
