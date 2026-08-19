import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";

/**
 * The views the terminal panel draws into. They live outside React because a shell outlives the panel:
 * closing the dock tab must not lose what a running build has printed, and output keeps arriving while
 * nothing is mounted. Each view owns a container element the panel borrows, so a terminal is only ever
 * opened once however often its tab is shown.
 *
 * Output reaches these views straight from main. It is never dispatched, so it never becomes state.
 */
const SCROLLBACK_LINES = 5_000;

type TerminalView = {
  terminal: Terminal;
  fit: FitAddon;
  container: HTMLDivElement;
  opened: boolean;
};

const views = new Map<string, TerminalView>();
let publishInput: (terminalId: string, data: string) => void = () => undefined;

/** Where keystrokes go. Set by the panel, since a view can exist before the panel is mounted. */
export function onTerminalInput(handler: (terminalId: string, data: string) => void) {
  publishInput = handler;
}

/** The colours are the stylesheet's, read from the tokens so a theme reaches the terminal too. */
function terminalTheme(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(name).trim();
  return {
    background: token("--code-surface"),
    foreground: token("--code-ink"),
    cursor: token("--ink"),
    cursorAccent: token("--code-surface"),
    selectionBackground: token("--selection"),
    black: token("--ansi-black"),
    red: token("--ansi-red"),
    green: token("--ansi-green"),
    yellow: token("--ansi-yellow"),
    blue: token("--ansi-blue"),
    magenta: token("--ansi-magenta"),
    cyan: token("--ansi-cyan"),
    white: token("--ansi-white"),
    brightBlack: token("--ansi-bright-black"),
    brightRed: token("--ansi-bright-red"),
    brightGreen: token("--ansi-bright-green"),
    brightYellow: token("--ansi-bright-yellow"),
    brightBlue: token("--ansi-bright-blue"),
    brightMagenta: token("--ansi-bright-magenta"),
    brightCyan: token("--ansi-bright-cyan"),
    brightWhite: token("--ansi-bright-white"),
  };
}

export function terminalView(terminalId: string): TerminalView {
  const existing = views.get(terminalId);
  if (existing) return existing;
  const terminal = new Terminal({
    allowProposedApi: true,
    scrollback: SCROLLBACK_LINES,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "monospace",
    fontSize: 12,
    theme: terminalTheme(),
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  const container = document.createElement("div");
  container.className = "terminal-surface";
  const view: TerminalView = { terminal, fit, container, opened: false };
  views.set(terminalId, view);
  terminal.onData((data) => publishInput(terminalId, data));
  return view;
}

/** Draws the view into its container the first time it is shown; a later show only re-attaches it. */
export function showTerminalView(terminalId: string, parent: HTMLElement) {
  const view = terminalView(terminalId);
  parent.appendChild(view.container);
  if (!view.opened) {
    view.terminal.open(view.container);
    view.opened = true;
    try {
      view.terminal.loadAddon(new WebglAddon());
    } catch {
      /** No WebGL here; xterm falls back to its own renderer. */
    }
  }
  return view;
}

export function focusTerminalView(terminalId: string) {
  views.get(terminalId)?.terminal.focus();
}

export function hideTerminalView(terminalId: string) {
  views.get(terminalId)?.container.remove();
}

export function disposeTerminalView(terminalId: string) {
  const view = views.get(terminalId);
  if (!view) return;
  views.delete(terminalId);
  view.container.remove();
  view.terminal.dispose();
}

/** Output goes to every view, shown or not, so switching tabs never shows a terminal missing lines. */
if (typeof window !== "undefined" && "desktop" in window) {
  window.desktop.onTerminalData(({ terminalId, data }) => terminalView(terminalId).terminal.write(data));
}
