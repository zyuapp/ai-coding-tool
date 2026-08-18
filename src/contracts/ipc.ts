import { isAutomationDraft, isAutomationPatch, type AutomationDraft, type AutomationPatch, type AutomationRunStatus, type AutomationView } from "../domain/automation.js";
import type { ExternalCommand, ThreadRequest, ThreadResponse } from "./threads.js";
import type { AgentEffort, AgentModel, Continuation, ExecutionPolicy, RunStatus, SubagentStatus, ToolIntent } from "../domain/run.js";
import type { Project, Task, TaskMessage, TaskStoreData } from "../domain/task.js";
import type { WorkspaceRecord } from "../domain/workspace.js";

export type WorkspaceId = string;
export type RunChannel = "main" | "side";

export type PersistedTask = Omit<Task, "messages">;

export type TaskStoreDelta = {
  tasks: Array<{ task: PersistedTask; messages: Array<{ index: number; message: TaskMessage }> }>;
  removedTasks?: string[];
  projects?: Project[];
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

export type RunCommand = StartRunCommand | CancelRunCommand | ApprovalDecisionCommand | SteerRunCommand;

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
  projectlessWorkspace(): Promise<WorkspaceRecord>;
  commands(workspaceId: WorkspaceId): Promise<CommandDiscoveryResult>;
  computerUsePermissions(): Promise<ComputerUsePermissions>;
  enableComputerUse(permission: ComputerUsePermission): Promise<ComputerUsePermissions>;
  restartForComputerUse(): void;
  send(command: RunCommand): void;
  onAgentEvent(listener: (event: RunEvent) => void): () => void;
  changedFiles(workspaceId: WorkspaceId): Promise<ChangedFilesResult>;
  /** Writes base64 PNG bytes into the attachments directory and resolves with the absolute path. */
  saveAttachment(data: string): Promise<string>;
  /** Names a thread from its first message, off the agent's run path. Null when no name came back. */
  suggestTaskTitle(text: string): Promise<string | null>;
  loadTaskStore(): Promise<TaskStoreData | null>;
  persistTaskStore(delta: TaskStoreDelta): Promise<void>;
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
};

export type AvailableCommand = {
  name: string;
  description: string;
  argumentHint: string;
  aliases?: string[];
};

export type CommandDiscoveryResult =
  | { status: "available"; commands: AvailableCommand[] }
  | { status: "error"; message: string };

export type ChangedFilesResult =
  | { status: "available"; files: string[]; branch: string | null; additions: number; deletions: number }
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
  return false;
}

export function isInternalRunCommand(value: unknown): value is InternalStartRunCommand | CancelRunCommand | ApprovalDecisionCommand | SteerRunCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;
  if (command.type === "start") return isStartCommand(command, true);
  return isRunCommand(value);
}

function isStartCommand(command: Record<string, unknown>, internal: boolean) {
  const base = isRunChannel(command.channel) && isString(command.taskId) && isString(command.runId) && isString(command.prompt, MAX_PROMPT_LENGTH) && isString(command.workspaceId) && isPolicy(command.policy) && isModel(command.model) && isEffort(command.effort) && (command.continuation === undefined || isContinuation(command.continuation)) && (command.forkContinuation === undefined || (command.forkContinuation === true && command.channel === "side" && isContinuation(command.continuation)));
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
      && (command.steer === undefined || typeof command.steer === "boolean");
  }
  if (command.type === "task.archive" || command.type === "task.restore") return isString(command.taskId);
  if (command.type === "task.rename") return isString(command.taskId) && isString(command.title, 1_000);
  if (command.type === "task.set-policy") return named && isPolicy(command.policy);
  if (command.type === "task.set-model") return named && isModel(command.model);
  if (command.type === "task.set-effort") return named && isEffort(command.effort);
  if (command.type === "run.cancel") return named;
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
      && (request.limit === undefined || isCount(request.limit));
  }
  if (request.op === "read") return isString(request.threadId) && (request.limit === undefined || isCount(request.limit));
  if (request.op === "command") return isExternalCommand(request.command);
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
  if (event.type === "approval.requested") return isString(event.approvalId) && isIntent(event.intent) && isString(event.title) && isString(event.description, 100_000);
  if (event.type === "continuation.updated") return isContinuation(event.continuation);
  if (event.type === "queued.delivered") return isString(event.messageId);
  return false;
}
