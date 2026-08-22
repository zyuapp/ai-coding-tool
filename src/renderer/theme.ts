import { readViewPreferences } from "../application/view-preferences";
import { themeFor, themeModeOrDefault, themeOrDefault, variantFor, type Theme } from "../domain/theme";
import { redrawDiagrams } from "./components/MermaidBlock";
import { repaintTerminalViews } from "./task-workspace/terminal-views";

/** Whether the system is asking for a dark ground, which only a window set to "auto" reads. */
export function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

/** The theme the window has actually settled on, which a preview paints over and then puts back. */
let settled = "";
/** Whether that settled choice came from the system, which a preview leaves alone. */
let following = false;

function paint(id: string) {
  document.documentElement.dataset.theme = themeOrDefault(id).id;
}

/**
 * The platform draws the frame, the traffic lights, and the scrollbars, and it writes what it is
 * told down. A preview is not a choice, so only a settled theme is ever sent.
 */
function tellWindow(chosen: Theme) {
  if ("desktop" in window) window.desktop.setTheme({ variant: chosen.variant, canvas: chosen.canvas, follow: following });
}

/**
 * The theme lives on the root as an attribute; the stylesheet does the rest. What CSS cannot reach
 * is repainted here: xterm holds the colours it was built with, Mermaid bakes them into its SVG,
 * and the window's own frame is drawn by the platform.
 */
export function applyTheme(id: string, follow = false): void {
  const chosen = themeOrDefault(id);
  if (settled === chosen.id && following === follow && document.documentElement.dataset.theme === chosen.id) return;
  const repaint = settled !== chosen.id || document.documentElement.dataset.theme !== chosen.id;
  settled = chosen.id;
  following = follow;
  paint(chosen.id);
  tellWindow(chosen);
  if (!repaint) return;
  repaintTerminalViews();
  redrawDiagrams();
}

/**
 * Paints a theme the pointer is only resting on, and passing null puts the settled one back. The
 * picker covers the window, so nothing behind it is redrawn until the choice is actually made.
 */
export function previewTheme(id: string | null): void {
  const chosen = themeOrDefault(id ?? settled);
  if (document.documentElement.dataset.theme === chosen.id) return;
  paint(chosen.id);
}

/** Runs before the first render, so the window never paints a theme the user has already left. */
export function applyStoredTheme(): void {
  const stored = readViewPreferences(localStorage);
  const mode = themeModeOrDefault(stored.themeMode);
  const chosen = mode === "auto"
    ? themeFor(themeOrDefault(stored.theme).family, variantFor(mode, systemPrefersDark()))
    : themeOrDefault(stored.theme);
  settled = chosen.id;
  following = mode === "auto";
  paint(chosen.id);
  tellWindow(chosen);
}
