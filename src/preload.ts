import { contextBridge, ipcRenderer } from "electron";
import type { AgentEvent, AgentRequest, DesktopAPI } from "./shared";

const api: DesktopAPI = {
  openFolder: () => ipcRenderer.invoke("folder:open"),
  send: (request: AgentRequest) => ipcRenderer.send("agent:request", request),
  onAgentEvent: (listener: (event: AgentEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AgentEvent) => listener(payload);
    ipcRenderer.on("agent:event", handler);
    return () => ipcRenderer.removeListener("agent:event", handler);
  },
  changedFiles: (folder: string) => ipcRenderer.invoke("git:changed-files", folder),
};

contextBridge.exposeInMainWorld("desktop", api);
