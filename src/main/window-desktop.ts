import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isBrowserBounds, isString, isWindowTheme, type WindowDesktopAPI, type WindowDesktopCall, type WindowTheme } from "../contracts/ipc.js";
import { isAgentEngine } from "../domain/agent-engine.js";
import { isDiffRange } from "../domain/diff.js";
import type { RuntimeDesktop } from "../host/runtime-desktop.js";
import { readAttachmentContext, savedAttachmentPath } from "./attachment-store.js";
import { setBounds } from "./browser-host.js";
import type { ComputerReads } from "./computer-queries.js";
import { terminalSnapshot } from "./terminal-host.js";

/** What the window's calls are answered from: the runtime's own desktop, the reads, and the window's frame. */
export type WindowDesktopHost = {
  desktop: Pick<RuntimeDesktop, "openFolder" | "projectlessWorkspace" | "diffPatch" | "saveAttachment" | "focusBrowserTab">;
  reads: Pick<ComputerReads, "read">;
  setTheme: (theme: WindowTheme) => void;
};

type GuardEach<Args extends unknown[]> = { [Index in keyof Args]-?: (value: unknown) => boolean };
type Guards<Name extends WindowDesktopCall> = GuardEach<Parameters<WindowDesktopAPI[Name]>>;
/** A call's argument guards, one per parameter, and what it does once they pass. */
type Relayed<Name extends WindowDesktopCall> = { args: Guards<Name>; run: (...args: Parameters<WindowDesktopAPI[Name]>) => unknown };

const MAX_PATH_LENGTH = 4_096;
/** How many paths one drop may name. */
const MAX_DESCRIBED_FILES = 20;

const isId = (value: unknown) => isString(value);
const isPath = (value: unknown) => isString(value, MAX_PATH_LENGTH);
const optional = (guard: (value: unknown) => boolean) => (value: unknown) => value === undefined || guard(value);
const isSequence = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;

function keptAttachment(file: string) {
  const saved = savedAttachmentPath(file);
  if (!saved) throw new Error("That image is not one this app is keeping.");
  return saved;
}

/** What the window dropped: the name to show, and whether the path is a folder. */
async function describeFiles(paths: unknown[]) {
  const named = paths.filter((value): value is string => isPath(value)).slice(0, MAX_DESCRIBED_FILES);
  const described = await Promise.all(named.map(async (candidate) => {
    const entry = await stat(candidate).catch(() => null);
    if (!entry || (!entry.isFile() && !entry.isDirectory())) return null;
    const resolved = path.resolve(candidate);
    return { path: resolved, name: path.basename(resolved), ...(entry.isDirectory() ? { folder: true as const } : {}) };
  }));
  return described.filter((item) => item !== null);
}

/** Every call the window makes, with the checks its arguments pass before anything runs. */
export function windowDesktopCalls(host: WindowDesktopHost): { [Name in WindowDesktopCall]: Relayed<Name> } {
  return {
    openFolder: { args: [], run: () => host.desktop.openFolder() },
    projectlessWorkspace: { args: [], run: () => host.desktop.projectlessWorkspace() },
    commands: {
      args: [isId, isAgentEngine],
      run: (workspaceId, engine) => host.reads.read({ kind: "commands", workspaceId, engine }, { workspace: workspaceId }),
    },
    branches: { args: [isId], run: (workspaceId) => host.reads.read({ kind: "branches", workspaceId }, { workspace: workspaceId }) },
    diffPatch: {
      args: [isId, isDiffRange, isPath, optional(isPath), optional((value) => typeof value === "boolean")],
      run: (workspaceId, range, filePath, previousPath, ignoreWhitespace) => host.desktop.diffPatch(workspaceId, range, filePath, previousPath, ignoreWhitespace),
    },
    describeFiles: { args: [Array.isArray], run: (paths) => describeFiles(paths) },
    saveAttachment: { args: [(value) => typeof value === "string", optional(isPath)], run: (data, original) => host.desktop.saveAttachment(data, original) },
    readAttachment: { args: [isPath], run: async (file) => (await readFile(keptAttachment(file))).toString("base64") },
    readAttachmentContext: { args: [isPath], run: (file) => readAttachmentContext(keptAttachment(file)) },
    setBrowserBounds: { args: [(value) => value === null || isBrowserBounds(value)], run: async (bounds) => setBounds(bounds) },
    focusBrowserTab: { args: [isId], run: (tabId) => host.desktop.focusBrowserTab(tabId) },
    terminalSnapshot: { args: [isId], run: (terminalId) => terminalSnapshot(terminalId) },
    readRemoteTerminal: {
      args: [isId, isId, optional(isSequence)],
      run: (computerId, terminalId, after) => host.reads.read({ kind: "terminal-output", terminalId, ...(after === undefined ? {} : { after }) }, { computer: computerId }),
    },
    setTheme: { args: [isWindowTheme], run: (theme) => host.setTheme(theme) },
  };
}

/** The window's desktop calls, on one channel behind one trust check and each call's argument guards. */
export function serveWindowDesktop(host: WindowDesktopHost, trusted: (event: IpcMainInvokeEvent) => boolean) {
  const calls = windowDesktopCalls(host);
  ipcMain.handle("desktop:call", async (event, name: unknown, ...args: unknown[]) => {
    if (!trusted(event)) throw new Error("Untrusted IPC sender.");
    if (typeof name !== "string" || !Object.hasOwn(calls, name)) throw new Error("Unknown desktop call.");
    const call = calls[name as WindowDesktopCall] as { args: ReadonlyArray<(value: unknown) => boolean>; run: (...args: unknown[]) => unknown };
    if (args.length > call.args.length || !call.args.every((guard, index) => guard(args[index]))) throw new Error(`Invalid ${name} call.`);
    return call.run(...args);
  });
}
