import { sideChatIds, type WorkspaceState } from "../../application/workspace-state.js";
import type { PersistedSubagent, PersistedTask, TaskStoreDelta } from "../../contracts/ipc.js";
import type { Subagent, SubagentActivity } from "../../domain/run.js";
import type { Task } from "../../domain/task.js";

function persistedTask(task: Task): PersistedTask {
  const { messages: _messages, subagents: _subagents, ...record } = task;
  return record;
}

function persistedSubagent(subagent: Subagent): PersistedSubagent {
  const { activity: _activity, ...record } = subagent;
  return record;
}

/** Only the subagents and activity items the last write did not already hold. */
function subagentDelta(before: Task | undefined, task: Task) {
  const previous = new Map((before?.subagents ?? []).map((subagent) => [subagent.id, subagent]));
  const subagents: Array<{ index: number; subagent: PersistedSubagent }> = [];
  const activity: Array<{ subagentId: string; index: number; item: SubagentActivity }> = [];
  (task.subagents ?? []).forEach((subagent, index) => {
    const stored = previous.get(subagent.id);
    if (stored === subagent) return;
    subagents.push({ index, subagent: persistedSubagent(subagent) });
    subagent.activity.forEach((item, position) => {
      if (stored?.activity[position] === item) return;
      activity.push({ subagentId: subagent.id, index: position, item });
    });
  });
  return { subagents, activity };
}

/** A side chat's thread never reaches the store, so it is filtered out on both sides of the delta. */
function persistedTasks(state: Pick<WorkspaceState, "tasks" | "sideChats"> | null) {
  if (!state) return [];
  if (state.sideChats.length === 0) return state.tasks;
  const forked = sideChatIds(state);
  return state.tasks.filter((task) => !forked.has(task.id));
}

export type PersistenceState = Pick<WorkspaceState, "tasks" | "sideChats" | "projects" | "worktrees" | "lastFolder">;

export type PersistenceQueue = {
  persisted: PersistenceState | null;
  pending: PersistenceState | null;
  inFlight: boolean;
};

export function persistenceState(state: WorkspaceState): PersistenceState {
  const { tasks, sideChats, projects, worktrees, lastFolder } = state;
  return { tasks, sideChats, projects, worktrees, lastFolder };
}

export function persistenceDelta(previous: PersistenceState | null, next: PersistenceState): TaskStoreDelta {
  const previousTasks = new Map(persistedTasks(previous).map((task) => [task.id, task]));
  const nextTasks = persistedTasks(next);
  const nextIds = new Set(nextTasks.map((task) => task.id));
  const removedTasks = [...previousTasks.keys()].filter((id) => !nextIds.has(id));
  return {
    ...(removedTasks.length ? { removedTasks } : {}),
    tasks: nextTasks.flatMap((task) => {
      const before = previousTasks.get(task.id);
      if (before === task) return [];
      const messages: Array<{ index: number; message: Task["messages"][number] }> = [];
      for (let index = 0; index < task.messages.length; index += 1) {
        const message = task.messages[index]!;
        if (before?.messages[index] !== message) messages.push({ index, message });
      }
      const { subagents, activity } = subagentDelta(before, task);
      return [{
        task: persistedTask(task),
        messages,
        ...(subagents.length ? { subagents } : {}),
        ...(activity.length ? { activity } : {}),
      }];
    }),
    ...(!previous || previous.projects !== next.projects ? { projects: next.projects } : {}),
    ...(!previous || previous.worktrees !== next.worktrees ? { worktrees: next.worktrees } : {}),
    ...(!previous || previous.lastFolder !== next.lastFolder ? { lastFolder: next.lastFolder } : {}),
  };
}

export function hasPersistenceDelta(delta: TaskStoreDelta) {
  return Boolean(delta.tasks.length || delta.removedTasks || delta.projects || delta.worktrees || "lastFolder" in delta);
}

/** One durable write at a time; changes during it replace the one snapshot still waiting. */
export async function drainLatestPersistence(queue: PersistenceQueue, persist: (delta: TaskStoreDelta) => Promise<void>) {
  if (queue.inFlight) return;
  queue.inFlight = true;
  try {
    while (queue.pending) {
      const next = queue.pending;
      queue.pending = null;
      const delta = persistenceDelta(queue.persisted, next);
      if (hasPersistenceDelta(delta)) await persist(delta);
      queue.persisted = next;
    }
  } finally {
    queue.inFlight = false;
  }
}
