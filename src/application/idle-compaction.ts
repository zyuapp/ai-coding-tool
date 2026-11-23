import { capabilitiesFor, modelLabel, threadModel } from "../domain/agent-engine.js";
import { NEAR_LIMIT_SHARE, tightestWindow, windowsFor } from "../domain/plan-usage.js";
import type { Thread } from "../domain/thread.js";
import { threadBusy } from "./run-record.js";
import { compactableSession } from "./session-operations.js";
import { catalogOf } from "./state/engines.js";
import type { IdleCompaction } from "./state/idle-compaction.js";
import { cancelling, queuedFor } from "./workspace-reducer/run-queue.js";
import { compactionRequested } from "./workspace-reducer/runs.js";
import { applied, type Step } from "./workspace-reducer/slice.js";
import type { WorkspaceInput, WorkspaceTransition } from "./workspace-reducer/types.js";
import type { WorkspaceState } from "./workspace-state.js";

/** Share of the cache window that passes before compacting, which leaves a few minutes to finish in. */
const DUE_SHARE = 0.9;
/** Past this, the cache may already be gone, so compacting would cost as much as the next message. */
const LATE_MS = 60_000;
/** Longer than any compaction takes; one still going by then is stopped so its thread is free again. */
const LIMIT_MS = 10 * 60_000;
/** A smaller thread costs too little to read again to be worth a summary. */
export const IDLE_COMPACTION_MIN_TOKENS = 200_000;

/**
 * When a thread is due to be compacted, null when it never is: a large thread of an engine whose cache
 * expires, whose session is still its own, idle since a run end not yet answered.
 */
function dueAt(state: WorkspaceState, thread: Thread): number | null {
  const cacheMs = capabilitiesFor(thread.engine).idleCompactionCacheMs;
  if (cacheMs === null || thread.runEndedAt === undefined || (thread.contextUsage?.tokens ?? 0) < IDLE_COMPACTION_MIN_TOKENS) return null;
  if (thread.archivedAt !== undefined || thread.limitPause || thread.inheritedContinuation) return null;
  if (state.idleCompactions[thread.id]?.runEndedAt === thread.runEndedAt) return null;
  if (!compactableSession(state, thread)) return null;
  return thread.runEndedAt + cacheMs * DUE_SHARE;
}

/** When the app's own compaction running on a thread is stopped, null for none. */
function deadline(state: WorkspaceState, taskId: string): number | null {
  const active = state.activeRuns[taskId];
  const startedAt = state.idleCompactions[taskId]?.startedAt;
  if (!active?.idle || active.cancelling || startedAt === undefined) return null;
  return startedAt + LIMIT_MS;
}

/** The next moment a compaction is due or one has run too long, null for none. */
function nextIdleCompaction(state: WorkspaceState): number | null {
  let next: number | null = null;
  const consider = (at: number | null) => { if (at !== null && (next === null || at < next)) next = at; };
  for (const taskId of Object.keys(state.activeRuns)) consider(deadline(state, taskId));
  if (state.idleCompaction) for (const thread of state.threads) consider(dueAt(state, thread));
  return next;
}

/**
 * Whether a due thread may be compacted now: nobody is working in it, and its account is not billed
 * outside a plan or running low on one. A plan not yet read, or a read that failed, does not stop it.
 */
function allowed(state: WorkspaceState, thread: Thread) {
  if (threadBusy(state, thread.id) || queuedFor(state, thread.id).length > 0) return false;
  if (state.workflows[thread.id]?.some((workflow) => workflow.status === "running")) return false;
  if (state.subagents[thread.id]?.some((subagent) => subagent.status === "working")) return false;
  const report = state.planUsage.reports[thread.engine];
  if (report?.status === "not-applicable") return false;
  const catalog = catalogOf(state);
  const model = threadModel(catalog, thread);
  const tightest = model === undefined ? null : tightestWindow(windowsFor(report, modelLabel(catalog, thread.engine, model)));
  return !tightest || tightest.utilization < NEAR_LIMIT_SHARE;
}

/**
 * Stops each idle compaction that has run too long, and starts each one due by `at`. A thread whose
 * time passed more than a minute ago, or that is in use, is let be until its next run ends.
 */
function idleCompactionsAt(state: WorkspaceState, at: number): WorkspaceTransition {
  let transition: WorkspaceTransition = { state, effects: [] };
  const marks: Record<string, IdleCompaction> = {};
  for (const thread of state.threads) {
    const mark = state.idleCompactions[thread.id];
    if (mark) marks[thread.id] = mark;
  }
  const apply = (step: Step) => {
    const next = applied(transition.state, step);
    transition = { state: next.state, effects: [...transition.effects, ...next.effects] };
  };
  for (const thread of state.threads) {
    const stopAt = deadline(transition.state, thread.id);
    if (stopAt !== null && stopAt <= at) {
      apply(cancelling(transition.state, transition.state.activeRuns[thread.id]!));
      continue;
    }
    if (!state.idleCompaction) continue;
    const due = dueAt(state, thread);
    if (due === null || due > at) continue;
    marks[thread.id] = { runEndedAt: thread.runEndedAt! };
    if (at - due > LATE_MS || !allowed(transition.state, thread)) continue;
    const step = compactionRequested(transition.state, thread.id, true);
    if (!step.effects?.length) continue;
    marks[thread.id] = { runEndedAt: thread.runEndedAt!, startedAt: at };
    apply(step);
  }
  const same = Object.keys(marks).length === Object.keys(state.idleCompactions).length
    && Object.entries(marks).every(([id, mark]) => state.idleCompactions[id] === mark);
  return same ? transition : { ...transition, state: { ...transition.state, idleCompactions: marks } };
}

/**
 * Compacts a large thread shortly before its engine's prompt cache expires, so coming back to it reads
 * a summary instead of the whole thread at full price. One timer watches for the next one due, and for
 * a compaction that has run too long.
 */
export function reconcileIdleCompaction(previous: WorkspaceState, transition: WorkspaceTransition, input: WorkspaceInput): WorkspaceTransition {
  const fired = input.type === "idle-compaction.due";
  const loaded = input.type === "store.loaded" || input.type === "preferences.loaded";
  const after = transition.state;
  if (!fired && !loaded && previous.idleCompaction === after.idleCompaction && previous.threads === after.threads && previous.activeRuns === after.activeRuns) return transition;
  if (fired) {
    const started = idleCompactionsAt(after, input.at);
    transition = { ...transition, state: started.state, effects: [...transition.effects, ...started.effects] };
  }
  const next = nextIdleCompaction(transition.state);
  if (!fired && (loaded ? next === null : next === nextIdleCompaction(previous))) return transition;
  return { ...transition, effects: [...transition.effects, { type: "schedule-idle-compaction", at: next }] };
}
