import { spawn, type IPty } from "@lydell/node-pty";
import { Terminal } from "@xterm/headless";
import type { TerminalDataEvent, TerminalReadOptions, TerminalText } from "../contracts/ipc.js";
import { terminalTitle, withinReadBudget, type TerminalUpdate } from "../domain/terminal.js";

/**
 * The terminal panel's shells. This is the only place a pseudo-terminal is created, written to, or
 * killed, and the only place that keeps what one has printed.
 *
 * Output is coalesced rather than forwarded per chunk: a build printing thousands of small writes
 * would otherwise cost one IPC message each. Every flush is fed to a headless terminal here and to
 * the view at the same moment, from the same trimmed text, so what a caller reads is what the user
 * sees rather than a second, drifting copy.
 */
const FLUSH_MS = 16;
/** The most one flush carries. Anything past it is dropped from the front, with a line saying so. */
const MAX_FLUSH_BYTES = 512 * 1024;
const SCROLLBACK_LINES = 5_000;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

type Session = {
  id: string;
  cwd: string;
  pty: IPty | null;
  /** The read source of truth: resolves overwrites, clears, and alternate screens the way the view does. */
  screen: Terminal;
  pending: string;
  timer: NodeJS.Timeout | null;
};

const sessions = new Map<string, Session>();
let publishData: (event: TerminalDataEvent) => void = () => undefined;
let publishUpdate: (update: TerminalUpdate) => void = () => undefined;

export function startTerminalHost(handlers: { onData: (event: TerminalDataEvent) => void; onUpdate: (update: TerminalUpdate) => void }) {
  publishData = handlers.onData;
  publishUpdate = handlers.onUpdate;
}

/** Every shell is killed when the window goes, so a closed window leaves no process running. */
export function stopTerminalHost() {
  for (const id of [...sessions.keys()]) closeTerminal(id);
}

/** The user's own login shell, so a terminal here has the environment their terminal app would. */
function shellCommand(): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: process.env.COMSPEC || "cmd.exe", args: [] };
  const file = process.env.SHELL || "/bin/bash";
  return { file, args: ["-l"] };
}

function shellEnvironment(): Record<string, string> {
  const { ELECTRON_RUN_AS_NODE: _node, ...rest } = process.env;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rest)) if (value !== undefined) env[key] = value;
  return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" };
}

function flush(session: Session) {
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = null;
  }
  if (!session.pending) return;
  const pending = session.pending;
  session.pending = "";
  const dropped = pending.length - MAX_FLUSH_BYTES;
  const data = dropped > 0
    ? `\r\n… ${Math.round(dropped / 1024).toLocaleString()} KB of output dropped\r\n${pending.slice(dropped)}`
    : pending;
  session.screen.write(data);
  publishData({ terminalId: session.id, data });
}

function schedule(session: Session, chunk: string) {
  session.pending += chunk;
  if (session.timer) return;
  session.timer = setTimeout(() => flush(session), FLUSH_MS);
  session.timer.unref?.();
}

/** Idempotent: a terminal that already has a shell keeps it, so reopening the panel never restarts one. */
export function startTerminal(terminalId: string, cwd: string) {
  if (sessions.get(terminalId)) return;
  const screen = new Terminal({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
  const session: Session = { id: terminalId, cwd, pty: null, screen, pending: "", timer: null };
  sessions.set(terminalId, session);
  screen.onTitleChange((title) => publishUpdate({ terminalId, title: title || terminalTitle(cwd) }));
  const { file, args } = shellCommand();
  try {
    session.pty = spawn(file, args, {
      name: "xterm-256color",
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd,
      env: shellEnvironment(),
    });
  } catch (error) {
    publishUpdate({ terminalId, status: "exited", error: error instanceof Error ? error.message : String(error) });
    return;
  }
  session.pty.onData((chunk) => schedule(session, chunk));
  session.pty.onExit(({ exitCode }) => {
    flush(session);
    session.pty = null;
    publishUpdate({ terminalId, status: "exited", exitCode });
  });
}

export function writeTerminal(terminalId: string, data: string) {
  sessions.get(terminalId)?.pty?.write(data);
}

export function resizeTerminal(terminalId: string, cols: number, rows: number) {
  const session = sessions.get(terminalId);
  if (!session) return;
  session.screen.resize(cols, rows);
  session.pty?.resize(cols, rows);
}

export function closeTerminal(terminalId: string) {
  const session = sessions.get(terminalId);
  if (!session) return;
  sessions.delete(terminalId);
  if (session.timer) clearTimeout(session.timer);
  session.pty?.kill();
  session.screen.dispose();
}

/** Everything the terminal holds, oldest first, with the trailing blank lines a screen always has removed. */
function screenLines(screen: Terminal) {
  const buffer = screen.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < buffer.length; row++) lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

/**
 * Reads a terminal as plain text. Pending output is flushed first, so a read taken straight after a
 * command shows what that command printed rather than what was there before it.
 */
export async function readTerminal(terminalId: string, options: TerminalReadOptions): Promise<TerminalText | null> {
  const session = sessions.get(terminalId);
  if (!session) return null;
  flush(session);
  await new Promise<void>((resolve) => session.screen.write("", resolve));
  const all = screenLines(session.screen);
  const match = options.match?.trim().toLowerCase();
  const filtered = match ? all.filter((line) => line.toLowerCase().includes(match)) : all;
  const kept = withinReadBudget(filtered.slice(-options.lines));
  return {
    lines: kept,
    omitted: filtered.length - kept.length,
    ...(match ? { matched: filtered.length } : {}),
  };
}
