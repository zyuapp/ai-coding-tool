import type { Continuation, ExecutionPolicy, ToolIntent } from "../../domain/run.js";

export type ProviderEvent =
  | { type: "assistant"; messageId: string; text: string }
  | { type: "tool"; intent: ToolIntent }
  | { type: "continuation"; continuation: Continuation };

export type ProviderRunInput = {
  prompt: string;
  workspaceRoot: string;
  projectless: boolean;
  policy: ExecutionPolicy;
  continuation?: Continuation;
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
