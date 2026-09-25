import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { terminalLineLimit } from "../domain/terminal.js";
import * as terminal from "./terminal-host.js";
import { isComputerQuery, type ComputerQuery } from "../contracts/computers.js";
import { isTerminalDimension, isTerminalOutputRead, MAX_TERMINAL_INPUT } from "../contracts/terminal.js";

function terminalId(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 256) throw new Error("Invalid terminal ID.");
  return value;
}

function terminalDimension(value: unknown) {
  if (!isTerminalDimension(value)) throw new Error("Invalid terminal size.");
  return value;
}

export function registerTerminalIpc(trusted: (event: IpcMainInvokeEvent) => boolean, query: (computerId: string, query: ComputerQuery) => Promise<unknown>) {
  ipcMain.handle("terminal:remote-read", async (event, computerId: unknown, id: unknown, after: unknown) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    const request = { kind: "terminal-output", terminalId: id, ...(after === undefined ? {} : { after }) };
    if (!isComputerQuery(request)) throw new Error("Invalid terminal read.");
    const result = await query(terminalId(computerId), request);
    if (!isTerminalOutputRead(result)) throw new Error("Invalid terminal output.");
    return result;
  });
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
