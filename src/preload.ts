import { contextBridge, ipcRenderer } from "electron";
import type { AutomationAck, AutomationFire, ComputerUsePermission, DesktopAPI, RunCommand, RunEvent } from "./contracts/ipc";
import type { ThreadRequest, ThreadResponse } from "./contracts/threads";
import type { AutomationDraft, AutomationPatch, AutomationView } from "./domain/automation";

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
  suggestTaskTitle: (text: string, attachments: string[]) => ipcRenderer.invoke("task-title:suggest", text, attachments),
  loadTaskStore: () => ipcRenderer.invoke("task-store:load"),
  persistTaskStore: (delta) => ipcRenderer.invoke("task-store:persist", delta),
  listAutomations: () => ipcRenderer.invoke("automation:list"),
  saveAutomation: (draft: AutomationDraft) => ipcRenderer.invoke("automation:save", draft),
  updateAutomation: (taskId: string, patch: AutomationPatch) => ipcRenderer.invoke("automation:update", taskId, patch),
  deleteAutomation: (taskId: string) => ipcRenderer.invoke("automation:delete", taskId),
  runAutomationNow: (taskId: string) => ipcRenderer.invoke("automation:run-now", taskId),
  onAutomationsChanged: (listener: (automations: AutomationView[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AutomationView[]) => listener(payload);
    ipcRenderer.on("automation:changed", handler);
    return () => ipcRenderer.removeListener("automation:changed", handler);
  },
  onAutomationFire: (listener: (fire: AutomationFire) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: AutomationFire) => listener(payload);
    ipcRenderer.on("automation:fire", handler);
    return () => ipcRenderer.removeListener("automation:fire", handler);
  },
  acknowledgeAutomation: (ack: AutomationAck) => ipcRenderer.send("automation:ack", ack),
  onThreadRequest: (listener: (request: ThreadRequest) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ThreadRequest) => listener(payload);
    ipcRenderer.on("thread:request", handler);
    return () => ipcRenderer.removeListener("thread:request", handler);
  },
  answerThreadRequest: (response: ThreadResponse) => ipcRenderer.send("thread:answer", response),
};

contextBridge.exposeInMainWorld("desktop", api);
