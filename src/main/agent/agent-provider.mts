import type { ComputerUseRunConfig, RunChannel } from "../../contracts/ipc.js";
import type { BrowserRead, BrowserReadResult, BrowserWrite, ExternalCommand, TerminalRead, TerminalReadResult, ThreadCommandResult, ThreadListQuery, ThreadSummary, ThreadTranscript, ThreadWaitResult } from "../../contracts/threads.js";
import type { AutomationDraft, AutomationPatch, AutomationView } from "../../domain/automation.js";
import type { AgentEffort, AgentModel, BackgroundProcess, Continuation, ExecutionPolicy, SubagentStatus, ToolIntent } from "../../domain/run.js";
import type { WorkflowAgent, WorkflowPhase, WorkflowStatus } from "../../domain/workflow.js";

/** The window's workspace, reachable from the run: reads are projections, writes are commands. */
export type ThreadBridge = {
  list(query: ThreadListQuery): Promise<ThreadSummary[]>;
  read(threadId: string, limit?: number): Promise<ThreadTranscript>;
  wait(threadId: string, timeoutMs: number): Promise<ThreadWaitResult>;
  command(command: ExternalCommand): Promise<ThreadCommandResult>;
};

/** The browser panel, driven as the thread that is running: writes are commands, reads are the page. */
export type BrowserBridge = {
  command(write: BrowserWrite): Promise<void>;
  read(read: BrowserRead): Promise<BrowserReadResult>;
};

/** The terminal panel, which a run may only read: the shell is the user's, and a run has Bash of its own. */
export type TerminalBridge = {
  read(read: TerminalRead): Promise<TerminalReadResult>;
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
  | { type: "subagent.finished"; id: string; status: Exclude<SubagentStatus, "working">; summary: string }
  /** The run's whole set of background processes, republished on every change. */
  | { type: "background.changed"; processes: BackgroundProcess[] }
  | { type: "workflow.started"; id: string; name: string; description: string }
  /** A dynamic workflow's whole tree, republished on every change. */
  | { type: "workflow.progress"; id: string; phases: WorkflowPhase[]; agents: WorkflowAgent[]; totalTokens: number; totalToolCalls: number }
  | { type: "workflow.finished"; id: string; status: Exclude<WorkflowStatus, "running">; summary: string };

/** The levers a run only has once it is live, handed back so control can reach it mid-run. */
export type RunControls = {
  stopProcess(processId: string): Promise<void>;
};

export type ProviderRunInput = {
  channel: RunChannel;
  /** Which thread is asking, which is what a warm session belongs to. */
  taskId: string;
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
  browser?: BrowserBridge;
  terminal?: TerminalBridge;
  steering: SteerQueue;
  abortController: AbortController;
  attach: (controls: RunControls) => void;
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
