import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { isWorkspaceViewInput } from "../contracts/workspace-view-input.js";
import type { WorkspaceInput } from "../application/workspace-reducer.js";
import type { WorkspaceResponse, WorkspaceSurfaceEffect, WorkspaceUpdate } from "../contracts/workspace-runtime.js";
import { createRuntimePublisher } from "../host/runtime-publisher.js";
import type { RuntimeDesktop } from "../host/runtime-desktop.js";
import { createWorkspaceRuntime } from "../host/workspace-runtime.js";
import { loadViewPreferences } from "../host/view-preferences-store.js";
import type { JsonStorage } from "./json-storage.js";

export type WorkspaceRuntimeHostOptions = {
  /** The window showing the workspace, which every update and surface effect is sent to. */
  view: () => BrowserWindow | null;
  trusted: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean;
  desktop: RuntimeDesktop;
  storage: JsonStorage;
};

/** How many stored values a window may hand over. Two are expected; a bound keeps a stranger's payload small. */
const MAX_MIGRATED_VALUES = 8;
const MAX_MIGRATED_LENGTH = 16_000_000;

function isStoredValues(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= MAX_MIGRATED_VALUES && entries.every(([key, item]) => key.startsWith("aicodingtool.") && typeof item === "string" && item.length <= MAX_MIGRATED_LENGTH);
}

/**
 * The application, hosted in this process. The window is a view of it: it subscribes to revisions,
 * submits inputs, and is handed the few effects that live in its own views.
 */
export function createWorkspaceRuntimeHost(options: WorkspaceRuntimeHostOptions) {
  const { storage } = options;
  function send(channel: string, payload: WorkspaceUpdate | WorkspaceSurfaceEffect) {
    const window = options.view();
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  }
  const runtime = createWorkspaceRuntime({ desktop: options.desktop, storage, surface: (effect) => send("workspace-runtime:surface", effect) });
  const publisher = createRuntimePublisher(runtime);
  publisher.subscribe((update) => send("workspace-runtime:update", update));
  let closed = false;

  function request(input?: WorkspaceInput): Promise<WorkspaceResponse["result"]> {
    if (closed) return Promise.reject(new Error("The workspace runtime has closed."));
    if (input === undefined) {
      send("workspace-runtime:update", publisher.snapshot());
      return Promise.resolve({ ok: true, revision: publisher.revision });
    }
    return publisher.request(input);
  }

  /** Values a window kept from hosting the runtime itself, taken on once and applied without a restart. */
  async function migrate(values: Record<string, string>) {
    if (!storage.adopt(values)) return;
    const { browserTabs: _reopened, ...preferences } = loadViewPreferences(storage);
    await runtime.dispatch({ type: "preferences.loaded", preferences });
    await runtime.restoreDrafts();
  }

  ipcMain.handle("workspace-runtime:request", (event, input?: unknown) => {
    if (!options.trusted(event)) throw new Error("Untrusted IPC sender.");
    if (input !== undefined && !isWorkspaceViewInput(input)) throw new Error("Invalid workspace input.");
    return request(input);
  });
  ipcMain.handle("workspace-runtime:migrate", async (event, values: unknown) => {
    if (!options.trusted(event)) throw new Error("Untrusted IPC sender.");
    if (!isStoredValues(values)) throw new Error("Invalid stored values.");
    await migrate(values);
  });

  return {
    runtime,
    publisher,
    dispatch: (input: WorkspaceInput) => request(input),
    start: () => runtime.start(),
    async flush() {
      const result = await publisher.flush();
      if (!result.ok) throw new Error(result.message);
    },
    close() {
      closed = true;
      publisher.dispose();
      runtime.dispose();
    },
  };
}

export type WorkspaceRuntimeHost = ReturnType<typeof createWorkspaceRuntimeHost>;
