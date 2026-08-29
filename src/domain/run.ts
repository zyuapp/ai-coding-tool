export type ExecutionPolicy = "confirm" | "plan" | "allow-edits" | "autonomous" | "bypass";

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

export type SubagentLiveStatus = "working" | "idle";
export type SubagentTerminalStatus = "completed" | "failed" | "stopped";
export type SubagentStatus = SubagentLiveStatus | SubagentTerminalStatus;

/** Provider-neutral updates for one delegated agent, before the owning thread is attached for transport. */
export type SubagentReport =
  | { type: "subagent.started"; id: string; description: string; agentType?: string; sessionScoped?: true }
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

export type Subagent = {
  id: string;
  description: string;
  agentType?: string;
  /** A session-owned agent can continue after the parent run returns. */
  sessionScoped?: true;
  status: SubagentStatus;
  lastToolName?: string;
  summary?: string;
  totalTokens?: number;
  startedAt: number;
  finishedAt?: number;
  activity: SubagentActivity[];
};

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

export type Run = {
  taskId: string;
  runId: string;
  status: RunStatus;
  sequence: number;
};
