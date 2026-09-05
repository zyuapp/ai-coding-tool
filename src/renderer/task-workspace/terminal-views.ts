import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import type { FindResults } from "../../domain/find.js";
import { TerminalOutput } from "./terminal-output.js";

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
  search: SearchAddon | null;
  output: TerminalOutput;
  opened: boolean;
};

const views = new Map<string, TerminalView>();
let publishInput: (terminalId: string, data: string) => void = () => undefined;
let publishFind: (terminalId: string, results: FindResults) => void = () => undefined;
let publishResize: (terminalId: string, cols: number, rows: number) => void = () => undefined;
let xterm: Promise<{ Terminal: typeof Terminal; FitAddon: typeof FitAddon; SearchAddon: typeof SearchAddon }> | null = null;

/** xterm is only needed once a shell exists, so it stays out of the startup bundle. */
function loadXterm() {
  xterm ??= Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/addon-search")]).then(([core, fit, search]) => ({
    Terminal: core.Terminal,
    FitAddon: fit.FitAddon,
    SearchAddon: search.SearchAddon,
  }));
  return xterm;
}

/**
 * The chunk is read from disk, and a build under a running app takes it away for as long as it runs.
 * A module that failed to load stays failed for the life of the window however often it is asked for,
 * so it is fetched while the app is idle rather than at the moment a terminal is opened.
 */
if (typeof window !== "undefined" && !window.workspace?.owner && "requestIdleCallback" in window) {
  window.requestIdleCallback(() => void loadXterm().catch(() => undefined));
}

/** Where keystrokes go. Set by the panel, since a view can exist before the panel is mounted. */
export function onTerminalInput(handler: (terminalId: string, data: string) => void) {
  publishInput = handler;
}

/** The grid a shell ends up with when nothing resized its container, which only a type change does. */
export function onTerminalResize(handler: (terminalId: string, cols: number, rows: number) => void) {
  publishResize = handler;
  return () => { publishResize = () => undefined; };
}

/** What a search found. The shell holds its own scrollback, so it counts its own matches. */
export function onTerminalFindResults(handler: (terminalId: string, results: FindResults) => void) {
  publishFind = handler;
  return () => { publishFind = () => undefined; };
}

/**
 * A custom property keeps its color-mix() and relative colours unevaluated, so the values are read
 * off an element that actually paints them rather than off the root's own tokens.
 */
function readColours<K extends string>(tokens: Record<K, string>): Record<K, string> {
  const colours = {} as Record<K, string>;
  const view = document.defaultView;
  if (!view) return colours;
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;top:0;left:0;visibility:hidden;pointer-events:none";
  document.body.appendChild(probe);
  const computed = view.getComputedStyle(probe);
  for (const [key, token] of Object.entries(tokens) as [K, string][]) {
    probe.style.color = `var(${token})`;
    colours[key] = computed.color;
  }
  probe.remove();
  return colours;
}

/** The colours are the stylesheet's, read from the tokens so a theme reaches the terminal too. */
function terminalTheme(): Record<string, string> {
  return readColours({
    background: "--code-surface",
    foreground: "--code-ink",
    cursor: "--ink",
    cursorAccent: "--code-surface",
    selectionBackground: "--terminal-selection",
    black: "--ansi-black",
    red: "--ansi-red",
    green: "--ansi-green",
    yellow: "--ansi-yellow",
    blue: "--ansi-blue",
    magenta: "--ansi-magenta",
    cyan: "--ansi-cyan",
    white: "--ansi-white",
    brightBlack: "--ansi-bright-black",
    brightRed: "--ansi-bright-red",
    brightGreen: "--ansi-bright-green",
    brightYellow: "--ansi-bright-yellow",
    brightBlue: "--ansi-bright-blue",
    brightMagenta: "--ansi-bright-magenta",
    brightCyan: "--ansi-bright-cyan",
    brightWhite: "--ansi-bright-white",
  });
}

/** The face and size the terminal draws in, read from the stylesheet the way its colours are. */
function terminalFont() {
  const tokens = document.defaultView?.getComputedStyle(document.documentElement);
  const size = Number.parseFloat(tokens?.getPropertyValue("--terminal-text") ?? "");
  return {
    family: tokens?.getPropertyValue("--mono").trim() || "monospace",
    size: Number.isFinite(size) && size > 0 ? size : 12,
  };
}

/**
 * Redraws every open shell at the type the user chose. Nothing resized the container, so the panel's
 * observer never fires and the new grid is reported from here instead.
 */
export function restyleTerminalViews() {
  const font = terminalFont();
  for (const [terminalId, view] of views) {
    if (!view.terminal) continue;
    view.terminal.options.fontFamily = font.family;
    view.terminal.options.fontSize = font.size;
    if (!view.opened || !view.fit) continue;
    view.fit.fit();
    publishResize(terminalId, view.terminal.cols, view.terminal.rows);
  }
}

/** Repaints every open shell after the theme changes, since xterm holds the colours it was built with. */
export function repaintTerminalViews() {
  const theme = terminalTheme();
  for (const view of views.values()) {
    if (view.terminal) view.terminal.options.theme = theme;
  }
}

/** The record of a view, which exists before xterm does so output has somewhere to wait. */
function terminalRecord(terminalId: string): TerminalView {
  const existing = views.get(terminalId);
  if (existing) return existing;
  const container = document.createElement("div");
  container.className = "terminal-surface";
  const output = new TerminalOutput(
    () => window.desktop.terminalSnapshot(terminalId),
    (snapshot) => {
      view.terminal?.resize(snapshot.cols, snapshot.rows);
      view.terminal?.write(snapshot.data);
    },
    (data) => view.terminal?.write(data),
  );
  const view: TerminalView = { container, terminal: null, fit: null, search: null, output, opened: false };
  views.set(terminalId, view);
  return view;
}

async function terminalView(terminalId: string): Promise<TerminalView> {
  const view = terminalRecord(terminalId);
  if (view.terminal) { await view.output.start(); return view; }
  const { Terminal, FitAddon, SearchAddon } = await loadXterm();
  const font = terminalFont();
  /** Another caller may have raced ahead, or the terminal may be gone by now. */
  if (views.get(terminalId) !== view) return view;
  if (view.terminal) { await view.output.start(); return view; }
  const terminal = new Terminal({
    allowProposedApi: true,
    scrollback: SCROLLBACK_LINES,
    fontFamily: font.family,
    fontSize: font.size,
    theme: terminalTheme(),
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  const search = new SearchAddon();
  terminal.loadAddon(search);
  search.onDidChangeResults(({ resultIndex, resultCount }) => publishFind(terminalId, { matches: resultCount, index: Math.max(0, resultIndex) }));
  terminal.onData((data) => publishInput(terminalId, data));
  view.terminal = terminal;
  view.fit = fit;
  view.search = search;
  await view.output.start();
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

/** The colours a match is drawn in, read from the stylesheet the way the rest of the theme is. */
function searchDecorations() {
  const { match, active } = readColours({ match: "--find-match", active: "--find-active" });
  return { decorations: { matchBackground: match, activeMatchBackground: active, matchOverviewRuler: match, activeMatchColorOverviewRuler: active } };
}

/** Steps to the next match, or the one before it, highlighting every match it passes. */
export function searchTerminalView(terminalId: string, query: string, forward: boolean) {
  const search = views.get(terminalId)?.search;
  if (!search) return;
  const options = searchDecorations();
  if (forward) search.findNext(query, options);
  else search.findPrevious(query, options);
}

export function clearTerminalSearch(terminalId: string) {
  views.get(terminalId)?.search?.clearDecorations();
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
  view.output.dispose();
  view.container.remove();
  view.terminal?.dispose();
}

/** Output goes to every view, shown or not, so switching tabs never shows a terminal missing lines. */
if (typeof window !== "undefined" && "desktop" in window) {
  window.desktop.onTerminalData((event) => {
    const { terminalId } = event;
    const view = terminalRecord(terminalId);
    view.output.push(event);
    /** A failed import or snapshot is retried when the panel is next shown. */
    void terminalView(terminalId).catch(() => undefined);
  });
}
