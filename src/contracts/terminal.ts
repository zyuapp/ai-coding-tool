export type TerminalStartOptions = { cwd: string };
export type TerminalReadOptions = { lines: number; match?: string };

/** What main holds for a terminal: its lines, with no escape sequences left in them. */
export type TerminalText = {
  lines: string[];
  /** How many lines the terminal holds that the limit left out. */
  omitted: number;
  /** Set when a filter was applied, counting the lines it kept. */
  matched?: number;
};

/** A flush of everything the shell printed since the last one. */
export type TerminalDataEvent = { terminalId: string; data: string; sequence: number };

/** Resolved screen contents and the last live-output flush included in them. */
export type TerminalScreenSnapshot = { data: string; cols: number; rows: number; sequence: number };
