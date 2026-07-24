/**
 * Layer 2 side panel (spec §3).
 *
 * A vanilla-DOM panel bound to a `Graph` and a `Layer1Renderer`. It shows the
 * top-3 ranked candidate constraints with a per-signal breakdown (the "why"),
 * and four weight sliders that re-score live. Slider events are debounced to
 * <= 100ms (spec acceptance) and re-apply heat WITHOUT re-running the force
 * layout (the renderer's `applyHeat` only restyles nodes).
 *
 * Architecture rule: this panel holds no parallel state. Every render
 * re-derives scores from `(Graph, weights)` via the pure `scoreGraph` function.
 * The only thing it owns is the current `Weights` (a UI input), which is not
 * model state — it's a view parameter, so it lives here, not on `Graph`.
 */

import type { Graph } from "@/model/types";
import { scoreGraph, DEFAULT_WEIGHTS, type ScoredNode, type Weights } from "@/layer2/scoring";
import {
  observedConstraint,
  detectCycle,
  stepSummary,
  disagreementMessage,
  type MigrationTrail,
  type CycleDetection,
} from "@/layer2/migration";
import { heatColor } from "@/layer1/layout";
import { normalizedSensitivities } from "@/sim";
import { DEFAULT_ENGINE_OPTIONS, type EngineOptions } from "@/sim";
import type { Layer1Renderer } from "@/layer1/renderer";

const DEBOUNCE_MS = 80; // comfortably under the 100ms acceptance budget

const SIGNAL_LABELS: Record<keyof Weights, string> = {
  in_degree: "Loop membership",
  delay_ratio: "Delay / cycle time",
  rate_mismatch: "R/B rate mismatch",
  dominant_loop: "Dominant-loop share",
  sensitivity: "Sensitivity (impulse)",
};

export interface SidePanelOptions {
  /** How many top constraints to show. Default 3 per spec. */
  topK?: number;
  /** Notified whenever scores are recomputed (e.g. for external sync). */
  onRescore?: (weights: Weights) => void;
}

export class Layer2Panel {
  private readonly host: HTMLElement;
  private readonly graph: Graph;
  private readonly renderer: Layer1Renderer;
  private readonly topK: number;
  private readonly onRescore: ((w: Weights) => void) | undefined;
  private weights: Weights;
  /**
   * Engine-derived sensitivities (normalised [0,1] across nodes), cached so the
   * ranking is stable across animation ticks. Invalidated only on a graph edit
   * (see `invalidate`), never on a nudge — this is the fix for "the ranking
   * changes when you click a nudge." `null` = not yet computed.
   */
  private sensitivities: Map<string, number> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  /** Phase 5 migration trail — the ordered list of applied interventions and
   * the constraint's movement. Maintained externally (main.ts) and passed in
   * via `setMigrationTrail`. Rendered as a compact list; cycles flagged. */
  private migrationTrail: MigrationTrail = [];
  private cycle: CycleDetection | null = null;

  constructor(
    host: HTMLElement,
    graph: Graph,
    renderer: Layer1Renderer,
    opts: SidePanelOptions = {},
  ) {
    this.host = host;
    this.graph = graph;
    this.renderer = renderer;
    this.topK = opts.topK ?? 3;
    this.onRescore = opts.onRescore;
    this.weights = { ...DEFAULT_WEIGHTS };
    this.host.classList.add("layer2-panel");
    this.render();
  }
  /** Show the overlay and apply heat. */
  enable(): void {
    this.active = true;
    this.host.classList.add("is-active");
    this.recompute();
  }

  /** Hide the overlay and clear heat from the renderer. */
  disable(): void {
    this.active = false;
    this.host.classList.remove("is-active");
    this.renderer.applyHeat(null);
  }

  /** Toggle the overlay on/off. Returns the new active state. */
  toggle(): boolean {
    if (this.active) this.disable();
    else this.enable();
    return this.active;
  }

  /** Update weights (e.g. from an external control) and re-score. */
  setWeights(w: Weights): void {
    this.weights = { ...w };
    this.syncSliderValues();
    this.recompute();
  }

  /** Replace the migration trail and re-render the trail + cycle sections. */
  setMigrationTrail(trail: MigrationTrail): void {
    this.migrationTrail = trail;
    this.cycle = detectCycle(trail);
    this.refreshMigration();
  }

  /**
   * Invalidate the cached sensitivities, e.g. after the graph is edited (a
   * node added/removed, an edge changed, a collar moved). The next `recompute`
   * re-derives them from the engine. Cheap to call; the work happens lazily.
   */
  invalidate(): void {
    this.sensitivities = null;
  }

  /** Expose the cached sensitivities (computing if needed) for external use. */
  getSensitivities(): Map<string, number> {
    return this.ensureSensitivities();
  }

  /** Lazily compute (and cache) the engine-derived sensitivities. */
  private ensureSensitivities(): Map<string, number> {
    if (this.sensitivities === null) {
      this.sensitivities = normalizedSensitivities(this.graph);
    }
    return this.sensitivities;
  }

  // --- rendering ---------------------------------------------------------

  private render(): void {
    this.host.innerHTML = "";
    this.host.append(this.renderHeader());
    this.host.append(this.renderSliders());
    this.host.append(this.renderRanking());
    this.host.append(this.renderPredictedVsObserved());
    this.host.append(this.renderMigration());
  }

  private renderHeader(): HTMLElement {
    const header = document.createElement("div");
    header.className = "layer2-header";
    const title = document.createElement("h2");
    title.textContent = "Layer 2 — Constraints";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "layer2-toggle";
    toggle.textContent = "On";
    toggle.addEventListener("click", () => {
      this.toggle();
      toggle.textContent = this.active ? "On" : "Off";
      toggle.classList.toggle("is-on", this.active);
    });
    // Start on by default — Phase 3 ships with the overlay visible.
    toggle.classList.add("is-on");
    this.active = true;
    header.append(title, toggle);
    return header;
  }

  private renderSliders(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "layer2-sliders";
    const caption = document.createElement("p");
    caption.className = "layer2-caption";
    caption.textContent = "Weights — only the ratios matter.";
    wrap.append(caption);
    (Object.keys(this.weights) as (keyof Weights)[]).forEach((key) => {
      const row = document.createElement("label");
      row.className = "layer2-slider";
      const span = document.createElement("span");
      span.className = "layer2-slider-label";
      span.textContent = SIGNAL_LABELS[key];
      const input = document.createElement("input");
      input.type = "range";
      input.min = "0";
      input.max = "3";
      input.step = "0.1";
      input.value = String(this.weights[key]);
      input.dataset.signal = key;
      input.addEventListener("input", () => {
        const v = Number.parseFloat(input.value);
        if (!Number.isNaN(v)) {
          this.weights[key] = v;
          // Debounce the (pure) recompute + heat restyle so a drag doesn't fire
          // on every pixel. 80ms sits well under the 100ms acceptance budget.
          this.scheduleRecompute();
        }
      });
      const val = document.createElement("span");
      val.className = "layer2-slider-value";
      val.textContent = formatWeight(this.weights[key]);
      val.dataset.signalValue = key;
      row.append(span, input, val);
      wrap.append(row);
    });
    return wrap;
  }

  private renderRanking(): HTMLElement {
    const section = document.createElement("div");
    section.className = "layer2-ranking";
    const { ranked } = scoreGraph(this.graph, this.weights, this.ensureSensitivities());
    const top = ranked.slice(0, this.topK);
    const caption = document.createElement("p");
    caption.className = "layer2-caption";
    caption.textContent = `Top ${this.topK} candidate constraints`;
    section.append(caption);
    top.forEach((sn, i) => section.append(this.renderRankedCard(sn, i + 1)));
    // Keep a reference so recompute can swap children without rebuilding sliders.
    section.dataset.role = "ranking";
    return section;
  }

  private renderRankedCard(sn: ScoredNode, rank: number): HTMLElement {
    const card = document.createElement("div");
    card.className = "layer2-card";
    card.style.setProperty("--chip", heatColor(sn.score));
    const rankEl = document.createElement("span");
    rankEl.className = "layer2-rank";
    rankEl.textContent = `#${rank}`;
    const chip = document.createElement("span");
    chip.className = "layer2-chip";
    chip.title = "Constraint score (0–1)";
    chip.textContent = sn.score.toFixed(2);
    const label = document.createElement("span");
    label.className = "layer2-node-label";
    label.textContent = sn.label;
    const breakdown = document.createElement("dl");
    breakdown.className = "layer2-breakdown";
    (Object.keys(sn.contributions) as (keyof Weights)[]).forEach((key) => {
      const dt = document.createElement("dt");
      dt.textContent = SIGNAL_LABELS[key];
      const dd = document.createElement("dd");
      dd.textContent = `${sn.contributions[key].toFixed(2)}  (raw ${formatRaw(sn.raw[key])})`;
      breakdown.append(dt, dd);
    });
    card.append(rankEl, chip, label, breakdown);
    return card;
  }

  // --- live update -------------------------------------------------------

  private scheduleRecompute(): void {
    this.syncSliderValues();
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.recompute();
      this.debounceTimer = null;
    }, DEBOUNCE_MS);
  }

  private recompute(): void {
    if (!this.active) return;
    this.recomputeLive();
    this.onRescore?.(this.weights);
  }

  /**
   * Re-score and refresh the ranking + heat overlay from `(graph, weights,
   * sensitivities)`. Does NOT fire `onRescore` — used by both weight changes
   * (which add `onRescore` via `recompute`) and graph edits (which invalidate
   * the cached sensitivities). Pure in its inputs; the animation never feeds it.
   */
  private recomputeLive(): void {
    if (!this.active) return;
    const sens = this.ensureSensitivities();
    const { ranked } = scoreGraph(this.graph, this.weights, sens);
    // Apply heat to the canvas (no layout re-run).
    const scores = new Map<string, number>(ranked.map((r) => [r.nodeId, r.score]));
    this.renderer.applyHeat(scores);
    // Refresh the ranked list in place — sliders stay untouched.
    const section = this.host.querySelector<HTMLElement>('[data-role="ranking"]');
    if (section) {
      const caption = section.querySelector<HTMLElement>(".layer2-caption");
      section.innerHTML = "";
      if (caption) section.append(caption);
      ranked.slice(0, this.topK).forEach((sn, i) => section.append(this.renderRankedCard(sn, i + 1)));
    }
    // Refresh the predicted-vs-observed section (Phase 5).
    this.updatePredictedVsObserved(ranked[0]?.nodeId ?? null);
  }

  // --- predicted vs observed (Phase 5 §5.1) -----------------------------

  private renderPredictedVsObserved(): HTMLElement {
    const section = document.createElement("div");
    section.className = "layer2-pred-obs";
    section.dataset.role = "pred-obs";
    return section;
  }

  private updatePredictedVsObserved(predictedId: string | null): void {
    const section = this.host.querySelector<HTMLElement>('[data-role="pred-obs"]');
    if (!section) return;
    const engOpts: EngineOptions = DEFAULT_ENGINE_OPTIONS;
    const obs = observedConstraint(this.graph, engOpts, 500);
    const predictedLabel = this.labelOf(predictedId);
    const observedLabel = this.labelOf(obs.nodeId);
    const agree = predictedId && obs.nodeId && predictedId === obs.nodeId;

    section.innerHTML = "";

    const title = document.createElement("p");
    title.className = "layer2-caption";
    title.textContent = "Constraint: predicted vs observed";
    section.append(title);

    const predRow = document.createElement("div");
    predRow.className = "layer2-pred-obs-row";
    const predLabel = document.createElement("span");
    predLabel.textContent = "Predicted (L2 #1):";
    const predVal = document.createElement("span");
    predVal.textContent = predictedLabel;
    predVal.classList.toggle("is-agree", !!agree);
    predVal.classList.toggle("is-disagree", !agree && !!predictedId && !!obs.nodeId);
    predRow.append(predLabel, predVal);
    section.append(predRow);

    const obsRow = document.createElement("div");
    obsRow.className = "layer2-pred-obs-row";
    const obsLabel = document.createElement("span");
    obsLabel.textContent = "Observed (pinned %):";
    const obsVal = document.createElement("span");
    obsVal.textContent = observedLabel + (obs.nodeId ? ` (${(obs.fraction * 100).toFixed(0)}%)` : "");
    obsVal.classList.toggle("is-agree", !!agree);
    obsVal.classList.toggle("is-disagree", !agree && !!predictedId && !!obs.nodeId);
    obsRow.append(obsLabel, obsVal);
    section.append(obsRow);

    const msg = disagreementMessage(this.graph, predictedId, obs.nodeId);
    if (msg) {
      const note = document.createElement("p");
      note.className = "layer2-disagreement";
      note.textContent = msg;
      section.append(note);
    } else if (agree) {
      const note = document.createElement("p");
      note.className = "layer2-agreement";
      note.textContent = "Predicted and observed agree.";
      section.append(note);
    }
  }

  // --- migration trail (Phase 5 §5.3–5.4) -------------------------------

  private renderMigration(): HTMLElement {
    const section = document.createElement("div");
    section.className = "layer2-migration";
    section.dataset.role = "migration";
    this.populateMigration(section);
    return section;
  }

  /** Re-render the migration trail + cycle sections in place. */
  private refreshMigration(): void {
    const section = this.host.querySelector<HTMLElement>('[data-role="migration"]');
    if (section) this.populateMigration(section);
  }

  private populateMigration(section: HTMLElement): void {
    section.innerHTML = "";
    const title = document.createElement("p");
    title.className = "layer2-caption";
    title.textContent = "Migration trail";
    section.append(title);

    if (this.migrationTrail.length === 0) {
      const empty = document.createElement("p");
      empty.className = "layer2-migration-empty";
      empty.textContent = "No interventions applied yet. Use Layer 3 → Apply.";
      section.append(empty);
      return;
    }

    this.migrationTrail.forEach((step, i) => {
      const row = document.createElement("div");
      row.className = "layer2-migration-step";
      row.style.setProperty("--recency", String((i + 1) / this.migrationTrail.length));
      const idx = document.createElement("span");
      idx.className = "layer2-migration-idx";
      idx.textContent = `#${i + 1}`;
      const text = document.createElement("span");
      text.className = "layer2-migration-text";
      text.textContent = stepSummary(step, this.graph);
      row.append(idx, text);
      section.append(row);
    });

    if (this.cycle && this.cycle.detected) {
      const alert = document.createElement("div");
      alert.className = "layer2-cycle-alert";
      const node = this.labelOf(this.cycle.node);
      const dT = this.cycle.netDeltaT;
      const dOE = this.cycle.netDeltaOE;
      alert.textContent =
        `Cycle detected: ${this.cycle.length} intervention${this.cycle.length > 1 ? "s" : ""}, ` +
        `net ΔT ${dT >= 0 ? "+" : ""}${dT.toFixed(1)}, ΔOE ${dOE >= 0 ? "+" : ""}${dOE.toFixed(1)}. ` +
        `The constraint returned to ${node}.`;
      section.append(alert);
    }
  }

  private labelOf(id: string | null): string {
    if (!id) return "—";
    return this.graph.nodes.find((n) => n.id === id)?.label ?? id;
  }

  private syncSliderValues(): void {
    (Object.keys(this.weights) as (keyof Weights)[]).forEach((key) => {
      const val = this.host.querySelector<HTMLElement>(`[data-signal-value="${key}"]`);
      if (val) val.textContent = formatWeight(this.weights[key]);
    });
  }
}

function formatWeight(w: number): string {
  return Number.isInteger(w) ? w.toFixed(1) : w.toFixed(1);
}

function formatRaw(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}
