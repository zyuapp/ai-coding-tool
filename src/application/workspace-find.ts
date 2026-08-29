/**
 * The find bar as it is drawn. A thread is counted here, because its messages are in the state; every
 * other view counts its own matches and reports them back.
 */
import { memoizedFindHits, searchesItself, type FindHit } from "../domain/find.js";
import type { Thread } from "../domain/thread.js";
import type { FindState, WorkspaceState } from "./workspace-state.js";

export type FindView = FindState & { matches: number; counting: boolean; hit: FindHit | null };

export function findView(state: WorkspaceState, currentThread: Thread | undefined): FindView | null {
  const find = state.find;
  if (!find) return null;
  const target = find.target;
  if (target.kind === "thread") {
    /** A side chat is a thread like any other, so naming it is all the same search needs. */
    const thread = target.taskId === (currentThread?.id ?? null)
      ? currentThread
      : state.threads.find((item) => item.id === target.taskId);
    const hits = memoizedFindHits(thread?.messages ?? [], find.query);
    const index = hits.length ? Math.min(find.index, hits.length - 1) : 0;
    return { ...find, index, matches: hits.length, counting: false, hit: hits[index] ?? null };
  }
  const reported = state.findResults;
  const matches = reported?.matches ?? 0;
  if (searchesItself(find.target)) {
    return { ...find, matches, index: reported?.index ?? 0, counting: false, hit: null };
  }
  /** Nothing reported yet is a view still counting, not a view that found nothing. */
  const counting = reported ? reported.counting ?? false : find.query.trim().length > 0;
  return { ...find, matches, index: matches ? Math.min(find.index, matches - 1) : 0, counting, hit: null };
}
