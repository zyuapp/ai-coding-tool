import { readViewPreferences } from "../application/view-preferences";
import { themeFor, themeModeOrDefault, themeOrDefault, variantFor, type Theme } from "../domain/theme";
import { redrawDiagrams } from "./components/MermaidBlock";
import { repaintTerminalViews } from "./task-workspace/terminal-views";

/** Whether the system is asking for a dark ground, which only a window set to "auto" reads. */
export function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

/** The theme the window has settled on, so repaints only happen on a real change. */
let settled = "";
/** Whether that settled choice came from the system. */
let following = false;

function paint(id: string) {
  document.documentElement.dataset.theme = themeOrDefault(id).id;
}

/** The platform draws the frame, the traffic lights, and the scrollbars, and it writes what it is told down. */
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
