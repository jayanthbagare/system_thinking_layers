/**
 * Loom spec item 6 — provenance detail panel.
 *
 * Clicking a node or edge that carries attached provenance opens its evidence
 * trail inline: which Loom stage produced it, confidence / p-value, the
 * plain-English reasoning already present in `tioe_suggestions.md`, and the
 * suggested T/I/OE class (with `"none"` shown as the neutral "unclassified"
 * state, never as an error). This is the same text a person would otherwise
 * have to find in the sidecar separately.
 *
 * Architecture: a view over `Graph` — it reads the element's `provenance` to
 * populate itself and holds no parallel state. For elements without provenance
 * it is not offered (the caller decides). The P3 override (item 9) extends
 * this panel with a write-back control; the read-only form here is the P1 #6
 * surface.
 */

import type { Edge, Graph, Node, Provenance } from "@/model/types";

export interface ProvenanceDetailOptions {
  /**
   * Loom spec item 9 — invoked when the user overrides a node's suggested
   * `tioeClass`. The host writes the correction back to the relevant Loom
   * intermediate file (a `provenance.json` download). Optional; the read-only
   * panel omits the override control when absent.
   */
  onOverride?: (nodeId: string, tioeClass: "T" | "I" | "OE" | "none") => void;
}

export class ProvenanceDetailPanel {
  private readonly graph: Graph;
  private readonly onOverride: ((nodeId: string, tioeClass: "T" | "I" | "OE" | "none") => void) | undefined;

  constructor(graph: Graph, opts: ProvenanceDetailOptions = {}) {
    this.graph = graph;
    this.onOverride = opts.onOverride;
  }

  /**
   * Open the detail dialog for a node or edge by id. If the element has no
   * attached provenance this is a no-op (the caller should not offer the
   * action, but the guard keeps it safe).
   */
  open(kind: "node" | "edge", id: string): void {
    const prov = this.provenanceOf(kind, id);
    if (!prov) return;
    const label = this.labelOf(kind, id);
    const dialog = this.buildDialog(kind, id, label, prov);
    document.body.append(dialog);
    // `showModal` is the native modal affordance; some test DOMs (jsdom) do not
    // implement it. Fall back to the `open` attribute so the dialog is still
    // visible/queryable — the panel's content is what matters, not modality.
    try {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } catch {
      dialog.setAttribute("open", "");
    }
  }

  private provenanceOf(kind: "node" | "edge", id: string): Provenance | undefined {
    if (kind === "node") return this.graph.nodes.find((n) => n.id === id)?.provenance;
    return this.graph.edges.find((e) => e.id === id)?.provenance;
  }

  private labelOf(kind: "node" | "edge", id: string): string {
    if (kind === "node") {
      const n = this.graph.nodes.find((x) => x.id === id) as Node | undefined;
      return n?.label ?? id;
    }
    const e = this.graph.edges.find((x) => x.id === id) as Edge | undefined;
    if (!e) return id;
    const s = this.graph.nodes.find((n) => n.id === e.source)?.label ?? e.source;
    const t = this.graph.nodes.find((n) => n.id === e.target)?.label ?? e.target;
    return `${e.id}: ${s} \u2192 ${t}`;
  }

  private buildDialog(kind: "node" | "edge", id: string, label: string, prov: Provenance): HTMLDialogElement {
    const dialog = document.createElement("dialog");
    dialog.className = "provenance-modal";
    dialog.setAttribute("aria-label", `Provenance for ${label}`);

    const form = document.createElement("form");
    form.method = "dialog";
    form.className = "provenance-modal-form";

    const title = document.createElement("h3");
    title.className = "provenance-modal-title";
    title.textContent = `${kind === "node" ? "Node" : "Edge"}: ${label}`;
    form.append(title);

    form.append(this.row("Mined", prov.mined === false ? "human-confirmed" : prov.mined === true ? "mined" : "\u2014"));
    form.append(this.row("Stage", prov.stage ?? "\u2014"));
    form.append(this.row("Confidence", prov.confidence !== undefined ? prov.confidence.toFixed(3) : "\u2014"));
    form.append(this.row("p-value", prov.pValue !== undefined ? prov.pValue.toExponential(2) : "\u2014"));
    if (kind === "node") {
      form.append(this.row("Suggested T/I/OE", tioeLabel(prov.tioeClass)));
    }
    if (kind === "edge") {
      form.append(this.row("Causal support", supportLabel(prov.causalSupport)));
      form.append(this.row("Structural support", supportLabel(prov.structuralSupport)));
    }
    if (prov.unitValue !== undefined) {
      form.append(this.row("unit_value", `$${prov.unitValue} / unit`));
    }

    if (prov.reasoning) {
      const reasoningTitle = document.createElement("p");
      reasoningTitle.className = "provenance-modal-section";
      reasoningTitle.textContent = "Reasoning";
      const reasoning = document.createElement("p");
      reasoning.className = "provenance-modal-reasoning";
      reasoning.textContent = prov.reasoning;
      form.append(reasoningTitle, reasoning);
    }

    // P3 #9 override control (only for nodes, only when an override channel is
    // wired). Renders a dropdown + "Save override" button.
    if (kind === "node" && this.onOverride) {
      form.append(this.overrideControl(id, prov.tioeClass));
    }

    const close = document.createElement("button");
    close.type = "submit";
    close.className = "provenance-modal-close";
    close.textContent = "Close";
    close.value = "close";
    form.append(close);

    dialog.append(form);
    dialog.addEventListener("close", () => dialog.remove());
    return dialog;
  }

  /** P3 #9 — the tioeClass override control (accept or correct Loom's suggestion). */
  private overrideControl(nodeId: string, current: Provenance["tioeClass"]): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "provenance-modal-override";
    const label = document.createElement("p");
    label.className = "provenance-modal-section";
    label.textContent = "Override T/I/OE suggestion";
    const select = document.createElement("select");
    select.dataset.role = "tioe-override";
    for (const v of ["keep", "T", "I", "OE", "none"] as const) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v === "keep" ? `Keep (${current ?? "\u2014"})` : v === "none" ? "none (unclassified)" : v;
      opt.selected = v === "keep";
      select.append(opt);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Save override";
    btn.addEventListener("click", () => {
      const v = select.value;
      if (v === "keep") return;
      this.onOverride?.(nodeId, v as "T" | "I" | "OE" | "none");
      btn.textContent = "Saved";
      btn.disabled = true;
    });
    wrap.append(label, select, btn);
    return wrap;
  }

  private row(label: string, value: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "provenance-modal-row";
    const dt = document.createElement("span");
    dt.className = "provenance-modal-key";
    dt.textContent = label;
    const dd = document.createElement("span");
    dd.className = "provenance-modal-val";
    dd.textContent = value;
    row.append(dt, dd);
    return row;
  }
}

function tioeLabel(tioe: Provenance["tioeClass"]): string {
  if (tioe === undefined) return "\u2014";
  if (tioe === "none") return "none (unclassified)";
  return tioe;
}

function supportLabel(flag: boolean | undefined): string {
  if (flag === undefined) return "\u2014";
  return flag ? "supported" : "not supported";
}
