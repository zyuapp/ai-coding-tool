import type { BackgroundReport, ComputerUseRunConfig, RunChannel, WorkflowReport } from "../../contracts/ipc.js";
import type { BrowserRead, BrowserReadResult, BrowserWrite, ExternalCommand, FindingReport, FindingResult, TerminalRead, TerminalReadResult, ThreadCommandResult, ThreadListQuery, ThreadSummary, ThreadTranscript, ThreadWaitResult } from "../../contracts/threads.js";
import type { AutomationDraft, AutomationPatch, AutomationView } from "../../domain/automation.js";
import type { AgentEngine, AgentModel } from "../../domain/agent-engine.js";
import type { AgentEffort, Continuation, ExecutionPolicy, SubagentStatus, ToolIntent } from "../../domain/run.js";

/** The window's workspace, reachable from the run: reads are projections, writes are commands. */
export type ThreadBridge = {
  list(query: ThreadListQuery): Promise<ThreadSummary[]>;
  read(threadId: string, limit?: number): Promise<ThreadTranscript>;
  wait(threadId: string, timeoutMs: number): Promise<ThreadWaitResult>;
  command(command: ExternalCommand): Promise<ThreadCommandResult>;
};

/**
 * What a scheduled run says about itself, answered by the window that keeps it. Scoped to the running
 * task: a run reports on its own thread or on none at all.
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
  prompt: string;
  workspaceRoot: string;
  projectless: boolean;
  computerUse: ComputerUseRunConfig;
  policy: ExecutionPolicy;
  engine: AgentEngine;
  model: AgentModel;
  effort: AgentEffort;
  /** The Claude Code output style the run answers in, layered over the user's own settings. */
  outputStyle?: string;
  /** Whether the run also reaches the user's own Chrome through the Claude in Chrome extension. */
  chromeBrowser?: true;
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
  /** Opens a run for a turn nobody asked for. Null when the thread already has a run of its own. */
  beginAgentTurn: () => AgentTurn | null;
};

export type ProviderResult = {
  status: "succeeded" | "failed" | "cancelled";
  message?: string;
};

export interface AgentProvider {
  execute(input: ProviderRunInput): Promise<ProviderResult>;
  /** Kills one background process of the thread's session, whether or not a run is going. */
  stopProcess(taskId: string, processId: string): boolean;
}
