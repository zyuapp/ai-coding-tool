/**
 * The threads list, which only its owner rewrites. A feature patches the fields it keeps on a thread
 * through the functions here, and changes that span features are the functions here that make them.
 */
import type { ThreadsState } from "../state/threads.js";
import { dismissed } from "../../domain/attention.js";
import type { Thread } from "../../domain/thread.js";

/** The threads as one input leaves them, where `Field` is every thread field patched directly. Only the functions here make one. */
class ThreadsChange<Field extends keyof Thread> {
  private declare readonly writes: Field;
  constructor(readonly view: Pick<ThreadsState, "threads">) {}
}

/** The threads as one input leaves them, having patched only the fields of `Facet` on any of them. */
export type ThreadsEdit<Facet = Record<never, never>> = ThreadsChange<keyof Facet & keyof Thread>;

/**
 * Fields of the facet, and `updatedAt`, which any change to a thread moves. Naming any other field does
 * not compile. A field given as undefined is taken off the thread.
 */
export type ThreadPatch<Field extends keyof Thread> = { [Name in Field | "updatedAt"]?: Thread[Name] | undefined } & { [Name in Exclude<keyof Thread, Field | "updatedAt">]?: never };

export function threadsOf<Facet = Record<never, never>>(state: Pick<ThreadsState, "threads">): ThreadsEdit<Facet> {
  return new ThreadsChange({ threads: state.threads });
}

/** One thread with what the patch says. The list and that thread are new even when the patch changes nothing. */
export function editThread<Field extends keyof Thread>(edit: ThreadsChange<Field>, id: string, patch: (thread: Thread) => ThreadPatch<Field>): ThreadsChange<Field> {
  return new ThreadsChange({ threads: edit.view.threads.map((thread) => thread.id === id ? patched(thread, patch(thread)) : thread) });
}

/** Every thread the patch answers for, each one it answers null for left as it was. A list none changed is kept. */
export function editThreads<Field extends keyof Thread>(edit: ThreadsChange<Field>, patch: (thread: Thread) => ThreadPatch<Field> | null): ThreadsChange<Field> {
  let changed = false;
  const threads = edit.view.threads.map((thread) => {
    const fields = patch(thread);
    if (!fields) return thread;
    changed = true;
    return patched(thread, fields);
  });
  return changed ? new ThreadsChange({ threads }) : edit;
}

/** Threads filed away: their verdicts, and what their runs found, set down as {@link dismissed} sets them. */
export function dismissedIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, ids: Set<string>): ThreadsChange<Field> {
  const threads = dismissed(edit.view.threads, ids);
  return threads === edit.view.threads ? edit : new ThreadsChange({ threads });
}

/** Threads under a coordinator whose work settled at `at`, filed away under Resolved. */
export function resolvedIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, ids: Set<string>, at: number): ThreadsChange<Field> {
  const resolved = new ThreadsChange<Field>({ threads: edit.view.threads.map((thread) => ids.has(thread.id) ? { ...thread, resolvedAt: at } : thread) });
  return dismissedIn(resolved, ids);
}

function patched(thread: Thread, patch: ThreadPatch<keyof Thread>): Thread {
  const next = { ...thread, ...patch };
  if (!Object.values(patch).some((value) => value === undefined)) return next;
  return Object.fromEntries(Object.entries(next).filter(([field, value]) => value !== undefined || !(field in patch))) as Thread;
}
