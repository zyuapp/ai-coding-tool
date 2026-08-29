/**
 * What a thread has to say for itself: the verdict its last run left, and what its runs found. A
 * verdict belongs to one run and the next run supersedes it; a finding outlives every run after it,
 * because the tick that raised it may have been at 3am. Both rank a thread in Priority, both are
 * marked read by landing on the thread, and both are retired by the same dismissal.
 *
 * A function belongs here when a thread, or a list of threads, is all it needs.
 */
import { createConversationMessage } from "./conversation.js";
import { MAX_FINDINGS, MAX_HANDLED_ISSUES, type AutomationFinding } from "./finding.js";
import type { Thread } from "./thread.js";

export function unreadFindings(thread: Thread): AutomationFinding[] {
  return (thread.findings ?? []).filter((finding) => !finding.read);
}

/** The headline a row shows: the newest thing the user has not seen. */
export function newestUnreadFinding(thread: Thread): AutomationFinding | undefined {
  return unreadFindings(thread).at(-1);
}

function hasFindings(thread: Thread): boolean {
  return (thread.findings ?? []).length > 0;
}

/**
 * Whether the thread has anything to put to the user: a verdict its last run left, or something a
 * run found. Read or not, it holds the thread in Priority and is what a dismissal files away.
 */
export function wantsAttention(thread: Thread): boolean {
  return Boolean(thread.outcome) || hasFindings(thread);
}

/** Whether any of that is still unseen, which is the narrower thing a row's dot stands for. */
export function hasUnreadAttention(thread: Thread): boolean {
  return Boolean(newestUnreadFinding(thread) || (thread.outcome && thread.outcomeUnread));
}

function findingKeys(thread: Thread): string[] {
  return (thread.findings ?? []).flatMap((finding) => finding.key ?? []);
}

function handledKeys(thread: Thread): string[] {
  return thread.handledIssues ?? [];
}

/**
 * Where a keyed issue stands with the thread: one it carries a finding for, one the user has filed
 * away, or one it has never been told about. A report with no key, blank included, is always
 * unknown: a blank is stored as no key at all, so treating it as one would match nothing forever.
 */
export function issueState(thread: Thread, key?: string): "unknown" | "carried" | "handled" {
  if (!key) return "unknown";
  if (findingKeys(thread).includes(key)) return "carried";
  return handledKeys(thread).includes(key) ? "handled" : "unknown";
}

/** Only an issue the thread has never heard of is news; carried and filed away are the same one. */
export function isNews(thread: Thread, key?: string): boolean {
  return issueState(thread, key) === "unknown";
}

/**
 * Records the finding, oldest dropped once the thread is at its fill, and says it in the thread so
 * the transcript still carries it once the finding itself is filed away. An issue the thread already
 * knows changes nothing.
 */
export function withFinding(thread: Thread, report: { headline: string; detail?: string; key?: string }, at: number, seen = false): Thread {
  if (!isNews(thread, report.key)) return thread;
  const finding: AutomationFinding = {
    id: crypto.randomUUID(),
    headline: report.headline,
    ...(report.detail ? { detail: report.detail } : {}),
    ...(report.key ? { key: report.key } : {}),
    at,
    ...(seen ? { read: true as const } : {}),
  };
  return {
    ...thread,
    findings: [...thread.findings ?? [], finding].slice(-MAX_FINDINGS),
    /** Outlives the finding itself, so a schedule that found something at 3am can still prove it. */
    lastFindingAt: at,
    messages: [...thread.messages, createConversationMessage("system", report.headline, report.detail)],
    updatedAt: at,
  };
}

/** Landing on the thread takes the marks off. The findings stay, the way a verdict stays. */
export function withReadFindings(thread: Thread): Thread {
  if (!unreadFindings(thread).length) return thread;
  return { ...thread, findings: thread.findings!.map((finding) => finding.read ? finding : { ...finding, read: true as const }) };
}

/** Filing the thread away is what retires what it found. */
export function withoutFindings(thread: Thread): Thread {
  if (!thread.findings) return thread;
  const { findings: _filed, ...rest } = thread;
  return rest;
}

/**
 * Landing on a thread takes its marks off. The verdict and what its runs found both stay, so the
 * thread keeps its place in Priority until the user files it away.
 */
export function readAttention<T extends { threads: Thread[] }>(state: T, threadId: string | null): T {
  const seen = threadId ? state.threads.find((thread) => thread.id === threadId) : undefined;
  if (!seen || (!seen.outcomeUnread && !unreadFindings(seen).length)) return state;
  const { outcomeUnread: _read, ...rest } = seen;
  return { ...state, threads: state.threads.map((thread) => thread === seen ? withReadFindings(rest) : thread) };
}

/** Retires the named threads' verdicts, leaving the list alone when none of them carry one. */
export function withoutOutcome(threads: Thread[], dismissing: Set<string>): Thread[] {
  if (!threads.some((thread) => dismissing.has(thread.id) && thread.outcome)) return threads;
  return threads.map((thread) => {
    if (!dismissing.has(thread.id) || !thread.outcome) return thread;
    const { outcome: _gone, outcomeUnread: _read, ...rest } = thread;
    return rest;
  });
}

/**
 * Filing a thread away retires what its runs found along with the verdict of the last one. The keys
 * go with it rather than being forgotten: a dismissal says the finding is handled, not that the user
 * wants telling again on the next tick.
 */
export function dismissed(threads: Thread[], dismissing: Set<string>): Thread[] {
  const filed = withoutOutcome(threads, dismissing);
  if (!filed.some((thread) => dismissing.has(thread.id) && thread.findings)) return filed;
  return filed.map((thread) => dismissing.has(thread.id) ? withoutFindings(withHandledIssues(thread)) : thread);
}

function withHandledIssues(thread: Thread): Thread {
  const keys = findingKeys(thread);
  if (!keys.length) return thread;
  const handled = [...handledKeys(thread).filter((key) => issueState(thread, key) !== "carried"), ...keys];
  return { ...thread, handledIssues: handled.slice(-MAX_HANDLED_ISSUES) };
}

/**
 * What a run that has finished looking says about the keys it did not report: the thing it was
 * filed away for is over, so the next sighting is news again.
 */
export function withClosedIssues(thread: Thread, reportedIssues: string[]): Thread {
  const held = handledKeys(thread);
  const still = held.filter((key) => reportedIssues.includes(key));
  if (still.length === held.length) return thread;
  if (!still.length) {
    const { handledIssues: _closed, ...rest } = thread;
    return rest;
  }
  return { ...thread, handledIssues: still };
}

/** Which threads a "dismiss everything" reaches: the ones carrying anything to file away. */
export function dismissableThreads(threads: Thread[]): Thread[] {
  return threads.filter(wantsAttention);
}
