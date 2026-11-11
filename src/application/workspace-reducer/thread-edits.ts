/**
 * The threads list, which only its owner rewrites. A feature patches the fields it keeps on a thread
 * through the functions here, and changes that span features are the functions here that make them.
 */
import type { ThreadsState } from "../state/threads.js";
import { openedTurn, type RunProvenance } from "../thread-run-state.js";
import { dismissed } from "../../domain/attention.js";
import { withAnswer, withCoordinationNote, withoutAnswer, type CoordinationNote } from "../../domain/coordination.js";
import type { Thread } from "../../domain/thread.js";
import { withoutSnooze } from "../../domain/thread-snooze.js";
import { withoutLimitPause } from "../../domain/usage-limit.js";

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

/** A new thread, at the end of the list. */
export function addedIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, thread: Thread): ThreadsChange<Field> {
  return new ThreadsChange({ threads: [...edit.view.threads, thread] });
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

/** A thread written to while filed away, back among the others. */
export function restoredIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, id: string): ThreadsChange<Field> {
  return mapped(edit, id, ({ archivedAt: _restored, ...thread }) => thread);
}

/** A snoozed thread written to, which ends its snooze. */
export function unsnoozedIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, id: string): ThreadsChange<Field> {
  return mapped(edit, id, withoutSnooze);
}

/** A thread waiting out a usage limit written to at `at`, which moves it to the front of the line. */
export function nudgedIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, id: string, at: number): ThreadsChange<Field> {
  return mapped(edit, id, (thread) => thread.limitPause ? { ...thread, limitPause: { ...thread.limitPause, nudgedAt: at } } : thread);
}

/** A thread out of its usage limit's line. */
export function unpausedIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, id: string): ThreadsChange<Field> {
  return mapped(edit, id, withoutLimitPause);
}

/** A thread whose turn a run of `provenance` opens, as {@link openedTurn} has it, unless it is open already. */
export function turnOpenedIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, id: string, provenance: Pick<RunProvenance, "origin" | "quiet" | "operation">): ThreadsChange<Field> {
  return mapped(edit, id, (thread) => thread.runOpen ? thread : openedTurn(thread, provenance));
}

/** A decision whose answer never reached its thread, open to answer again. */
export function answerReopenedIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, id: string, decisionId: string): ThreadsChange<Field> {
  return mapped(edit, id, (thread) => withoutAnswer(thread, decisionId));
}

/** A decision answered at `at`. */
export function answeredIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, id: string, decisionId: string, answer: string, at: number): ThreadsChange<Field> {
  return mapped(edit, id, (thread) => withAnswer(thread, decisionId, answer, at));
}

/** A note left for a coordinator to hear with its next wake. */
export function notedIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, leadId: string, note: CoordinationNote): ThreadsChange<Field> {
  return mapped(edit, leadId, (lead) => withCoordinationNote(lead, note));
}

/** The list with `update` made to one thread. The list is new even when no thread has that id. */
function mapped<Field extends keyof Thread>(edit: ThreadsChange<Field>, id: string, update: (thread: Thread) => Thread): ThreadsChange<Field> {
  return new ThreadsChange({ threads: edit.view.threads.map((thread) => thread.id === id ? update(thread) : thread) });
}

function patched(thread: Thread, patch: ThreadPatch<keyof Thread>): Thread {
  const next = { ...thread, ...patch };
  if (!Object.values(patch).some((value) => value === undefined)) return next;
  return Object.fromEntries(Object.entries(next).filter(([field, value]) => value !== undefined || !(field in patch))) as Thread;
}
