/**
 * Layer 3 panel (spec §4 + Phase 4 — typed ToC interventions).
 *
 * A vanilla-DOM panel bound to a `Graph`. It renders three sparklines (T, I, OE)
 * for a pre/post intervention, plus the Phase-4 typed-intervention analysis:
 *   - an intervention-type selector (Exploit / Subordinate / Elevate) mapping
 *     each ToC step onto a collar operation,
 *   - the expected vs observed T/I/OE signature,
 *   - TA decision ratios (ΔT/ΔOE, ΔT/ΔI, ΔT per constraint time, payback),
 *   - the J-curve (worse-before-better) depth and duration,
 *   - the degrees-of-freedom change.
 *
 * Exploit is capped at available headroom and disabled at zero headroom — the
 * ToC discipline that tier-1 (Exploit) must be exhausted before tier-2
 * (Elevate) is paid for, made mechanical (spec §4.1, §6.3).
 *
 * Architecture rule: this panel holds no parallel state. Every render
 * re-derives the trajectory from `(Graph, intervention, options)` via the pure
 * `simulateTyped` function. The only things it owns are the current selection,
 * intervention type/magnitude, and integrator settings — view parameters, not
 * model state. The canvas nudge (Phase 1 bridge) drives a raw impulse through
 * the same engine and is rendered as an untyped pre/post probe.
 */

import type { Graph, Node } from "@/model/types";
import {
  simulate,
  simulateTyped,
  clampExploitMagnitude,
  operatingHeadroom,
  type Intervention,
  type IntegratorMethod,
  type TypedIntervention,
  type InterventionType,
  type Direction,
  type TypedSimulationResult,
} from "@/layer3";
import { sparkline, type SparklineSeries } from "@/layer3";
import { DEFAULT_WEIGHTS, topConstraints, type Weights } from "@/layer2/scoring";

const PRE_COLOR = "#9e9e9e";
const POST_COLOR = "#1976d2";
const STEPS_DEFAULT = 200;
const DT_DEFAULT = 0.1;
const MAGNITUDE_DEFAULT = 20;

const TYPE_LABELS: Record<InterventionType, string> = {
  exploit: "Exploit",
  subordinate: "Subordinate",
  elevate: "Elevate",
};

const TYPE_BLURB: Record<InterventionType, string> = {
  exploit: "Close the gap to the existing upper collar. The collar does not move.",
  subordinate: "Add a rope: a negative edge from a downstream buffer to the upstream release.",
  elevate: "Move the upper collar up. OE rises (more flow through the constraint).",
};

const TIOE_META: { key: "T" | "I" | "OE"; label: string; description: string }[] = [
  { key: "T", label: "Throughput", description: "Rate of flow across the system boundary (outbound delivery, or inbound demand when no outbound edges exist)" },
  { key: "I", label: "Inventory / Investment", description: "Total stock mass + in-flight material inside the system boundary" },
  { key: "OE", label: "Operating Expense", description: "Flow through constrained resources (collared stocks) inside the system" },
];

/** "raw" = canvas nudge probe (untyped impulse); "typed" = a ToC intervention. */
type PanelMode = "raw" | "typed";

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

  // Typed intervention state (view parameters).
  private type: InterventionType = "exploit";
  private magnitude = MAGNITUDE_DEFAULT;
  /** Subordinate rope endpoints. Defaults are filled from the graph on first render. */
  private rope: { buffer: string; release: string } = { buffer: "", release: "" };

  // Raw-impulse state for the canvas-nudge probe (Phase 1 bridge).
  private mode: PanelMode = "typed";
  private rawDelta = 50;

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
    this.initRopeDefaults();
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
    this.initRopeDefaults();
    this.syncNodeSelect();
    this.clampMagnitudeToHeadroom();
    this.renderTrajectory();
  }

  /**
   * Update the constraint weights and re-derive the default intervention node
   * from the Layer 2 top constraint. A manually chosen node is left alone.
   */
  setWeights(w: Weights): void {
    this.weights = { ...w };
    if (this.userSelectedNode) return;
    const top = topConstraints(this.graph, this.weights)[0];
    const newId = top?.nodeId ?? this.graph.nodes[0]?.id ?? "";
    if (newId && newId !== this.nodeId) {
      this.nodeId = newId;
      this.initRopeDefaults();
      this.syncNodeSelect();
      this.clampMagnitudeToHeadroom();
      this.renderTrajectory();
    }
  }

  /**
   * React to a loopy-style up/down-arrow nudge on the canvas (Phase 1 bridge).
   * A nudge is an *untyped* impulse — it is NOT a ToC intervention — so it
   * switches the panel into the raw-probe mode: pre/post sparklines from a
   * plain `engine.impulse`, without the signature analysis. Selects the nudged
   * node (locking out L2 auto-follow) and re-derives a fresh post trajectory.
   * The L1 nudge and an equivalent raw L3 Δ both call the same engine impulse,
   * so the trajectories are identical (Phase 1 acceptance).
   */
  applyNudge(nodeId: string, direction: number): void {
    this.nodeId = nodeId;
    this.userSelectedNode = true;
    this.mode = "raw";
    const mag = Math.abs(this.rawDelta);
    this.rawDelta = direction >= 0 ? mag : -mag;
    this.initRopeDefaults();
    this.syncNodeSelect();
    this.syncModeToggle();
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

    // Intervention type selector (replaces the raw Δ slider, spec §4.1).
    const typeRow = document.createElement("div");
    typeRow.className = "layer3-control";
    const typeLabel = document.createElement("span");
    typeLabel.textContent = "Intervention";
    const typeGroup = document.createElement("div");
    typeGroup.className = "layer3-type-group";
    (["exploit", "subordinate", "elevate"] as InterventionType[]).forEach((t) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = TYPE_LABELS[t];
      btn.dataset.type = t;
      btn.title = TYPE_BLURB[t];
      btn.classList.toggle("is-selected", t === this.type);
      btn.addEventListener("click", () => {
        this.type = t;
        this.mode = "typed";
        typeGroup
          .querySelectorAll("button")
          .forEach((b) => b.classList.toggle("is-selected", b.dataset.type === t));
        this.syncModeToggle();
        this.clampMagnitudeToHeadroom();
        this.renderTrajectory();
      });
      typeGroup.append(btn);
    });
    typeRow.append(typeLabel, typeGroup);
    wrap.append(typeRow);

    // Node selector.
    wrap.append(this.renderNodeSelect());

    // Subordinate rope selectors (only meaningful for subordinate).
    wrap.append(this.renderRopeSelectors());

    // Magnitude slider (range adapts to the intervention type / headroom).
    wrap.append(this.renderMagnitudeSlider());

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

  private renderNodeSelect(): HTMLElement {
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
      this.initRopeDefaults();
      this.clampMagnitudeToHeadroom();
      this.renderTrajectory();
    });
    nodeRow.append(nodeLabel, select);
    return nodeRow;
  }

  private renderRopeSelectors(): HTMLElement {
    const row = document.createElement("div");
    row.className = "layer3-control layer3-rope";
    row.dataset.role = "rope";
    row.style.display = this.type === "subordinate" ? "" : "none";
    const label = document.createElement("span");
    label.textContent = "Rope: buffer \u2192 release";
    const bufferSel = document.createElement("select");
    bufferSel.dataset.role = "rope-buffer";
    const releaseSel = document.createElement("select");
    releaseSel.dataset.role = "rope-release";
    for (const n of this.graph.nodes) {
      const b = document.createElement("option");
      b.value = n.id;
      b.textContent = n.label;
      if (n.id === this.rope.buffer) b.selected = true;
      bufferSel.append(b);
      const r = document.createElement("option");
      r.value = n.id;
      r.textContent = n.label;
      if (n.id === this.rope.release) r.selected = true;
      releaseSel.append(r);
    }
    bufferSel.addEventListener("change", () => {
      this.rope.buffer = bufferSel.value;
      this.renderTrajectory();
    });
    releaseSel.addEventListener("change", () => {
      this.rope.release = releaseSel.value;
      this.renderTrajectory();
    });
    row.append(label, bufferSel, releaseSel);
    return row;
  }

  private renderMagnitudeSlider(): HTMLElement {
    const range = this.magnitudeRange();
    const row = document.createElement("label");
    row.className = "layer3-control";
    const span = document.createElement("span");
    span.textContent = "Magnitude";
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);
    input.value = String(this.magnitude);
    input.dataset.role = "magnitude";
    input.disabled = range.disabled;
    const val = document.createElement("span");
    val.className = "layer3-control-value";
    val.textContent = formatNumber(this.magnitude);
    input.addEventListener("input", () => {
      const v = Number.parseFloat(input.value);
      if (!Number.isNaN(v)) {
        this.magnitude = v;
        val.textContent = formatNumber(v);
        this.renderTrajectory();
      }
    });
    row.append(span, input, val);

    // Exploit headroom cap reason line.
    if (this.type === "exploit") {
      const reason = this.exploitReason();
      if (reason) {
        const note = document.createElement("p");
        note.className = "layer3-reason";
        note.dataset.role = "exploit-reason";
        note.textContent = reason;
        row.append(note);
      }
    }
    return row;
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

  // --- trajectory --------------------------------------------------------

  private renderTrajectory(): void {
    if (!this.active) return;
    const wrap = this.host.querySelector<HTMLElement>('[data-role="sparklines"]');
    if (!wrap) return;
    wrap.innerHTML = "";
    const caption = document.createElement("p");
    caption.className = "layer3-caption";
    if (this.mode === "typed") {
      caption.textContent = `${TYPE_LABELS[this.type]} \u00b7 ${TYPE_BLURB[this.type]}`;
      wrap.removeAttribute("data-raw-delta");
    } else {
      caption.textContent = `Raw impulse (canvas nudge): \u0394 ${this.rawDelta >= 0 ? "+" : ""}${formatNumber(this.rawDelta)}. Directional delta only.`;
      wrap.setAttribute("data-raw-delta", String(this.rawDelta));
    }
    wrap.append(caption);

    if (this.mode === "typed") {
      this.renderTyped(wrap);
    } else {
      this.renderRaw(wrap);
    }
  }

  private renderTyped(wrap: HTMLElement): void {
    const iv: TypedIntervention = {
      type: this.type,
      target: this.nodeId,
      magnitude: this.magnitude,
      ...(this.type === "subordinate" ? { rope: this.rope } : {}),
    };
    const result = simulateTyped(
      this.graph,
      iv,
      { dt: this.dt, method: this.method },
      this.steps,
    );
    for (const meta of TIOE_META) wrap.append(this.renderOneSparkline(result.pre, result.post, meta));
    wrap.append(this.renderSignatureRow(result));
    wrap.append(this.renderRatiosRow(result));
    wrap.append(this.renderJCurveRow(result));
    wrap.append(this.renderDofRow(result));
  }

  private renderRaw(wrap: HTMLElement): void {
    const intervention: Intervention = { nodeId: this.nodeId, delta: this.rawDelta };
    const result = simulate(this.graph, {
      intervention,
      integrator: { dt: this.dt, method: this.method },
      steps: this.steps,
    });
    for (const meta of TIOE_META) {
      wrap.append(this.renderOneSparkline(result.pre.series, result.post.series, meta));
    }
  }

  private renderOneSparkline(
    pre: { T: number; I: number; OE: number }[],
    post: { T: number; I: number; OE: number }[],
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
    const preEnd = pre[pre.length - 1][meta.key];
    const postEnd = post[post.length - 1][meta.key];
    const d = postEnd - preEnd;
    delta.textContent = `\u0394 ${d >= 0 ? "+" : ""}${d.toFixed(2)}`;
    delta.classList.toggle("is-up", d > 0);
    delta.classList.toggle("is-down", d < 0);
    head.append(label, delta);

    const xs = pre.map((_, i) => i);
    const series: SparklineSeries[] = [
      { label: "pre", color: PRE_COLOR, points: pre.map((s, i) => ({ x: xs[i], y: s[meta.key] })) },
      { label: "post", color: POST_COLOR, points: post.map((s, i) => ({ x: xs[i], y: s[meta.key] })) },
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

  private renderSignatureRow(result: TypedSimulationResult): HTMLElement {
    const row = document.createElement("div");
    row.className = "layer3-analysis-row layer3-signature";
    row.dataset.role = "signature";
    const title = document.createElement("span");
    title.className = "layer3-analysis-title";
    title.textContent = "Signature";
    row.append(title);
    (["T", "I", "OE"] as const).forEach((k) => {
      const exp = result.expected[k];
      const obs = result.observed[k];
      const ok = result.agreement[k];
      const chip = document.createElement("span");
      chip.className = "layer3-sig-chip";
      chip.classList.toggle("is-agree", ok);
      chip.classList.toggle("is-disagree", !ok);
      const dirArrow = (d: Direction) => (d === "up" ? "\u2191" : d === "down" ? "\u2193" : "\u2192");
      const expStr = exp.map(dirArrow).join("/");
      chip.textContent = `${k}: exp ${expStr} obs ${dirArrow(obs)}`;
      chip.title = ok
        ? `Observed matches the expected ${TYPE_LABELS[result.intervention.type]} signature.`
        : `Disagreement: ${TYPE_LABELS[result.intervention.type]} normally moves ${k} within ${exp.join("/")}. Here it moved ${obs}. Check whether the model or the intervention is doing what it claims.`;
      row.append(chip);
    });
    return row;
  }

  private renderRatiosRow(result: TypedSimulationResult): HTMLElement {
    const row = document.createElement("div");
    row.className = "layer3-analysis-row layer3-ratios";
    row.dataset.role = "ratios";
    const title = document.createElement("span");
    title.className = "layer3-analysis-title";
    title.textContent = "Ratios";
    row.append(title);
    const r = result.ratios;
    const items: { label: string; value: string; title: string }[] = [
      {
        label: "\u0394T/\u0394OE",
        value: r.dT_dOE === null ? "n/a (OE ~0)" : r.dT_dOE.toFixed(2),
        title: "Throughput gain per unit of operating expense added.",
      },
      {
        label: "\u0394T/\u0394I",
        value: r.dT_dI === null ? "n/a (I ~0)" : r.dT_dI.toFixed(2),
        title: "Throughput gain per unit of inventory added.",
      },
      {
        label: "\u0394T/ct",
        value: r.dT_per_constraint_time.toFixed(3),
        title: "Throughput gain per unit of constraint time.",
      },
      {
        label: "Payback",
        value: r.payback_horizon === null ? "not within horizon" : `step ${r.payback_horizon}`,
        title: "First step where cumulative \u0394T meets or exceeds cumulative \u0394OE.",
      },
    ];
    for (const it of items) {
      const chip = document.createElement("span");
      chip.className = "layer3-ratio-chip";
      chip.title = it.title;
      const lbl = document.createElement("span");
      lbl.className = "layer3-ratio-label";
      lbl.textContent = it.label;
      const val = document.createElement("span");
      val.className = "layer3-ratio-value";
      val.textContent = it.value;
      chip.append(lbl, val);
      row.append(chip);
    }
    return row;
  }

  private renderJCurveRow(result: TypedSimulationResult): HTMLElement {
    const row = document.createElement("div");
    row.className = "layer3-analysis-row layer3-jcurve";
    row.dataset.role = "jcurve";
    const title = document.createElement("span");
    title.className = "layer3-analysis-title";
    title.textContent = "J-curve";
    row.append(title);
    const j = result.jCurve;
    const text = j.detected
      ? `Worse-before-better: T dips ${j.depth.toFixed(2)} for ${j.duration} steps before crossing over.`
      : "No worse-before-better dip detected.";
    const chip = document.createElement("span");
    chip.className = "layer3-jcurve-chip";
    chip.classList.toggle("is-detected", j.detected);
    chip.textContent = text;
    chip.title = "Depth and duration of the dip in (post \u2212 pre) T before it crosses to >= 0.";
    row.append(chip);
    return row;
  }

  private renderDofRow(result: TypedSimulationResult): HTMLElement {
    const row = document.createElement("div");
    row.className = "layer3-analysis-row layer3-dof";
    row.dataset.role = "dof";
    const title = document.createElement("span");
    title.className = "layer3-analysis-title";
    title.textContent = "Degrees of freedom";
    row.append(title);
    const d = result.dof;
    const chip = document.createElement("span");
    chip.className = "layer3-dof-chip";
    const sign = d.delta >= 0 ? "+" : "";
    chip.textContent = `${d.before} \u2192 ${d.after} of ${d.total} (\u0394 ${sign}${d.delta})`;
    chip.title =
      "Free nodes before and after. An Elevate that raises T without freeing nodes bought throughput without buying flexibility.";
    row.append(chip);
    return row;
  }

  // --- sync helpers ------------------------------------------------------

  private syncNodeSelect(): void {
    const sel = this.host.querySelector<HTMLSelectElement>('[data-role="node-select"]');
    if (sel) sel.value = this.nodeId;
  }

  /** Show/hide the rope selectors and mode hint when the type or mode changes. */
  private syncModeToggle(): void {
    const rope = this.host.querySelector<HTMLElement>('[data-role="rope"]');
    if (rope) rope.style.display = this.mode === "typed" && this.type === "subordinate" ? "" : "none";
  }

  /** Clamp the current magnitude into the active slider's range (exploit cap). */
  private clampMagnitudeToHeadroom(): void {
    const range = this.magnitudeRange();
    this.magnitude = Math.max(range.min, Math.min(this.magnitude, range.max));
    const input = this.host.querySelector<HTMLInputElement>('[data-role="magnitude"]');
    if (input) {
      input.min = String(range.min);
      input.max = String(range.max);
      input.value = String(this.magnitude);
      input.disabled = range.disabled;
      const val = input.parentElement?.querySelector(".layer3-control-value");
      if (val) (val as HTMLElement).textContent = formatNumber(this.magnitude);
    }
    // Refresh the exploit reason line.
    const existingReason = this.host.querySelector<HTMLElement>('[data-role="exploit-reason"]');
    if (existingReason) existingReason.remove();
    if (this.type === "exploit") {
      const reason = this.exploitReason();
      if (reason) {
        const inputEl = this.host.querySelector<HTMLInputElement>('[data-role="magnitude"]');
        const note = document.createElement("p");
        note.className = "layer3-reason";
        note.dataset.role = "exploit-reason";
        note.textContent = reason;
        inputEl?.parentElement?.append(note);
      }
    }
  }

  /** Compute the magnitude slider's (min, max, step, disabled) for the current type+target. */
  private magnitudeRange(): { min: number; max: number; step: number; disabled: boolean } {
    const node = this.graph.nodes.find((n) => n.id === this.nodeId);
    if (this.type === "exploit") {
      const cap = clampExploitMagnitude(this.graph, this.engineOpts(), this.nodeId, this.magnitude);
      if (cap === null) return { min: 0, max: 0, step: 1, disabled: true };
      const hr = cap.headroom;
      if (hr <= 0) return { min: 0, max: 0, step: 1, disabled: true };
      const step = hr > 1 ? 0.5 : 0.01;
      return { min: 0, max: hr, step, disabled: false };
    }
    if (this.type === "elevate") {
      const base = node?.collar?.upper ?? node?.initial_value ?? 100;
      const max = Math.max(10, base * 2);
      return { min: 0, max, step: 1, disabled: false };
    }
    // subordinate: rope strength
    return { min: 0, max: 3, step: 0.05, disabled: false };
  }

  /** The reason string shown when Exploit is disabled / capped (spec §4.1). */
  private exploitReason(): string | null {
    if (this.type !== "exploit") return null;
    const hr = operatingHeadroom(this.graph, this.engineOpts(), this.nodeId);
    if (hr === null)
      return "No upper collar on this node. Exploit needs a bound to close the gap toward. Use Elevate to add one.";
    if (hr <= 0)
      return "Only 0% headroom remains here. The node is pinned at its collar \u2014 further gain requires Elevate.";
    const node = this.graph.nodes.find((n) => n.id === this.nodeId);
    const span = node?.collar?.upper !== undefined && node?.collar?.lower !== undefined
      ? node.collar.upper - node.collar.lower
      : hr;
    const pct = span > 0 ? (hr / span) * 100 : 100;
    if (pct < 100) return `Only ${pct.toFixed(0)}% headroom remains here. Further gain requires Elevate.`;
    return null;
  }

  private engineOpts() {
    return { dt: this.dt, integrator: this.method as "euler" | "rk4" };
  }

  /** Default the rope to a downstream buffer + an upstream release flow. */
  private initRopeDefaults(): void {
    const node = this.graph.nodes.find((n) => n.id === this.nodeId);
    // Buffer: a stock among the target's downstream nodes (or the target itself
    // if it is a stock). Release: a flow upstream of the target (or the first
    // flow feeding the target).
    const stocks = this.graph.nodes.filter((n) => n.type === "stock");
    const flows = this.graph.nodes.filter((n) => n.type === "flow");
    const downstream = this.graph.edges
      .filter((e) => e.source === this.nodeId)
      .map((e) => e.target);
    const buffer =
      downstream.find((id) => this.graph.nodes.find((n) => n.id === id)?.type === "stock") ??
      (node?.type === "stock" ? this.nodeId : stocks[0]?.id ?? "");
    const upstream = this.graph.edges.filter((e) => e.target === this.nodeId).map((e) => e.source);
    const release =
      upstream.find((id) => this.graph.nodes.find((n) => n.id === id)?.type === "flow") ??
      flows.find((f) => f.id !== this.nodeId)?.id ??
      "";
    this.rope = { buffer, release };
  }
}

function formatNumber(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}

export type { Node };
