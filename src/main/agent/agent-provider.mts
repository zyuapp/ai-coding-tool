import type { QuestionAnswers, QuestionRequest } from "../../domain/agent-question.js";
import type { BackgroundReport, ComputerUseRunConfig, RunChannel, RunOperation, WorkflowReport } from "../../contracts/ipc.js";
import type { CoordinationRole } from "../../domain/coordination.js";
import type { AgentEngine, AgentModel } from "../../domain/agent-engine.js";
import type { AgentEffort, Continuation, ExecutionPolicy, RetryNotice, SubagentReport, ToolIntent } from "../../domain/run.js";
import type { UsageLimit } from "../../domain/usage-limit.js";
import type { AutomationBridge, FindingBridge } from "../tools/automation.mjs";
import type { BrowserBridge } from "../tools/browser.mjs";
import type { CoordinationBridge } from "../tools/coordination.mjs";
import type { SimulatorBridge } from "../tools/simulator.mjs";
import type { TerminalBridge } from "../tools/terminal.mjs";
import type { ThreadBridge } from "../tools/threads.mjs";

export type SteerMessage = {
  messageId: string;
  prompt: string;
};

/** Messages the user pushed into a run that had already started. Resolves null once the run is over. */
export type SteerQueue = {
  next(): Promise<SteerMessage | null>;
};

export type ProviderEvent =
  | { type: "assistant"; messageId: string; text: string; append?: boolean; artifact?: true }
  /** The buffered remainder that has not formed a complete block yet, so the UI can type it out. */
  | { type: "assistant-tail"; messageId: string; text: string }
  /** `model` is the id the engine reported on the wire, not an AgentModel. */
  | { type: "usage"; tokens: number; limit: number; model: string }
  /** Tokens a model response spent, input and output, beyond what an earlier event already counted for it. */
  | { type: "spend"; tokens: number }
  | { type: "compaction-status"; compacting: boolean; error?: string }
  | ({ type: "retry" } & RetryNotice)
  | { type: "compaction"; trigger: "manual" | "auto"; preTokens: number; postTokens?: number }
  | { type: "tool"; intent: ToolIntent }
  | { type: "computer-use.setup-required" }
  | { type: "continuation"; continuation: Continuation }
  /** The continuation the run was given resumes nothing any more, so the thread has to start over. */
  | { type: "continuation-lost" }
  | { type: "steered"; messageId: string }
  | { type: "steer-failed"; messageId: string; message: string }
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

/** What the agent is told of a denial, which every engine words the same. */
export function denialReason(decision: Exclude<ToolDecision, "allow">) {
  return typeof decision === "object" ? decision.deny : "The user denied this action.";
}

export type ProviderRunInput = {
  /** Null means the request expired; aborting the signal withdraws its unanswered questions. */
  askQuestion: (request: QuestionRequest, signal?: AbortSignal) => Promise<QuestionAnswers | null>;
  channel: RunChannel;
  /** Which thread is asking, which is what a warm session belongs to. */
  taskId: string;
  title: string;
  prompt: string;
  workspaceRoot: string;
  /** Set for a member working in a checkout of its own: the project's checkout, which is the user's to change. */
  projectRoot?: string;
  projectless: boolean;
  computerUse: ComputerUseRunConfig;
  policy: ExecutionPolicy;
  engine: AgentEngine;
  model: AgentModel;
  effort: AgentEffort;
  /** Read only by an engine whose capabilities include fast mode. Absent means standard speed. */
  fastMode?: boolean;
  operation?: RunOperation;
  /** Read only by an engine whose capabilities include driving Chrome. */
  chromeBrowser?: true;
  continuation?: Continuation;
  forkContinuation?: boolean;
  /** The run starts a session of its own even where the thread has a warm one it could take. */
  freshSession?: true;
  automations?: AutomationBridge;
  /** Only alongside `automations`: the two tools that use it live on the automation surface. */
  findings?: FindingBridge;
  threads?: ThreadBridge;
  /** The part the run plays beside a coordinator, and the tools that come with it. */
  coordinationRole?: CoordinationRole;
  coordination?: CoordinationBridge;
  browser?: BrowserBridge;
  simulator?: SimulatorBridge;
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
  /** Set on a failure caused by the account reaching its plan's usage limit. */
  limit?: UsageLimit;
};

/** The handle a continuation holds for `engine`; another engine's continuation means nothing to it. */
export function handleFor(continuation: Continuation | undefined, engine: AgentEngine) {
  return continuation?.provider === engine ? continuation.value : undefined;
}

/** The run's engine's own handle on the thread. */
export function continuationOf(input: ProviderRunInput) {
  return handleFor(input.continuation, input.engine);
}

export interface AgentProvider {
  execute(input: ProviderRunInput): Promise<ProviderResult>;
  /** Kills one background process of the thread's session, whether or not a run is going. */
  stopProcess(taskId: string, processId: string): boolean;
  /** Offers the thread's title to the engine's own record of it. Engines that keep none say so. */
  labelThread(taskId: string, title: string): boolean;
  /** Files the thread away in the engine's own record of it, or brings it back. Engines that keep none say so. */
  archiveThread(taskId: string, continuation: Continuation | undefined, archived: boolean): boolean;
  /**
   * Lets the thread's session go, once its turn has answered, when it was built for a coordination
   * role the thread no longer has: it holds that role's tools, so it may not act for the thread again.
   */
  retireOutOfRole(taskId: string, role: CoordinationRole | undefined): void;
}
