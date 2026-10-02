/** Threads waiting out their account's usage limit, and the line they resume in once it lifts. */
import { drainQueue, queuedFor, resolveWorkspaceEffect, withQueued } from "./workspace-reducer/run-queue.js";
import { settled } from "./workspace-reducer/shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./workspace-reducer/types.js";
import { updateThread } from "./thread-run-state.js";
import { leavingThreadIds, projectFor, worktreeFor } from "./thread-location.js";
import type { PendingRun, WorkspaceState } from "./workspace-state.js";
import type { AgentEngine } from "../domain/agent-engine.js";
import { limitLines, resumePrompt, resumesOnItsOwn, withEngineLimit, withoutLimitPause, type LimitPause, type UsageLimit } from "../domain/usage-limit.js";

/**
 * Puts a thread whose run hit the limit in line. A session limit lifts on its own, so the failure is
 * not news; a weekly one waits for the user and keeps its verdict to say so.
 */
export function pausedForLimit(state: WorkspaceState, taskId: string, limit: UsageLimit, at: number): WorkspaceState {
  const thread = state.threads.find((item) => item.id === taskId);
  if (!thread) return state;
  const workflow = (state.workflows[taskId] ?? []).some((item) => item.status === "stopped");
  const pause: LimitPause = { ...limit, pausedAt: at, ...(workflow ? { workflow: true as const } : {}) };
  const threads = withEngineLimit(state.threads, thread.engine, limit);
  return updateThread({ ...state, threads }, taskId, (item) => {
    if (pause.window === "weekly") return { ...item, limitPause: pause };
    const { outcome: _expected, outcomeUnread: _unread, ...rest } = item;
    return { ...rest, limitPause: pause };
  });
}

/**
 * Whether a message to this thread waits with it. One that resumes on its own waits for its turn in
 * line even after the limit lifts; a weekly one is taken up by the user's own send once it has.
 */
export function heldByLimit(state: WorkspaceState, taskId: string, at: number) {
  const pause = state.threads.find((thread) => thread.id === taskId)?.limitPause;
  return Boolean(pause && (resumesOnItsOwn(pause) || at < pause.resetsAt));
}

/** A message written to a paused thread waits with it and moves it to the front of the line. */
export function nudged(state: WorkspaceState, taskId: string, at: number): WorkspaceState {
  return updateThread(state, taskId, (thread) => thread.limitPause ? { ...thread, limitPause: { ...thread.limitPause, nudgedAt: at } } : thread);
}

/**
 * Takes a thread out of line and starts it: with the first message written to it while it waited,
 * or with a prompt to carry on. Either run warms up before the next thread in line goes.
 */
export function resumeThread(state: WorkspaceState, taskId: string): WorkspaceTransition {
  const thread = state.threads.find((item) => item.id === taskId);
  const pause = thread?.limitPause;
  if (!thread || !pause || state.activeRuns[taskId] || Object.values(state.pendingRuns).some((pending) => pending.taskId === taskId)) return settled(state);
  const lifted = updateThread(state, taskId, withoutLimitPause);
  const [written, ...rest] = queuedFor(lifted, taskId);
  if (written) return drainQueue(withQueued(lifted, taskId, [{ ...written, prompt: resumePrompt(pause, written.prompt) }, ...rest]), taskId, "succeeded", true);
  const project = projectFor(lifted, thread);
  const pending: PendingRun = {
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    origin: "composer",
    operation: { type: "resume" },
    taskId,
    ...(project ? { projectId: project.id } : {}),
    text: "",
    prompt: resumePrompt(pause),
    attachments: [],
    warming: true,
  };
  return settled(
    { ...lifted, pendingRuns: { ...lifted.pendingRuns, [pending.id]: pending } },
    [resolveWorkspaceEffect(pending.id, thread, project, worktreeFor(lifted, thread), false)],
  );
}

/** Takes a thread out of line, handing anything written to it while it waited back to the composer. */
export function cancelPause(state: WorkspaceState, taskId: string): WorkspaceTransition {
  const thread = state.threads.find((item) => item.id === taskId);
  if (!thread?.limitPause) return settled(state);
  return drainQueue(updateThread(state, taskId, withoutLimitPause), taskId, "cancelled");
}

/** An engine's line moves one thread at a time: the next waits until the one before has answered once. */
function warming(state: WorkspaceState, engine: AgentEngine) {
  const engineOf = (taskId: string | undefined) => state.threads.find((thread) => thread.id === taskId)?.engine;
  return Object.values(state.activeRuns).some((run) => run.warming && engineOf(run.taskId) === engine)
    || Object.values(state.pendingRuns).some((pending) => pending.warming && engineOf(pending.taskId) === engine);
}

/** Starts the first thread in each engine's line whose limit has lifted, unless one is still warming up. */
function advanceLines(state: WorkspaceState, at: number): WorkspaceTransition {
  let transition = settled(state);
  const leaving = leavingThreadIds(state);
  for (const [engine, line] of limitLines(state.threads)) {
    if (warming(transition.state, engine)) continue;
    const next = line.find((thread) => thread.limitPause!.resetsAt <= at && !leaving.has(thread.id) && !transition.state.creatingWorktrees.includes(thread.id));
    if (!next) continue;
    const resumed = resumeThread(transition.state, next.id);
    transition = { ...resumed, effects: [...transition.effects, ...resumed.effects] };
  }
  return transition;
}

/** The next moment a thread in line has its limit lift; ones already due wait on the thread warming up. */
function nextReset(state: WorkspaceState, after: number): number | null {
  let next: number | null = null;
  for (const line of limitLines(state.threads).values()) {
    for (const thread of line) if (thread.limitPause!.resetsAt > after) next = Math.min(next ?? Infinity, thread.limitPause!.resetsAt);
  }
  return next;
}

/** Inputs after which a thread in line may be free to go: time passing, or a run warming up or ending. */
function mayAdvance(input: WorkspaceInput) {
  if (input.type === "run.event") return input.event.type === "context.usage" || input.event.type === "run.status";
  return input.type === "limits.elapsed" || input.type === "store.loaded" || input.type === "store.absent" || input.type === "task.send"
    || input.type === "run.unresolved" || input.type === "limit.cancel" || input.type === "view.set-focused" && input.focused;
}

/** Deadlines are durable; resuming threads and the one timer watching for the next reset belong to the reducer. */
export function reconcileLimitPauses(previous: WorkspaceState, transition: WorkspaceTransition, input: WorkspaceInput): WorkspaceTransition {
  const check = mayAdvance(input);
  if (!check && previous.threads === transition.state.threads) return transition;
  const at = input.type === "limits.elapsed" ? input.at : Date.now();
  const advanced = check ? advanceLines(transition.state, at) : settled(transition.state);
  const before = nextReset(previous, at);
  const next = nextReset(advanced.state, at);
  const effects = [...transition.effects, ...advanced.effects];
  if (next === before && !(check && next !== null)) return { ...transition, state: advanced.state, effects };
  return { ...transition, state: advanced.state, effects: [...effects, { type: "schedule-limit-reset", at: next }] };
}
