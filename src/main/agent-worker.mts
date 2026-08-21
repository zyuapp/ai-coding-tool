import { isAutomationResponse, isInternalRunCommand, isThreadResponse, type AgentEvent, type AutomationRequest } from "../contracts/ipc.js";
import type { ThreadRequest } from "../contracts/threads.js";
import { ClaudeAgentProvider } from "./agent/claude-agent-provider.mjs";
import { AutomationChannel } from "./agent/automation-channel.mjs";
import { ThreadChannel } from "./agent/thread-channel.mjs";
import { RunCoordinator } from "./agent/run-coordinator.mjs";
import { isWritePathInside } from "./path-policy.mjs";

type ParentPort = {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: AgentEvent | AutomationRequest | ThreadRequest): void;
};

const parentPort = (process as typeof process & { parentPort: ParentPort }).parentPort;
const automations = new AutomationChannel((request) => parentPort.postMessage(request));
const threads = new ThreadChannel((request) => parentPort.postMessage(request));
/** Both channels get the same tools; a side chat's automations are retired when its thread closes. */
const coordinatorOptions = {
  isWritePathInside,
  automations: (taskId: string) => automations.bridgeFor(taskId),
  threads: (taskId: string) => threads.bridgeFor(taskId),
  browser: (taskId: string) => threads.browserFor(taskId),
  terminal: (taskId: string) => threads.terminalFor(taskId),
};
const providers = { main: new ClaudeAgentProvider(), side: new ClaudeAgentProvider() };
const coordinators = {
  main: new RunCoordinator(providers.main, (event) => parentPort.postMessage(event), coordinatorOptions),
  side: new RunCoordinator(providers.side, (event) => parentPort.postMessage(event), coordinatorOptions),
};

function closeSessions() {
  for (const provider of Object.values(providers)) provider.closeAll();
}

/** Sessions outlive the runs that used them, so leaving takes them down explicitly. */
process.on("exit", closeSessions);
/**
 * Listening for a termination signal replaces Node's own handler, which would have ended the
 * process, so each one has to end it itself. A worker that stays up holds the quit open until the
 * parent gives up waiting and kills it.
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    closeSessions();
    process.exit(0);
  });
}

parentPort.on("message", ({ data }) => {
  if (isAutomationResponse(data)) {
    automations.settle(data);
    return;
  }
  if (isThreadResponse(data)) {
    threads.settle(data);
    return;
  }
  if (!isInternalRunCommand(data)) return;
  if (data.type === "start") coordinators[data.channel].start(data);
  else if (data.type === "cancel") Object.values(coordinators).some((coordinator) => coordinator.cancel(data.taskId, data.runId));
  else if (data.type === "steer") Object.values(coordinators).some((coordinator) => coordinator.steer(data.taskId, data.runId, data.messageId, data.prompt));
  else if (data.type === "stop-process") Object.values(coordinators).some((coordinator) => coordinator.stopProcess(data.taskId, data.runId, data.processId));
  else Object.values(coordinators).some((coordinator) => coordinator.decideApproval(data.taskId, data.runId, data.approvalId, data.allow));
});
