import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { terminalLineLimit } from "../domain/terminal.js";
import * as terminal from "./terminal-host.js";

const MAX_TERMINAL_INPUT = 64 * 1024;
const MAX_TERMINAL_DIMENSION = 1_000;

function terminalId(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 256) throw new Error("Invalid terminal ID.");
  return value;
}

function terminalDimension(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_TERMINAL_DIMENSION) throw new Error("Invalid terminal size.");
  return value;
}

export function registerTerminalIpc(trusted: (event: IpcMainInvokeEvent) => boolean) {
  ipcMain.handle("terminal:snapshot", (event, id: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    return terminal.terminalSnapshot(terminalId(id));
  });

  ipcMain.handle("terminal:start", (event, id: unknown, options: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    const cwd = (options as { cwd?: unknown } | null)?.cwd;
    if (typeof cwd !== "string" || !cwd) throw new Error("Invalid terminal folder.");
    terminal.startTerminal(terminalId(id), cwd);
  });

  ipcMain.handle("terminal:write", (event, id: unknown, data: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    if (typeof data !== "string" || data.length > MAX_TERMINAL_INPUT) throw new Error("Invalid terminal input.");
    terminal.writeTerminal(terminalId(id), data);
  });

  ipcMain.handle("terminal:resize", (event, id: unknown, cols: unknown, rows: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    terminal.resizeTerminal(terminalId(id), terminalDimension(cols), terminalDimension(rows));
  });

  ipcMain.handle("terminal:close", (event, id: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    terminal.closeTerminal(terminalId(id));
  });

  ipcMain.handle("terminal:read", (event, id: unknown, options: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    const read = options as { lines?: unknown; match?: unknown } | null;
    if (typeof read?.lines !== "number" || !Number.isFinite(read.lines)) throw new Error("Invalid terminal read.");
    if (read.match !== undefined && typeof read.match !== "string") throw new Error("Invalid terminal filter.");
    return terminal.readTerminal(terminalId(id), { lines: terminalLineLimit(read.lines), ...(read.match ? { match: read.match } : {}) });
  });
}
