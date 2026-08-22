import { readViewPreferences } from "../application/view-preferences";
import {
  READING_SIZE,
  TERMINAL_SIZE,
  customFontFamily,
  monoFontOrDefault,
  sizeOrDefault,
  uiFontOrDefault,
} from "../domain/typography";
import { redrawDiagrams } from "./components/MermaidBlock";
import { restyleTerminalViews } from "./task-workspace/terminal-views";

export type TypographyChoice = {
  uiFont: string;
  monoFont: string;
  readingSize: number;
  terminalSize: number;
};

/**
 * A family the app bundles is an attribute the stylesheet already answers. One the app only knows
 * the name of has no block to match, so its stack is written onto the root instead.
 */
function setFamily(attribute: "uiFont" | "monoFont", token: "--ui-font" | "--mono", system: string, id: string) {
  const root = document.documentElement;
  const named = customFontFamily(id);
  const value = named ? "installed" : id;
  const stack = named ? `"${named}", var(${system})` : "";
  const changed = root.dataset[attribute] !== value || root.style.getPropertyValue(token) !== stack;
  root.dataset[attribute] = value;
  if (stack) root.style.setProperty(token, stack);
  else root.style.removeProperty(token);
  return changed;
}

function setSize(token: "--text-content" | "--terminal-text", px: number) {
  const root = document.documentElement;
  const value = `${px}px`;
  const changed = root.style.getPropertyValue(token) !== value;
  root.style.setProperty(token, value);
  return changed;
}

/** The four choices as attributes and custom properties on the root, which is all the stylesheet needs. */
function settle(choice: TypographyChoice) {
  return {
    uiFont: setFamily("uiFont", "--ui-font", "--system-ui-font", uiFontOrDefault(choice.uiFont).id),
    monoFont: setFamily("monoFont", "--mono", "--system-mono-font", monoFontOrDefault(choice.monoFont).id),
    readingSize: setSize("--text-content", sizeOrDefault(READING_SIZE, choice.readingSize)),
    terminalSize: setSize("--terminal-text", sizeOrDefault(TERMINAL_SIZE, choice.terminalSize)),
  };
}

/**
 * The choice lives on the root; the stylesheet does the rest. What CSS cannot reach is redrawn
 * here: xterm holds the font it was built with, and Mermaid bakes one into its SVG.
 */
export function applyTypography(choice: TypographyChoice): void {
  const changed = settle(choice);
  if (changed.monoFont || changed.terminalSize) restyleTerminalViews();
  if (changed.uiFont || changed.monoFont) redrawDiagrams();
}

/** Runs before the first render, so the window never paints type the user has already left. */
export function applyStoredTypography(): void {
  const stored = readViewPreferences(localStorage);
  settle({
    uiFont: stored.uiFont ?? "",
    monoFont: stored.monoFont ?? "",
    readingSize: sizeOrDefault(READING_SIZE, stored.readingSize),
    terminalSize: sizeOrDefault(TERMINAL_SIZE, stored.terminalSize),
  });
}
