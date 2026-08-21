import { readViewPreferences } from "../application/view-preferences";
import { themeOrDefault } from "../domain/theme";
import { redrawDiagrams } from "./components/MermaidBlock";
import { repaintTerminalViews } from "./task-workspace/terminal-views";

/**
 * The theme lives on the root as an attribute; the stylesheet does the rest. What CSS cannot reach
 * is repainted here: xterm holds the colours it was built with, Mermaid bakes them into its SVG,
 * and the window's own frame is drawn by the platform.
 */
export function applyTheme(id: string): void {
  const chosen = themeOrDefault(id);
  if (document.documentElement.dataset.theme === chosen.id) return;
  document.documentElement.dataset.theme = chosen.id;
  repaintTerminalViews();
  redrawDiagrams();
  if ("desktop" in window) window.desktop.setTheme({ variant: chosen.variant, canvas: chosen.canvas });
}

/** Runs before the first render, so the window never paints a theme the user has already left. */
export function applyStoredTheme(): void {
  const stored = readViewPreferences(localStorage);
  const chosen = themeOrDefault(stored.theme);
  document.documentElement.dataset.theme = chosen.id;
  if ("desktop" in window) window.desktop.setTheme({ variant: chosen.variant, canvas: chosen.canvas });
}
