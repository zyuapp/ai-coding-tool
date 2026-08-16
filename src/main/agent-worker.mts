import { isInternalRunCommand, type RunEvent } from "../contracts/ipc.js";
import { ClaudeAgentProvider } from "./agent/claude-agent-provider.mjs";
import { RunCoordinator } from "./agent/run-coordinator.mjs";
import { isWritePathInside } from "./path-policy.mjs";

type ParentPort = {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: RunEvent): void;
};

const parentPort = (process as typeof process & { parentPort: ParentPort }).parentPort;
const coordinator = new RunCoordinator(new ClaudeAgentProvider(), (event) => parentPort.postMessage(event), { isWritePathInside });

parentPort.on("message", ({ data }) => {
  if (!isInternalRunCommand(data)) return;
  if (data.type === "start") coordinator.start(data);
  else if (data.type === "cancel") coordinator.cancel(data.taskId, data.runId);
  else coordinator.decideApproval(data.taskId, data.runId, data.approvalId, data.allow);
});
