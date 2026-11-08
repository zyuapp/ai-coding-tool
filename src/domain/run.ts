import type { EngineId } from "./agent-engine.js";

export const EXECUTION_POLICIES = ["confirm", "plan", "allow-edits", "autonomous", "bypass"] as const;

export type ExecutionPolicy = (typeof EXECUTION_POLICIES)[number];

export function isExecutionPolicy(value: unknown): value is ExecutionPolicy {
  return EXECUTION_POLICIES.some((policy) => policy === value);
}

/** How a mode reads wherever it is named, so one setting means one thing on every screen. */
export const POLICIES: Record<ExecutionPolicy, { label: string; description: string }> = {
  autonomous: { label: "Auto", description: "Only ask for potentially unsafe actions" },
  bypass: { label: "Bypass", description: "Use tools and change files without asking" },
  "allow-edits": { label: "Edits", description: "Apply file edits without asking" },
  confirm: { label: "Confirm", description: "Ask before using tools or changing files" },
  plan: { label: "Plan", description: "Plan the work without doing it" },
};

/** The modes a picker offers, in the order it lists them. Plan is left out because nobody uses it. */
export const POLICY_CHOICES: readonly ExecutionPolicy[] = ["autonomous", "bypass", "allow-edits", "confirm"];

/** How much reasoning a run asks for. Models that do not offer a level fall back to the nearest one they do. */
export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export const DEFAULT_EFFORT: AgentEffort = "high";

/** An engine's own handle on a thread, named by the engine that made it. */
export type Continuation = {
  provider: EngineId;
  value: string;
};

export type ToolIntent = {
  toolId: string;
  name: string;
  input: unknown;
  writePath?: string;
};

export type RunStatus = "running" | "awaiting-approval" | "succeeded" | "failed" | "cancelled";

/** The engine's request failed and it is trying again on its own. `message` says why in the user's terms. */
export type RetryNotice = {
  message: string;
  attempt?: number;
  maxRetries?: number;
};

export type SubagentLiveStatus = "working" | "idle";
export type SubagentTerminalStatus = "completed" | "failed" | "stopped";
export type SubagentStatus = SubagentLiveStatus | SubagentTerminalStatus;

/** Details reported by the provider; absent fields were not supplied, never inferred from the parent. */
export type SubagentMetadata = {
  model?: string;
  effort?: string;
  prompt?: string;
};

/** Provider-neutral updates for one delegated agent, before the owning thread is attached for transport. */
export type SubagentReport =
  | ({ type: "subagent.started"; id: string; description: string; agentType?: string; sessionScoped?: true } & SubagentMetadata)
  | ({ type: "subagent.metadata"; id: string } & SubagentMetadata)
  | { type: "subagent.status"; id: string; status: SubagentLiveStatus; summary?: string }
  | { type: "subagent.progress"; id: string; description: string; agentType?: string; lastToolName?: string; summary?: string; totalTokens: number }
  | { type: "subagent.activity"; id: string; activityId: string; kind: "text" | "tool"; title?: string; text: string }
  | { type: "subagent.finished"; id: string; status: SubagentTerminalStatus; summary: string };

/** Every foldable group of subagents: the sidebar's own list, and one heading per status in the panel. */
export const SUBAGENT_GROUPS = ["sidebar", "working", "idle", "failed", "stopped", "completed"] as const;

export type SubagentGroup = (typeof SUBAGENT_GROUPS)[number];

export type SubagentGroups = Record<SubagentGroup, boolean>;

/** Every group unfolded, which is how the app starts before the user folds anything. */
export const OPEN_SUBAGENT_GROUPS: SubagentGroups = { sidebar: true, working: true, idle: true, failed: true, stopped: true, completed: true };

export function isSubagentGroup(value: unknown): value is SubagentGroup {
  return SUBAGENT_GROUPS.includes(value as SubagentGroup);
}

export type SubagentActivity = {
  id: string;
  kind: "text" | "tool";
  title?: string;
  text: string;
  at: number;
};

export type Subagent = SubagentMetadata & {
  id: string;
  description: string;
  agentType?: string;
  /** A session-owned agent can continue after the parent run returns. */
  sessionScoped?: true;
  status: SubagentStatus;
  /** Set from the moment a stop is asked for until the subagent stops working. */
  stopping?: true;
  lastToolName?: string;
  summary?: string;
  totalTokens?: number;
  startedAt: number;
  finishedAt?: number;
  activity: SubagentActivity[];
};

export function subagentStatusLabel(status: SubagentStatus) {
  return { working: "Working", idle: "Idle", completed: "Completed", failed: "Failed", stopped: "Stopped" }[status];
}

/** One steady line per subagent: what it is doing now, or what it came back with. */
export function subagentLine(subagent: Subagent) {
  if (subagent.status === "working") return subagent.lastToolName ? `Using ${subagent.lastToolName}` : "Working";
  return subagent.summary?.split("\n")[0] ?? subagentStatusLabel(subagent.status);
}

/** Failures first, then the work still going: a session with a thousand subagents is read from the top. */
const SUBAGENT_STATUS_RANK: Record<SubagentStatus, number> = { failed: 0, working: 1, idle: 2, stopped: 3, completed: 4 };

export function orderSubagents(subagents: Subagent[]) {
  return [...subagents].sort((left, right) => SUBAGENT_STATUS_RANK[left.status] - SUBAGENT_STATUS_RANK[right.status]);
}

/** What a thread session keeps running between agent turns: a shell, or a watch feeding it events. */
export type BackgroundProcessKind = "shell" | "monitor";

/**
 * A process owned by one thread session. The provider owns the set and republishes it whole on
 * every change, so the process can outlive the turn that started it but not its session.
 */
export type BackgroundProcess = {
  id: string;
  kind: BackgroundProcessKind;
  description: string;
  /** Set from the moment a stop is asked for until the run stops reporting the process. */
  stopping?: boolean;
};

export function processLabel(process: BackgroundProcess) {
  if (process.stopping) return "Stopping";
  return process.kind === "shell" ? "Shell" : "Monitor";
}
