import type { ComputerUseRunConfig, RunChannel } from "../../contracts/ipc.js";
import type { AgentModel, ContextWindow, Continuation, ExecutionPolicy, SubagentStatus, ToolIntent } from "../../domain/run.js";

export type ProviderEvent =
  | { type: "assistant"; messageId: string; text: string }
  | { type: "usage"; tokens: number; limit: number; model: string }
  | { type: "compaction-status"; compacting: boolean; error?: string }
  | { type: "compaction"; trigger: "manual" | "auto"; preTokens: number; postTokens?: number }
  | { type: "tool"; intent: ToolIntent }
  | { type: "computer-use.setup-required" }
  | { type: "continuation"; continuation: Continuation }
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
  contextWindow: ContextWindow;
  continuation?: Continuation;
  forkContinuation?: boolean;
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
