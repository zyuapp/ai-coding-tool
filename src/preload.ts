import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DesktopShortcutRefusal, ShortcutInvocation, TerminalDataEvent, WindowDesktopAPI, WindowDesktopCall, WindowScreenshot } from "./contracts/ipc";
import type { SimulatorFrame } from "./domain/simulator";
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

/** Main may say whether the window is in use before the page listens, so the last word is kept. */
let windowActive: boolean | undefined;
ipcRenderer.on("window:active", (_event, active: boolean) => { windowActive = active; });
const onWindowActive = pushed<boolean>("window:active");
let glassTint: number | undefined;
ipcRenderer.on("window:glass-tint", (_event, amount: number) => { glassTint = amount; });
const onGlassTint = pushed<number>("window:glass-tint");

const materialArgument = process.argv.find((argument) => argument.startsWith("--window-material="))?.slice("--window-material=".length);

const api: WindowDesktopAPI = {
  platform: process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : "other",
  windowMaterial: materialArgument === "glass" || materialArgument === "vibrancy" ? materialArgument : "none",
  glassLayer: process.argv.includes("--glass-layer"),
  setGlassRegions: relay("setGlassRegions"),
  setWindowGlassRegions: relay("setWindowGlassRegions"),
  setGlassLayerInteractive: relay("setGlassLayerInteractive"),
  focusGlassLayer: relay("focusGlassLayer"),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  openFolder: relay("openFolder"),
  projectlessWorkspace: relay("projectlessWorkspace"),
  commands: relay("commands"),
  branches: relay("branches"),
  commits: relay("commits"),
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
  watchSimulator: relay("watchSimulator"),
  unwatchSimulator: relay("unwatchSimulator"),
  onTerminalData: pushed<TerminalDataEvent>("terminal:data"),
  onSimulatorFrame: pushed<SimulatorFrame>("simulator:frame"),
  onWindowScreenshot: pushed<WindowScreenshot>("window:screenshot"),
  onDesktopShortcutRefused: pushed<DesktopShortcutRefusal>("window:shortcut-refused"),
  onShortcut: pushed<ShortcutInvocation>("window:shortcut"),
  onShortcutCaptured: pushed<string | null>("window:shortcut-captured"),
  onOpenThread: pushed<string>("window:open-thread"),
  onDictationLevel: pushed<number>("dictation:level"),
  onWindowActive: (listener) => {
    if (windowActive !== undefined) listener(windowActive);
    return onWindowActive(listener);
  },
  onGlassTint: (listener) => {
    if (glassTint !== undefined) listener(glassTint);
    return onGlassTint(listener);
  },
};

contextBridge.exposeInMainWorld("desktop", api);

const workspace: WorkspaceBridge = {
  request: (input) => ipcRenderer.invoke("workspace-runtime:request", input),
  migrate: (values) => ipcRenderer.invoke("workspace-runtime:migrate", values),
  onUpdate: pushed<WorkspaceUpdate>("workspace-runtime:update"),
  onSurface: pushed<WorkspaceSurfaceEffect>("workspace-runtime:surface"),
};
contextBridge.exposeInMainWorld("workspace", workspace);
