export type ExecutionPolicy = "confirm" | "plan" | "allow-edits" | "autonomous";
export type AgentModel = "default" | "sonnet" | "opus" | "haiku";
export type ContextWindow = "default" | "1m";

export type Continuation = {
  provider: string;
  value: string;
};

export type ToolIntent = {
  toolId: string;
  name: string;
  input: unknown;
  writePath?: string;
};

export type RunStatus = "running" | "awaiting-approval" | "succeeded" | "failed" | "cancelled";

export type Run = {
  taskId: string;
  runId: string;
  status: RunStatus;
  sequence: number;
};
