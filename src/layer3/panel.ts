/**
 * Layer 3 panel (spec §4).
 *
 * A vanilla-DOM panel bound to a `Graph`. It renders three sparklines (T, I, OE)
 * for pre/post intervention on a user-selected node, with step-size and
 * integrator-method controls. The intervention is a scalar shift to the
 * selected node's value — explicitly *simulated directional delta* only, with
 * no UI surface claiming financial precision (spec §4).
 *
 * Architecture rule: this panel holds no parallel state. Every render
 * re-derives the trajectory from `(Graph, intervention, options)` via the pure
 * `simulate` function. The only thing it owns is the current selection and
 * integrator settings (view parameters, not model state).
 */

import type { Graph, Node } from "@/model/types";
import { simulate, type Intervention, type IntegratorMethod } from "@/layer3";
import { sparkline, type SparklineSeries } from "@/layer3";
import { DEFAULT_WEIGHTS, topConstraints, type Weights } from "@/layer2/scoring";

const PRE_COLOR = "#9e9e9e";
const POST_COLOR = "#1976d2";
const STEPS_DEFAULT = 200;
const DT_DEFAULT = 0.1;
const DELTA_DEFAULT = 50;

const TIOE_META: { key: "T" | "I" | "OE"; label: string; description: string }[] = [
  { key: "T", label: "Throughput", description: "Sum of nodes tagged T" },
  { key: "I", label: "Investment / Inventory", description: "Sum of nodes tagged I" },
  { key: "OE", label: "Operating Expense", description: "Sum of nodes tagged OE" },
];

export class Layer3Panel {
  private readonly host: HTMLElement;
  private readonly graph: Graph;
  private nodeId: string;
  private weights: Weights = { ...DEFAULT_WEIGHTS };
  /** Once the user picks a node from the dropdown, stop auto-following L2. */
  private userSelectedNode = false;
  private dt = DT_DEFAULT;
  private method: IntegratorMethod = "rk4";
  private steps = STEPS_DEFAULT;
  private delta = DELTA_DEFAULT;
  private active = false;

  constructor(host: HTMLElement, graph: Graph) {
    this.host = host;
    this.graph = graph;
    this.host.classList.add("layer3-panel");
    // Default to the Layer 2 top-ranked constraint as the intervention node —
    // the spec frames Layer 3 as "what moving the constraint does." Re-derived
    // whenever weights change (see setWeights) unless the user picks a node.
    const top = topConstraints(graph, this.weights)[0];
    this.nodeId = top?.nodeId ?? graph.nodes[0]?.id ?? "";
    this.render();
  }

  /** Show the panel. */
  enable(): void {
    this.active = true;
    this.host.classList.add("is-active");
    this.renderTrajectory();
  }

  /** Hide the panel. */
  disable(): void {
    this.active = false;
    this.host.classList.remove("is-active");
  }

  toggle(): boolean {
    if (this.active) this.disable();
    else this.enable();
    return this.active;
  }

  /** Select a different intervention node. */
  setNode(nodeId: string): void {
    this.nodeId = nodeId;
    this.userSelectedNode = true;
    this.syncNodeSelect();
    this.renderTrajectory();
  }

  /**
   * Update the constraint weights and re-derive the default intervention node
   * from the Layer 2 top constraint. Sparklines don't depend on weights
   * directly — only on the selected node — so this only matters when the new
   * weights change which node is #1. A manually chosen node is left alone.
   */
  setWeights(w: Weights): void {
    this.weights = { ...w };
    if (this.userSelectedNode) return;
    const top = topConstraints(this.graph, this.weights)[0];
    const newId = top?.nodeId ?? this.graph.nodes[0]?.id ?? "";
    if (newId && newId !== this.nodeId) {
      this.nodeId = newId;
      this.syncNodeSelect();
      this.renderTrajectory();
    }
  }

  /**
   * React to a loopy-style nudge on the canvas (top half +, bottom half −).
   * Selects the nudged node as the intervention node (locking out L2
   * auto-follow, like an explicit dropdown pick) and sets the intervention
   * delta's sign from the nudge direction — keeping the current magnitude — so
   * the sparklines re-derive a fresh post trajectory. This is the bridge
   * between the Layer 1 animation and the Layer 3 quantitative view; it touches
   * only view parameters (node + delta), never parallel state, so `simulate`
   * still reads solely from `Graph`.
   */
  applyNudge(nodeId: string, direction: number): void {
    this.nodeId = nodeId;
    this.userSelectedNode = true;
    const mag = Math.abs(this.delta);
    this.delta = direction >= 0 ? mag : -mag;
    this.syncNodeSelect();
    this.syncDeltaSlider();
    this.renderTrajectory();
  }

  // --- rendering ---------------------------------------------------------

  private render(): void {
    this.host.innerHTML = "";
    this.host.append(this.renderHeader());
    this.host.append(this.renderControls());
    this.host.append(this.renderSparklines());
  }

  private renderHeader(): HTMLElement {
    const header = document.createElement("div");
    header.className = "layer3-header";
    const title = document.createElement("h2");
    title.textContent = "Layer 3 — T / I / OE";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "layer3-toggle";
    toggle.textContent = "Off";
    toggle.addEventListener("click", () => {
      this.toggle();
      toggle.textContent = this.active ? "On" : "Off";
      toggle.classList.toggle("is-on", this.active);
    });
    header.append(title, toggle);
    return header;
  }

  private renderControls(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "layer3-controls";

    // Node selector.
    const nodeRow = document.createElement("label");
    nodeRow.className = "layer3-control";
    const nodeLabel = document.createElement("span");
    nodeLabel.textContent = "Intervention node";
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
      this.userSelectedNode = true;
      this.renderTrajectory();
    });
    nodeRow.append(nodeLabel, select);
    wrap.append(nodeRow);

    // Delta (intervention magnitude).
    wrap.append(
      this.slider("delta", "Intervention \u0394", this.delta, -200, 200, 1, (v) => {
        this.delta = v;
        this.renderTrajectory();
      }),
    );

    // Step size.
    wrap.append(
      this.slider("dt", "Step size (dt)", this.dt, 0.01, 1, 0.01, (v) => {
        this.dt = v;
        this.renderTrajectory();
      }),
    );

    // Steps.
    wrap.append(
      this.slider("steps", "Steps", this.steps, 50, 2000, 50, (v) => {
        this.steps = v;
        this.renderTrajectory();
      }),
    );

    // Method toggle.
    const methodRow = document.createElement("div");
    methodRow.className = "layer3-control";
    const methodLabel = document.createElement("span");
    methodLabel.textContent = "Integrator";
    const methodGroup = document.createElement("div");
    methodGroup.className = "layer3-method-group";
    (["euler", "rk4"] as const).forEach((m) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = m === "rk4" ? "RK4" : "Euler";
      btn.dataset.method = m;
      btn.classList.toggle("is-selected", m === this.method);
      btn.addEventListener("click", () => {
        this.method = m;
        methodGroup
          .querySelectorAll("button")
          .forEach((b) => b.classList.toggle("is-selected", b.dataset.method === m));
        this.renderTrajectory();
      });
      methodGroup.append(btn);
    });
    methodRow.append(methodLabel, methodGroup);
    wrap.append(methodRow);

    return wrap;
  }

  private slider(
    role: string,
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void,
  ): HTMLElement {
    const row = document.createElement("label");
    row.className = "layer3-control";
    const span = document.createElement("span");
    span.textContent = label;
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.dataset.role = role;
    const val = document.createElement("span");
    val.className = "layer3-control-value";
    val.textContent = formatNumber(value);
    input.addEventListener("input", () => {
      const v = Number.parseFloat(input.value);
      if (!Number.isNaN(v)) {
        onChange(v);
        val.textContent = formatNumber(v);
      }
    });
    row.append(span, input, val);
    return row;
  }

  private renderSparklines(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "layer3-sparklines";
    wrap.dataset.role = "sparklines";
    const caption = document.createElement("p");
    caption.className = "layer3-caption";
    caption.textContent = "Pre (grey) vs. post (blue) intervention. Directional delta only.";
    wrap.append(caption);
    return wrap;
  }

  private renderTrajectory(): void {
    if (!this.active) return;
    const wrap = this.host.querySelector<HTMLElement>('[data-role="sparklines"]');
    if (!wrap) return;
    // Keep the caption; clear the rest.
    const caption = wrap.querySelector<HTMLElement>(".layer3-caption");
    wrap.innerHTML = "";
    if (caption) wrap.append(caption);

    const intervention: Intervention = {
      nodeId: this.nodeId,
      delta: this.delta,
    };
    const result = simulate(this.graph, {
      intervention,
      integrator: { dt: this.dt, method: this.method },
      steps: this.steps,
    });

    for (const meta of TIOE_META) {
      wrap.append(this.renderOneSparkline(result, meta));
    }
  }

  private renderOneSparkline(
    result: ReturnType<typeof simulate>,
    meta: { key: "T" | "I" | "OE"; label: string; description: string },
  ): HTMLElement {
    const card = document.createElement("div");
    card.className = "layer3-spark-card";
    const head = document.createElement("div");
    head.className = "layer3-spark-head";
    const label = document.createElement("span");
    label.className = "layer3-spark-label";
    label.textContent = `${meta.key} \u00b7 ${meta.label}`;
    label.title = meta.description;
    const delta = document.createElement("span");
    delta.className = "layer3-spark-delta";
    const preEnd = result.pre.series[result.pre.series.length - 1][meta.key];
    const postEnd = result.post.series[result.post.series.length - 1][meta.key];
    const d = postEnd - preEnd;
    delta.textContent = `\u0394 ${d >= 0 ? "+" : ""}${d.toFixed(2)}`;
    delta.classList.toggle("is-up", d > 0);
    delta.classList.toggle("is-down", d < 0);
    head.append(label, delta);

    const series: SparklineSeries[] = [
      {
        label: "pre",
        color: PRE_COLOR,
        points: result.pre.series.map((s, i) => ({ x: result.pre.times[i], y: s[meta.key] })),
      },
      {
        label: "post",
        color: POST_COLOR,
        points: result.post.series.map((s, i) => ({ x: result.post.times[i], y: s[meta.key] })),
      },
    ];
    const sl = sparkline(series, { width: 260, height: 48 });

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", sl.viewBox);
    svg.setAttribute("class", "layer3-spark-svg");
    svg.setAttribute("preserveAspectRatio", "none");
    for (const p of sl.paths) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", p.d);
      path.setAttribute("stroke", p.color);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke-width", "1.5");
      path.setAttribute("stroke-linejoin", "round");
      path.setAttribute("stroke-linecap", "round");
      svg.append(path);
    }
    card.append(head, svg);
    return card;
  }

  private syncNodeSelect(): void {
    const sel = this.host.querySelector<HTMLSelectElement>('[data-role="node-select"]');
    if (sel) sel.value = this.nodeId;
  }

  /** Keep the delta slider + its readout in sync with `this.delta`. */
  private syncDeltaSlider(): void {
    const input = this.host.querySelector<HTMLInputElement>('[data-role="delta"]');
    if (input) input.value = String(this.delta);
    const val = input?.parentElement?.querySelector(".layer3-control-value");
    if (val) (val as HTMLElement).textContent = formatNumber(this.delta);
  }
}

function formatNumber(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}

export type { Node };
