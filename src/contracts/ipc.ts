export type { BranchesResult } from "./git.js";
import type { AgentSettingsReloadEvent, ReloadAgentSettingsCommand } from "./agent-settings.js";
export { isAgentSettingsReloadEvent, type AgentSettingsReloadEvent } from "./agent-settings.js";
import { isQuestionRequest, type QuestionRequest } from "../domain/agent-question.js";
import { isAutomationDraft, isAutomationPatch, type AutomationDraft, type AutomationPatch } from "../domain/automation.js";
import type { BrowserRead, SimulatorRead, TerminalRead, ThreadResponse } from "./threads.js";
import type { BrowserAction, BrowserBounds } from "../domain/browser.js";
import type { DictationModel } from "../domain/dictation.js";
import { isUsageLimit, type UsageLimit } from "../domain/usage-limit.js";
import type { ComputerUseRunConfig } from "../domain/computer-use.js";
import type { DiffFileSummary, DiffRange } from "../domain/diff.js";
import type { ExternalApp } from "../domain/external-apps.js";
import type { FindResults } from "../domain/find.js";
import type { ActiveGoal } from "../domain/goal.js";
import { capabilitiesFor, isAgentEffort, isAgentEngine, isModelId, type AgentEngine, type AgentModel } from "../domain/agent-engine.js";
import type { CoordinationRole } from "../domain/coordination.js";
import { isExecutionPolicy, type AgentEffort, type BackgroundProcess, type BackgroundProcessKind, type Continuation, type ExecutionPolicy, type RetryNotice, type RunStatus, type SubagentReport, type ToolIntent } from "../domain/run.js";
import type { ShortcutSurface } from "../domain/shortcuts.js";
import type { WorkflowAgent, WorkflowAgentState, WorkflowPhase, WorkflowStatus } from "../domain/workflow.js";
import type { Worktree, WorktreeRelease } from "../domain/worktree.js";
import { isReviewTarget, type ReviewTarget } from "../domain/review.js";
import type { MobileDesktopAPI } from "./mobile.js";
import type { JoinedPorts, PortMembers } from "./desktop-port.js";
import type { AutomationPort } from "./automation-port.js";
import type { BrowserPort } from "./browser-port.js";
import type { CliPort } from "./cli-port.js";
import type { ComputerUsePort } from "./computer-use-port.js";
import type { DictationPort } from "./dictation-port.js";
import type { EnginePort } from "./engine-port.js";
import type { FilePort } from "./file-port.js";
import type { GitPort } from "./git-port.js";
import type { ProjectPort } from "./project-port.js";
import type { RunPort } from "./run-port.js";
import type { ShortcutPort } from "./shortcut-port.js";
import type { SimulatorPort } from "./simulator-port.js";
import type { StorePort } from "./store-port.js";
import type { TerminalPort } from "./terminal-port.js";
import type { UpdatePort } from "./update-port.js";
import type { WindowPort } from "./window-port.js";
export type { TerminalDataEvent, TerminalReadOptions, TerminalScreenSnapshot, TerminalText } from "./terminal.js";
export type { LoadedTaskStore, PersistedSubagent, PersistedTask, TaskStoreDelta } from "./task-store.js";
export type { ComputerUsePermission, ComputerUsePermissions, ComputerUseRunConfig } from "../domain/computer-use.js";

/** What the window needs of a theme: the ground its frame is drawn on, and the colour it paints bare. */
export type WindowTheme = {
  variant: "dark" | "light";
  canvas: string;
  /** Whether the renderer took this ground from the system, in which case native chrome asks it too. */
  follow?: boolean;
};

/** An application the machine has, as the window draws it. */
export type InstalledApp = ExternalApp & {
  /** The application's own icon as a data URL, or null when nothing here can read one. */
  icon: string | null;
};

export type WorkspaceId = string;
export type RunChannel = "main" | "side";

/** Work a run performs without sending its prompt as a model turn. */
export type RunOperation =
  | { type: "compact"; preTokens: number }
  | { type: "review"; target: ReviewTarget };

export type StartRunCommand = {
  type: "start";
  channel: RunChannel;
  taskId: string;
  title: string;
  runId: string;
  prompt: string;
  workspaceId: WorkspaceId;
  policy: ExecutionPolicy;
  engine: AgentEngine;
  model: AgentModel;
  effort: AgentEffort;
  /** Read only by an engine whose capabilities include fast mode. Absent means standard speed. */
  fastMode?: boolean;
  operation?: RunOperation;
  /** Set when the user turned Chrome on and the engine can drive it: the run also reaches their own Chrome. */
  chromeBrowser?: true;
  /** Set when the user turned computer use off: the run gets no computer-use tools. */
  computerUseTools?: false;
  /** Set when the user turned browser use off: the run gets no browser-panel tools. */
  browserTools?: false;
  /** Set when this Mac cannot run the simulator: the run gets no simulator tools. */
  simulatorTools?: false;
  continuation?: Continuation;
  forkContinuation?: boolean;
  /** Set when the run resumes no session on purpose, so not even the thread's warm one is reused. */
  memoryProtection?: boolean;
  freshSession?: true;
  /** Set only by a scheduled tick: nobody is present, so an approval nobody answers is denied for them. */
  unattended?: true;
  /** Gives the run the tools and instructions for its part beside a coordinator. */
  coordinationRole?: CoordinationRole;
  /** Set for a member working in a checkout of its own: the project's checkout, which is the user's to change. */
  projectWorkspaceId?: WorkspaceId;
};

export type CreateWorktreeRequest = {
  projectRoot: string;
  carryChanges: boolean;
  /** Which branch the worktree detaches from. The project's own HEAD when absent. */
  branch?: string;
};

/**
 * The checkout the desktop just made. Which project's list it belongs to is workspace state, so the
 * reducer says that; the desktop only reports what it did on disk.
 */
export type CreatedWorktree = Omit<Worktree, "projectId">;

export type ReleaseWorktreeRequest = {
  worktreeId: string;
  root: string;
  taskId: string | null;
  title: string;
  release: WorktreeRelease;
  /** Only forget a missing folder; an existing folder must remain untouched. */
  missingOnly?: boolean;
};

export type WorktreeSnapshotResult = {
  commit: string | null;
  shortCommit: string | null;
  ref: string | null;
};

export type InternalStartRunCommand = StartRunCommand & {
  workspaceRoot: string;
  projectless: boolean;
  computerUse: ComputerUseRunConfig;
  /** Where `projectWorkspaceId` is, while it is there. */
  projectRoot?: string;
};

export type CancelRunCommand = {
  type: "cancel";
  taskId: string;
  runId: string;
};

export type AnswerQuestionCommand = {
  type: "answer-question";
  taskId: string; runId: string; requestId: string; questionId: string; text: string;
};

export type ApprovalDecisionCommand = {
  type: "approval";
  taskId: string;
  runId: string;
  approvalId: string;
  allow: boolean;
};

/** Joins a run that is already going, rather than waiting for it to finish. */
export type SteerRunCommand = {
  type: "steer";
  taskId: string;
  runId: string;
  messageId: string;
  prompt: string;
};

/**
 * Kills one background process of the thread's session, leaving the session itself going. It names
 * the thread rather than a run: a workflow outlives the run that started it and is stopped after it.
 */
export type StopProcessCommand = {
  type: "stop-process";
  taskId: string;
  processId: string;
};

export type LabelThreadCommand = { type: "label"; taskId: string; title: string };

/**
 * Mirrors archiving and restoring a thread into the engine's own record of it, on the channel its
 * runs take. Without a continuation, only a session the thread still holds names what to file.
 */
export type ArchiveThreadCommand = { type: "archive"; taskId: string; channel: RunChannel; continuation?: Continuation; archived: boolean };

/**
 * What a thread runs as now, said whenever that changes. A session built for what the thread was
 * holds that role's tools, so it goes, background work and all; the thread's next run starts one that fits.
 */
export type ThreadRoleCommand = { type: "role"; taskId: string; coordinationRole?: CoordinationRole };

export type RunCommand = { type: "memory-protection"; enabled: boolean } | ReloadAgentSettingsCommand | StartRunCommand | CancelRunCommand | AnswerQuestionCommand | ApprovalDecisionCommand | SteerRunCommand | StopProcessCommand | LabelThreadCommand | ArchiveThreadCommand | ThreadRoleCommand;

/** The same commands as the agent process reads them: a start arrives already resolved against its workspace. */
export type InternalRunCommand = Exclude<RunCommand, StartRunCommand> | InternalStartRunCommand;

/** The scheduler owns the run ID so it can correlate the renderer's run back to the tick that asked for it. */
export type AutomationFire = {
  automationId: string;
  taskId: string;
  runId: string;
  prompt: string;
  policy?: ExecutionPolicy;
  runNumber: number;
  /** The tick may settle without surfacing, if the run says it looked and found nothing. */
  quiet?: true;
  /** Nobody is watching a cron tick, so its run may answer its own approvals. A pressed button is not one. */
  unattended?: true;
  /** What the automation says is worth surfacing, carried into the run's own framing. */
  surfaceWhen?: string;
  /** What finishes the automation, so the run knows when to stop it. */
  endsWhen?: string;
};

export type AutomationAck = {
  automationId: string;
  runId: string;
  started: boolean;
};

/** Automation tool calls travel from the agent process to the scheduler in main and back. */
export type AutomationRequest = {
  type: "automation.request";
  requestId: string;
  taskId: string;
} & (
  | { op: "read" }
  | { op: "list" }
  | { op: "save"; runId: string; draft: Omit<AutomationDraft, "taskId"> }
  | { op: "update"; runId: string; patch: AutomationPatch }
  | { op: "delete" }
);

export type AutomationResponse = {
  type: "automation.response";
  requestId: string;
} & ({ ok: true; result: unknown } | { ok: false; message: string });

export type DesktopPlatform = "macos" | "linux" | "other";

/** What the platform draws under the window's page: Liquid Glass, the older vibrancy blur, or nothing. */
export type WindowMaterial = "glass" | "vibrancy" | "none";

/** Every capability's part of the desktop API. */
export type DesktopPorts = [
  WindowPort, ShortcutPort, ProjectPort, CliPort, ComputerUsePort, EnginePort, RunPort, GitPort, FilePort, StorePort,
  UpdatePort, AutomationPort, BrowserPort, SimulatorPort, DictationPort, TerminalPort, { runtime: MobileDesktopAPI },
];

export type DesktopAPI = PortMembers<DesktopPorts>;

/** The calls a window's own views make on the desktop, each relayed to main by name. */
export type WindowDesktopCall = keyof JoinedPorts<DesktopPorts, "windowCalls">;

/** What a window reaches directly: its calls, what main pushes at it, and what it answers itself. The rest is the runtime's. */
export type WindowDesktopAPI = JoinedPorts<DesktopPorts, "windowCalls"> & JoinedPorts<DesktopPorts, "windowOwn">;

/** Where the speech model stands, and why when it cannot be used. */
/** `progress` is how much of the download has arrived, 0 to 1; a download without one is being prepared. */
export type DictationModelStatus = { model: DictationModel; message?: string; progress?: number };

/** What a keystroke asked for, and where it was pressed. */
export type ShortcutInvocation = { action: string; surface: ShortcutSurface };

/** A window the desktop hotkey grabbed, already written to the attachments directory. */
export type WindowScreenshot = { app: string; title: string; path: string };

export type DesktopShortcutRefusal = { binding: string; reason: "taken" } | { binding: string; reason: "unsupported"; message: string };

/** A desktop-wide binding whose action this session cannot safely perform on the active platform. */
export type DesktopShortcutUnavailable = Extract<DesktopShortcutRefusal, { reason: "unsupported" }>;

/** What a thread wants in front of the user: the thread a click lands on, the name it is shown under, and the line itself. */
export type ThreadNotice = { taskId: string; title: string; headline: string };

/** What a page did, pushed from main so the reducer stays the only writer of the tab record. */
export type BrowserPageEvent = {
  navigationRequest?: { taskId: string; url: string };
  tabId: string;
  url?: string;
  title?: string;
  loading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  error?: string;
};

/** What a page found: how many matches it has, and which one it is showing, counting from zero. */
export type BrowserFindEvent = { tabId: string } & FindResults;

export type AvailableCommand = {
  name: string;
  description: string;
  argumentHint: string;
  aliases?: string[];
};

export type CommandDiscoveryResult =
  | { status: "available"; commands: AvailableCommand[] }
  | { status: "error"; message: string };

/** A comparison's file list. Patches are fetched one at a time and never travel with the list. */
export type DiffSummaryResult =
  /** `ignoreWhitespace` is how the counts were taken, which is what tells a recount from a rewrite. */
  | { status: "available"; range: DiffRange; ignoreWhitespace: boolean; files: DiffFileSummary[]; additions: number; deletions: number }
  | { status: "unavailable"; reason: "missing" | "not-directory" | "inaccessible" | "changed" }
  | { status: "unknown"; workspaceId: WorkspaceId }
  | { status: "error"; message: string };

/** One file's patch, as Git wrote it. `too-large` names the ceiling rather than truncating a patch. */
export type DiffPatchResult =
  | { status: "available"; patch: string }
  | { status: "too-large"; limit: number }
  | { status: "error"; message: string };

export type ChangedFilesResult =
  /** `baseline` is the ref the counts are measured from, or null when only the working tree is counted. */
  | { status: "available"; files: string[]; branch: string | null; baseline: string | null; additions: number; deletions: number }
  | { status: "unavailable"; reason: "missing" | "not-directory" | "inaccessible" | "changed" }
  | { status: "unknown"; workspaceId: WorkspaceId }
  | { status: "error"; message: string };

type RunEventBase = {
  taskId: string;
  runId: string;
  sequence: number;
};

export type RunEvent =
  | (RunEventBase & { type: "question.requested"; requestId: string; request: QuestionRequest })
  | (RunEventBase & { type: "question.answered"; requestId: string; questionId: string; text: string })
  | (RunEventBase & { type: "question.closed"; requestId: string })
  /** `agentInitiated` marks a turn the agent started itself, which the thread takes on a run for. */
  | (RunEventBase & { type: "run.started"; agentInitiated?: true })
  /** `limit` marks a run that failed because the account reached its plan's usage limit. */
  | (RunEventBase & { type: "run.status"; status: RunStatus; message?: string; limit?: UsageLimit })
  | (RunEventBase & { type: "assistant.delta"; messageId: string; text: string; append?: boolean; artifact?: true })
  /** Streamed text that is not a complete Markdown block yet. Superseded by the next delta, never stored. */
  | (RunEventBase & { type: "assistant.tail"; messageId: string; text: string })
  | (RunEventBase & { type: "context.usage"; tokens: number; limit: number; model: string })
  /** What a model response spent beyond what was already counted. Unlike `context.usage`, it only ever adds up. */
  | (RunEventBase & { type: "context.spent"; tokens: number })
  | (RunEventBase & { type: "context.compaction-status"; compacting: boolean; error?: string })
  | (RunEventBase & { type: "run.retrying" } & RetryNotice)
  | (RunEventBase & { type: "context.compacted"; trigger: "manual" | "auto"; preTokens: number; postTokens?: number })
  | (RunEventBase & { type: "tool.intent"; intent: ToolIntent })
  | (RunEventBase & { type: "computer-use.setup-required" })
  | (RunEventBase & {
      type: "approval.requested";
      approvalId: string;
      intent: ToolIntent;
      title: string;
      description: string;
    })
  | (RunEventBase & { type: "continuation.updated"; continuation: Continuation })
  /** The engine no longer has the session the thread was continuing, so the thread starts over next time. */
  | (RunEventBase & { type: "continuation.lost" })
  /** A steered message reached the agent, so it is part of this run rather than the next one. */
  | (RunEventBase & { type: "queued.delivered"; messageId: string })
  /** Steering was rejected, so the queued message can be steered again or removed. */
  | (RunEventBase & { type: "queued.steer-failed"; messageId: string; message: string });

/** What a workflow reports as it runs. The thread it belongs to is added on the way out of the agent process. */
export type WorkflowReport =
  | { type: "workflow.started"; id: string; name: string; description: string }
  /** The workflow's whole tree as it stands. Replaces the record rather than amending it. */
  | { type: "workflow.progress"; id: string; phases: WorkflowPhase[]; agents: WorkflowAgent[]; totalTokens: number; totalToolCalls: number }
  | { type: "workflow.finished"; id: string; status: Exclude<WorkflowStatus, "running">; summary: string };

/** A workflow outlives the run that started it, so what it reports is the thread's rather than a run's. */
export type WorkflowEvent = WorkflowReport & { taskId: string };

/**
 * Every background process the thread's session still has. Replaces the set rather than amending it.
 * A shell or a monitor outlives the run that started it, so the set belongs to the thread.
 */
export type BackgroundReport = { type: "background.changed"; processes: BackgroundProcess[] };

export type BackgroundEvent = BackgroundReport & { taskId: string };

/** A subagent belongs to its thread, so its updates remain valid after the parent run settles. */
export type SubagentEvent = SubagentReport & { taskId: string };

/** Native goal state is session-only and belongs to the thread, not the run that set it. */
export type GoalReport = { type: "goal.changed"; goal: ActiveGoal | null };
export type GoalEvent = GoalReport & { taskId: string };

/** What the agent process reports about work that answers to the thread rather than to a run. */
export type ThreadEvent = WorkflowEvent | BackgroundEvent | SubagentEvent | GoalEvent | import("./session-resources.js").ResourceStoppedEvent;

/** Everything the agent process pushes back, on one channel so a workflow cannot overtake its own run. */
export type AgentEvent = RunEvent | ThreadEvent | AgentSettingsReloadEvent;

/** The longest id a request names a thread, a tab, a terminal or a worktree by, which the tools that send one hold their fields to. */
export const MAX_ID_LENGTH = 256;
/** The longest address a run may open in the browser panel. */
export const MAX_URL_LENGTH = 8_192;
/** The longest text a read looks for: a thread search, a terminal match, or what a browser wait watches for. */
export const MAX_SEARCH_TEXT = 1_000;
/** A wait holds a tool call open, so it is bounded rather than left to the caller. */
export const MAX_THREAD_WAIT_MS = 15 * 60 * 1_000;
/** A page read waits for the tab to settle, which a slow site must not stretch without limit. */
export const MAX_BROWSER_WAIT_MS = 2 * 60 * 1_000;
export const MAX_PROMPT_LENGTH = 1_000_000;
const MAX_TITLE_LENGTH = 64;

export function isString(value: unknown, maxLength = MAX_ID_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

export function isBlankable(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

export function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRunChannel(value: unknown): value is RunChannel {
  return value === "main" || value === "side";
}

function isContinuation(value: unknown): value is Continuation {
  return Boolean(value && typeof value === "object" && isString((value as Record<string, unknown>).provider) && isString((value as Record<string, unknown>).value, 100_000));
}

function isBackgroundProcessKind(value: unknown): value is BackgroundProcessKind {
  return value === "shell" || value === "monitor";
}

function isBackgroundProcess(value: unknown): value is BackgroundProcess {
  if (!value || typeof value !== "object") return false;
  const process = value as Record<string, unknown>;
  return isString(process.id) && isBackgroundProcessKind(process.kind) && isString(process.description, 100_000);
}

function isWorkflowPhase(value: unknown): value is WorkflowPhase {
  if (!value || typeof value !== "object") return false;
  const phase = value as Record<string, unknown>;
  return isCount(phase.index) && isString(phase.title, 100_000);
}

function isWorkflowAgentState(value: unknown): value is WorkflowAgentState {
  return value === "queued" || value === "running" || value === "done" || value === "error";
}

function isWorkflowAgent(value: unknown): value is WorkflowAgent {
  if (!value || typeof value !== "object") return false;
  const agent = value as Record<string, unknown>;
  const strings = ["phaseTitle", "agentId", "agentType", "model", "lastAttemptReason", "lastToolName", "lastToolSummary", "promptPreview", "resultPreview", "error"];
  const counts = ["phaseIndex", "attempt", "queuedAt", "startedAt", "durationMs", "lastProgressAt", "tokens", "toolCalls"];
  return isCount(agent.index)
    && isString(agent.label, 100_000)
    && isWorkflowAgentState(agent.state)
    && (agent.isolation === undefined || agent.isolation === "worktree" || agent.isolation === "remote")
    && (agent.cached === undefined || typeof agent.cached === "boolean")
    && strings.every((key) => agent[key] === undefined || isString(agent[key], 100_000))
    && counts.every((key) => agent[key] === undefined || isCount(agent[key]));
}

function isIntent(value: unknown): value is ToolIntent {
  if (!value || typeof value !== "object") return false;
  const intent = value as Record<string, unknown>;
  return isString(intent.toolId) && isString(intent.name) && (intent.writePath === undefined || typeof intent.writePath === "string");
}

function isComputerUseRunConfig(value: unknown): value is ComputerUseRunConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Record<string, unknown>;
  if (config.status === "setup-required") return true;
  if (config.status === "unavailable") return isString(config.message, 10_000);
  if (config.status !== "available" || !config.mcp || typeof config.mcp !== "object") return false;
  const mcp = config.mcp as Record<string, unknown>;
  return isString(mcp.command, 4_096)
    && Array.isArray(mcp.args) && mcp.args.every((item) => typeof item === "string")
    && Boolean(mcp.env && typeof mcp.env === "object" && !Array.isArray(mcp.env) && Object.values(mcp.env).every((item) => typeof item === "string"));
}

export function isRunCommand(value: unknown): value is RunCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;
  if (command.type === "start") {
    return isStartCommand(command, false);
  }
  if (command.type === "memory-protection") return typeof command.enabled === "boolean";
  if (command.type === "reload-settings") return true;
  if (command.type === "cancel") return isString(command.taskId) && isString(command.runId);
  if (command.type === "answer-question") return isString(command.taskId) && isString(command.runId) && isString(command.requestId) && isString(command.questionId) && isString(command.text, MAX_PROMPT_LENGTH) && command.text.trim().length > 0;
  if (command.type === "approval") return isString(command.taskId) && isString(command.runId) && isString(command.approvalId) && typeof command.allow === "boolean";
  if (command.type === "steer") return isString(command.taskId) && isString(command.runId) && isString(command.messageId) && isString(command.prompt, MAX_PROMPT_LENGTH);
  if (command.type === "stop-process") return isString(command.taskId) && isString(command.processId);
  if (command.type === "label") return isString(command.taskId) && isString(command.title, MAX_TITLE_LENGTH);
  if (command.type === "archive") return isString(command.taskId) && isRunChannel(command.channel) && (command.continuation === undefined || isContinuation(command.continuation)) && typeof command.archived === "boolean";
  if (command.type === "role") return isString(command.taskId) && (command.coordinationRole === undefined || command.coordinationRole === "coordinator" || command.coordinationRole === "member");
  return false;
}

export function isInternalRunCommand(value: unknown): value is InternalRunCommand {
  const command = value as Record<string, unknown> | null;
  if (command?.type === "start") return isStartCommand(command, true);
  return isRunCommand(value);
}

function isStartCommand(command: Record<string, unknown>, internal: boolean) {
  if (!isString(command.title, MAX_TITLE_LENGTH)) return false;
  const operation = command.operation as Record<string, unknown> | undefined;
  /** An operation is work the engine performs itself; whether the thread's model offers it is the reducer's to decide. */
  const compact = operation?.type === "compact"
    && typeof operation.preTokens === "number" && Number.isFinite(operation.preTokens) && operation.preTokens >= 0
    && command.prompt === "" && isAgentEngine(command.engine) && isModelId(command.model)
    && isContinuation(command.continuation) && command.continuation.provider === command.engine
    && command.forkContinuation === undefined;
  const review = operation?.type === "review"
    && isReviewTarget(operation.target)
    && command.channel === "main" && command.prompt === "" && isAgentEngine(command.engine) && capabilitiesFor(command.engine).review
    && isContinuation(command.continuation) && command.continuation.provider === command.engine
    && (command.forkContinuation === undefined || command.forkContinuation === true);
  const operationOnly = compact || review;
  const base = (command.memoryProtection === undefined || typeof command.memoryProtection === "boolean") && isRunChannel(command.channel) && isString(command.taskId) && isString(command.runId) && (operationOnly ? isBlankable(command.prompt, MAX_PROMPT_LENGTH) : isString(command.prompt, MAX_PROMPT_LENGTH)) && isString(command.workspaceId) && isExecutionPolicy(command.policy) && isAgentEngine(command.engine) && isModelId(command.model) && isAgentEffort(command.effort) && (command.operation === undefined || operationOnly) && (command.chromeBrowser === undefined || (command.chromeBrowser === true && capabilitiesFor(command.engine).chromeBrowser)) && (command.computerUseTools === undefined || command.computerUseTools === false) && (command.browserTools === undefined || command.browserTools === false) && (command.simulatorTools === undefined || command.simulatorTools === false) && (command.continuation === undefined || isContinuation(command.continuation)) && (command.forkContinuation === undefined || (command.forkContinuation === true && isContinuation(command.continuation))) && (command.freshSession === undefined || (command.freshSession === true && command.continuation === undefined && command.forkContinuation === undefined)) && (command.unattended === undefined || command.unattended === true) && (command.coordinationRole === undefined || command.coordinationRole === "coordinator" || command.coordinationRole === "member") && (command.projectWorkspaceId === undefined || (command.coordinationRole === "member" && isString(command.projectWorkspaceId)));
  if (!base || !(command.fastMode === undefined || isAgentEngine(command.engine) && capabilitiesFor(command.engine).fastMode && typeof command.fastMode === "boolean")) return false;
  if (!internal) return !["workspaceRoot", "projectless", "computerUse", "projectRoot", "cwd", "folder", "sessionId", "mode", "requestId"].some((key) => key in command);
  return isString(command.workspaceRoot, 4_096) && typeof command.projectless === "boolean" && isComputerUseRunConfig(command.computerUse) && (command.projectRoot === undefined || isString(command.projectRoot, 4_096));
}

export function isAutomationRequest(value: unknown): value is AutomationRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  if (request.type !== "automation.request" || !isString(request.requestId) || !isString(request.taskId)) return false;
  if (request.op === "read" || request.op === "list" || request.op === "delete") return true;
  if (request.op === "save") return isString(request.runId) && isAutomationDraft({ ...(request.draft as object), taskId: request.taskId });
  return request.op === "update" && isString(request.runId) && isAutomationPatch(request.patch);
}

export function isBrowserAction(value: unknown): value is BrowserAction {
  if (!value || typeof value !== "object") return false;
  const action = value as Record<string, unknown>;
  if (action.kind === "click") return isString(action.ref);
  if (action.kind === "type") {
    return isString(action.ref) && typeof action.text === "string" && action.text.length <= MAX_PROMPT_LENGTH
      && (action.submit === undefined || typeof action.submit === "boolean");
  }
  return false;
}

export function isBrowserBounds(value: unknown): value is BrowserBounds {
  if (!value || typeof value !== "object") return false;
  const box = value as Record<string, unknown>;
  return [box.x, box.y, box.width, box.height].every((side) => typeof side === "number" && Number.isFinite(side));
}

export function isBrowserRead(value: unknown): value is BrowserRead {
  if (!value || typeof value !== "object") return false;
  const read = value as Record<string, unknown>;
  if (read.op === "tabs") return true;
  const tabbed = read.tabId === undefined || isString(read.tabId);
  if (read.op === "console") {
    return tabbed
      && (read.since === undefined || isCount(read.since))
      && (read.limit === undefined || isCount(read.limit) && read.limit <= 200)
      && (read.minimumLevel === undefined || ["debug", "info", "warning", "error"].includes(String(read.minimumLevel)));
  }
  if (read.op === "network") {
    return tabbed
      && (read.since === undefined || isCount(read.since))
      && (read.limit === undefined || isCount(read.limit) && read.limit <= 200)
      && (read.failuresOnly === undefined || typeof read.failuresOnly === "boolean");
  }
  if (read.op === "wait") {
    const condition = String(read.condition), needsValue = condition !== "network-idle";
    return tabbed
      && ["text", "text-gone", "element", "element-gone", "url", "network-idle"].includes(condition)
      && (!needsValue && read.value === undefined || needsValue && isString(read.value, MAX_SEARCH_TEXT))
      && isCount(read.timeoutMs) && read.timeoutMs <= MAX_BROWSER_WAIT_MS;
  }
  if (read.op !== "snapshot" && read.op !== "screenshot") return false;
  const waited = tabbed && isCount(read.timeoutMs) && read.timeoutMs <= MAX_BROWSER_WAIT_MS;
  if (read.op === "screenshot") return waited && (read.fullPage === undefined || typeof read.fullPage === "boolean");
  return waited && (read.textLimit === undefined || isCount(read.textLimit));
}

/** The longest a run waits on a device to boot, which a first boot of a fresh device can take. */
export const MAX_SIMULATOR_WAIT_MS = 300_000;

export function isSimulatorRead(value: unknown): value is SimulatorRead {
  if (!value || typeof value !== "object") return false;
  const read = value as Record<string, unknown>;
  if (read.op === "status") return isCount(read.timeoutMs) && read.timeoutMs <= MAX_SIMULATOR_WAIT_MS;
  return read.op === "snapshot" && typeof read.screenshot === "boolean";
}

export function isTerminalRead(value: unknown): value is TerminalRead {
  if (!value || typeof value !== "object") return false;
  const read = value as Record<string, unknown>;
  if (read.op === "terminals") return true;
  if (read.op !== "snapshot") return false;
  return (read.terminalId === undefined || isString(read.terminalId))
    && (read.lines === undefined || isCount(read.lines))
    && (read.match === undefined || isString(read.match, MAX_SEARCH_TEXT));
}

/**
 * What a request no guard could read is answered with. The caller is a tool call held open, so a
 * message that is dropped reaches it as a timeout saying nothing about what was wrong with it.
 */
export function unreadableRequest(value: unknown): ThreadResponse | AutomationResponse | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (!isString(message.requestId)) return null;
  const refusal = "AI Coding Tool could not read that request: one of its fields is not what the request allows.";
  if (message.type === "thread.request") return { type: "thread.response", requestId: message.requestId, ok: false, message: refusal };
  if (message.type === "automation.request") return { type: "automation.response", requestId: message.requestId, ok: false, message: refusal };
  return null;
}

export function isThreadResponse(value: unknown): value is ThreadResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  if (response.type !== "thread.response" || !isString(response.requestId)) return false;
  return response.ok === true || (response.ok === false && isString(response.message, 100_000));
}

export function isAutomationResponse(value: unknown): value is AutomationResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  if (response.type !== "automation.response" || !isString(response.requestId)) return false;
  return response.ok === true || (response.ok === false && isString(response.message, 100_000));
}

export function isAutomationAck(value: unknown): value is AutomationAck {
  if (!value || typeof value !== "object") return false;
  const ack = value as Record<string, unknown>;
  return isString(ack.automationId) && isString(ack.runId) && typeof ack.started === "boolean";
}

/** More than any one model response could spend, so a larger count is a mistake rather than spend. */
const MAX_SPENT_TOKENS = 1_000_000_000;

export function isRunEvent(value: unknown): value is RunEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if (!isString(event.taskId) || !isString(event.runId) || typeof event.sequence !== "number" || !Number.isSafeInteger(event.sequence) || event.sequence < 1) return false;
  if (event.type === "question.requested") return isString(event.requestId) && isQuestionRequest(event.request);
  if (event.type === "question.answered") return isString(event.requestId) && isString(event.questionId) && isString(event.text, MAX_PROMPT_LENGTH);
  if (event.type === "question.closed") return isString(event.requestId);
  if (event.type === "run.started") return event.agentInitiated === undefined || event.agentInitiated === true;
  if (event.type === "run.status") return (event.status === "running" || event.status === "awaiting-approval" || event.status === "succeeded" || event.status === "failed" || event.status === "cancelled") && (event.message === undefined || isString(event.message, 100_000)) && (event.limit === undefined || event.status === "failed" && isUsageLimit(event.limit));
  if (event.type === "assistant.delta") return isString(event.messageId) && typeof event.text === "string" && (event.append === undefined || event.append === true) && (event.artifact === undefined || event.artifact === true);
  if (event.type === "assistant.tail") return isString(event.messageId) && typeof event.text === "string" && event.text.length <= MAX_PROMPT_LENGTH;
  if (event.type === "context.usage") return typeof event.tokens === "number" && Number.isFinite(event.tokens) && event.tokens >= 0 && typeof event.limit === "number" && Number.isFinite(event.limit) && event.limit > 0 && isString(event.model);
  if (event.type === "context.spent") return Number.isSafeInteger(event.tokens) && (event.tokens as number) >= 1 && (event.tokens as number) <= MAX_SPENT_TOKENS;
  if (event.type === "run.retrying") return isString(event.message, 100_000) && (event.attempt === undefined || isCount(event.attempt)) && (event.maxRetries === undefined || isCount(event.maxRetries));
  if (event.type === "context.compaction-status") return typeof event.compacting === "boolean" && (event.error === undefined || isString(event.error, 100_000));
  if (event.type === "context.compacted") return (event.trigger === "manual" || event.trigger === "auto") && typeof event.preTokens === "number" && Number.isFinite(event.preTokens) && event.preTokens >= 0 && (event.postTokens === undefined || (typeof event.postTokens === "number" && Number.isFinite(event.postTokens) && event.postTokens >= 0));
  if (event.type === "tool.intent") return isIntent(event.intent);
  if (event.type === "computer-use.setup-required") return true;
  if (event.type === "approval.requested") return isString(event.approvalId) && isIntent(event.intent) && isString(event.title) && isString(event.description, 100_000);
  if (event.type === "continuation.updated") return isContinuation(event.continuation);
  if (event.type === "continuation.lost") return true;
  if (event.type === "queued.delivered") return isString(event.messageId);
  if (event.type === "queued.steer-failed") return isString(event.messageId) && isString(event.message, 100_000);
  return false;
}

export function isBackgroundEvent(value: unknown): value is BackgroundEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if (!isString(event.taskId) || event.type !== "background.changed") return false;
  return Array.isArray(event.processes) && event.processes.every(isBackgroundProcess);
}

export function isSubagentEvent(value: unknown): value is SubagentEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if (!isString(event.taskId) || !isString(event.id)) return false;
  if (event.type === "subagent.started" || event.type === "subagent.metadata") {
    if (!(event.model === undefined || isString(event.model))
      || !(event.effort === undefined || isString(event.effort))
      || !(event.prompt === undefined || typeof event.prompt === "string")) return false;
    if (event.type === "subagent.metadata") return true;
  }
  if (event.type === "subagent.started") {
    return isString(event.description, 100_000)
      && (event.agentType === undefined || isString(event.agentType))
      && (event.sessionScoped === undefined || event.sessionScoped === true);
  }
  if (event.type === "subagent.status") return (event.status === "working" || event.status === "idle")
    && (event.summary === undefined || isString(event.summary, 100_000));
  if (event.type === "subagent.progress") {
    return isString(event.description, 100_000)
      && (event.agentType === undefined || isString(event.agentType))
      && (event.lastToolName === undefined || isString(event.lastToolName))
      && (event.summary === undefined || isString(event.summary, 100_000))
      && isCount(event.totalTokens);
  }
  if (event.type === "subagent.activity") {
    return isString(event.activityId)
      && (event.kind === "text" || event.kind === "tool")
      && (event.title === undefined || isString(event.title))
      && typeof event.text === "string";
  }
  if (event.type === "subagent.finished") {
    return (event.status === "completed" || event.status === "failed" || event.status === "stopped")
      && typeof event.summary === "string";
  }
  return false;
}

export function isGoalEvent(value: unknown): value is GoalEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if (!isString(event.taskId) || event.type !== "goal.changed") return false;
  if (event.goal === null) return true;
  if (!event.goal || typeof event.goal !== "object") return false;
  const goal = event.goal as Record<string, unknown>;
  return isString(goal.objective, 100_000)
    && (goal.status === "active" || goal.status === "blocked")
    && (goal.iterations === undefined || isCount(goal.iterations))
    && (goal.lastReason === undefined || isString(goal.lastReason, 100_000));
}

export function isWorkflowEvent(value: unknown): value is WorkflowEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if (!isString(event.taskId) || !isString(event.id)) return false;
  if (event.type === "workflow.started") return isString(event.name, 100_000) && isString(event.description, 100_000);
  if (event.type === "workflow.progress") {
    return Array.isArray(event.phases) && event.phases.every(isWorkflowPhase)
      && Array.isArray(event.agents) && event.agents.every(isWorkflowAgent)
      && isCount(event.totalTokens) && isCount(event.totalToolCalls);
  }
  if (event.type === "workflow.finished") return (event.status === "completed" || event.status === "failed" || event.status === "stopped") && typeof event.summary === "string";
  return false;
}

/** A theme arriving from the renderer, which the window trusts no further than its own three fields. */
export function isWindowTheme(value: unknown): value is WindowTheme {
  if (!value || typeof value !== "object") return false;
  const theme = value as Record<string, unknown>;
  return (theme.variant === "dark" || theme.variant === "light")
    && typeof theme.canvas === "string"
    && /^#[0-9a-fA-F]{6}$/.test(theme.canvas)
    && (theme.follow === undefined || typeof theme.follow === "boolean");
}
