import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DesktopShortcutRefusal, ShortcutInvocation, TerminalDataEvent, WindowDesktopAPI, WindowDesktopCall, WindowScreenshot } from "./contracts/ipc";
import type { WorkspaceBridge, WorkspaceSurfaceEffect, WorkspaceUpdate } from "./contracts/workspace-runtime";

/** Every call crosses on one channel under its name, which main checks against its one table. */
function relay<Name extends WindowDesktopCall>(name: Name) {
  return ((...args: unknown[]) => ipcRenderer.invoke("desktop:call", name, ...args)) as WindowDesktopAPI[Name];
}

/** What main pushes at the window, each on a channel of its own. */
function pushed<Payload>(channel: string) {
  return (listener: (payload: Payload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: Payload) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => { ipcRenderer.removeListener(channel, handler); };
  };
}

const api: WindowDesktopAPI = {
  platform: process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : "other",
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  openFolder: relay("openFolder"),
  projectlessWorkspace: relay("projectlessWorkspace"),
  commands: relay("commands"),
  branches: relay("branches"),
  diffPatch: relay("diffPatch"),
  describeFiles: relay("describeFiles"),
  saveAttachment: relay("saveAttachment"),
  readAttachment: relay("readAttachment"),
  readAttachmentContext: relay("readAttachmentContext"),
  setBrowserBounds: relay("setBrowserBounds"),
  focusBrowserTab: relay("focusBrowserTab"),
  terminalSnapshot: relay("terminalSnapshot"),
  readRemoteTerminal: relay("readRemoteTerminal"),
  setTheme: relay("setTheme"),
  onTerminalData: pushed<TerminalDataEvent>("terminal:data"),
  onWindowScreenshot: pushed<WindowScreenshot>("window:screenshot"),
  onDesktopShortcutRefused: pushed<DesktopShortcutRefusal>("window:shortcut-refused"),
  onShortcut: pushed<ShortcutInvocation>("window:shortcut"),
  onShortcutCaptured: pushed<string | null>("window:shortcut-captured"),
  onOpenThread: pushed<string>("window:open-thread"),
};

contextBridge.exposeInMainWorld("desktop", api);

const workspace: WorkspaceBridge = {
  request: (input) => ipcRenderer.invoke("workspace-runtime:request", input),
  migrate: (values) => ipcRenderer.invoke("workspace-runtime:migrate", values),
  onUpdate: pushed<WorkspaceUpdate>("workspace-runtime:update"),
  onSurface: pushed<WorkspaceSurfaceEffect>("workspace-runtime:surface"),
};
contextBridge.exposeInMainWorld("workspace", workspace);
