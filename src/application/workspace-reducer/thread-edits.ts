/**
 * The threads list, which only its owner rewrites. A feature patches the fields it keeps on a thread
 * through the functions here, and changes that span features are the functions here that make them.
 */
import type { ThreadsState } from "../state/threads.js";
import { endedTurn, openedTurn, restoredTestimony, withdrawRun, type ActiveRun, type FinishedVerdict, type RunProvenance, type ThreadMark } from "../thread-run-state.js";
import { readRow } from "../thread-attention.js";
import { dismissed, readAttention, withClosedIssues, withFinding } from "../../domain/attention.js";
import { reopenedIfStuck, withCoordinationNote, withoutAnswer, type CoordinationNote } from "../../domain/coordination.js";
import type { Thread } from "../../domain/thread.js";
import type { ThreadOutcome } from "../../domain/thread-run.js";
import { withoutSnooze } from "../../domain/thread-snooze.js";
import { withEngineLimit, withoutLimitPause, type LimitPause, type UsageLimit } from "../../domain/usage-limit.js";

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

/** Notes left for a coordinator to hear with its next wake. */
export function notedIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, leadId: string, ...notes: CoordinationNote[]): ThreadsChange<Field> {
  return mapped(edit, leadId, (lead) => notes.reduce(withCoordinationNote, lead));
}

/** What a coordinator holds of its news kept for a later wake, so none of it wakes it now. */
export function newsQuietedIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, leadId: string): ThreadsChange<Field> {
  const lead = edit.view.threads.find((thread) => thread.id === leadId);
  if (!lead?.coordinationNotes?.some((note) => !note.quiet)) return edit;
  return mapped(edit, leadId, (thread) => ({ ...thread, coordinationNotes: thread.coordinationNotes!.map((note) => note.quiet ? note : { ...note, quiet: true as const }) }));
}

/** A thread whose turn ended with `status`, as {@link endedTurn} has it. */
export function turnEndedIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, id: string, status: Parameters<typeof endedTurn>[1]): ThreadsChange<Field> {
  return mapped(edit, id, (thread) => endedTurn(thread, status));
}

/** The verdict a settled turn leaves its thread, unread unless the user was looking at it. A thread filed away is left none. */
export function verdictIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, id: string, outcome: ThreadOutcome, unread: boolean): ThreadsChange<Field> {
  return mapped(edit, id, (thread) => thread.archivedAt !== undefined ? thread : { ...thread, outcome, ...unread ? { outcomeUnread: true as const } : {} });
}

/** A tick's run withdrawn as if it never ran, or the filed-away issues it no longer reports closed, or both. */
export function withdrawnIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, id: string, run: Pick<ActiveRun, "messagesBefore" | "before" | "reportedIssues">, { withdraws, closesIssues }: { withdraws: boolean; closesIssues: boolean }): ThreadsChange<Field> {
  return mapped(edit, id, (thread) => {
    const withdrawn = withdraws ? withdrawRun(thread, run.messagesBefore, run.before) : thread;
    return closesIssues ? withClosedIssues(withdrawn, run.reportedIssues) : withdrawn;
  });
}

/** How the last turn ended, its verdict and its report put back, as {@link restoredTestimony} has it. */
export function testimonyRestoredIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, id: string, before: ThreadMark): ThreadsChange<Field> {
  return mapped(edit, id, (thread) => restoredTestimony(thread, before));
}

/** A usage limit one thread's run reached, which every waiting thread of its engine waits for too. */
export function engineLimitIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, id: string, limit: UsageLimit): ThreadsChange<Field> {
  const thread = edit.view.threads.find((item) => item.id === id);
  const threads = thread ? withEngineLimit(edit.view.threads, thread.engine, limit) : edit.view.threads;
  return threads === edit.view.threads ? edit : new ThreadsChange({ threads });
}

/** A thread in its usage limit's line. One that carries on by itself has its verdict and its end taken off. */
export function limitPausedIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, id: string, pause: LimitPause, carriesOn: boolean): ThreadsChange<Field> {
  return mapped(edit, id, (thread) => {
    if (!carriesOn) return { ...thread, limitPause: pause };
    const { outcome: _expected, outcomeUnread: _unread, runEndedAs: _carriedOn, ...rest } = thread;
    return { ...rest, limitPause: pause };
  });
}

/** What a run found, said in the thread and kept with its findings, unless the thread already carries it. */
export function findingIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, id: string, report: Parameters<typeof withFinding>[1], at: number, seen: boolean): ThreadsChange<Field> {
  return mapped(edit, id, (thread) => withFinding(thread, report, at, seen));
}

/** A thread whose work finished, ranked and marked as {@link finishedVerdict} has it. */
export function finishedIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, id: string, verdict: FinishedVerdict): ThreadsChange<Field> {
  return mapped(edit, id, (thread) => ({ ...thread, ...verdict }));
}

/** A resolved thread its failed turn left stuck, open again. */
export function reopenedIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, id: string): ThreadsChange<Field> {
  return mapped(edit, id, reopenedIfStuck);
}

/** A thread the user has seen: its verdict and what its runs found are read. A list with nothing unread is kept. */
export function readIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, id: string): ThreadsChange<Field> {
  const read = readAttention(edit.view, id);
  return read === edit.view ? edit : new ThreadsChange(read);
}

/** {@link readIn} for a row, which a coordinator speaks for with every thread under it, as {@link readRow} has it. */
export function rowReadIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, id: string | null): ThreadsChange<Field> {
  const read = readRow(edit.view, id);
  return read === edit.view ? edit : new ThreadsChange(read);
}

/** Threads gone for good, out of the list. */
export function removedIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, ids: Set<string>): ThreadsChange<Field> {
  return new ThreadsChange({ threads: edit.view.threads.filter((thread) => !ids.has(thread.id)) });
}

/** A thread's conversation, loaded from the store where only its summary was held. */
export function historyLoadedIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, id: string, messages: Thread["messages"]): ThreadsChange<Field> {
  return mapped(edit, id, ({ historySummary: _loaded, ...thread }) => ({ ...thread, messages }));
}

/** A project's threads once the project is gone: none of them is in it, and each is filed away at `at` unless it was already. */
export function projectRemovedIn<Field extends keyof Thread>(edit: ThreadsChange<Field>, projectId: string, at: () => number): ThreadsChange<Field> {
  return new ThreadsChange({
    threads: edit.view.threads.map((thread) => {
      if (thread.projectId !== projectId) return thread;
      const { projectId: _removed, ...projectless } = thread;
      return thread.archivedAt === undefined ? { ...projectless, archivedAt: at() } : projectless;
    }),
  });
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
