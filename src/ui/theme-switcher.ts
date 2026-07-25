/**
 * Theme switcher — Light / System / Dark.
 *
 * The preference is persisted in `localStorage` under `layers.theme`. The
 * resolved theme ("light" | "dark") is written to
 * `document.documentElement.dataset.theme`, which is what the CSS tokens in
 * `styles.css` key off of. "system" follows the OS `prefers-color-scheme`
 * setting live (re-resolves when the OS preference changes).
 *
 * Vanilla DOM, keyboard-accessible (role="group" toolbar), no framework.
 */

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "layers.theme";
const VALID: readonly ThemePreference[] = ["light", "dark", "system"];

/** Read a CSS custom property from :root (resolves through the cascade). */
export function cssVar(name: string, fallback = ""): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function storedThemePreference(): ThemePreference {
  if (typeof localStorage === "undefined") return "system";
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw && (VALID as readonly string[]).includes(raw) ? (raw as ThemePreference) : "system";
}

export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === "system") {
    if (typeof window === "undefined" || !window.matchMedia) return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return pref;
}

/** Apply a resolved theme to <html> and notify listeners. */
export function applyResolvedTheme(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved;
  window.dispatchEvent(new CustomEvent("layers:theme", { detail: { resolved } }));
}

interface ThemeSwitcherOptions {
  /** Override the initial preference (otherwise read from localStorage). */
  initial?: ThemePreference;
}

export class ThemeSwitcher {
  private readonly host: HTMLElement;
  private preference: ThemePreference;
  private readonly mq: MediaQueryList | null;
  private readonly onMedia: () => void;

  constructor(host: HTMLElement, options?: ThemeSwitcherOptions) {
    this.host = host;
    this.host.setAttribute("role", "group");
    this.host.setAttribute("aria-label", "Theme");
    this.host.classList.add("theme-switcher");
    this.preference = options?.initial ?? storedThemePreference();
    this.mq =
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
    this.onMedia = () => {
      if (this.preference === "system") this.apply();
    };
  }

  /** Render the control, apply the current theme, and start listening. */
  mount(): void {
    this.render();
    this.apply();
    this.mq?.addEventListener("change", this.onMedia);
  }

  /** Detach the OS-change listener (rarely needed; mainly for tests). */
  dispose(): void {
    this.mq?.removeEventListener("change", this.onMedia);
  }

  /** Current user preference (the choice, not the resolved value). */
  get current(): ThemePreference {
    return this.preference;
  }

  /** Set and apply a new preference, persisting it. */
  set(pref: ThemePreference): void {
    this.preference = pref;
    try {
      localStorage.setItem(STORAGE_KEY, pref);
    } catch {
      /* localStorage may be unavailable (private mode); ignore. */
    }
    this.apply();
    this.updateActiveState();
  }

  private apply(): void {
    applyResolvedTheme(resolveTheme(this.preference));
  }

  private render(): void {
    this.host.innerHTML = "";
    const labels: Record<ThemePreference, string> = {
      light: "Light",
      system: "System",
      dark: "Dark",
    };
    for (const pref of VALID) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "theme-switcher-btn";
      btn.dataset.theme = pref;
      btn.textContent = labels[pref];
      btn.setAttribute("aria-pressed", String(this.preference === pref));
      btn.addEventListener("click", () => this.set(pref));
      this.host.append(btn);
    }
    this.updateActiveState();
  }

  private updateActiveState(): void {
    for (const btn of this.host.querySelectorAll<HTMLElement>(".theme-switcher-btn")) {
      const pref = btn.dataset.theme as ThemePreference;
      const isActive = pref === this.preference;
      btn.setAttribute("aria-pressed", String(isActive));
      btn.classList.toggle("is-active", isActive);
    }
  }
}
