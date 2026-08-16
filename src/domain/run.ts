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

export type SubagentStatus = "working" | "completed" | "failed" | "stopped";

export type SubagentActivity = {
  id: string;
  kind: "text" | "tool";
  title?: string;
  text: string;
  at: number;
};

export type Subagent = {
  id: string;
  description: string;
  agentType?: string;
  status: SubagentStatus;
  lastToolName?: string;
  summary?: string;
  totalTokens?: number;
  startedAt: number;
  finishedAt?: number;
  activity: SubagentActivity[];
};

export type Run = {
  taskId: string;
  runId: string;
  status: RunStatus;
  sequence: number;
};
