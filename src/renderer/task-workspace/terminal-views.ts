import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

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
  container: HTMLDivElement;
  terminal: Terminal | null;
  fit: FitAddon | null;
  /** What arrived before xterm finished loading, written in order once it has. */
  pending: string[];
  opened: boolean;
};

const views = new Map<string, TerminalView>();
let publishInput: (terminalId: string, data: string) => void = () => undefined;
let xterm: Promise<{ Terminal: typeof Terminal; FitAddon: typeof FitAddon }> | null = null;

/** xterm is only needed once a shell exists, so it stays out of the startup bundle. */
function loadXterm() {
  xterm ??= Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(([core, addon]) => ({
    Terminal: core.Terminal,
    FitAddon: addon.FitAddon,
  }));
  return xterm;
}

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

/** The record of a view, which exists before xterm does so output has somewhere to wait. */
function terminalRecord(terminalId: string): TerminalView {
  const existing = views.get(terminalId);
  if (existing) return existing;
  const container = document.createElement("div");
  container.className = "terminal-surface";
  const view: TerminalView = { container, terminal: null, fit: null, pending: [], opened: false };
  views.set(terminalId, view);
  return view;
}

async function terminalView(terminalId: string): Promise<TerminalView> {
  const view = terminalRecord(terminalId);
  if (view.terminal) return view;
  const { Terminal, FitAddon } = await loadXterm();
  /** Another caller may have raced ahead, or the terminal may be gone by now. */
  if (view.terminal || views.get(terminalId) !== view) return view;
  const terminal = new Terminal({
    allowProposedApi: true,
    scrollback: SCROLLBACK_LINES,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "monospace",
    fontSize: 12,
    theme: terminalTheme(),
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.onData((data) => publishInput(terminalId, data));
  view.terminal = terminal;
  view.fit = fit;
  for (const data of view.pending.splice(0)) terminal.write(data);
  return view;
}

/** Draws the view into its container the first time it is shown; a later show only re-attaches it. */
export async function showTerminalView(terminalId: string, parent: HTMLElement) {
  const view = await terminalView(terminalId);
  if (!view.terminal || views.get(terminalId) !== view) return;
  parent.appendChild(view.container);
  if (view.opened) return;
  view.terminal.open(view.container);
  view.opened = true;
  try {
    const { WebglAddon } = await import("@xterm/addon-webgl");
    view.terminal.loadAddon(new WebglAddon());
  } catch {
    /** No WebGL here; xterm falls back to its own renderer. */
  }
}

/** Sizes an opened view to its container and reports the grid the shell now has. */
export function fitTerminalView(terminalId: string) {
  const view = views.get(terminalId);
  if (!view?.terminal || !view.fit || !view.opened) return null;
  view.fit.fit();
  return { cols: view.terminal.cols, rows: view.terminal.rows };
}

export function focusTerminalView(terminalId: string) {
  views.get(terminalId)?.terminal?.focus();
}

export function hideTerminalView(terminalId: string) {
  views.get(terminalId)?.container.remove();
}

export function disposeTerminalView(terminalId: string) {
  const view = views.get(terminalId);
  if (!view) return;
  views.delete(terminalId);
  view.container.remove();
  view.terminal?.dispose();
}

/** Output goes to every view, shown or not, so switching tabs never shows a terminal missing lines. */
if (typeof window !== "undefined" && "desktop" in window) {
  window.desktop.onTerminalData(({ terminalId, data }) => {
    const view = terminalRecord(terminalId);
    if (view.terminal) {
      view.terminal.write(data);
      return;
    }
    view.pending.push(data);
    void terminalView(terminalId);
  });
}
