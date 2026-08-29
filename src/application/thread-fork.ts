import { forkTitle, type Thread } from "../domain/thread.js";
import { moveThread, nextSortIndex, orderThreads } from "./thread-order.js";

/** What a new thread takes from the thread it was made from: where it runs, and how it runs. */
function inherited(source: Thread) {
  return {
    ...(source.projectId ? { projectId: source.projectId } : {}),
    executionPolicy: source.executionPolicy,
    engine: source.engine,
    ...(source.model ? { model: source.model } : {}),
    ...(source.effort ? { effort: source.effort } : {}),
  };
}

/** A side chat: a thread of its own, starting empty, which forks the source's session on its first run. */
export function sideChatThread(source: Thread, id: string, title: string, at: number): Thread {
  return {
    id,
    title,
    ...inherited(source),
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: at },
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * Copies a thread, and puts the copy straight under it in the list. The copy carries the
 * conversation, the session it was left in, and how the thread was set to run. What the thread has
 * been through stays its own: no verdict, no findings, no schedule, and no checkout crosses over.
 */
export function forkedThreads(threads: Thread[], source: Thread, id: string, at: number): { threads: Thread[]; fork: Thread } {
  const fork: Thread = {
    id,
    title: forkTitle(source.title, threads.map((thread) => thread.title)),
    titleByUser: true,
    ...inherited(source),
    messages: [...source.messages],
    ...(source.continuation ? { continuation: source.continuation, inheritedContinuation: true as const } : {}),
    continuationStatus: source.continuationStatus,
    lastChangeSnapshot: { files: [], capturedAt: at },
    sortIndex: nextSortIndex(threads),
    createdAt: at,
    updatedAt: at,
  };
  /** The slot after the source, counted in the list the copy is dropped into with the copy left out. */
  const group = orderThreads(threads.filter((thread) => thread.archivedAt === undefined && thread.projectId === source.projectId));
  const under = group.findIndex((thread) => thread.id === source.id) + 1;
  return { fork, threads: moveThread([...threads, fork], fork.id, { projectId: source.projectId ?? null, index: under }) };
}
