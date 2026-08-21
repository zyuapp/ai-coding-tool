import { isAutomationDraft, isAutomationPatch, type AutomationDraft, type AutomationPatch, type AutomationRunStatus, type AutomationView } from "../domain/automation.js";
import type { BrowserRead, ExternalCommand, TerminalRead, ThreadRequest, ThreadResponse } from "./threads.js";
import type { BrowserAction, BrowserBounds, BrowserSnapshot } from "../domain/browser.js";
import type { CliStatus } from "../domain/cli.js";
import type { DiffFileSummary, DiffRange } from "../domain/diff.js";
import type { FindResults } from "../domain/find.js";
import type { TerminalUpdate } from "../domain/terminal.js";
import type { AgentEffort, AgentModel, BackgroundProcess, BackgroundProcessKind, Continuation, ExecutionPolicy, RunStatus, Subagent, SubagentActivity, SubagentStatus, ToolIntent } from "../domain/run.js";
import type { PlanUsage } from "../domain/plan-usage.js";
import { shortcutAction, shortcutProblem, type ShortcutOverrides, type ShortcutSurface } from "../domain/shortcuts.js";
import type { WorkflowAgent, WorkflowAgentState, WorkflowPhase, WorkflowStatus } from "../domain/workflow.js";
import type { Project, Task, TaskMessage, TaskStoreData } from "../domain/task.js";
import type { WorkspaceRecord } from "../domain/workspace.js";
import type { Worktree, WorktreeRelease } from "../domain/worktree.js";

export type WorkspaceId = string;
export type RunChannel = "main" | "side";

export type PersistedTask = Omit<Task, "messages" | "subagents">;
export type PersistedSubagent = Omit<Subagent, "activity">;

export type TaskStoreDelta = {
  tasks: Array<{
    task: PersistedTask;
    messages: Array<{ index: number; message: TaskMessage }>;
    subagents?: Array<{ index: number; subagent: PersistedSubagent }>;
    activity?: Array<{ subagentId: string; index: number; item: SubagentActivity }>;
  }>;
  removedTasks?: string[];
  projects?: Project[];
  /** The whole list, as `projects` is: a checkout is only ever added or dropped, never edited alone. */
  worktrees?: Worktree[];
  lastFolder?: string | null;
};

export type StartRunCommand = {
  type: "start";
  channel: RunChannel;
  taskId: string;
  runId: string;
  prompt: string;
  workspaceId: WorkspaceId;
  policy: ExecutionPolicy;
  model: AgentModel;
  effort: AgentEffort;
  continuation?: Continuation;
  forkContinuation?: boolean;
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

export type BranchesResult =
  /** `branches` are local and can be moved onto; `remotes` can only be compared against. */
  | { status: "available"; branches: string[]; remotes: string[]; current: string | null }
  | { status: "error"; message: string };

export type ReleaseWorktreeRequest = {
  worktreeId: string;
  root: string;
  taskId: string;
  title: string;
  release: WorktreeRelease;
};

export type WorktreeSnapshotResult = {
  commit: string | null;
  shortCommit: string | null;
  ref: string | null;
};

export type ComputerUsePermissions = {
  accessibility: boolean;
  screenRecording: boolean;
};

export type ComputerUsePermission = keyof ComputerUsePermissions;

export type ComputerUseMcp = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export type ComputerUseRunConfig =
  | { status: "available"; mcp: ComputerUseMcp }
  | { status: "setup-required" }
  | { status: "unavailable"; message: string };

export type InternalStartRunCommand = StartRunCommand & {
  workspaceRoot: string;
  projectless: boolean;
  computerUse: ComputerUseRunConfig;
};

export type CancelRunCommand = {
  type: "cancel";
  taskId: string;
  runId: string;
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

/** Kills one background process the run started, leaving the run itself going. */
export type StopProcessCommand = {
  type: "stop-process";
  taskId: string;
  runId: string;
  processId: string;
};

export type RunCommand = StartRunCommand | CancelRunCommand | ApprovalDecisionCommand | SteerRunCommand | StopProcessCommand;

/** The scheduler owns the run ID so it can correlate the renderer's run back to the tick that asked for it. */
export type AutomationFire = {
  automationId: string;
  taskId: string;
  runId: string;
  prompt: string;
  policy?: ExecutionPolicy;
  runNumber: number;
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
  | { op: "save"; draft: Omit<AutomationDraft, "taskId"> }
  | { op: "update"; patch: AutomationPatch }
  | { op: "delete" }
);

export type AutomationResponse = {
  type: "automation.response";
  requestId: string;
} & ({ ok: true; result: unknown } | { ok: false; message: string });

export type DesktopAPI = {
  openFolder(): Promise<WorkspaceRecord | null>;
  /** A folder the `claudex` terminal command named, already registered as a workspace. */
  onOpenProject(listener: (workspace: WorkspaceRecord) => void): () => void;
  /** Whether the `claudex` terminal command is installed, and the path it takes. */
  cliStatus(): Promise<CliStatus>;
  /** Writes the command, asking for the administrator password when its directory needs one. */
  installCli(): Promise<CliStatus>;
  uninstallCli(): Promise<CliStatus>;
  projectlessWorkspace(): Promise<WorkspaceRecord>;
  commands(workspaceId: WorkspaceId): Promise<CommandDiscoveryResult>;
  computerUsePermissions(): Promise<ComputerUsePermissions>;
  enableComputerUse(permission: ComputerUsePermission): Promise<ComputerUsePermissions>;
  /** The plan's rate-limit windows. Never rejects: a provider that cannot answer says why instead. */
  planUsage(): Promise<PlanUsage>;
  restartForComputerUse(): void;
  send(command: RunCommand): void;
  onAgentEvent(listener: (event: RunEvent) => void): () => void;
  changedFiles(workspaceId: WorkspaceId): Promise<ChangedFilesResult>;
  /** The files a comparison touches, with their counts. Cheap enough to read whenever a run ends. */
  diffSummary(workspaceId: WorkspaceId, range: DiffRange): Promise<DiffSummaryResult>;
  /** One file's patch, read only once that file is drawn. A rename needs both of its paths. */
  diffPatch(workspaceId: WorkspaceId, range: DiffRange, path: string, previousPath?: string): Promise<DiffPatchResult>;
  /** The local branches a thread can start from, newest first. */
  branches(workspaceId: WorkspaceId): Promise<BranchesResult>;
  /** Moves a project checkout onto a branch. Never forced, so uncommitted work stops it. */
  checkoutBranch(workspaceId: WorkspaceId, branch: string): Promise<void>;
  /** Makes a branch at the checkout's own HEAD, without moving onto it. */
  createBranch(workspaceId: WorkspaceId, branch: string): Promise<void>;
  /** Makes the thread's own checkout, detached at whatever the project has checked out right now. */
  createWorktree(request: CreateWorktreeRequest): Promise<CreatedWorktree>;
  /** Force-commits what the worktree still holds so the thread can leave it without losing work. */
  releaseWorktree(request: ReleaseWorktreeRequest): Promise<WorktreeSnapshotResult>;
  /** Discards the checkout and everything uncommitted in it. */
  deleteWorktree(root: string): Promise<void>;
  /** Writes base64 PNG bytes into the attachments directory and resolves with the absolute path. */
  saveAttachment(data: string): Promise<string>;
  /** Names a thread from its first message and any screenshots it carries, off the agent's run path. Null when no name came back. */
  suggestTaskTitle(text: string, attachments: string[]): Promise<string | null>;
  loadTaskStore(): Promise<TaskStoreData | null>;
  persistTaskStore(delta: TaskStoreDelta): Promise<void>;
  /** A stored subagent's activity, which the store leaves behind until someone opens that subagent. */
  loadSubagentActivity(taskId: string, subagentId: string): Promise<SubagentActivity[]>;
  listAutomations(): Promise<AutomationView[]>;
  saveAutomation(draft: AutomationDraft): Promise<AutomationView>;
  updateAutomation(taskId: string, patch: AutomationPatch): Promise<AutomationView>;
  deleteAutomation(taskId: string): Promise<boolean>;
  runAutomationNow(taskId: string): Promise<AutomationRunStatus | "busy">;
  onAutomationsChanged(listener: (automations: AutomationView[]) => void): () => void;
  onAutomationFire(listener: (fire: AutomationFire) => void): () => void;
  acknowledgeAutomation(ack: AutomationAck): void;
  /** The window answers thread requests itself: it is the only process that holds workspace state. */
  onThreadRequest(listener: (request: ThreadRequest) => void): () => void;
  answerThreadRequest(response: ThreadResponse): void;
  /** The browser panel's pages live in main; the window owns the record of them and their geometry. */
  openBrowserTab(tabId: string, url?: string): Promise<void>;
  navigateBrowser(tabId: string, url: string): Promise<void>;
  browserHistory(tabId: string, delta: -1 | 1): Promise<void>;
  reloadBrowser(tabId: string): Promise<void>;
  closeBrowserTab(tabId: string): Promise<void>;
  /** Which tab the panel is showing. */
  showBrowserTab(tabId: string | null): Promise<void>;
  /** Where the panel is, in window coordinates. Null while the panel is not on screen. */
  setBrowserBounds(bounds: BrowserBounds | null): Promise<void>;
  actInBrowser(tabId: string, action: BrowserAction): Promise<string>;
  /** Waits for the tab to stop loading, then reads the page. Null when that tab is gone. */
  readBrowserPage(tabId: string, textLimit: number, timeoutMs: number): Promise<BrowserSnapshot | null>;
  clearBrowserData(): Promise<void>;
  onBrowserEvent(listener: (event: BrowserPageEvent) => void): () => void;
  /** Searching a page. Chromium holds the text and counts the matches, so it reports them back. */
  findInPage(tabId: string, query: string, forward: boolean, findNext: boolean): Promise<void>;
  stopFindInPage(tabId: string): Promise<void>;
  focusBrowserTab(tabId: string): Promise<void>;
  onBrowserFind(listener: (event: BrowserFindEvent) => void): () => void;
  /** Hands a file to the desktop, which opens it with whatever it opens that kind of file with. */
  openFile(root: string, path: string, line: number | null): Promise<void>;
  /** The terminal panel's shells live in main; the window owns the record of them. */
  startTerminal(terminalId: string, options: TerminalStartOptions): Promise<void>;
  /** What the user typed. Nothing outside the window reaches this: a run may read a terminal, never drive one. */
  writeTerminal(terminalId: string, data: string): Promise<void>;
  resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void>;
  closeTerminal(terminalId: string): Promise<void>;
  /** The lines the terminal holds, cooked to plain text. Null when that terminal is gone. */
  readTerminal(terminalId: string, options: TerminalReadOptions): Promise<TerminalText | null>;
  /** Output, coalesced and delivered straight to the view. It is never workspace state. */
  onTerminalData(listener: (event: TerminalDataEvent) => void): () => void;
  onTerminalEvent(listener: (update: TerminalUpdate) => void): () => void;
  /** The keystrokes main matches, so a shortcut works inside a page the window never hears from. */
  setShortcuts(overrides: ShortcutOverrides): void;
  /** While settings wait for a keystroke, main hands every one of them over instead of acting on it. */
  setShortcutCapture(capturing: boolean): void;
  onShortcut(listener: (invocation: ShortcutInvocation) => void): () => void;
  /** What was pressed while capturing, or null for the Escape that calls it off. */
  onShortcutCaptured(listener: (binding: string | null) => void): () => void;
  closeWindow(): void;
  /** Takes the keyboard back from a page in the panel, so the window can have it. */
  focusWindow(): void;
};

/** What a keystroke asked for, and where it was pressed. */
export type ShortcutInvocation = { action: string; surface: ShortcutSurface };

/** How many bindings a window may send. Far more than the app has actions, and still bounded. */
const MAX_SHORTCUTS = 200;

/** Bindings arrive from the window like any other outside command, so main reads them defensively. */
export function isShortcutOverrides(value: unknown): value is ShortcutOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_SHORTCUTS) return false;
  return entries.every(([action, binding]) => Boolean(shortcutAction(action))
    && (binding === null || (typeof binding === "string" && !shortcutProblem(binding))));
}

export type TerminalStartOptions = { cwd: string };

export type TerminalReadOptions = { lines: number; match?: string };

/** What main holds for a terminal: its lines, with no escape sequences left in them. The record is the window's. */
export type TerminalText = {
  lines: string[];
  /** How many lines the terminal holds that the limit left out. */
  omitted: number;
  /** Set when a filter was applied, counting the lines it kept. */
  matched?: number;
};

/** A flush of everything the shell printed since the last one. */
export type TerminalDataEvent = { terminalId: string; data: string };

/** What a page did, pushed from main so the reducer stays the only writer of the tab record. */
export type BrowserPageEvent = {
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
  | { status: "available"; range: DiffRange; files: DiffFileSummary[]; additions: number; deletions: number }
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
  | (RunEventBase & { type: "run.started" })
  | (RunEventBase & { type: "run.status"; status: RunStatus; message?: string })
  | (RunEventBase & { type: "assistant.delta"; messageId: string; text: string; append?: boolean })
  /** Streamed text that is not a complete Markdown block yet. Superseded by the next delta, never stored. */
  | (RunEventBase & { type: "assistant.tail"; messageId: string; text: string })
  | (RunEventBase & { type: "context.usage"; tokens: number; limit: number; model: string })
  | (RunEventBase & { type: "context.compaction-status"; compacting: boolean; error?: string })
  | (RunEventBase & { type: "context.compacted"; trigger: "manual" | "auto"; preTokens: number; postTokens?: number })
  | (RunEventBase & { type: "tool.intent"; intent: ToolIntent })
  | (RunEventBase & { type: "computer-use.setup-required" })
  | (RunEventBase & { type: "subagent.started"; id: string; description: string; agentType?: string })
  | (RunEventBase & { type: "subagent.progress"; id: string; description: string; lastToolName?: string; summary?: string; totalTokens: number })
  | (RunEventBase & { type: "subagent.activity"; id: string; activityId: string; kind: "text" | "tool"; title?: string; text: string })
  | (RunEventBase & { type: "subagent.finished"; id: string; status: Exclude<SubagentStatus, "working">; summary: string })
  /** Every background process the run still has. Replaces the set rather than amending it. */
  | (RunEventBase & { type: "background.changed"; processes: BackgroundProcess[] })
  | (RunEventBase & { type: "workflow.started"; id: string; name: string; description: string })
  /** The workflow's whole tree as it stands. Replaces the record rather than amending it. */
  | (RunEventBase & {
      type: "workflow.progress";
      id: string;
      phases: WorkflowPhase[];
      agents: WorkflowAgent[];
      totalTokens: number;
      totalToolCalls: number;
    })
  | (RunEventBase & { type: "workflow.finished"; id: string; status: Exclude<WorkflowStatus, "running">; summary: string })
  | (RunEventBase & {
      type: "approval.requested";
      approvalId: string;
      intent: ToolIntent;
      title: string;
      description: string;
    })
  | (RunEventBase & { type: "continuation.updated"; continuation: Continuation })
  /** A steered message reached the agent, so it is part of this run rather than the next one. */
  | (RunEventBase & { type: "queued.delivered"; messageId: string });

const MAX_ID_LENGTH = 256;
/** A wait holds a tool call open, so it is bounded rather than left to the caller. */
export const MAX_THREAD_WAIT_MS = 15 * 60 * 1_000;
/** A page read waits for the tab to settle, which a slow site must not stretch without limit. */
export const MAX_BROWSER_WAIT_MS = 2 * 60 * 1_000;
const MAX_PROMPT_LENGTH = 1_000_000;

function isString(value: unknown, maxLength = MAX_ID_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPolicy(value: unknown): value is ExecutionPolicy {
  return value === "confirm" || value === "plan" || value === "allow-edits" || value === "autonomous";
}

function isModel(value: unknown): value is AgentModel {
  return value === "fable" || value === "opus" || value === "sonnet" || value === "haiku";
}

function isEffort(value: unknown): value is AgentEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
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
  if (command.type === "cancel") return isString(command.taskId) && isString(command.runId);
  if (command.type === "approval") return isString(command.taskId) && isString(command.runId) && isString(command.approvalId) && typeof command.allow === "boolean";
  if (command.type === "steer") return isString(command.taskId) && isString(command.runId) && isString(command.messageId) && isString(command.prompt, MAX_PROMPT_LENGTH);
  if (command.type === "stop-process") return isString(command.taskId) && isString(command.runId) && isString(command.processId);
  return false;
}

export function isInternalRunCommand(value: unknown): value is InternalStartRunCommand | CancelRunCommand | ApprovalDecisionCommand | SteerRunCommand | StopProcessCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;
  if (command.type === "start") return isStartCommand(command, true);
  return isRunCommand(value);
}

function isStartCommand(command: Record<string, unknown>, internal: boolean) {
  const base = isRunChannel(command.channel) && isString(command.taskId) && isString(command.runId) && isString(command.prompt, MAX_PROMPT_LENGTH) && isString(command.workspaceId) && isPolicy(command.policy) && isModel(command.model) && isEffort(command.effort) && (command.continuation === undefined || isContinuation(command.continuation)) && (command.forkContinuation === undefined || (command.forkContinuation === true && isContinuation(command.continuation)));
  if (!base) return false;
  if (!internal) return !["workspaceRoot", "projectless", "computerUse", "cwd", "folder", "sessionId", "mode", "requestId"].some((key) => key in command);
  return isString(command.workspaceRoot, 4_096) && typeof command.projectless === "boolean" && isComputerUseRunConfig(command.computerUse);
}

export function isAutomationRequest(value: unknown): value is AutomationRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  if (request.type !== "automation.request" || !isString(request.requestId) || !isString(request.taskId)) return false;
  if (request.op === "read" || request.op === "list" || request.op === "delete") return true;
  if (request.op === "save") return isAutomationDraft({ ...(request.draft as object), taskId: request.taskId });
  if (request.op === "update") return isAutomationPatch(request.patch);
  return false;
}

/** The command surface open to callers outside the window. Everything else is the user's alone. */
export function isExternalCommand(value: unknown): value is ExternalCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;
  const named = command.taskId === undefined || isString(command.taskId);
  if (command.type === "task.send") {
    return named
      && (command.projectId === undefined || isString(command.projectId))
      && isString(command.text, MAX_PROMPT_LENGTH)
      && command.attachments === undefined
      && (command.steer === undefined || typeof command.steer === "boolean")
      && (command.worktree === undefined || typeof command.worktree === "boolean")
      /** An id, never a path: the reducer resolves it against the checkouts the app itself made. */
      && (command.worktreeId === undefined || isString(command.worktreeId));
  }
  if (command.type === "task.archive") return isString(command.taskId);
  if (command.type === "run.cancel") return named;
  if (typeof command.type === "string" && command.type.startsWith("browser.")) return isBrowserCommand(command);
  return false;
}

const MAX_URL_LENGTH = 8_192;

export function isBrowserAction(value: unknown): value is BrowserAction {
  if (!value || typeof value !== "object") return false;
  const action = value as Record<string, unknown>;
  if (action.kind === "click") return isString(action.ref);
  if (action.kind === "type") {
    return isString(action.ref)
      && typeof action.text === "string" && action.text.length <= MAX_PROMPT_LENGTH
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
  if (read.op !== "snapshot") return false;
  return (read.tabId === undefined || isString(read.tabId))
    && (read.textLimit === undefined || isCount(read.textLimit))
    && isCount(read.timeoutMs) && read.timeoutMs <= MAX_BROWSER_WAIT_MS;
}

export function isTerminalRead(value: unknown): value is TerminalRead {
  if (!value || typeof value !== "object") return false;
  const read = value as Record<string, unknown>;
  if (read.op === "terminals") return true;
  if (read.op !== "snapshot") return false;
  return (read.terminalId === undefined || isString(read.terminalId))
    && (read.lines === undefined || isCount(read.lines))
    && (read.match === undefined || isString(read.match, 1_000));
}

/** A run drives the browser as itself, so every browser command names the thread that asked. */
function isBrowserCommand(command: Record<string, unknown>) {
  if (!isString(command.taskId)) return false;
  const tabbed = command.tabId === undefined || isString(command.tabId);
  if (command.type === "browser.open") return tabbed && isString(command.url, MAX_URL_LENGTH) && (command.newTab === undefined || typeof command.newTab === "boolean");
  if (command.type === "browser.close-tab" || command.type === "browser.select-tab") return isString(command.tabId);
  if (command.type === "browser.go") return tabbed && (command.delta === 1 || command.delta === -1);
  if (command.type === "browser.reload") return tabbed;
  if (command.type === "browser.act") return tabbed && isBrowserAction(command.action);
  return false;
}

export function isThreadRequest(value: unknown): value is ThreadRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  if (request.type !== "thread.request" || !isString(request.requestId) || !isString(request.taskId)) return false;
  if (request.op === "list") {
    return (request.project === undefined || isString(request.project, 4_096))
      && (request.archived === undefined || typeof request.archived === "boolean")
      && (request.idleForMs === undefined || isCount(request.idleForMs))
      && (request.search === undefined || isString(request.search, 1_000))
      && (request.attachments === undefined || typeof request.attachments === "boolean")
      && (request.limit === undefined || isCount(request.limit));
  }
  if (request.op === "read") return isString(request.threadId) && (request.limit === undefined || isCount(request.limit));
  if (request.op === "wait") return isString(request.threadId) && isCount(request.timeoutMs) && request.timeoutMs <= MAX_THREAD_WAIT_MS;
  if (request.op === "command") return isExternalCommand(request.command);
  if (request.op === "browser") return isBrowserRead(request.read);
  if (request.op === "terminal") return isTerminalRead(request.read);
  return false;
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

export function isRunEvent(value: unknown): value is RunEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if (!isString(event.taskId) || !isString(event.runId) || typeof event.sequence !== "number" || !Number.isSafeInteger(event.sequence) || event.sequence < 1) return false;
  if (event.type === "run.started") return true;
  if (event.type === "run.status") return (event.status === "running" || event.status === "awaiting-approval" || event.status === "succeeded" || event.status === "failed" || event.status === "cancelled") && (event.message === undefined || isString(event.message, 100_000));
  if (event.type === "assistant.delta") return isString(event.messageId) && typeof event.text === "string" && (event.append === undefined || event.append === true);
  if (event.type === "assistant.tail") return isString(event.messageId) && typeof event.text === "string" && event.text.length <= MAX_PROMPT_LENGTH;
  if (event.type === "context.usage") return typeof event.tokens === "number" && Number.isFinite(event.tokens) && event.tokens >= 0 && typeof event.limit === "number" && Number.isFinite(event.limit) && event.limit > 0 && isString(event.model);
  if (event.type === "context.compaction-status") return typeof event.compacting === "boolean" && (event.error === undefined || isString(event.error, 100_000));
  if (event.type === "context.compacted") return (event.trigger === "manual" || event.trigger === "auto") && typeof event.preTokens === "number" && Number.isFinite(event.preTokens) && event.preTokens >= 0 && (event.postTokens === undefined || (typeof event.postTokens === "number" && Number.isFinite(event.postTokens) && event.postTokens >= 0));
  if (event.type === "tool.intent") return isIntent(event.intent);
  if (event.type === "computer-use.setup-required") return true;
  if (event.type === "subagent.started") return isString(event.id) && isString(event.description, 100_000) && (event.agentType === undefined || isString(event.agentType));
  if (event.type === "subagent.progress") return isString(event.id) && isString(event.description, 100_000) && (event.lastToolName === undefined || isString(event.lastToolName)) && (event.summary === undefined || isString(event.summary, 100_000)) && typeof event.totalTokens === "number" && Number.isFinite(event.totalTokens) && event.totalTokens >= 0;
  if (event.type === "subagent.activity") return isString(event.id) && isString(event.activityId) && (event.kind === "text" || event.kind === "tool") && (event.title === undefined || isString(event.title)) && typeof event.text === "string";
  if (event.type === "subagent.finished") return isString(event.id) && (event.status === "completed" || event.status === "failed" || event.status === "stopped") && typeof event.summary === "string";
  if (event.type === "background.changed") return Array.isArray(event.processes) && event.processes.every(isBackgroundProcess);
  if (event.type === "workflow.started") return isString(event.id) && isString(event.name, 100_000) && isString(event.description, 100_000);
  if (event.type === "workflow.progress") {
    return isString(event.id)
      && Array.isArray(event.phases) && event.phases.every(isWorkflowPhase)
      && Array.isArray(event.agents) && event.agents.every(isWorkflowAgent)
      && isCount(event.totalTokens) && isCount(event.totalToolCalls);
  }
  if (event.type === "workflow.finished") return isString(event.id) && (event.status === "completed" || event.status === "failed" || event.status === "stopped") && typeof event.summary === "string";
  if (event.type === "approval.requested") return isString(event.approvalId) && isIntent(event.intent) && isString(event.title) && isString(event.description, 100_000);
  if (event.type === "continuation.updated") return isContinuation(event.continuation);
  if (event.type === "queued.delivered") return isString(event.messageId);
  return false;
}
