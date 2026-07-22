/**
 * Phase 5 — ABM companion view panel (spec §5).
 *
 * A separate pane (not an overlay) bound to a node. Authors an agent
 * population, runs the ABM in a Web Worker, validates the aggregate against
 * the bound node's loops, and writes the `AbmVerdict` back onto the Graph's
 * node (single source of truth). Perturbation re-runs update the macro verdict
 * (held / weakened / bifurcated).
 *
 * Architecture rule: the panel holds no parallel state. The verdict is written
 * onto `Node.abm_verdict` on the `Graph`; the panel only owns UI inputs (rule,
 * topology, params, seed), which are view parameters, not model state.
 */

import type { AbmVerdict, Graph, Node } from "@/model/types";
import { AbmClient } from "./client";
import type { AbmResult, AgentPopulation, RuleKind, Topology } from "./engine";
import {
  macroBehavior,
  perturbationVerdict,
  ruleExpectedBehavior,
  validateAbm,
} from "./validate";

const STEPS = 300;
const RULE_LABELS: Record<RuleKind, string> = {
  reorder_policy: "Reorder policy (reinforcing)",
  capacity_threshold: "Capacity threshold (balancing)",
  info_passing_delay: "Info-passing delay",
};
const TOPOLOGY_LABELS: Record<Topology, string> = {
  well_mixed: "Well-mixed",
  lattice: "Lattice (ring)",
  network: "Network (random)",
};

export interface AbmPanelOptions {
  onVerdict?: (nodeId: string, verdict: AbmVerdict) => void;
}

export class AbmPanel {
  private readonly host: HTMLElement;
  private readonly graph: Graph;
  private readonly client: AbmClient;
  private readonly onVerdict: ((nodeId: string, verdict: AbmVerdict) => void) | undefined;
  private nodeId: string;
  private rule: RuleKind = "reorder_policy";
  private topology: Topology = "well_mixed";
  private sensitivity = 1.2;
  private delay = 1;
  private seed = 42;
  private agentCount = 1000;
  private perturbation = 0;
  private baseline: AbmResult | null = null;
  private running = false;

  constructor(host: HTMLElement, graph: Graph, opts: AbmPanelOptions = {}) {
    this.host = host;
    this.graph = graph;
    this.client = new AbmClient();
    this.onVerdict = opts.onVerdict;
    this.nodeId = graph.nodes[0]?.id ?? "";
    this.host.classList.add("abm-panel");
    this.render();
  }

  /** Open the pane bound to a specific node. */
  bindNode(nodeId: string): void {
    this.nodeId = nodeId;
    this.syncNodeSelect();
    this.baseline = null;
    this.clearVerdict();
  }

  destroy(): void {
    this.client.destroy();
  }

  // --- rendering ---------------------------------------------------------

  private render(): void {
    this.host.innerHTML = "";
    this.host.append(this.renderHeader());
    this.host.append(this.renderControls());
    this.host.append(this.renderRunSection());
  }

  private renderHeader(): HTMLElement {
    const header = document.createElement("div");
    header.className = "abm-header";
    const title = document.createElement("h2");
    title.textContent = "ABM Companion";
    header.append(title);
    return header;
  }

  private renderControls(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "abm-controls";

    const nodeRow = document.createElement("label");
    nodeRow.className = "abm-control";
    nodeRow.append(this.makeLabel("Bound node"));
    const select = document.createElement("select");
    select.dataset.role = "node-select";
    for (const n of this.graph.nodes) {
      const opt = document.createElement("option");
      opt.value = n.id;
      opt.textContent = n.label;
      if (n.id === this.nodeId) opt.selected = true;
      select.append(opt);
    }
    select.addEventListener("change", () => {
      this.nodeId = select.value;
      this.baseline = null;
      this.clearVerdict();
    });
    nodeRow.append(select);
    wrap.append(nodeRow);

    wrap.append(this.makeSelect("rule", "Rule", RULE_LABELS, this.rule, (v) => {
      this.rule = v as RuleKind;
    }));
    wrap.append(this.makeSelect("topology", "Topology", TOPOLOGY_LABELS, this.topology, (v) => {
      this.topology = v as Topology;
    }));
    wrap.append(this.makeSlider("sensitivity", "Sensitivity", this.sensitivity, 0, 3, 0.05, (v) => {
      this.sensitivity = v;
    }));
    wrap.append(this.makeSlider("delay", "Delay (steps)", this.delay, 0, 10, 1, (v) => {
      this.delay = v;
    }));
    wrap.append(this.makeSlider("agents", "Agent count", this.agentCount, 100, 10000, 100, (v) => {
      this.agentCount = v;
    }));
    wrap.append(this.makeSlider("seed", "Seed", this.seed, 0, 999, 1, (v) => {
      this.seed = v;
    }));

    return wrap;
  }

  private renderRunSection(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "abm-run-section";
    wrap.dataset.role = "run-section";

    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "abm-run-btn";
    runBtn.textContent = "Run validation";
    runBtn.addEventListener("click", () => void this.run());
    wrap.append(runBtn);

    const perturbRow = document.createElement("div");
    perturbRow.className = "abm-perturb";
    perturbRow.append(this.makeSlider("perturbation", "Perturbation \u0394sensitivity", this.perturbation, -1, 1, 0.05, (v) => {
      this.perturbation = v;
    }));
    const perturbBtn = document.createElement("button");
    perturbBtn.type = "button";
    perturbBtn.className = "abm-perturb-btn";
    perturbBtn.textContent = "Perturb & re-run";
    perturbBtn.disabled = true;
    perturbBtn.dataset.role = "perturb-btn";
    perturbBtn.addEventListener("click", () => void this.runPerturbed());
    perturbRow.append(perturbBtn);
    wrap.append(perturbRow);

    const status = document.createElement("div");
    status.className = "abm-status";
    status.dataset.role = "status";
    wrap.append(status);

    return wrap;
  }

  // --- run ---------------------------------------------------------------

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.setStatus("Running\u2026");
    const pop = this.currentPopulation();
    try {
      this.baseline = await this.client.run({ population: pop, steps: STEPS });
      const verdict = validateAbm({ graph: this.graph, result: this.baseline });
      this.writeVerdict(verdict);
      this.enablePerturb();
      const behavior = macroBehavior(this.baseline.series);
      this.setStatus(
        `${verdict.status === "validated" ? "\u2705 Validated" : "\u26a0\ufe0f Flagged"} \u2014 ${behavior} behavior. ${verdict.detail}`,
      );
    } catch (err) {
      this.setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }

  private async runPerturbed(): Promise<void> {
    if (this.running || !this.baseline) return;
    this.running = true;
    this.setStatus("Perturbing\u2026");
    const pop = this.currentPopulation(this.perturbation);
    try {
      const perturbed = await this.client.run({ population: pop, steps: STEPS });
      const macro = perturbationVerdict({ baseline: this.baseline, perturbed });
      const baseBehavior = macroBehavior(this.baseline.series);
      const pertBehavior = macroBehavior(perturbed.series);
      const verdict: AbmVerdict = {
        status: macro === "bifurcated" ? "flagged" : "validated",
        detail: `Perturbation: macro ${macro}. Baseline ${baseBehavior} \u2192 perturbed ${pertBehavior}.`,
        macro,
      };
      this.writeVerdict(verdict);
      this.setStatus(`Macro verdict: ${macro}. ${verdict.detail}`);
    } catch (err) {
      this.setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }

  private writeVerdict(verdict: AbmVerdict): void {
    const idx = this.graph.nodes.findIndex((n: Node) => n.id === this.nodeId);
    if (idx >= 0) {
      this.graph.nodes[idx] = { ...this.graph.nodes[idx], abm_verdict: verdict };
    }
    this.onVerdict?.(this.nodeId, verdict);
    this.renderVerdictBadge(verdict);
  }

  private clearVerdict(): void {
    const idx = this.graph.nodes.findIndex((n: Node) => n.id === this.nodeId);
    if (idx >= 0) {
      const { abm_verdict: _drop, ...rest } = this.graph.nodes[idx];
      void _drop;
      this.graph.nodes[idx] = rest;
    }
    this.renderVerdictBadge(null);
  }

  private renderVerdictBadge(verdict: AbmVerdict | null): void {
    const host = this.host.querySelector<HTMLElement>('[data-role="status"]');
    if (host && verdict) {
      host.classList.toggle("is-validated", verdict.status === "validated");
      host.classList.toggle("is-flagged", verdict.status === "flagged");
    }
  }

  // --- helpers -----------------------------------------------------------

  private currentPopulation(perturbation = 0): AgentPopulation {
    return {
      boundNode: this.nodeId,
      agentCount: this.agentCount,
      rule: this.rule,
      topology: this.topology,
      params: { sensitivity: this.sensitivity + perturbation, delay: this.delay },
      seed: this.seed,
    };
  }

  private setStatus(msg: string): void {
    const el = this.host.querySelector<HTMLElement>('[data-role="status"]');
    if (el) el.textContent = msg;
  }

  private enablePerturb(): void {
    const btn = this.host.querySelector<HTMLButtonElement>('[data-role="perturb-btn"]');
    if (btn) btn.disabled = false;
  }

  private syncNodeSelect(): void {
    const sel = this.host.querySelector<HTMLSelectElement>('[data-role="node-select"]');
    if (sel) sel.value = this.nodeId;
  }

  private makeLabel(text: string): HTMLElement {
    const span = document.createElement("span");
    span.textContent = text;
    return span;
  }

  private makeSlider(
    role: string,
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void,
  ): HTMLElement {
    const row = document.createElement("label");
    row.className = "abm-control";
    row.append(this.makeLabel(label));
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.dataset.role = role;
    const val = document.createElement("span");
    val.className = "abm-control-value";
    val.textContent = formatNum(value);
    input.addEventListener("input", () => {
      const v = Number.parseFloat(input.value);
      if (!Number.isNaN(v)) {
        onChange(v);
        val.textContent = formatNum(v);
      }
    });
    row.append(input, val);
    return row;
  }

  private makeSelect(
    role: string,
    label: string,
    options: Record<string, string>,
    value: string,
    onChange: (v: string) => void,
  ): HTMLElement {
    const row = document.createElement("label");
    row.className = "abm-control";
    row.append(this.makeLabel(label));
    const select = document.createElement("select");
    select.dataset.role = role;
    for (const [val, text] of Object.entries(options)) {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = text;
      if (val === value) opt.selected = true;
      select.append(opt);
    }
    select.addEventListener("change", () => onChange(select.value));
    row.append(select);
    return row;
  }
}

function formatNum(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}

export { ruleExpectedBehavior };
