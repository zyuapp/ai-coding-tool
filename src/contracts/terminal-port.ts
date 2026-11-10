import type { TerminalUpdate } from "../domain/terminal.js";
import type { TerminalDataEvent, TerminalOutputRead, TerminalReadOptions, TerminalScreenSnapshot, TerminalStartOptions, TerminalText } from "./terminal.js";

/** The terminal panel's shells live in main; the window owns the record of them. */
export type TerminalPort = {
  runtime: {
    startTerminal(terminalId: string, options: TerminalStartOptions): Promise<void>;
    /** User input from this window or a paired computer. A run may read a terminal, never drive one. */
    writeTerminal(terminalId: string, data: string): Promise<void>;
    resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void>;
    closeTerminal(terminalId: string): Promise<void>;
    /** The lines the terminal holds, cooked to plain text. Null when that terminal is gone. */
    readTerminal(terminalId: string, options: TerminalReadOptions): Promise<TerminalText | null>;
    onTerminalEvent(listener: (update: TerminalUpdate) => void): () => void;
  };
  windowCalls: {
    terminalSnapshot(terminalId: string): Promise<TerminalScreenSnapshot | null>;
    readRemoteTerminal(computerId: string, terminalId: string, after?: number): Promise<TerminalOutputRead | null>;
  };
  windowOwn: {
    /** Output, coalesced and delivered straight to the view. It is never workspace state. */
    onTerminalData(listener: (event: TerminalDataEvent) => void): () => void;
  };
};
