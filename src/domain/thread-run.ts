import { isAgentModel, type AgentModel } from "./agent-engine.js";
import type { RunStatus } from "./run.js";

export type ChangeSnapshot = {
  files: string[];
  capturedAt: number;
};

export type ContinuationStatus = "none" | "available" | "invalid";

/** How the thread's newest settled run ended. Whether it is blocked on an approval lives in `activeRuns`. */
export type ThreadOutcome = "finished" | "failed" | "stopped";

/** How a run that reached its end ended, or null while it has yet to. A stopped run ended too. */
export function runOutcome(status: RunStatus): ThreadOutcome | null {
  if (status === "succeeded") return "finished";
  if (status === "failed") return "failed";
  return status === "cancelled" ? "stopped" : null;
}

export type ContextUsage = {
  tokens: number;
  limit: number;
  /** The id the engine reported on the wire, not the AgentModel the thread chose. */
  model: string;
};

/**
 * The tokens a thread's runs spent, by the model the thread ran on: every input token a model read,
 * cached or not, and every one it wrote. Counted from when a build first recorded it; what came
 * before is unknown rather than nothing.
 */
export type ThreadUsage = Partial<Record<AgentModel, number>>;

/** Shape only: models this build knows, each with a whole, non-negative count. */
export function isThreadUsage(value: unknown): value is ThreadUsage {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.entries(value).every(([model, tokens]) => isAgentModel(model) && Number.isSafeInteger(tokens) && (tokens as number) >= 0);
}
