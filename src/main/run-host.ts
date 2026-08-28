import { utilityProcess, type BrowserWindow, type IpcMainEvent } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isAutomationRequest, isBackgroundEvent, isGoalEvent, isRunCommand, isRunEvent, isSubagentEvent, isThreadRequest, isWorkflowEvent, unreadableRequest, type AgentEvent, type AutomationRequest, type AutomationResponse, type BackgroundEvent, type RunCommand, type RunEvent, type StartRunCommand, type SubagentEvent } from "../contracts/ipc.js";
import type { ThreadRequest, ThreadResponse } from "../contracts/threads.js";
import type { Automation, AutomationRunStatus, TickKind } from "../domain/automation.js";
import type { AutomationScheduler } from "./automation/automation-scheduler.mjs" with { "resolution-mode": "import" };
import type { WorkspaceService } from "./workspace/workspace-service.mjs" with { "resolution-mode": "import" };
import { acceptRunEvent, automationFire, AUTOMATION_SETTLE_TIMEOUT, failedEventsForTransportLoss, settledWithin, supersedePendingStarts } from "./run-routing.js";

/** What the agent process needs from main: the window it reports to, and the services a run resolves against. */
export type RunHost = {
  window: () => BrowserWindow | null;
  running: () => boolean;
  workspaces: () => WorkspaceService;
  scheduler: () => AutomationScheduler;
  trusted: (event: IpcMainEvent) => boolean;
  computerUseForRun: typeof import("./computer-use-host.js").computerUseForRun;
};

export type RunBridge = {
  dispatchAutomation: (automation: Automation, tick: TickKind) => Promise<AutomationRunStatus>;
  handleRunCommand: (event: IpcMainEvent, payload: unknown) => void;
  acknowledgeAutomation: (runId: string, started: boolean) => void;
  answerThread: (response: ThreadResponse) => void;
  killAgent: () => void;
  clearPendingStarts: () => void;
};

type RunState = {
  taskId: string;
  runId: string;
  lastSequence: number;
  terminal: boolean;
};

/** A scheduled run is in flight from the moment the renderer is asked until its run reaches a terminal status. */
type AutomationDispatchState = {
  acknowledge?: (started: boolean) => void;
  settle?: (status: AutomationRunStatus) => void;
};

const AUTOMATION_ACK_TIMEOUT = 30_000;
/** Shorter than the agent's own wait, so a lost answer still comes back as a tool error. */
const THREAD_REQUEST_TIMEOUT = 8_000;
/** A wait answers when the thread it names settles, so the relay outlives the wait itself. */
const THREAD_WAIT_SLACK = 5_000;

let agent: Electron.UtilityProcess | null = null;
const runStates = new Map<string, RunState>();
/** Threads the agent process last reported background work for, so its death can take that work off the panel. */
const backgroundThreads = new Set<string>();
/** Session-scoped Codex children, and the subset whose turns an agent-process death would cut short. */
const sessionSubagents = new Map<string, Set<string>>();
const liveSubagents = new Map<string, Set<string>>();
const pendingStarts = new Map<string, StartRunCommand>();
const automationDispatches = new Map<string, AutomationDispatchState>();
const threadRequests = new Map<string, ReturnType<typeof setTimeout>>();

function runKey(taskId: string, runId: string) {
  return `${taskId}\u0000${runId}`;
}

function sendToRenderer(host: RunHost, event: AgentEvent) {
  const window = host.window();
  if (window && !window.isDestroyed()) window.webContents.send("run:event", event);
}

function recordRun(command: StartRunCommand) {
  const key = runKey(command.taskId, command.runId);
  runStates.set(key, { taskId: command.taskId, runId: command.runId, lastSequence: 0, terminal: false });
  return key;
}

function publishRunEvent(host: RunHost, event: RunEvent) {
  if (!isRunEvent(event)) return;
  const key = runKey(event.taskId, event.runId);
  let state = runStates.get(key);
  if (!state && event.type === "run.started") {
    state = { taskId: event.taskId, runId: event.runId, lastSequence: 0, terminal: false };
    runStates.set(key, state);
  }
  if (!state || event.sequence <= state.lastSequence) return;
  if (!acceptRunEvent(state, event)) return;
  sendToRenderer(host, event);
  if (event.type === "run.status" && (event.status === "succeeded" || event.status === "failed" || event.status === "cancelled")) {
    automationDispatches.get(event.runId)?.settle?.(event.status);
    runStates.delete(key);
  }
}

/** Kept apart from the run gate: what the set says outlives whichever run started the work. */
function publishBackgroundEvent(host: RunHost, event: BackgroundEvent) {
  if (event.processes.length) backgroundThreads.add(event.taskId);
  else backgroundThreads.delete(event.taskId);
  sendToRenderer(host, event);
}

function idsFor(index: Map<string, Set<string>>, taskId: string) {
  let ids = index.get(taskId);
  if (!ids) index.set(taskId, ids = new Set());
  return ids;
}

/** Kept outside the run gate because a Codex child thread may work between parent turns. */
function publishSubagentEvent(host: RunHost, event: SubagentEvent) {
  if (event.type === "subagent.started" && event.sessionScoped) {
    idsFor(sessionSubagents, event.taskId).add(event.id);
    idsFor(liveSubagents, event.taskId).add(event.id);
  } else if (event.type === "subagent.status" && sessionSubagents.get(event.taskId)?.has(event.id)) {
    if (event.status === "working") idsFor(liveSubagents, event.taskId).add(event.id);
    else liveSubagents.get(event.taskId)?.delete(event.id);
  } else if (event.type === "subagent.finished") {
    liveSubagents.get(event.taskId)?.delete(event.id);
  }
  sendToRenderer(host, event);
}

/** Hands the tick to the renderer, which owns the transcript, then waits for that run to settle. */
async function dispatchAutomation(host: RunHost, automation: Automation, tick: TickKind): Promise<AutomationRunStatus> {
  const window = host.window();
  if (!window || window.isDestroyed()) return "skipped";
  const runId = randomUUID();
  const dispatch: AutomationDispatchState = {};
  automationDispatches.set(runId, dispatch);
  try {
    const fire = automationFire(automation, runId, tick);
    // Armed before the tick leaves main so a run that settles immediately still reports back.
    const settled = new Promise<AutomationRunStatus>((resolve) => { dispatch.settle = resolve; });
    const started = await new Promise<boolean>((resolve) => {
      dispatch.acknowledge = resolve;
      setTimeout(() => resolve(false), AUTOMATION_ACK_TIMEOUT).unref?.();
      window.webContents.send("automation:fire", fire);
    });
    return started ? await settledWithin(settled, AUTOMATION_SETTLE_TIMEOUT) : "skipped";
  } finally {
    automationDispatches.delete(runId);
  }
}

async function handleAutomationRequest(host: RunHost, request: AutomationRequest) {
  let response: AutomationResponse;
  try {
    const scheduler = host.scheduler();
    const result = request.op === "read"
      ? scheduler.forTask(request.taskId)
      : request.op === "list"
        ? scheduler.list()
        : request.op === "save"
          ? scheduler.save({ ...request.draft, taskId: request.taskId })
          : request.op === "update"
            ? scheduler.update(request.taskId, request.patch)
            : scheduler.remove(request.taskId);
    response = { type: "automation.response", requestId: request.requestId, ok: true, result };
  } catch (error) {
    response = { type: "automation.response", requestId: request.requestId, ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  agent?.postMessage(response);
}

function answerThreadRequest(response: ThreadResponse) {
  agent?.postMessage(response);
}

/** The window owns workspace state, so thread requests are relayed to it rather than answered here. */
function handleThreadRequest(host: RunHost, request: ThreadRequest) {
  const window = host.window();
  if (!window || window.isDestroyed()) {
    answerThreadRequest({ type: "thread.response", requestId: request.requestId, ok: false, message: "The AI Coding Tool window is not open." });
    return;
  }
  const patience = request.op === "wait"
    ? request.timeoutMs + THREAD_WAIT_SLACK
    : request.op === "browser" && request.read.op !== "tabs"
      ? request.read.timeoutMs + THREAD_WAIT_SLACK
      : THREAD_REQUEST_TIMEOUT;
  const timer = setTimeout(() => {
    threadRequests.delete(request.requestId);
    answerThreadRequest({ type: "thread.response", requestId: request.requestId, ok: false, message: `AI Coding Tool did not answer the thread "${request.op}" request within ${patience}ms.` });
  }, patience);
  timer.unref?.();
  threadRequests.set(request.requestId, timer);
  window.webContents.send("thread:request", request);
}

function emitSyntheticTerminal(host: RunHost, command: StartRunCommand, status: "failed" | "cancelled", message: string) {
  const key = runKey(command.taskId, command.runId);
  const state = runStates.get(key) ?? { taskId: command.taskId, runId: command.runId, lastSequence: 0, terminal: false };
  runStates.set(key, state);
  if (state.lastSequence === 0) publishRunEvent(host, { type: "run.started", taskId: command.taskId, runId: command.runId, sequence: 1 });
  publishRunEvent(host, { type: "run.status", taskId: command.taskId, runId: command.runId, sequence: state.lastSequence + 1, status, message });
}

function startAgent(host: RunHost) {
  if (agent) return;
  agent = utilityProcess.fork(path.join(__dirname, "agent-worker.mjs"), [], {
    serviceName: "AI Coding Tool Agent",
    stdio: "pipe",
  });
  agent.on("message", (event: unknown) => {
    if (isRunEvent(event)) publishRunEvent(host, event);
    /** No run to gate them: workflows, background work, and child agents can all outlive a parent turn. */
    else if (isWorkflowEvent(event)) sendToRenderer(host, event);
    else if (isBackgroundEvent(event)) publishBackgroundEvent(host, event);
    else if (isSubagentEvent(event)) publishSubagentEvent(host, event);
    else if (isGoalEvent(event)) sendToRenderer(host, event);
    else if (isAutomationRequest(event)) void handleAutomationRequest(host, event);
    else if (isThreadRequest(event)) handleThreadRequest(host, event);
    /** A request no guard could read is answered rather than dropped: a dropped one hangs the tool call. */
    else { const refusal = unreadableRequest(event); if (refusal) agent?.postMessage(refusal); }
  });
  agent.on("exit", (code) => {
    agent = null;
    if (host.running()) {
      pendingStarts.clear();
      const message = `Agent process exited${code === null ? "" : ` with code ${code}`}.`;
      for (const event of failedEventsForTransportLoss(runStates.values(), message)) publishRunEvent(host, event);
      /** The processes died with it, and no session is left to say so. */
      for (const taskId of backgroundThreads) sendToRenderer(host, { type: "background.changed", taskId, processes: [] });
      backgroundThreads.clear();
      for (const [taskId, ids] of liveSubagents) {
        for (const id of ids) sendToRenderer(host, { type: "subagent.finished", taskId, id, status: "stopped", summary: "Codex stopped before this subagent finished." });
      }
    }
    sessionSubagents.clear();
    liveSubagents.clear();
  });
  agent.stderr?.on("data", (chunk) => console.error(String(chunk)));
}

async function resolveStart(host: RunHost, command: StartRunCommand) {
  const { installPlainEnglishStyle } = await import("./agent/output-style-install.mjs");
  const [resolution, computerUse] = await Promise.all([
    host.workspaces().resolve(command.workspaceId),
    /** Off in settings never reaches the driver, so no permission is asked for and no host is started. */
    command.computerUseTools === false ? Promise.resolve({ status: "unavailable" as const, message: "Computer use is turned off in Settings." }) : host.computerUseForRun(),
    /** The style has to be on disk before the run names it, or the CLI resolves the name to nothing. */
    installPlainEnglishStyle(command.claude?.outputStyle),
  ]);
  if (resolution.status !== "available") throw new Error(`Workspace is unavailable (${resolution.reason}).`);
  return {
    ...command,
    workspaceRoot: resolution.workspace.root,
    projectless: resolution.workspace.kind === "projectless",
    computerUse,
  };
}

function postCommand(host: RunHost, command: RunCommand) {
  try {
    if (!agent) startAgent(host);
    if (!agent) throw new Error("Agent process is unavailable.");
    agent.postMessage(command);
  } catch (error) {
    /** A stop belongs to no run, so a failure to send it has no run to report against. */
    if (command.type === "stop-process") return;
    const state = runStates.get(runKey(command.taskId, command.runId));
    const message = error instanceof Error ? error.message : String(error);
    if (state && !state.terminal) {
      publishRunEvent(host, { type: "run.status", taskId: command.taskId, runId: command.runId, sequence: state.lastSequence + 1, status: "failed", message });
    }
  }
}

async function dispatchStart(host: RunHost, command: StartRunCommand) {
  const key = recordRun(command);
  pendingStarts.set(key, command);
  try {
    const internal = await resolveStart(host, command);
    if (!pendingStarts.has(key)) return;
    pendingStarts.delete(key);
    startAgent(host);
    agent?.postMessage(internal);
  } catch (error) {
    pendingStarts.delete(key);
    emitSyntheticTerminal(host, command, "failed", error instanceof Error ? error.message : String(error));
  }
}

function handleRunCommand(host: RunHost, event: IpcMainEvent, payload: unknown) {
  if (!host.running() || !host.trusted(event) || !isRunCommand(payload)) return;
  if (payload.type === "start") {
    if (runStates.has(runKey(payload.taskId, payload.runId))) return;
    for (const [oldKey, oldCommand] of supersedePendingStarts(pendingStarts, runKey(payload.taskId, payload.runId), (command) => command.taskId === payload.taskId)) {
      if (runStates.get(oldKey)?.terminal) continue;
      emitSyntheticTerminal(host, oldCommand, "cancelled", "The run was superseded before it started.");
    }
    void dispatchStart(host, payload);
    return;
  }
  /** A stop names the thread's session, which outlives its runs, so no run has to be live to send it. */
  if (payload.type === "stop-process") return postCommand(host, payload);
  const key = runKey(payload.taskId, payload.runId);
  const pending = pendingStarts.get(key);
  if (pending && payload.type === "cancel") {
    pendingStarts.delete(key);
    emitSyntheticTerminal(host, pending, "cancelled", "The run was cancelled before it started.");
    return;
  }
  const state = runStates.get(key);
  if (!state || state.terminal) return;
  postCommand(host, payload);
}

export function startRunHost(host: RunHost): RunBridge {
  return {
    dispatchAutomation: (automation, tick) => dispatchAutomation(host, automation, tick),
    handleRunCommand: (event, payload) => handleRunCommand(host, event, payload),
    acknowledgeAutomation: (runId, started) => automationDispatches.get(runId)?.acknowledge?.(started),
    answerThread: (response) => {
      const timer = threadRequests.get(response.requestId);
      if (!timer) return;
      clearTimeout(timer);
      threadRequests.delete(response.requestId);
      answerThreadRequest(response);
    },
    killAgent: () => agent?.kill(),
    clearPendingStarts: () => pendingStarts.clear(),
  };
}
