import type { AgentModel, ContextWindow, Continuation, ExecutionPolicy, RunStatus, SubagentStatus, ToolIntent } from "../domain/run.js";
import type { Project, Task, TaskMessage, TaskStoreData } from "../domain/task.js";
import type { WorkspaceRecord } from "../domain/workspace.js";

export type WorkspaceId = string;
export type RunChannel = "main" | "side";

export type PersistedTask = Omit<Task, "messages">;

export type TaskStoreDelta = {
  tasks: Array<{ task: PersistedTask; messages: Array<{ index: number; message: TaskMessage }> }>;
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
  contextWindow: ContextWindow;
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

export type RunCommand = StartRunCommand | CancelRunCommand | ApprovalDecisionCommand;

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
  loadTaskStore(): Promise<TaskStoreData | null>;
  persistTaskStore(delta: TaskStoreDelta): Promise<void>;
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
  | (RunEventBase & { type: "continuation.updated"; continuation: Continuation });

const MAX_ID_LENGTH = 256;
const MAX_PROMPT_LENGTH = 1_000_000;

function isString(value: unknown, maxLength = MAX_ID_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isPolicy(value: unknown): value is ExecutionPolicy {
  return value === "confirm" || value === "plan" || value === "allow-edits" || value === "autonomous";
}

function isModel(value: unknown): value is AgentModel {
  return value === "default" || value === "sonnet" || value === "opus" || value === "haiku";
}

function isContextWindow(value: unknown): value is ContextWindow {
  return value === "default" || value === "1m";
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
  return false;
}

export function isInternalRunCommand(value: unknown): value is InternalStartRunCommand | CancelRunCommand | ApprovalDecisionCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;
  if (command.type === "start") return isStartCommand(command, true);
  return isRunCommand(value);
}

function isStartCommand(command: Record<string, unknown>, internal: boolean) {
  const base = isRunChannel(command.channel) && isString(command.taskId) && isString(command.runId) && isString(command.prompt, MAX_PROMPT_LENGTH) && isString(command.workspaceId) && isPolicy(command.policy) && isModel(command.model) && isContextWindow(command.contextWindow) && (command.continuation === undefined || isContinuation(command.continuation)) && (command.forkContinuation === undefined || (command.forkContinuation === true && command.channel === "side" && isContinuation(command.continuation)));
  if (!base) return false;
  if (!internal) return !["workspaceRoot", "projectless", "computerUse", "cwd", "folder", "sessionId", "mode", "requestId"].some((key) => key in command);
  return isString(command.workspaceRoot, 4_096) && typeof command.projectless === "boolean" && isComputerUseRunConfig(command.computerUse);
}

export function isRunEvent(value: unknown): value is RunEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if (!isString(event.taskId) || !isString(event.runId) || typeof event.sequence !== "number" || !Number.isSafeInteger(event.sequence) || event.sequence < 1) return false;
  if (event.type === "run.started") return true;
  if (event.type === "run.status") return (event.status === "running" || event.status === "awaiting-approval" || event.status === "succeeded" || event.status === "failed" || event.status === "cancelled") && (event.message === undefined || isString(event.message, 100_000));
  if (event.type === "assistant.delta") return isString(event.messageId) && typeof event.text === "string" && (event.append === undefined || event.append === true);
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
  return false;
}
