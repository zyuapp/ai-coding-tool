export type ExecutionPolicy = "confirm" | "plan" | "allow-edits" | "autonomous";
export type AgentModel = "fable" | "opus" | "sonnet" | "haiku";
export const DEFAULT_MODEL: AgentModel = "opus";

/** How much reasoning a run asks for. Models that do not offer a level fall back to the nearest one they do. */
export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max";
export const DEFAULT_EFFORT: AgentEffort = "high";

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

/** What a background task is: a shell the run left running, or a watch feeding it events. */
export type BackgroundProcessKind = "shell" | "monitor";

/**
 * A process the run started and left running. The agent process owns the set and republishes it
 * whole on every change, so this record only lives as long as the run that reported it.
 */
export type BackgroundProcess = {
  id: string;
  kind: BackgroundProcessKind;
  description: string;
  /** Set from the moment a stop is asked for until the run stops reporting the process. */
  stopping?: boolean;
};

export type Run = {
  taskId: string;
  runId: string;
  status: RunStatus;
  sequence: number;
};

/** Runs always request the widest context a model offers; only Haiku stops short of 1M. */
export function contextWindowLimit(model: AgentModel) {
  return model === "haiku" ? 200_000 : 1_000_000;
}
