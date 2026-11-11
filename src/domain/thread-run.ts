import { isModelId, type AgentModel } from "./agent-engine.js";
import type { Continuation, RunStatus } from "./run.js";
import type { LimitPause } from "./usage-limit.js";

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

/** Shape only: well-formed model ids, each with a whole, non-negative count. */
export function isThreadUsage(value: unknown): value is ThreadUsage {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.entries(value).every(([model, tokens]) => isModelId(model) && Number.isSafeInteger(tokens) && (tokens as number) >= 0);
}

/** What a thread's runs leave on it: their session, spend, verdict, and how the newest one ended. */
export type RunThread = {
  contextUsage?: ContextUsage;
  /** What this thread's runs have spent, which unlike its context only ever grows. */
  usage?: ThreadUsage;
  continuation?: Continuation;
  continuationStatus: ContinuationStatus;
  lastChangeSnapshot: ChangeSnapshot;
  /** The verdict of the newest settled run, until a dismissal or the next run supersedes it. */
  outcome?: ThreadOutcome;
  /** Set while the user has yet to see that verdict. It marks the thread, the verdict ranks it. */
  outcomeUnread?: true;
  /** Set while the thread waits out its account's usage limit. */
  limitPause?: LimitPause;
  /** When this thread's newest run settled. A turn the run left unfinished ends there. */
  runEndedAt?: number;
  /**
   * How that run ended, until the next one begins. Its verdict says the same until the user files it
   * away; this stays, since filing a thread away changes nothing it did.
   */
  runEndedAs?: ThreadOutcome;
  /**
   * Set while a run is going on this thread. No run outlives the app, so a thread saved with it was
   * cut off when the app quit, and is restored as having been stopped there.
   */
  runOpen?: true;
  /**
   * Set on a thread copied from another, which inherits that thread's session. Its runs fork that
   * session instead of continuing it until one reports a session of its own, which clears this, so
   * a run that dies before it names a session never leaves the two threads writing to one.
   */
  inheritedContinuation?: true;
};
