/** Threads an update's restart cut off mid-turn, and how they carry on once the new build is up. */
import { threadBusy } from "./run-record.js";
import { projectFor, worktreeFor } from "./thread-location.js";
import { resolveWorkspaceEffect } from "./workspace-reducer/run-queue.js";
import { pendingIn, runsOf } from "./workspace-reducer/run-edits.js";
import { applied } from "./workspace-reducer/slice.js";
import type { WorkspaceTransition } from "./workspace-reducer/types.js";
import type { PendingRun, WorkspaceState } from "./workspace-state.js";

export const UPDATE_RESUME_PROMPT = "The app restarted to install an update, which cut off your last turn. Check whether anything it was doing was left half-done, then continue where you left off.";

/**
 * The threads whose turn is going when the app quits to update. One waiting on the user for an
 * approval or an answer, or that the user asked to stop, stays stopped.
 */
export function resumableAfterUpdate(state: Pick<WorkspaceState, "activeRuns" | "threads">): string[] {
  const open = new Set(state.threads.filter((thread) => thread.runOpen).map((thread) => thread.id));
  return Object.values(state.activeRuns)
    .filter((run) => open.has(run.taskId) && run.status !== "awaiting-approval" && !run.questions?.length && !run.cancelling)
    .map((run) => run.taskId);
}

/** Starts each named thread again on the session it was in, told to carry on. */
export function resumedAfterUpdate(transition: WorkspaceTransition, taskIds: readonly string[]): WorkspaceTransition {
  return taskIds.reduce((next, taskId) => {
    const resumed = carriedOn(next.state, taskId);
    return { ...resumed, effects: [...next.effects, ...resumed.effects] };
  }, transition);
}

function carriedOn(state: WorkspaceState, taskId: string): WorkspaceTransition {
  const thread = state.threads.find((item) => item.id === taskId);
  if (!thread || thread.archivedAt !== undefined || threadBusy(state, taskId)) return applied(state, {});
  const project = projectFor(state, thread);
  const pending: PendingRun = {
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    origin: "composer",
    operation: { type: "resume", after: "update" },
    taskId,
    ...(project ? { projectId: project.id } : {}),
    text: "",
    prompt: UPDATE_RESUME_PROMPT,
    attachments: [],
  };
  return applied(state, { edits: [pendingIn(runsOf(state), pending)], effects: [resolveWorkspaceEffect(pending.id, thread, project, worktreeFor(state, thread), false)] });
}
