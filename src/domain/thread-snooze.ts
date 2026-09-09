import type { Thread } from "./thread.js";

export const SNOOZE_OPTIONS = [
  { label: "1 hour", hours: 1 },
  { label: "4 hours", hours: 4 },
  { label: "1 day", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "1 week", hours: 168 },
] as const;

export type SnoozeHours = typeof SNOOZE_OPTIONS[number]["hours"];

export function isSnoozeHours(value: unknown): value is SnoozeHours {
  return SNOOZE_OPTIONS.some((option) => option.hours === value);
}

export function withoutSnooze(thread: Thread): Thread {
  if (thread.snoozedUntil === undefined) return thread;
  const { snoozedUntil: _expired, ...rest } = thread;
  return rest;
}

const deadlines = new WeakMap<Thread[], number | null>();

/** One wake-up for the entire workspace; unchanged threads need no further scan. */
export function nextSnoozeExpiry(threads: Thread[]): number | null {
  if (deadlines.has(threads)) return deadlines.get(threads)!;
  let next: number | null = null;
  for (const thread of threads) {
    if (thread.archivedAt === undefined && thread.snoozedUntil !== undefined) {
      next = Math.min(next ?? Infinity, thread.snoozedUntil);
    }
  }
  deadlines.set(threads, next);
  return next;
}
