/**
 * Phase 6 — layer switcher (spec §6).
 *
 * Enforces "one active overlay at a time" (per spec: "not simultaneous — one
 * active overlay at a time, to keep it a thinking tool rather than a cluttered
 * dashboard"). Each layer has an enable/disable callback; the switcher ensures
 * that enabling one disables all others.
 *
 * Vanilla DOM, keyboard-accessible (role="tablist"), no framework.
 */

export type LayerId = "layer1" | "layer2" | "layer3" | "abm";

export interface LayerControl {
  id: LayerId;
  label: string;
  enable(): void;
  disable(): void;
}

export class LayerSwitcher {
  private readonly host: HTMLElement;
  private readonly controls: Map<LayerId, LayerControl> = new Map();
  private active: LayerId = "layer1";

  constructor(host: HTMLElement) {
    this.host = host;
    this.host.setAttribute("role", "tablist");
    this.host.setAttribute("aria-label", "Layer switcher");
    this.host.className = "layer-switcher";
  }

  register(control: LayerControl): void {
    this.controls.set(control.id, control);
    this.render();
  }

  /** Activate a layer; deactivate all others. */
  switchTo(id: LayerId): void {
    if (!this.controls.has(id)) return;
    for (const [lid, ctrl] of this.controls) {
      if (lid === id) {
        ctrl.enable();
      } else {
        ctrl.disable();
      }
    }
    this.active = id;
    this.updateActiveState();
  }

  /** The currently active layer. */
  get activeLayer(): LayerId {
    return this.active;
  }

  private render(): void {
    this.host.innerHTML = "";
    for (const ctrl of this.controls.values()) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "layer-switcher-tab";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(ctrl.id === this.active));
      tab.dataset.layer = ctrl.id;
      tab.textContent = ctrl.label;
      tab.addEventListener("click", () => this.switchTo(ctrl.id));
      this.host.append(tab);
    }
    this.updateActiveState();
  }

  private updateActiveState(): void {
    for (const tab of this.host.querySelectorAll<HTMLElement>(".layer-switcher-tab")) {
      const id = tab.dataset.layer as LayerId;
      const isActive = id === this.active;
      tab.setAttribute("aria-selected", String(isActive));
      tab.classList.toggle("is-active", isActive);
    }
  }
}
