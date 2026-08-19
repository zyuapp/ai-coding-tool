/**
 * One shell the terminal panel holds open. The reducer owns this record; the process itself, and
 * everything it has printed, live in main. Output never becomes workspace state.
 */
export type TerminalSession = {
  id: string;
  /** What the shell calls itself, else the folder it runs in. */
  title: string;
  cwd: string;
  /** The thread it was opened for. A read that names no terminal prefers that thread's own. */
  taskId: string | null;
  status: "running" | "exited";
  exitCode?: number;
  /** Why the shell never started, or why it stopped in a way its exit code does not explain. */
  error?: string;
};

/** What main reports about a session. Output travels on its own channel and never comes through here. */
export type TerminalUpdate = {
  terminalId: string;
  title?: string;
  status?: TerminalSession["status"];
  exitCode?: number;
  error?: string;
};

/** What a caller reads: the lines on screen and in scrollback, as text with no escape sequences left. */
export type TerminalSnapshot = {
  terminalId: string;
  title: string;
  cwd: string;
  status: TerminalSession["status"];
  exitCode?: number;
  error?: string;
  lines: string[];
  /** How many lines the terminal holds that the limit left out. */
  omitted: number;
  /** Set when a filter was applied, counting the lines it kept. */
  matched?: number;
};

/** How many lines a read returns when the caller does not say, kept small so a read is cheap. */
export const DEFAULT_TERMINAL_LINES = 100;
/** The most any read returns, however much the caller asks for. */
export const MAX_TERMINAL_LINES = 2_000;
/** How much text a read returns at most, whatever the line count works out to. */
export const MAX_TERMINAL_BYTES = 100_000;

export function terminalLineLimit(lines: number | undefined) {
  if (lines === undefined) return DEFAULT_TERMINAL_LINES;
  return Math.max(1, Math.min(Math.floor(lines), MAX_TERMINAL_LINES));
}

/** The folder a session is named after when the shell says nothing. */
export function terminalTitle(cwd: string) {
  return cwd.split("/").filter(Boolean).at(-1) ?? cwd;
}

/** How a session reads in a list, for a caller that has no screen. */
export function describeTerminal(session: TerminalSession) {
  const state = session.status === "running" ? "running" : `exited${session.exitCode === undefined ? "" : ` (${session.exitCode})`}`;
  return `${session.title} [${session.id}] · ${session.cwd} · ${state}`;
}

/** Trims a read to the byte ceiling from the end, since the newest lines are the ones worth having. */
export function withinReadBudget(lines: string[]) {
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    bytes += lines[index].length + 1;
    if (bytes > MAX_TERMINAL_BYTES) return lines.slice(index + 1);
  }
  return lines;
}
