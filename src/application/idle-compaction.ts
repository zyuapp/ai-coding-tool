import { capabilitiesFor } from "../domain/agent-engine.js";
import { NEAR_LIMIT_SHARE, tightestWindow } from "../domain/plan-usage.js";
import type { Thread } from "../domain/thread.js";
import { compactable, requestCompaction } from "./workspace-reducer/runs.js";
import type { WorkspaceInput, WorkspaceTransition } from "./workspace-reducer/types.js";
import type { WorkspaceState } from "./workspace-state.js";

/** Share of the cache window that passes before compacting, which leaves a few minutes to finish in. */
const DUE_SHARE = 0.9;
/** Past this, the cache may already be gone, so compacting would cost as much as the next message. */
const LATE_MS = 60_000;
/** Smaller threads cost too little to re-read to be worth a summary. */
export const IDLE_COMPACTION_MIN_TOKENS = 200_000;

/** When the thread is due to be compacted, or null when it never is. */
function dueAt(state: WorkspaceState, thread: Thread): number | null {
  const cacheMs = capabilitiesFor(thread.engine).idleCompactionCacheMs;
  if (cacheMs === null || thread.runEndedAt === undefined || thread.archivedAt !== undefined || thread.limitPause) return null;
  if ((thread.contextUsage?.tokens ?? 0) < IDLE_COMPACTION_MIN_TOKENS || thread.continuation?.provider !== thread.engine) return null;
  if (state.idleCompactionSeen[thread.id] === thread.runEndedAt) return null;
  return thread.runEndedAt + cacheMs * DUE_SHARE;
}

function nextDue(state: WorkspaceState): number | null {
  if (!state.idleCompaction) return null;
  let next: number | null = null;
  for (const thread of state.threads) {
    const due = dueAt(state, thread);
    if (due !== null && (next === null || due < next)) next = due;
  }
  return next;
}

/** Only a plan reports limits, and a plan near its limit keeps what is left for the user. */
function planAllows(state: WorkspaceState, thread: Thread) {
  const usage = state.planUsage.reports[thread.engine];
  if (usage?.status !== "available") return false;
  return (tightestWindow(usage.windows)?.utilization ?? 0) < NEAR_LIMIT_SHARE;
}

/** Starts every compaction that is due at `at`, and lets one that is too late pass. */
function compactDue(state: WorkspaceState, at: number): WorkspaceTransition {
  let next = state;
  const effects: WorkspaceTransition["effects"] = [];
  const seen = { ...state.idleCompactionSeen };
  for (const thread of state.threads) {
    const due = dueAt(state, thread);
    if (due === null || due > at) continue;
    seen[thread.id] = thread.runEndedAt!;
    if (at - due > LATE_MS || !compactable(next, thread) || !planAllows(next, thread)) continue;
    const started = requestCompaction(next, thread.id, true);
    next = started.state;
    effects.push(...started.effects);
  }
  return { state: { ...next, idleCompactionSeen: seen }, effects };
}

/**
 * Compacts a large thread shortly before its engine's prompt cache expires, so coming back to it
 * reads a summary instead of the whole thread at full price. One timer watches the next one due.
 */
export function reconcileIdleCompaction(previous: WorkspaceState, transition: WorkspaceTransition, input: WorkspaceInput): WorkspaceTransition {
  const fired = input.type === "idle-compaction.due";
  const after = transition.state;
  if (!fired && previous.threads === after.threads && previous.idleCompaction === after.idleCompaction && input.type !== "store.loaded") return transition;
  const compacted = fired && after.idleCompaction ? compactDue(after, input.at) : null;
  const state = compacted?.state ?? after;
  const effects = compacted ? [...transition.effects, ...compacted.effects] : transition.effects;
  const before = nextDue(previous);
  const next = nextDue(state);
  if (next === before && !fired && input.type !== "store.loaded") return { ...transition, state, effects };
  return { ...transition, state, effects: [...effects, { type: "schedule-idle-compaction", at: next }] };
}
