import { readViewPreferences } from "../application/view-preferences";
import { monoFontOrDefault, textSizeOrDefault, uiFontOrDefault } from "../domain/typography";
import { redrawDiagrams } from "./components/MermaidBlock";
import { restyleTerminalViews } from "./task-workspace/terminal-views";

export type TypographyChoice = {
  uiFont: string;
  monoFont: string;
  readingSize: string;
  terminalSize: string;
};

/** The four choices as attributes on the root, which is all the stylesheet needs. */
function settle(choice: TypographyChoice) {
  const root = document.documentElement;
  const chosen = {
    uiFont: uiFontOrDefault(choice.uiFont).id,
    monoFont: monoFontOrDefault(choice.monoFont).id,
    readingSize: textSizeOrDefault(choice.readingSize).id,
    terminalSize: textSizeOrDefault(choice.terminalSize).id,
  };
  const changed = {
    uiFont: root.dataset.uiFont !== chosen.uiFont,
    monoFont: root.dataset.monoFont !== chosen.monoFont,
    readingSize: root.dataset.readingSize !== chosen.readingSize,
    terminalSize: root.dataset.terminalSize !== chosen.terminalSize,
  };
  root.dataset.uiFont = chosen.uiFont;
  root.dataset.monoFont = chosen.monoFont;
  root.dataset.readingSize = chosen.readingSize;
  root.dataset.terminalSize = chosen.terminalSize;
  return changed;
}

/**
 * The choice lives on the root as attributes; the stylesheet does the rest. What CSS cannot reach is
 * redrawn here: xterm holds the font it was built with, and Mermaid bakes one into its SVG.
 */
export function applyTypography(choice: TypographyChoice): void {
  const changed = settle(choice);
  if (changed.monoFont || changed.terminalSize) restyleTerminalViews();
  if (changed.uiFont || changed.monoFont) redrawDiagrams();
}

/** Runs before the first render, so the window never paints type the user has already left. */
export function applyStoredTypography(): void {
  const stored = readViewPreferences(localStorage);
  settle({ uiFont: stored.uiFont ?? "", monoFont: stored.monoFont ?? "", readingSize: stored.readingSize ?? "", terminalSize: stored.terminalSize ?? "" });
}
