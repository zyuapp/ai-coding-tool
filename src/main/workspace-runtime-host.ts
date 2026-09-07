import { ipcMain, WebContentsView, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isWorkspaceViewInput } from "../contracts/workspace-view-input.js";
import { rememberedPlacement } from "./window-placement.js";
import type { WorkspaceInput } from "../application/workspace-reducer.js";
import type { WorkspaceRequest, WorkspaceResponse, WorkspaceUpdate, WorkspaceSurfaceEffect } from "../contracts/workspace-runtime.js";

export type RuntimeOwner = Pick<BrowserWindow, "webContents" | "isDestroyed">;

/** A dedicated, nonvisual webContents hosts the application independently of the visible window. */
export function createWorkspaceRuntimeHost(view: () => BrowserWindow | null) {
  let owner: WebContentsView | null = null;
  let ready = false;
  let failure: string | null = null;
  const waiting: WorkspaceRequest[] = [];
  const pending = new Map<string, { resolve: (response: WorkspaceResponse["result"]) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }>();

  function failPending(message: string) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    pending.clear();
    waiting.length = 0;
  }

  /** An accepted command may perform long-running effects; its completion belongs to the runtime. */
  function send(request: WorkspaceRequest) {
    const entry = pending.get(request.id);
    if (!entry) return;
    if (request.input) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    try {
      owner!.webContents.send("workspace-runtime:request", request);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      failPending(failure);
    }
  }

  function trusted(event: IpcMainEvent | IpcMainInvokeEvent) {
    return Boolean(owner && event.sender === owner.webContents && !owner.webContents.isDestroyed());
  }

  function request(input?: WorkspaceInput, flush?: true): Promise<WorkspaceResponse["result"]> {
    if (!owner || owner.webContents.isDestroyed()) return Promise.reject(new Error("The workspace runtime is unavailable."));
    if (failure) return Promise.reject(new Error(failure));
    const request: WorkspaceRequest = { id: randomUUID() };
    if (input) request.input = input;
    if (flush) request.flush = true;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(request.id);
        const index = waiting.indexOf(request);
        if (index !== -1) waiting.splice(index, 1);
        reject(new Error("The workspace runtime did not respond."));
      }, 30_000);
      pending.set(request.id, { resolve, reject, timer });
      if (ready) send(request);
      else waiting.push(request);
    });
  }

  ipcMain.handle("workspace-runtime:request", (event, input?: WorkspaceInput) => {
    const window = view();
    if (!window || window.isDestroyed() || event.sender !== window.webContents) throw new Error("Untrusted IPC sender.");
    if (input !== undefined && !isWorkspaceViewInput(input)) throw new Error("Invalid workspace input.");
    return request(input);
  });
  ipcMain.on("workspace-runtime:ready", (event) => {
    if (!trusted(event)) return;
    const recovering = failure !== null;
    ready = true;
    failure = null;
    for (const request of waiting.splice(0)) send(request);
    if (recovering) void request().catch((error) => console.error("Could not refresh the workspace after recovery:", error));
  });
  ipcMain.on("workspace-runtime:response", (event, response: WorkspaceResponse) => {
    if (!trusted(event) || !response || typeof response.id !== "string") return;
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    clearTimeout(entry.timer);
    entry.resolve(response.result);
  });
  ipcMain.on("workspace-runtime:update", (event, update: WorkspaceUpdate) => {
    if (!trusted(event)) return;
    const window = view();
    if (window && !window.isDestroyed()) window.webContents.send("workspace-runtime:update", update);
  });
  ipcMain.on("workspace-runtime:surface", (event, effect: WorkspaceSurfaceEffect) => {
    if (!trusted(event)) return;
    const window = view();
    if (window && !window.isDestroyed()) window.webContents.send("workspace-runtime:surface", effect);
  });

  return {
    trusted,
    dispatch: (input: WorkspaceInput) => request(input),
    owner: (): RuntimeOwner | null => {
      const current = owner;
      return current ? { webContents: current.webContents, isDestroyed: () => current.webContents.isDestroyed() } : null;
    },
    async start() {
      owner = new WebContentsView({ webPreferences: {
        preload: path.join(__dirname, "../preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        additionalArguments: ["--workspace-runtime"],
      } });
      const placement = rememberedPlacement();
      owner.setBounds({ x: 0, y: 0, width: placement.width, height: placement.height });
      owner.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      owner.webContents.on("render-process-gone", () => {
        ready = false;
        failure = "The workspace runtime stopped unexpectedly.";
        failPending(failure);
      });
      await owner.webContents.loadURL(pathToFileURL(path.join(__dirname, "../../renderer/index.html")).toString());
    },
    async flush() {
      if (!owner) return;
      const result = await request(undefined, true);
      if (!result.ok) throw new Error(result.message);
    },
    close() {
      failPending("The workspace runtime has closed.");
      owner?.webContents.close();
      owner = null;
      ready = false;
      failure = null;
    },
  };
}
