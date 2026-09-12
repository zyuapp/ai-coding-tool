import { isAutomationResponse, isInternalRunCommand, isThreadResponse, type AgentEvent, type AutomationRequest, type InternalRunCommand } from "../contracts/ipc.js";
import type { ThreadRequest } from "../contracts/threads.js";
import { ClaudeAgentProvider } from "./agent/claude-agent-provider.mjs";
import { AutomationChannel } from "./agent/automation-channel.mjs";
import { EngineRouter } from "./agent/engine-router.mjs";
import { CodexAgentProvider } from "./codex/codex-agent-provider.mjs";
import { codexImageOutput } from "./codex/codex-images.mjs";
import { SessionPool } from "./agent/session-pool.mjs";
import { ThreadChannel } from "./agent/thread-channel.mjs";
import { RunCoordinator } from "./agent/run-coordinator.mjs";
import { isWritePathInside } from "./path-policy.mjs";
import { McpHttpHost } from "./tools/mcp-http-host.mjs";
import { setAppPluginRoot } from "./app-plugin.mjs";

type ParentPort = {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: AgentEvent | AutomationRequest | ThreadRequest): void;
};

/** The utility process speaks through its parent port; a plain child process through its IPC channel. */
const parentPort: ParentPort = (process as typeof process & { parentPort?: ParentPort }).parentPort ?? {
  on: (_event, listener) => { process.on("message", (data) => listener({ data })); },
  postMessage: (message) => { process.send?.(message); },
};
const automations = new AutomationChannel((request) => parentPort.postMessage(request));
const threads = new ThreadChannel((request) => parentPort.postMessage(request));
/** Both channels get the same tools; a side chat's automations are retired when its thread closes. */
const coordinatorOptions = {
  isWritePathInside,
  automations: (taskId: string, currentRunId: () => string) => automations.bridgeFor(taskId, currentRunId),
  findings: (taskId: string) => threads.findingsFor(taskId),
  threads: (taskId: string) => threads.bridgeFor(taskId),
  browser: (taskId: string) => threads.browserFor(taskId),
  terminal: (taskId: string) => threads.terminalFor(taskId),
};
setAppPluginRoot(process.argv[3] || undefined);
/** One tool service for the whole worker; every Codex session gets a token of its own on it. */
const toolHost = new McpHttpHost();
/** A channel's engines share one pool, so the warm sessions of a channel are capped together. */
const pools: SessionPool[] = [];
const engines = () => {
  const pool = new SessionPool();
  pools.push(pool);
  return new EngineRouter({ claude: new ClaudeAgentProvider(undefined, pool), codex: new CodexAgentProvider({
    host: toolHost, pool,
    imageOutput: (item, root) => codexImageOutput(item, root, process.argv[2]),
  }) });
};
const providers = { main: engines(), side: engines() };
const coordinators = {
  main: new RunCoordinator(providers.main, (event) => parentPort.postMessage(event), coordinatorOptions),
  side: new RunCoordinator(providers.side, (event) => parentPort.postMessage(event), coordinatorOptions),
};

async function reloadSettings() {
  try {
    const reloaded = pools.map((pool) => pool.reloadSettings());
    parentPort.postMessage({ type: "engine.settings-reload-status", status: "pending" });
    await Promise.all(reloaded);
    parentPort.postMessage({ type: "engine.settings-reload-status", status: "reloaded" });
  } catch (error) {
    parentPort.postMessage({ type: "engine.settings-reload-status", status: "failed", message: error instanceof Error ? error.message : String(error) });
  }
}

function closeSessions() {
  for (const provider of Object.values(providers)) provider.closeAll();
  void toolHost.close();
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

/** A command names a thread rather than a channel, so it is offered to each until one owns the run. */
function whichever(act: (coordinator: RunCoordinator) => boolean) {
  Object.values(coordinators).some(act);
}

type RunCommandHandlers = { [Type in InternalRunCommand["type"]]: (command: Extract<InternalRunCommand, { type: Type }>) => void };

const runCommands: RunCommandHandlers = {
  "reload-settings": () => void reloadSettings(),
  start: (command) => coordinators[command.channel].start(command),
  cancel: (command) => whichever((coordinator) => coordinator.cancel(command.taskId, command.runId)),
  "answer-question": (command) => whichever((coordinator) => coordinator.answerQuestion(command.taskId, command.runId, command.requestId, command.questionId, command.text)),
  steer: (command) => whichever((coordinator) => coordinator.steer(command.taskId, command.runId, command.messageId, command.prompt)),
  "stop-process": (command) => whichever((coordinator) => coordinator.stopProcess(command.taskId, command.processId)),
  label: (command) => whichever((coordinator) => coordinator.labelThread(command.taskId, command.title)),
  approval: (command) => whichever((coordinator) => coordinator.decideApproval(command.taskId, command.runId, command.approvalId, command.allow)),
};

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
  (runCommands[data.type] as (command: InternalRunCommand) => void)(data);
});
