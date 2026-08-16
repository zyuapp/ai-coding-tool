import type { AgentModel, ContextWindow, Continuation, ExecutionPolicy, RunStatus, ToolIntent } from "../domain/run.js";
import type { WorkspaceRecord } from "../domain/workspace.js";

export type WorkspaceId = string;

export type StartRunCommand = {
  type: "start";
  taskId: string;
  runId: string;
  prompt: string;
  workspaceId: WorkspaceId;
  policy: ExecutionPolicy;
  model: AgentModel;
  contextWindow: ContextWindow;
  continuation?: Continuation;
};

export type InternalStartRunCommand = StartRunCommand & {
  workspaceRoot: string;
  projectless: boolean;
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
  send(command: RunCommand): void;
  onAgentEvent(listener: (event: RunEvent) => void): () => void;
  changedFiles(workspaceId: WorkspaceId): Promise<ChangedFilesResult>;
};

export type ChangedFilesResult =
  | { status: "available"; files: string[] }
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
  | (RunEventBase & { type: "assistant.delta"; messageId: string; text: string })
  | (RunEventBase & { type: "context.usage"; tokens: number; limit: number; model: string })
  | (RunEventBase & { type: "tool.intent"; intent: ToolIntent })
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

function isContinuation(value: unknown): value is Continuation {
  return Boolean(value && typeof value === "object" && isString((value as Record<string, unknown>).provider) && isString((value as Record<string, unknown>).value, 100_000));
}

function isIntent(value: unknown): value is ToolIntent {
  if (!value || typeof value !== "object") return false;
  const intent = value as Record<string, unknown>;
  return isString(intent.toolId) && isString(intent.name) && (intent.writePath === undefined || typeof intent.writePath === "string");
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
  const base = isString(command.taskId) && isString(command.runId) && isString(command.prompt, MAX_PROMPT_LENGTH) && isString(command.workspaceId) && isPolicy(command.policy) && isModel(command.model) && isContextWindow(command.contextWindow) && (command.continuation === undefined || isContinuation(command.continuation));
  if (!base) return false;
  if (!internal) return !["workspaceRoot", "projectless", "cwd", "folder", "sessionId", "mode", "requestId"].some((key) => key in command);
  return isString(command.workspaceRoot, 4_096) && typeof command.projectless === "boolean";
}

export function isRunEvent(value: unknown): value is RunEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if (!isString(event.taskId) || !isString(event.runId) || typeof event.sequence !== "number" || !Number.isSafeInteger(event.sequence) || event.sequence < 1) return false;
  if (event.type === "run.started") return true;
  if (event.type === "run.status") return (event.status === "running" || event.status === "awaiting-approval" || event.status === "succeeded" || event.status === "failed" || event.status === "cancelled") && (event.message === undefined || isString(event.message, 100_000));
  if (event.type === "assistant.delta") return isString(event.messageId) && typeof event.text === "string";
  if (event.type === "context.usage") return typeof event.tokens === "number" && Number.isFinite(event.tokens) && event.tokens >= 0 && typeof event.limit === "number" && Number.isFinite(event.limit) && event.limit > 0 && isString(event.model);
  if (event.type === "tool.intent") return isIntent(event.intent);
  if (event.type === "approval.requested") return isString(event.approvalId) && isIntent(event.intent) && isString(event.title) && isString(event.description, 100_000);
  if (event.type === "continuation.updated") return isContinuation(event.continuation);
  return false;
}
