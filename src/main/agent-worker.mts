import { isAutomationResponse, isInternalRunCommand, type AutomationRequest, type RunEvent } from "../contracts/ipc.js";
import { ClaudeAgentProvider } from "./agent/claude-agent-provider.mjs";
import { AutomationChannel } from "./agent/automation-channel.mjs";
import { RunCoordinator } from "./agent/run-coordinator.mjs";
import { isWritePathInside } from "./path-policy.mjs";

type ParentPort = {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: RunEvent | AutomationRequest): void;
};

const parentPort = (process as typeof process & { parentPort: ParentPort }).parentPort;
const automations = new AutomationChannel((request) => parentPort.postMessage(request));
/** Scheduled runs arrive on the main channel, so only it can reach the automation tools. */
const coordinators = {
  main: new RunCoordinator(new ClaudeAgentProvider(), (event) => parentPort.postMessage(event), {
    isWritePathInside,
    automations: (taskId) => automations.bridgeFor(taskId),
  }),
  side: new RunCoordinator(new ClaudeAgentProvider(), (event) => parentPort.postMessage(event), { isWritePathInside }),
};

parentPort.on("message", ({ data }) => {
  if (isAutomationResponse(data)) {
    automations.settle(data);
    return;
  }
  if (!isInternalRunCommand(data)) return;
  if (data.type === "start") coordinators[data.channel].start(data);
  else if (data.type === "cancel") Object.values(coordinators).some((coordinator) => coordinator.cancel(data.taskId, data.runId));
  else Object.values(coordinators).some((coordinator) => coordinator.decideApproval(data.taskId, data.runId, data.approvalId, data.allow));
});
