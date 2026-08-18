import type { ComputerUseRunConfig, RunChannel } from "../../contracts/ipc.js";
import type { ExternalCommand, ThreadCommandResult, ThreadListQuery, ThreadSummary, ThreadTranscript } from "../../contracts/threads.js";
import type { AutomationDraft, AutomationPatch, AutomationView } from "../../domain/automation.js";
import type { AgentEffort, AgentModel, Continuation, ExecutionPolicy, SubagentStatus, ToolIntent } from "../../domain/run.js";

/** The window's workspace, reachable from the run: reads are projections, writes are commands. */
export type ThreadBridge = {
  list(query: ThreadListQuery): Promise<ThreadSummary[]>;
  read(threadId: string, limit?: number): Promise<ThreadTranscript>;
  command(command: ExternalCommand): Promise<ThreadCommandResult>;
};

/** Scoped to the running task, so a run can only reach its own automation. */
export type AutomationBridge = {
  read(): Promise<AutomationView | null>;
  list(): Promise<AutomationView[]>;
  save(draft: Omit<AutomationDraft, "taskId">): Promise<AutomationView>;
  update(patch: AutomationPatch): Promise<AutomationView>;
  remove(): Promise<boolean>;
};

export type SteerMessage = {
  messageId: string;
  prompt: string;
};

/** Messages the user pushed into a run that had already started. Resolves null once the run is over. */
export type SteerQueue = {
  next(): Promise<SteerMessage | null>;
};

export type ProviderEvent =
  | { type: "assistant"; messageId: string; text: string; append?: boolean }
  /** The buffered remainder that has not formed a complete block yet, so the UI can type it out. */
  | { type: "assistant-tail"; messageId: string; text: string }
  | { type: "usage"; tokens: number; limit: number; model: string }
  | { type: "compaction-status"; compacting: boolean; error?: string }
  | { type: "compaction"; trigger: "manual" | "auto"; preTokens: number; postTokens?: number }
  | { type: "tool"; intent: ToolIntent }
  | { type: "computer-use.setup-required" }
  | { type: "continuation"; continuation: Continuation }
  | { type: "steered"; messageId: string }
  | { type: "subagent.started"; id: string; description: string; agentType?: string }
  | { type: "subagent.progress"; id: string; description: string; lastToolName?: string; summary?: string; totalTokens: number }
  | { type: "subagent.activity"; id: string; activityId: string; kind: "text" | "tool"; title?: string; text: string }
  | { type: "subagent.finished"; id: string; status: Exclude<SubagentStatus, "working">; summary: string };

export type ProviderRunInput = {
  channel: RunChannel;
  prompt: string;
  workspaceRoot: string;
  projectless: boolean;
  computerUse: ComputerUseRunConfig;
  policy: ExecutionPolicy;
  model: AgentModel;
  effort: AgentEffort;
  continuation?: Continuation;
  forkContinuation?: boolean;
  automations?: AutomationBridge;
  threads?: ThreadBridge;
  steering: SteerQueue;
  abortController: AbortController;
  authorize: (intent: ToolIntent) => Promise<"allow" | "deny">;
  emit: (event: ProviderEvent) => void;
};

export type ProviderResult = {
  status: "succeeded" | "failed" | "cancelled";
  message?: string;
};

export interface AgentProvider {
  execute(input: ProviderRunInput): Promise<ProviderResult>;
}
