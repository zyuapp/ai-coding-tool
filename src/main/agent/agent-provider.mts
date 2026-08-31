import type { BackgroundReport, ClaudeRunSettings, ComputerUseRunConfig, RunChannel, RunOperation, WorkflowReport } from "../../contracts/ipc.js";
import type { BrowserRead, BrowserReadResult, BrowserWrite, ExternalCommand, FindingReport, FindingResult, TerminalRead, TerminalReadResult, ThreadCommandResult, ThreadListQuery, ThreadSummary, ThreadTranscript, ThreadWaitResult } from "../../contracts/threads.js";
import type { AutomationDraft, AutomationPatch, AutomationView } from "../../domain/automation.js";
import type { AgentEngine, AgentModel } from "../../domain/agent-engine.js";
import type { AgentEffort, Continuation, ExecutionPolicy, SubagentReport, ToolIntent } from "../../domain/run.js";

/** The window's workspace, reachable from the run: reads are projections, writes are commands. */
export type ThreadBridge = {
  list(query: ThreadListQuery): Promise<ThreadSummary[]>;
  read(threadId: string, limit?: number): Promise<ThreadTranscript>;
  wait(threadId: string, timeoutMs: number): Promise<ThreadWaitResult>;
  command(command: ExternalCommand): Promise<ThreadCommandResult>;
};

/**
 * What a scheduled run says about itself, answered by the window that keeps it. Scoped to the running
 * thread: a run reports on its own thread or on none at all.
 */
export type FindingBridge = {
  notify(report: FindingReport): Promise<FindingResult>;
  nothingToReport(checked: string): Promise<FindingResult>;
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

/** Scoped to the running thread, so a run can only reach its own automation. */
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
  /** `model` is the id the engine reported on the wire, not an AgentModel. */
  | { type: "usage"; tokens: number; limit: number; model: string }
  | { type: "compaction-status"; compacting: boolean; error?: string }
  | { type: "compaction"; trigger: "manual" | "auto"; preTokens: number; postTokens?: number }
  | { type: "tool"; intent: ToolIntent }
  | { type: "computer-use.setup-required" }
  | { type: "continuation"; continuation: Continuation }
  /** The continuation the run was given resumes nothing any more, so the thread has to start over. */
  | { type: "continuation-lost" }
  | { type: "steered"; messageId: string }
  | SubagentReport;

/**
 * A turn the agent started itself, after the run that seeded the session had ended. A workflow
 * reporting what it produced is one, and so is a tool call from work that outlived its run.
 */
export type AgentTurn = {
  emit(event: ProviderEvent): void;
  authorize(intent: ToolIntent): Promise<ToolDecision>;
  /** It is a run like any other, so the user can steer into it, and what they send has to be taken. */
  steering: SteerQueue;
  end(result: ProviderResult): void;
};

/** A plain denial reads as the user's; one that carries wording says why, for a run with no user. */
export type ToolDecision = "allow" | "deny" | { deny: string };

export type ProviderRunInput = {
  channel: RunChannel;
  /** Which thread is asking, which is what a warm session belongs to. */
  taskId: string;
  title: string;
  prompt: string;
  workspaceRoot: string;
  projectless: boolean;
  computerUse: ComputerUseRunConfig;
  policy: ExecutionPolicy;
  engine: AgentEngine;
  model: AgentModel;
  effort: AgentEffort;
  operation?: RunOperation;
  /** Read by the Claude engine alone; any other engine leaves it unopened. */
  claude?: ClaudeRunSettings;
  continuation?: Continuation;
  forkContinuation?: boolean;
  automations?: AutomationBridge;
  /** Only alongside `automations`: the two tools that use it live on the automation surface. */
  findings?: FindingBridge;
  threads?: ThreadBridge;
  browser?: BrowserBridge;
  terminal?: TerminalBridge;
  steering: SteerQueue;
  abortController: AbortController;
  authorize: (intent: ToolIntent) => Promise<ToolDecision>;
  emit: (event: ProviderEvent) => void;
  /** Kept apart from `emit`: a workflow reports to the thread, and outlasts the run that started it. */
  reportWorkflow: (report: WorkflowReport) => void;
  /** Kept apart from `emit` for the same reason: a shell or a monitor outlives the run that started it. */
  reportBackground: (report: BackgroundReport) => void;
  /** A child agent belongs to the thread and may keep reporting after the parent run settles. */
  reportSubagent: (report: SubagentReport) => void;
  /** A native goal belongs to the thread and can change between model turns. */
  reportGoal: (report: import("../../contracts/ipc.js").GoalReport) => void;
  /** Opens a run for a turn nobody asked for. Null when the thread already has a run of its own. */
  beginAgentTurn: () => AgentTurn | null;
};

export type ProviderResult = {
  status: "succeeded" | "failed" | "cancelled";
  message?: string;
};

/** The engine's own handle on the thread; another engine's continuation means nothing to it. */
export function continuationOf(input: ProviderRunInput) {
  return input.continuation?.provider === input.engine ? input.continuation.value : undefined;
}

export interface AgentProvider {
  execute(input: ProviderRunInput): Promise<ProviderResult>;
  /** Kills one background process of the thread's session, whether or not a run is going. */
  stopProcess(taskId: string, processId: string): boolean;
  /** Offers the thread's title to the engine's own record of it. Engines that keep none say so. */
  labelThread(taskId: string, title: string): boolean;
}
