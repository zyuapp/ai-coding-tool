import { contextBridge, ipcRenderer } from "electron";
import type { ComputerUsePermission, DesktopAPI, RunCommand, RunEvent } from "./contracts/ipc";

const api: DesktopAPI = {
  openFolder: () => ipcRenderer.invoke("workspace:open"),
  projectlessWorkspace: () => ipcRenderer.invoke("workspace:projectless"),
  commands: (workspaceId: string) => ipcRenderer.invoke("workspace:commands", workspaceId),
  computerUsePermissions: () => ipcRenderer.invoke("computer-use:permissions"),
  enableComputerUse: (permission: ComputerUsePermission) => ipcRenderer.invoke("computer-use:enable", permission),
  restartForComputerUse: () => ipcRenderer.send("computer-use:restart"),
  send: (command: RunCommand) => ipcRenderer.send("run:command", command),
  onAgentEvent: (listener: (event: RunEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: RunEvent) => listener(payload);
    ipcRenderer.on("run:event", handler);
    return () => ipcRenderer.removeListener("run:event", handler);
  },
  changedFiles: (workspaceId: string) => ipcRenderer.invoke("workspace:changed-files", workspaceId),
  saveAttachment: (data: string) => ipcRenderer.invoke("attachment:save", data),
  loadTaskStore: () => ipcRenderer.invoke("task-store:load"),
  persistTaskStore: (delta) => ipcRenderer.invoke("task-store:persist", delta),
};

contextBridge.exposeInMainWorld("desktop", api);
