export type ChangeSnapshot = {
  files: string[];
  capturedAt: number;
};

export type ContinuationStatus = "none" | "available" | "invalid";

/** How the thread's newest settled run ended. Whether it is blocked on an approval lives in `activeRuns`. */
export type ThreadOutcome = "finished" | "failed" | "stopped";

export type ContextUsage = {
  tokens: number;
  limit: number;
  /** The id the engine reported on the wire, not the AgentModel the thread chose. */
  model: string;
};
