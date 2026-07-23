/**
 * Layer 1 — node edit modal (spec §2: edit mode).
 *
 * A self-contained DOM view that opens a native `<dialog>` with a node's
 * editable properties when the user shift-clicks a node on the canvas. On save
 * it validates the candidate node against the full `Graph` (so the edit is
 * rejected up-front if it would break the model) and emits a `NodeEditPatch`
 * via `onSave`. The caller (main.ts) applies the patch to the in-memory
 * `Graph` and writes the result back to YAML.
 *
 * Architecture: this is a view over `Graph` — it holds no parallel state. It
 * reads the node to populate the form and returns a plain patch; it never
 * mutates `Graph` itself.
 */

import type { Collar, Graph, Node, NodeType, TioeClass } from "@/model/types";
import { validate } from "@/model/validate";

/** A node's editable fields, as collected from the modal form. */
export interface NodeEditPatch {
  label: string;
  type: NodeType;
  tioe_class: TioeClass;
  initial_value: number;
  unit: string;
  collar?: Collar;
  /** When true, the existing collar (if any) is removed. */
  clearCollar?: boolean;
  pin?: { x: number; y: number };
  /** When true, the existing pin (if any) is removed. */
  clearPin?: boolean;
  agent_binding?: { rule_id: string };
  /** When true, the existing agent_binding (if any) is removed. */
  clearAgentBinding?: boolean;
}

const NODE_TYPES: NodeType[] = ["stock", "flow", "auxiliary"];
const TIOE_CLASSES: TioeClass[] = ["T", "I", "OE", "none"];

/**
 * Open the edit modal for `node` against `graph`. Returns the dialog element
 * (already attached to `document.body` and shown). `onSave` receives the
 * validated patch; `onClose` is called when the dialog is dismissed without
 * saving. The dialog removes itself from the DOM on close.
 */
export function openEditModal(
  node: Node,
  graph: Graph,
  onSave: (patch: NodeEditPatch) => void,
  onClose?: () => void,
): HTMLDialogElement {
  const dialog = document.createElement("dialog");
  dialog.className = "edit-modal";
  dialog.setAttribute("aria-label", `Edit node ${node.label}`);

  const form = document.createElement("form");
  form.method = "dialog";
  form.className = "edit-modal-form";

  form.append(titleRow(node));
  form.append(fieldRow("Label", textInput("label", node.label)));
  form.append(fieldRow("Type", selectInput("type", NODE_TYPES, node.type)));
  form.append(fieldRow("TIOE class", selectInput("tioe_class", TIOE_CLASSES, node.tioe_class)));
  form.append(fieldRow("Initial value", numberInput("initial_value", node.initial_value)));
  form.append(fieldRow("Unit", textInput("unit", node.unit)));
  form.append(
    fieldRow(
      "Collar lower (physical)",
      numberInput("collar_lower", node.collar?.lower ?? 0, { step: "any" }),
    ),
  );
  form.append(
    fieldRow(
      "Collar upper (physical)",
      numberInput("collar_upper", node.collar?.upper ?? 0, { step: "any" }),
    ),
  );
  form.append(
    fieldRow(
      "Pin x / y",
      pinRow(
        node.pin?.x ?? 0,
        node.pin?.y ?? 0,
        node.pin !== undefined,
      ),
    ),
  );
  form.append(
    fieldRow(
      "Agent binding (rule id)",
      agentBindingRow(node.agent_binding?.rule_id ?? ""),
    ),
  );

  const errorBox = document.createElement("div");
  errorBox.className = "edit-modal-error";
  errorBox.setAttribute("role", "alert");
  form.append(errorBox);

  const actions = document.createElement("div");
  actions.className = "edit-modal-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => {
    dialog.close();
  });
  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.textContent = "Save";
  saveBtn.className = "is-primary";
  actions.append(cancelBtn, saveBtn);
  form.append(actions);

  dialog.append(form);
  document.body.append(dialog);
  dialog.showModal();

  dialog.addEventListener("close", () => {
    if (dialog.dataset.saved !== "true") onClose?.();
    dialog.remove();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const patch = collectPatch(form, node);
    const issue = validatePatch(node, patch, graph);
    if (issue) {
      errorBox.textContent = issue;
      return;
    }
    dialog.dataset.saved = "true";
    onSave(patch);
    dialog.close();
  });

  return dialog;
}

function titleRow(node: Node): HTMLElement {
  const head = document.createElement("div");
  head.className = "edit-modal-head";
  const title = document.createElement("h3");
  title.textContent = "Edit node";
  const id = document.createElement("span");
  id.className = "edit-modal-id";
  id.textContent = node.id;
  head.append(title, id);
  return head;
}

function fieldRow(labelText: string, control: HTMLElement): HTMLElement {
  const row = document.createElement("div");
  row.className = "edit-modal-row";
  const label = document.createElement("label");
  label.className = "edit-modal-label";
  label.textContent = labelText;
  const wrap = document.createElement("div");
  wrap.className = "edit-modal-control";
  wrap.append(control);
  row.append(label, wrap);
  return row;
}

function textInput(name: string, value: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.name = name;
  input.value = value;
  input.className = "edit-modal-input";
  return input;
}

function numberInput(
  name: string,
  value: number,
  opts: { step?: string; min?: string; max?: string } = {},
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.name = name;
  input.value = String(value);
  input.className = "edit-modal-input";
  if (opts.step) input.step = opts.step;
  if (opts.min) input.min = opts.min;
  if (opts.max) input.max = opts.max;
  return input;
}

function selectInput<T extends string>(name: string, options: T[], value: T): HTMLSelectElement {
  const select = document.createElement("select");
  select.name = name;
  select.className = "edit-modal-input";
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt;
    o.textContent = opt;
    if (opt === value) o.selected = true;
    select.append(o);
  }
  return select;
}

function pinRow(x: number, y: number, pinned: boolean): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "edit-modal-pin-row";
  const xInput = numberInput("pin_x", x);
  const yInput = numberInput("pin_y", y);
  const clearBox = document.createElement("label");
  clearBox.className = "edit-modal-pin-clear";
  const check = document.createElement("input");
  check.type = "checkbox";
  check.name = "pin_clear";
  check.checked = !pinned;
  const span = document.createElement("span");
  span.textContent = "auto-layout (clear pin)";
  clearBox.append(check, span);
  wrap.append(xInput, yInput, clearBox);
  return wrap;
}

function agentBindingRow(ruleId: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "edit-modal-binding-row";
  const input = textInput("agent_rule_id", ruleId);
  const clearBox = document.createElement("label");
  clearBox.className = "edit-modal-binding-clear";
  const check = document.createElement("input");
  check.type = "checkbox";
  check.name = "agent_clear";
  check.checked = ruleId.length === 0;
  const span = document.createElement("span");
  span.textContent = "no binding";
  clearBox.append(check, span);
  wrap.append(input, clearBox);
  return wrap;
}

function collectPatch(form: HTMLFormElement, original: Node): NodeEditPatch {
  const fd = new FormData(form);
  const collarLowerRaw = String(fd.get("collar_lower") ?? "");
  const collarUpperRaw = String(fd.get("collar_upper") ?? "");
  const pinClear = fd.get("pin_clear") === "on";
  const pinX = Number(fd.get("pin_x"));
  const pinY = Number(fd.get("pin_y"));
  const agentClear = fd.get("agent_clear") === "on";
  const agentRuleId = String(fd.get("agent_rule_id") ?? "").trim();

  const patch: NodeEditPatch = {
    label: String(fd.get("label") ?? "").trim(),
    type: String(fd.get("type")) as NodeType,
    tioe_class: String(fd.get("tioe_class")) as TioeClass,
    initial_value: Number(fd.get("initial_value")),
    unit: String(fd.get("unit") ?? "").trim(),
  };
  const lo = collarLowerRaw !== "" ? Number(collarLowerRaw) : NaN;
  const hi = collarUpperRaw !== "" ? Number(collarUpperRaw) : NaN;
  if (!Number.isNaN(lo) || !Number.isNaN(hi)) {
    const collar: Collar = {};
    if (!Number.isNaN(lo)) collar.lower = lo;
    if (!Number.isNaN(hi)) collar.upper = hi;
    patch.collar = collar;
  } else {
    patch.clearCollar = true;
  }
  if (!pinClear && !Number.isNaN(pinX) && !Number.isNaN(pinY)) {
    patch.pin = { x: pinX, y: pinY };
  } else if (pinClear) {
    patch.clearPin = true;
  }
  if (!agentClear && agentRuleId.length > 0) {
    patch.agent_binding = { rule_id: agentRuleId };
  } else if (agentClear) {
    patch.clearAgentBinding = true;
  }
  void original;
  return patch;
}

/** Validate the patch by constructing the candidate node + graph. Returns a message or null. */
function validatePatch(node: Node, patch: NodeEditPatch, graph: Graph): string | null {
  if (!patch.label) return "Label must not be empty.";
  if (Number.isNaN(patch.initial_value)) return "Initial value must be a number.";
  const candidate: Node = {
    id: node.id,
    label: patch.label,
    type: patch.type,
    tioe_class: patch.tioe_class,
    initial_value: patch.initial_value,
    unit: patch.unit,
    ...(patch.collar ? { collar: patch.collar } : {}),
    ...(patch.pin ? { pin: patch.pin } : {}),
    ...(patch.agent_binding ? { agent_binding: patch.agent_binding } : {}),
    ...(node.abm_verdict ? { abm_verdict: node.abm_verdict } : {}),
  };
  const candidateGraph: Graph = {
    nodes: graph.nodes.map((n) => (n.id === node.id ? candidate : n)),
    edges: graph.edges,
    loops: graph.loops,
  };
  const issues = validate(candidateGraph);
  if (issues.length === 0) return null;
  return issues
    .filter((i) => i.ref === node.id || i.ref === undefined)
    .map((i) => i.message)
    .join(" ");
}
