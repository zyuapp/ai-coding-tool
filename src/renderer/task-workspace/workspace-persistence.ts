import { sideChatIds, type WorkspaceState } from "../../application/workspace-state.js";
import type { PersistedSubagent, PersistedTask, TaskStoreDelta } from "../../contracts/ipc.js";
import type { Subagent, SubagentActivity } from "../../domain/run.js";
import type { Thread } from "../../domain/thread.js";
import { firstChangedMessage } from "../../domain/conversation-updates.js";
import type { ThreadStoreData } from "../../domain/thread-storage.js";

function persistedTask(thread: Thread): PersistedTask {
  const { messages: _messages, historySummary: _historySummary, ...record } = thread;
  return record;
}

function persistedSubagent(subagent: Subagent): PersistedSubagent {
  const { activity: _activity, ...record } = subagent;
  return record;
}

/** Only the subagents and activity items the last write did not already hold. */
function subagentDelta(before: Subagent[] | undefined, held: Subagent[] | undefined) {
  const subagents: Array<{ index: number; subagent: PersistedSubagent }> = [];
  const activity: Array<{ subagentId: string; index: number; item: SubagentActivity }> = [];
  if (before === held) return { subagents, activity };
  const previous = new Map((before ?? []).map((subagent) => [subagent.id, subagent]));
  (held ?? []).forEach((subagent, index) => {
    const stored = previous.get(subagent.id);
    if (stored === subagent) return;
    subagents.push({ index, subagent: persistedSubagent(subagent) });
    if (stored?.activity === subagent.activity) return;
    subagent.activity.forEach((item, position) => {
      if (stored?.activity[position] === item) return;
      activity.push({ subagentId: subagent.id, index: position, item });
    });
  });
  return { subagents, activity };
}

const threadIndexes = new WeakMap<Thread[], Map<string, Thread>>();

function threadIndex(threads: Thread[]) {
  let index = threadIndexes.get(threads);
  if (!index) {
    index = new Map(threads.map((thread) => [thread.id, thread]));
    threadIndexes.set(threads, index);
  }
  return index;
}

export type PersistenceState = Pick<WorkspaceState, "threads" | "subagents" | "sideChats" | "projects" | "worktrees" | "lastFolder">;

export type PersistenceQueue = {
  persisted: PersistenceState | null;
  pending: PersistenceState | null;
  inFlight: Promise<void> | null;
};

const activeSnapshots = new WeakMap<PersistenceQueue, PersistenceState>();

/** Disk reads update every durability snapshot that still carries the unloaded thread summary. */
export function adoptPersistedMessages(queue: PersistenceQueue, taskId: string, messages: Thread["messages"]) {
  function hydrate(snapshot: PersistenceState | null): PersistenceState | null {
    if (!snapshot?.threads.some((thread) => thread.id === taskId && thread.historySummary)) return snapshot;
    return {
      ...snapshot,
      threads: snapshot.threads.map((thread) => {
        if (thread.id !== taskId || !thread.historySummary) return thread;
        const { historySummary: _summary, ...loaded } = thread;
        return { ...loaded, messages };
      }),
    };
  }
  queue.persisted = hydrate(queue.persisted);
  queue.pending = hydrate(queue.pending);
  const active = activeSnapshots.get(queue);
  if (active) activeSnapshots.set(queue, hydrate(active)!);
}

export function persistenceState(state: WorkspaceState): PersistenceState {
  const { threads, subagents, sideChats, projects, worktrees, lastFolder } = state;
  return { threads, subagents, sideChats, projects, worktrees, lastFolder };
}

/** Immutable references identify which persisted collections a transition actually changed. */
export function hasPersistenceChanges(previous: PersistenceState, next: PersistenceState) {
  return previous.threads !== next.threads || previous.subagents !== next.subagents || previous.sideChats !== next.sideChats
    || previous.projects !== next.projects || previous.worktrees !== next.worktrees || previous.lastFolder !== next.lastFolder;
}

export function persistenceDelta(previous: PersistenceState | null, next: PersistenceState): TaskStoreDelta {
  const delta: TaskStoreDelta = { tasks: [] };
  if (!previous || previous.projects !== next.projects) delta.projects = next.projects;
  if (!previous || previous.worktrees !== next.worktrees) delta.worktrees = next.worktrees;
  if (!previous || previous.lastFolder !== next.lastFolder) delta.lastFolder = next.lastFolder;
  const threadsChanged = !previous || previous.threads !== next.threads || previous.sideChats !== next.sideChats;
  if (!threadsChanged && previous.subagents === next.subagents) return delta;

  const previousThreads = previous ? threadIndex(previous.threads) : new Map<string, Thread>();
  const previousSideChats = previous ? sideChatIds(previous) : new Set<string>();
  const nextSideChats = sideChatIds(next);
  let candidates: Thread[];
  if (threadsChanged) {
    candidates = next.threads;
    const nextThreads = threadIndex(next.threads);
    const removedTasks: string[] = [];
    for (const id of previousThreads.keys()) {
      if (!previousSideChats.has(id) && (!nextThreads.has(id) || nextSideChats.has(id))) removedTasks.push(id);
    }
    if (removedTasks.length) delta.removedTasks = removedTasks;
  } else {
    candidates = [];
    const nextThreads = threadIndex(next.threads);
    for (const id of Object.keys(next.subagents)) {
      if (previous.subagents[id] === next.subagents[id]) continue;
      const thread = nextThreads.get(id);
      if (thread) candidates.push(thread);
    }
  }
  for (const thread of candidates) {
    if (nextSideChats.has(thread.id)) continue;
    const before = previousSideChats.has(thread.id) ? undefined : previousThreads.get(thread.id);
    const heldBefore = previous?.subagents[thread.id];
    const held = next.subagents[thread.id];
    if (before === thread && heldBefore === held) continue;
    const messages: TaskStoreDelta["tasks"][number]["messages"] = [];
    if (before?.messages !== thread.messages) {
      for (let index = firstChangedMessage(before?.messages, thread.messages); index < thread.messages.length; index += 1) {
        const message = thread.messages[index]!;
        if (before?.messages[index] !== message) messages.push({ index, message });
      }
    }
    const { subagents, activity } = subagentDelta(heldBefore, held);
    if (before === thread && !subagents.length && !activity.length) continue;
    const taskDelta: TaskStoreDelta["tasks"][number] = { task: persistedTask(thread), messages };
    if (subagents.length) taskDelta.subagents = subagents;
    if (activity.length) taskDelta.activity = activity;
    delta.tasks.push(taskDelta);
  }
  return delta;
}

/** The durable baseline is the data read from disk, never a later workspace snapshot. */
export function persistedStoreState(stored: ThreadStoreData): PersistenceState {
  const subagents: Record<string, Subagent[]> = {};
  for (const task of stored.tasks) if (task.subagents?.length) subagents[task.id] = task.subagents;
  return {
    threads: stored.tasks,
    subagents,
    sideChats: [],
    projects: stored.projects,
    worktrees: stored.worktrees,
    lastFolder: stored.lastFolder,
  };
}

/** Writes anything created before the durable store finished loading, including worktree records. */
export function storeBackfill(stored: ThreadStoreData, current: PersistenceState) {
  return persistenceDelta(persistedStoreState(stored), current);
}

export function hasPersistenceDelta(delta: TaskStoreDelta) {
  return Boolean(delta.tasks.length || delta.removedTasks || delta.projects || delta.worktrees || "lastFolder" in delta);
}

/** Every caller waits for the active write and every newer snapshot queued before the drain settles. */
export async function drainLatestPersistence(queue: PersistenceQueue, persist: (delta: TaskStoreDelta) => Promise<void>): Promise<void> {
  while (queue.inFlight || queue.pending) {
    if (!queue.inFlight) {
      queue.inFlight = Promise.resolve().then(async () => {
        while (queue.pending) {
          const next = queue.pending;
          queue.pending = null;
          activeSnapshots.set(queue, next);
          try {
            const delta = persistenceDelta(queue.persisted, next);
            if (hasPersistenceDelta(delta)) await persist(delta);
            queue.persisted = activeSnapshots.get(queue)!;
          } catch (error) {
            queue.pending ??= activeSnapshots.get(queue)!;
            throw error;
          } finally {
            activeSnapshots.delete(queue);
          }
        }
      }).finally(() => { queue.inFlight = null; });
    }
    await queue.inFlight;
  }
}
