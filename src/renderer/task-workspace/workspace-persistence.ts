import { sideChatIds, type WorkspaceState } from "../../application/workspace-state.js";
import type { PersistedSubagent, PersistedTask, TaskStoreDelta } from "../../contracts/ipc.js";
import type { Subagent, SubagentActivity } from "../../domain/run.js";
import type { Thread } from "../../domain/thread.js";
import type { ThreadStoreData } from "../../domain/thread-storage.js";

function persistedTask(thread: Thread): PersistedTask {
  const { messages: _messages, ...record } = thread;
  return record;
}

function persistedSubagent(subagent: Subagent): PersistedSubagent {
  const { activity: _activity, ...record } = subagent;
  return record;
}

/** Only the subagents and activity items the last write did not already hold. */
function subagentDelta(before: Subagent[] | undefined, held: Subagent[] | undefined) {
  const previous = new Map((before ?? []).map((subagent) => [subagent.id, subagent]));
  const subagents: Array<{ index: number; subagent: PersistedSubagent }> = [];
  const activity: Array<{ subagentId: string; index: number; item: SubagentActivity }> = [];
  (held ?? []).forEach((subagent, index) => {
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
function persistedThreads(state: Pick<WorkspaceState, "threads" | "sideChats"> | null) {
  if (!state) return [];
  if (state.sideChats.length === 0) return state.threads;
  const forked = sideChatIds(state);
  return state.threads.filter((thread) => !forked.has(thread.id));
}

export type PersistenceState = Pick<WorkspaceState, "threads" | "subagents" | "sideChats" | "projects" | "worktrees" | "lastFolder">;

export type PersistenceQueue = {
  persisted: PersistenceState | null;
  pending: PersistenceState | null;
  inFlight: boolean;
};

export function persistenceState(state: WorkspaceState): PersistenceState {
  const { threads, subagents, sideChats, projects, worktrees, lastFolder } = state;
  return { threads, subagents, sideChats, projects, worktrees, lastFolder };
}

export function persistenceDelta(previous: PersistenceState | null, next: PersistenceState): TaskStoreDelta {
  const previousThreads = new Map(persistedThreads(previous).map((thread) => [thread.id, thread]));
  const nextThreads = persistedThreads(next);
  const nextIds = new Set(nextThreads.map((thread) => thread.id));
  const removedTasks = [...previousThreads.keys()].filter((id) => !nextIds.has(id));
  return {
    ...(removedTasks.length ? { removedTasks } : {}),
    tasks: nextThreads.flatMap((thread) => {
      const before = previousThreads.get(thread.id);
      const heldBefore = previous?.subagents[thread.id];
      const held = next.subagents[thread.id];
      if (before === thread && heldBefore === held) return [];
      const messages: Array<{ index: number; message: Thread["messages"][number] }> = [];
      for (let index = 0; index < thread.messages.length; index += 1) {
        const message = thread.messages[index]!;
        if (before?.messages[index] !== message) messages.push({ index, message });
      }
      const { subagents, activity } = subagentDelta(heldBefore, held);
      if (before === thread && !subagents.length && !activity.length) return [];
      return [{
        task: persistedTask(thread),
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

/** Writes anything created before the durable store finished loading, including worktree records. */
export function storeBackfill(stored: ThreadStoreData, current: PersistenceState) {
  const subagents: Record<string, Subagent[]> = {};
  for (const task of stored.tasks) if (task.subagents?.length) subagents[task.id] = task.subagents;
  return persistenceDelta({
    threads: stored.tasks,
    subagents,
    sideChats: [],
    projects: stored.projects,
    worktrees: stored.worktrees,
    lastFolder: stored.lastFolder,
  }, current);
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
