import type { PanelLayout } from "../domain/panel-widths";

/** The widths reach the stylesheet as two custom properties, the way the type sizes do. */
export function applyPanelWidths(layout: PanelLayout): void {
  const root = document.documentElement.style;
  root.setProperty("--sidebar-width", `${layout.sidebar}px`);
  root.setProperty("--dock-width", `${layout.dock}px`);
}
