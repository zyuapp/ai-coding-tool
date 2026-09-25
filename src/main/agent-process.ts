import { app, utilityProcess } from "electron";
import path from "node:path";
import type { AutomationResponse, InternalRunCommand } from "../contracts/ipc.js";
import type { ThreadResponse } from "../contracts/threads.js";
import { appPluginPath } from "./app-plugin-path.js";

/** Everything main says to the agent process: the commands a run is made of, and answers to what it asked. */
export type AgentMessage = InternalRunCommand | AutomationResponse | ThreadResponse;

/** Main's end of one agent process. */
export type AgentProcess = {
  post: (message: AgentMessage) => void;
  kill: () => void;
};

/** What main hears back. Exit is reported once, whatever ended the process. */
export type AgentProcessListener = {
  message: (message: unknown) => void;
  exit: (code: number | null) => void;
};

/** Starts one agent process. The run host holds at most one at a time. */
export type StartAgentProcess = (listener: AgentProcessListener) => AgentProcess;

export const forkAgentProcess: StartAgentProcess = (listener) => {
  /** The worker hosts every engine session, so it is told where the app's plugin is along with where images go. */
  const agent = utilityProcess.fork(path.join(__dirname, "agent-worker.mjs"), [path.join(app.getPath("userData"), "generated-images"), appPluginPath(app.isPackaged, process.resourcesPath, app.getAppPath())], {
    serviceName: "AI Coding Tool Agent",
    stdio: "pipe",
  });
  agent.on("message", (message: unknown) => listener.message(message));
  agent.on("exit", (code) => listener.exit(code));
  agent.stderr?.on("data", (chunk) => console.error(String(chunk)));
  return {
    post: (message) => agent.postMessage(message),
    kill: () => { agent.kill(); },
  };
};
