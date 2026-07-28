/**
 * YAML editor modal — load and edit the model's YAML directly.
 *
 * A self-contained DOM view that opens a native `<dialog>` with a `<textarea>`
 * pre-filled with the model's YAML. The user can edit the raw text and Apply
 * (re-parse + validate + recompute loops), or pull a file's contents into the
 * textarea via the inline "Load file…" button. Parse errors are shown inline
 * (the DSL parser collects ALL violations in one pass), so the user can fix
 * everything without restarting.
 *
 * Architecture: a view only — it never mutates `Graph`. On Apply it hands the
 * parsed `Graph` to `onApply`; the caller (main.ts) replaces the working graph
 * and refreshes the panels. This is the same single-source-of-truth contract as
 * the per-node edit modal (`src/layer1/editModal.ts`).
 */

import type { Graph } from "@/model/types";
import type { ValidationIssue } from "@/model/validate";
import { parseGraph } from "@/dsl/parser";
import { withComputedLoops } from "@/graph/loops";

export interface YamlEditorOptions {
  /** Initial textarea contents (serialized graph, or a loaded file's text). */
  initialText: string;
  /** Modal title — "Edit model YAML" or "Load model YAML". */
  title?: string;
  /** Called with the validated, loop-computed Graph when the user applies. */
  onApply: (graph: Graph) => void;
  /** Called when dismissed without applying. */
  onClose?: () => void;
}

/**
 * Open the YAML editor. Returns the dialog element (attached to
 * `document.body` and shown). The dialog removes itself from the DOM on close.
 */
export function openYamlEditor(opts: YamlEditorOptions): HTMLDialogElement {
  const { initialText, title = "Edit model YAML", onApply, onClose } = opts;

  const dialog = document.createElement("dialog");
  dialog.className = "yaml-editor";
  dialog.setAttribute("aria-label", title);

  const form = document.createElement("form");
  form.method = "dialog";
  form.className = "yaml-editor-form";

  const { head, fileBtn, fileInput } = headRow(title);
  const textarea = textareaEl(initialText);
  const errorBox = errorEl();
  const { actions, cancelBtn, applyBtn } = actionsRow();

  form.append(head, textareaWrap(textarea), errorBox, actions, fileInput);
  dialog.append(form);
  document.body.append(dialog);
  dialog.showModal();

  dialog.addEventListener("close", () => {
    if (dialog.dataset.saved !== "true") onClose?.();
    dialog.remove();
  });

  // Submit = Apply. The form's method="dialog" would close the dialog on
  // submit; preventDefault holds it open so we can validate first, then we
  // close manually only on success (mirrors src/layer1/editModal.ts).
  const onSubmit = (event: Event): void => {
    event.preventDefault();
    const { graph, issues } = parseGraph(textarea.value);
    if (graph) {
      dialog.dataset.saved = "true";
      onApply(withComputedLoops(graph));
      dialog.close();
      return;
    }
    errorBox.textContent = formatIssues(issues);
  };
  form.addEventListener("submit", onSubmit);
  applyBtn.addEventListener("click", () => form.requestSubmit());

  // Inline file loader: replace the textarea with the file's contents.
  fileBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    void file.text().then((text) => {
      textarea.value = text;
      errorBox.textContent = `Loaded ${file.name} (${text.length} bytes). Press Apply to validate and load.`;
    });
  });

  cancelBtn.addEventListener("click", () => dialog.close());

  return dialog;
}

function headRow(title: string): { head: HTMLElement; fileBtn: HTMLButtonElement; fileInput: HTMLInputElement } {
  const head = document.createElement("div");
  head.className = "yaml-editor-head";
  const h3 = document.createElement("h3");
  h3.textContent = title;
  const hint = document.createElement("span");
  hint.className = "yaml-editor-hint";
  hint.textContent = "Ctrl+Enter to apply";
  const fileBtn = document.createElement("button");
  fileBtn.type = "button";
  fileBtn.textContent = "Load file…";
  fileBtn.className = "yaml-editor-filebtn";
  head.append(h3, hint, fileBtn);
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".yaml,.yml,.json,text/yaml,application/json";
  fileInput.style.display = "none";
  return { head, fileBtn, fileInput };
}

function textareaEl(initialText: string): HTMLTextAreaElement {
  const textarea = document.createElement("textarea");
  textarea.className = "yaml-editor-textarea";
  textarea.value = initialText;
  textarea.spellcheck = false;
  textarea.setAttribute("aria-label", "Model YAML");
  textarea.setAttribute("wrap", "off");
  // Ctrl+Enter applies (submits the form); Enter inserts a newline.
  textarea.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      const formEl = textarea.closest("form");
      formEl?.requestSubmit();
    }
  });
  return textarea;
}

function textareaWrap(textarea: HTMLTextAreaElement): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "yaml-editor-textarea-wrap";
  wrap.append(textarea);
  return wrap;
}

function errorEl(): HTMLElement {
  const errorBox = document.createElement("div");
  errorBox.className = "yaml-editor-error";
  errorBox.setAttribute("role", "alert");
  errorBox.setAttribute("aria-live", "polite");
  return errorBox;
}

function actionsRow(): { actions: HTMLElement; cancelBtn: HTMLButtonElement; applyBtn: HTMLButtonElement } {
  const actions = document.createElement("div");
  actions.className = "yaml-editor-actions";
  const applyBtn = document.createElement("button");
  applyBtn.type = "submit";
  applyBtn.textContent = "Apply";
  applyBtn.className = "is-primary";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  actions.append(cancelBtn, applyBtn);
  return { actions, cancelBtn, applyBtn };
}

function formatIssues(issues: ValidationIssue[]): string {
  const lines = issues.map((i) => `• [${i.code}] ${i.message}${i.ref ? ` (${i.ref})` : ""}`);
  return `${issues.length} issue(s):\n${lines.join("\n")}`;
}
