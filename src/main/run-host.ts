import type { BrowserWindow, IpcMainEvent } from "electron";
import { randomUUID } from "node:crypto";
import { isAgentSettingsReloadEvent, isAutomationRequest, isBackgroundEvent, isGoalEvent, isRunCommand, isRunEvent, isSubagentEvent, isThreadRequest, isWorkflowEvent, unreadableRequest, type AgentEvent, type AutomationRequest, type AutomationResponse, type BackgroundEvent, type RunCommand, type RunEvent, type StartRunCommand, type SubagentEvent } from "../contracts/ipc.js";
import type { ThreadRequest, ThreadResponse } from "../contracts/threads.js";
import type { Automation, AutomationRunStatus, TickKind } from "../domain/automation.js";
import type { AutomationScheduler } from "./automation/automation-scheduler.mjs" with { "resolution-mode": "import" };
import type { WorkspaceService } from "./workspace/workspace-service.mjs" with { "resolution-mode": "import" };
import type { AgentProcess, StartAgentProcess } from "./agent-process.js";
import { isTerminalStatus, RunLedger } from "./run-ledger.js";
import { automationFire, AUTOMATION_SETTLE_TIMEOUT, settledWithin } from "./run-routing.js";

/** What the agent process needs from main: the window it reports to, and the services a run resolves against. */
export type RunHost = {
  window: () => Pick<BrowserWindow, "webContents" | "isDestroyed"> | null;
  running: () => boolean;
  workspaces: () => WorkspaceService;
  scheduler: () => AutomationScheduler;
  trusted: (event: IpcMainEvent) => boolean;
  computerUseForRun: typeof import("./computer-use-host.js").computerUseForRun;
  /** How the process itself is started, so what main does with it can be driven without one. */
  agent: StartAgentProcess;
};

export type RunBridge = {
  dispatchAutomation: (automation: Automation, tick: TickKind) => Promise<AutomationRunStatus>;
  handleRunCommand: (event: IpcMainEvent, payload: unknown) => void;
  acknowledgeAutomation: (runId: string, started: boolean) => void;
  answerThread: (response: ThreadResponse) => void;
  killAgent: () => void;
  clearPendingStarts: () => void;
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

/** Answers a message from the agent process, or declines it so the next reader is offered it. */
type AgentMessageRoute = (message: unknown) => boolean;

function reads<T>(guard: (value: unknown) => value is T, handle: (message: T) => void): AgentMessageRoute {
  return (message) => {
    if (!guard(message)) return false;
    handle(message);
    return true;
  };
}

function idsFor(index: Map<string, Set<string>>, taskId: string) {
  let ids = index.get(taskId);
  if (!ids) index.set(taskId, ids = new Set());
  return ids;
}

/** Main's side of one agent process: the runs on its books, and everything they exchange. */
class AgentRunHost {
  private agent: AgentProcess | null = null;
  private readonly ledger = new RunLedger();
  /** Threads the agent process last reported background work for, so its death can take that work off the panel. */
  private readonly backgroundThreads = new Set<string>();
  /** Session-scoped Codex children, and the subset whose turns an agent-process death would cut short. */
  private readonly sessionSubagents = new Map<string, Set<string>>();
  private readonly liveSubagents = new Map<string, Set<string>>();
  private readonly automationDispatches = new Map<string, AutomationDispatchState>();
  private readonly threadRequests = new Map<string, ReturnType<typeof setTimeout>>();
  private settingsReloadPending = false;

  private readonly routes: AgentMessageRoute[] = [
    reads(isAgentSettingsReloadEvent, (event) => {
      this.settingsReloadPending = event.status === "pending";
      this.send(event);
    }),
    reads(isRunEvent, (event) => this.publishRun(event)),
    /** No run to gate them: workflows, background work, and child agents can all outlive a parent turn. */
    reads(isWorkflowEvent, (event) => this.send(event)),
    reads(isBackgroundEvent, (event) => this.publishBackground(event)),
    reads(isSubagentEvent, (event) => this.publishSubagent(event)),
    reads(isGoalEvent, (event) => this.send(event)),
    reads(isAutomationRequest, (request) => void this.answerAutomation(request)),
    reads(isThreadRequest, (request) => this.relayThread(request)),
  ];

  constructor(private readonly host: RunHost) {}

  private send(event: AgentEvent) {
    const window = this.host.window();
    if (window && !window.isDestroyed()) window.webContents.send("run:event", event);
  }

  private publishRun(event: RunEvent) {
    if (!isRunEvent(event) || !this.ledger.accept(event)) return;
    this.send(event);
    if (event.type === "run.status" && isTerminalStatus(event.status)) this.automationDispatches.get(event.runId)?.settle?.(event.status);
  }

  /** Kept apart from the run gate: what the set says outlives whichever run started the work. */
  private publishBackground(event: BackgroundEvent) {
    if (event.processes.length) this.backgroundThreads.add(event.taskId);
    else this.backgroundThreads.delete(event.taskId);
    this.send(event);
  }

  /** Kept outside the run gate because a Codex child thread may work between parent turns. */
  private publishSubagent(event: SubagentEvent) {
    if (event.type === "subagent.started" && event.sessionScoped) {
      idsFor(this.sessionSubagents, event.taskId).add(event.id);
      idsFor(this.liveSubagents, event.taskId).add(event.id);
    } else if (event.type === "subagent.status" && this.sessionSubagents.get(event.taskId)?.has(event.id)) {
      if (event.status === "working") idsFor(this.liveSubagents, event.taskId).add(event.id);
      else this.liveSubagents.get(event.taskId)?.delete(event.id);
    } else if (event.type === "subagent.finished") {
      this.liveSubagents.get(event.taskId)?.delete(event.id);
    }
    this.send(event);
  }

  /** Hands the tick to the renderer, which owns the transcript, then waits for that run to settle. */
  async dispatchAutomation(automation: Automation, tick: TickKind): Promise<AutomationRunStatus> {
    const window = this.host.window();
    if (!window || window.isDestroyed()) return "skipped";
    const runId = randomUUID();
    const dispatch: AutomationDispatchState = {};
    this.automationDispatches.set(runId, dispatch);
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
      this.automationDispatches.delete(runId);
    }
  }

  acknowledgeAutomation(runId: string, started: boolean) {
    this.automationDispatches.get(runId)?.acknowledge?.(started);
  }

  private async answerAutomation(request: AutomationRequest) {
    let response: AutomationResponse;
    try {
      const scheduler = this.host.scheduler();
      const authority = () => {
        const session = this.ledger.session(request.taskId);
        const state = "runId" in request ? this.ledger.state(request.taskId, request.runId) : undefined;
        if (!state || state.terminal || !session || !("runId" in request) || session.runId !== request.runId) {
          throw new Error("This run is no longer authorized to change the task's automation.");
        }
        return session.policy;
      };
      const result = await (request.op === "read"
        ? scheduler.forThread(request.taskId)
        : request.op === "list"
          ? scheduler.list()
          : request.op === "save"
            ? scheduler.save({ ...request.draft, taskId: request.taskId }, authority)
            : request.op === "update"
              ? scheduler.update(request.taskId, request.patch, authority)
              : scheduler.remove(request.taskId));
      response = { type: "automation.response", requestId: request.requestId, ok: true, result };
    } catch (error) {
      response = { type: "automation.response", requestId: request.requestId, ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    this.agent?.post(response);
  }

  /** The window owns workspace state, so thread requests are relayed to it rather than answered here. */
  private relayThread(request: ThreadRequest) {
    const window = this.host.window();
    if (!window || window.isDestroyed()) {
      this.agent?.post({ type: "thread.response", requestId: request.requestId, ok: false, message: "The AI Coding Tool window is not open." });
      return;
    }
    const patience = request.op === "wait"
      ? request.timeoutMs + THREAD_WAIT_SLACK
      : request.op === "browser" && (request.read.op === "snapshot" || request.read.op === "screenshot" || request.read.op === "wait")
        ? request.read.timeoutMs + THREAD_WAIT_SLACK
        : THREAD_REQUEST_TIMEOUT;
    const timer = setTimeout(() => {
      this.threadRequests.delete(request.requestId);
      this.agent?.post({ type: "thread.response", requestId: request.requestId, ok: false, message: `AI Coding Tool did not answer the thread "${request.op}" request within ${patience}ms.` });
    }, patience);
    timer.unref?.();
    this.threadRequests.set(request.requestId, timer);
    window.webContents.send("thread:request", request);
  }

  answerThread(response: ThreadResponse) {
    const timer = this.threadRequests.get(response.requestId);
    if (!timer) return;
    clearTimeout(timer);
    this.threadRequests.delete(response.requestId);
    this.agent?.post(response);
  }

  private emitSyntheticTerminal(command: StartRunCommand, status: "failed" | "cancelled", message: string) {
    const state = this.ledger.reopen(command.taskId, command.runId);
    if (state.lastSequence === 0) this.publishRun({ type: "run.started", taskId: command.taskId, runId: command.runId, sequence: 1 });
    this.publishRun({ type: "run.status", taskId: command.taskId, runId: command.runId, sequence: state.lastSequence + 1, status, message });
  }

  private connect() {
    if (this.agent) return;
    this.agent = this.host.agent({
      message: (message) => this.receive(message),
      exit: (code) => this.disconnect(code),
    });
  }

  private receive(message: unknown) {
    if (this.routes.some((route) => route(message))) return;
    /** A request no guard could read is answered rather than dropped: a dropped one hangs the tool call. */
    const refusal = unreadableRequest(message);
    if (refusal) this.agent?.post(refusal);
  }

  private disconnect(code: number | null) {
    this.agent = null;
    this.ledger.forgetSessions();
    if (this.settingsReloadPending) {
      this.settingsReloadPending = false;
      this.send({ type: "engine.settings-reload-status", status: "failed", message: "Agent process exited while reloading settings. Try again." });
    }
    if (this.host.running()) {
      this.ledger.clearStarts();
      const message = `Agent process exited${code === null ? "" : ` with code ${code}`}.`;
      for (const event of this.ledger.failuresFor(message)) this.publishRun(event);
      /** The processes died with it, and no session is left to say so. */
      for (const taskId of this.backgroundThreads) this.send({ type: "background.changed", taskId, processes: [] });
      this.backgroundThreads.clear();
      for (const [taskId, ids] of this.liveSubagents) {
        for (const id of ids) this.send({ type: "subagent.finished", taskId, id, status: "stopped", summary: "The agent process stopped before this subagent finished." });
      }
    }
    this.sessionSubagents.clear();
    this.liveSubagents.clear();
  }

  killAgent() {
    this.agent?.kill();
  }

  clearPendingStarts() {
    this.ledger.clearStarts();
  }

  private async resolveStart(command: StartRunCommand) {
    const [resolution, computerUse] = await Promise.all([
      this.host.workspaces().resolve(command.workspaceId),
      /** Off in settings never reaches the driver, so no permission is asked for and no host is started. */
      command.computerUseTools === false ? Promise.resolve({ status: "unavailable" as const, message: "Computer use is turned off in Settings." }) : this.host.computerUseForRun(),
    ]);
    if (resolution.status !== "available") throw new Error(`Workspace is unavailable (${resolution.reason}).`);
    return {
      ...command,
      workspaceRoot: resolution.workspace.root,
      projectless: resolution.workspace.kind === "projectless",
      computerUse,
    };
  }

  private postCommand(command: Exclude<RunCommand, StartRunCommand>) {
    try {
      if (command.type === "reload-settings") this.settingsReloadPending = true;
      this.connect();
      if (!this.agent) throw new Error("Agent process is unavailable.");
      this.agent.post(command);
    } catch (error) {
      if (command.type === "reload-settings") {
        this.settingsReloadPending = false;
        this.send({ type: "engine.settings-reload-status", status: "failed", message: error instanceof Error ? error.message : String(error) });
        return;
      }
      /** A stop or a label belongs to no run, so a failure to send it has no run to report against. */
      if (command.type === "stop-process" || command.type === "label") return;
      const state = this.ledger.state(command.taskId, command.runId);
      const message = error instanceof Error ? error.message : String(error);
      if (state && !state.terminal) {
        this.publishRun({ type: "run.status", taskId: command.taskId, runId: command.runId, sequence: state.lastSequence + 1, status: "failed", message });
      }
    }
  }

  private async dispatchStart(command: StartRunCommand) {
    this.ledger.beginStart(command);
    try {
      const internal = await this.resolveStart(command);
      if (!this.ledger.takeStart(command.taskId, command.runId)) return;
      this.connect();
      this.agent?.post(internal);
    } catch (error) {
      this.ledger.takeStart(command.taskId, command.runId);
      this.emitSyntheticTerminal(command, "failed", error instanceof Error ? error.message : String(error));
    }
  }

  handleRunCommand(event: IpcMainEvent, payload: unknown) {
    if (!this.host.running() || !this.host.trusted(event) || !isRunCommand(payload)) return;
    if (payload.type === "reload-settings") {
      if (!this.agent) return this.send({ type: "engine.settings-reload-status", status: "reloaded" });
      return this.postCommand(payload);
    }
    if (payload.type === "start") {
      if (this.ledger.knows(payload.taskId, payload.runId)) return;
      for (const superseded of this.ledger.supersedeStarts(payload.taskId, payload.runId)) {
        this.emitSyntheticTerminal(superseded, "cancelled", "The run was superseded before it started.");
      }
      void this.dispatchStart(payload);
      return;
    }
    /** A stop or a label names the thread's session, which outlives its runs, so no run has to be live. */
    if (payload.type === "label") {
      this.ledger.retitleStarts(payload.taskId, payload.title);
      return this.postCommand(payload);
    }
    if (payload.type === "stop-process") return this.postCommand(payload);
    const pending = this.ledger.pendingStart(payload.taskId, payload.runId);
    if (pending && payload.type === "cancel") {
      this.ledger.takeStart(payload.taskId, payload.runId);
      this.emitSyntheticTerminal(pending, "cancelled", "The run was cancelled before it started.");
      return;
    }
    const state = this.ledger.state(payload.taskId, payload.runId);
    if (!state || state.terminal) return;
    this.postCommand(payload);
  }
}

export function startRunHost(host: RunHost): RunBridge {
  const runs = new AgentRunHost(host);
  return {
    dispatchAutomation: (automation, tick) => runs.dispatchAutomation(automation, tick),
    handleRunCommand: (event, payload) => runs.handleRunCommand(event, payload),
    acknowledgeAutomation: (runId, started) => runs.acknowledgeAutomation(runId, started),
    answerThread: (response) => runs.answerThread(response),
    killAgent: () => runs.killAgent(),
    clearPendingStarts: () => runs.clearPendingStarts(),
  };
}
