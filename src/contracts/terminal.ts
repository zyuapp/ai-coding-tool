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

/** A remote viewer first restores the screen, then reads only output after its watermark. */
export type TerminalOutputRead = TerminalScreenSnapshot & { kind: "snapshot" | "output" };

export const MAX_TERMINAL_INPUT = 64 * 1024;
export const MAX_TERMINAL_DIMENSION = 1_000;

export function isTerminalDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_TERMINAL_DIMENSION;
}

export function isTerminalOutputRead(value: unknown): value is TerminalOutputRead | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const read = value as TerminalOutputRead;
  return (read.kind === "snapshot" || read.kind === "output") && typeof read.data === "string"
    && isTerminalDimension(read.cols) && isTerminalDimension(read.rows)
    && Number.isSafeInteger(read.sequence) && read.sequence >= 0;
}
