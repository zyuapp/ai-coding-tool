import type { ProviderEvent } from "../agent/agent-provider.mjs";
import { RunningTotals } from "../agent/running-totals.mjs";
import type { ThreadTokenUsage } from "./protocol/v2/ThreadTokenUsage.js";

/**
 * What a session's Codex threads spend, the main one and each child it spawns, read off the running
 * total every usage report carries. A thread first seen in this session already holds what it spent
 * before, as a resumed one does, so only its latest response counts; after that, each report adds
 * what the total grew by. Only what arrives while a run is attached is counted: between runs the
 * total still moves, so the next run counts from where it stands. A compaction's recount of the
 * context it left carries no input or output, so it is no response and counts for nothing.
 */
export class CodexSpend {
  /** The last running total seen of each thread, by Codex's id for it. */
  private readonly totals = new RunningTotals();

  /** `emit` reaches the run in flight, and drops what arrives while there is none. */
  constructor(private readonly emit: (event: ProviderEvent) => void) {}

  report(threadId: string, usage: ThreadTokenUsage) {
    const total = usage.total.totalTokens;
    const latest = usage.last.inputTokens + usage.last.outputTokens > 0 ? Math.max(0, usage.last.totalTokens) : 0;
    const grown = this.totals.grow(threadId, total, Math.max(0, total - latest));
    if (grown) this.emit({ type: "spend", tokens: grown });
  }
}
