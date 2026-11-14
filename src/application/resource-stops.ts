import type { ResourceStoppedEvent } from "../contracts/session-resources.js";
import type { WorkspaceState, PendingRun } from "./workspace-state.js";
import { resourceStopIn, threadsOf, verdictIn } from "./workspace-reducer/thread-edits.js";
import { pendingIn, runsOf, threadEventIn } from "./workspace-reducer/run-edits.js";
import { andThen, type Step } from "./workspace-reducer/slice.js";
import { drained, resolveWorkspaceEffect } from "./workspace-reducer/run-queue.js";
import { projectFor, worktreeFor } from "./thread-location.js";
import { threadBusy } from "./run-record.js";
import { threadOnScreen } from "./thread-attention.js";
import { announced } from "./notices.js";

/** A session stop also ends work whose parent turn finished earlier. */
export function resourceStopped(state: WorkspaceState, event: ResourceStoppedEvent): Step {
  const thread = state.threads.find(item => item.id === event.taskId);
  if (!thread || event.stop.cleanup !== "stopping" && thread.resourceStop?.at !== event.stop.at) return {};
  const first = !thread.resourceStop || thread.resourceStop.at !== event.stop.at;
  let threads = resourceStopIn(threadsOf(state), thread.id, event.stop);
  let runs = runsOf(state);
  if (first) {
    threads = verdictIn(threads, thread.id, "stopped", !threadOnScreen(state, thread.id));
    runs = threadEventIn(runs, { type: "background.changed", taskId: thread.id, processes: [] });
    runs = threadEventIn(runs, { type: "goal.changed", taskId: thread.id, goal: null });
    for (const child of state.subagents[thread.id] ?? []) if (child.status === "working" || child.status === "idle") runs = threadEventIn(runs, { type: "subagent.finished", taskId: thread.id, id: child.id, status: "stopped", summary: "Stopped due to high memory usage." });
    for (const workflow of state.workflows[thread.id] ?? []) if (workflow.status === "running") runs = threadEventIn(runs, { type: "workflow.finished", taskId: thread.id, id: workflow.id, status: "stopped", summary: "Stopped due to high memory usage." });
  }
  return andThen(state, { edits: [threads, runs], effects: first ? announced(state, thread, "Stopped due to high memory usage", "failed") : [] }, next => drained(next, thread.id, "hand-back"));
}

export function resourceResumed(state: WorkspaceState, taskId: string): Step {
  const thread = state.threads.find(item => item.id === taskId);
  if (!thread?.resourceStop || thread.resourceStop.cleanup !== "complete" || threadBusy(state, taskId)) return {};
  const pending: PendingRun = { id: crypto.randomUUID(), runId: crypto.randomUUID(), taskId, origin: "composer", operation: { type: "resume", after: "memory" }, text: "", prompt: "Continue after the session was stopped for high memory usage. Inspect the current state before repeating any interrupted action. Avoid the allocation or command that caused the excessive memory use.", attachments: [] };
  const threads = resourceStopIn(threadsOf(state), taskId, undefined);
  return { edits: [threads, pendingIn(runsOf(state), pending)], effects: [resolveWorkspaceEffect(pending.id, thread, projectFor(state, thread), worktreeFor(state, thread), false)] };
}
