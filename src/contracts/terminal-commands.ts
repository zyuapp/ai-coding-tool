import { optionalText, text, type Declarations } from "./command-declaration.js";
import { isTerminalDimension, MAX_TERMINAL_INPUT } from "./terminal.js";

/**
 * The terminal panel. Every command here is the user's own: a run may read what a shell has printed
 * but never drives one, so none of these appear in `ExternalCommand`.
 */
export type TerminalCommand =
  /** A shell in the current thread's checkout, or in `cwd` when one is named. */
  | { type: "terminal.open"; cwd?: string }
  | { type: "terminal.select"; terminalId: string }
  | { type: "terminal.close"; terminalId: string }
  /** A fresh shell in the same folder, in the tab of the one it replaces. */
  | { type: "terminal.restart"; terminalId: string }
  /** Keystrokes on their way to the shell, and the size it believes it has. Neither changes state. */
  | { type: "terminal.input"; terminalId: string; data: string }
  | { type: "terminal.resize"; terminalId: string; cols: number; rows: number };

export const terminalCommands = {
  "terminal.open": { fields: { cwd: optionalText }, at: "thread" },
  "terminal.select": { fields: { terminalId: text }, at: "terminal" },
  "terminal.close": { fields: { terminalId: text }, at: "terminal" },
  "terminal.restart": { fields: { terminalId: text }, at: "terminal" },
  "terminal.input": { fields: { terminalId: text, data: (value): value is string => typeof value === "string" && value.length <= MAX_TERMINAL_INPUT }, at: "terminal" },
  "terminal.resize": { fields: { terminalId: text, cols: isTerminalDimension, rows: isTerminalDimension }, at: "terminal" },
} satisfies Declarations<TerminalCommand>;
