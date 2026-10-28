import type { Thread } from "./thread.js";
import { SETTINGS_PAGE_LABELS } from "./settings-catalog.js";

export const ARCHIVE_RETENTION_MS = 5 * 24 * 60 * 60 * 1000;

/** The question asked before the user archives a thread, on every screen. */
export function archiveQuestion(title: string): string {
  return `Archive “${title || "Untitled thread"}”?`;
}

/** What archiving does, said under {@link archiveQuestion}. A running thread's run is cancelled. */
export function archiveConsequence(running: boolean, phone = false): string {
  const days = Math.round(ARCHIVE_RETENTION_MS / 86_400_000);
  const where = `Settings › ${SETTINGS_PAGE_LABELS.archive}${phone ? " on your computer" : ""}`;
  return `${running ? "Its run stops and it" : "It"} leaves the ${phone ? "list" : "sidebar"}. Restore it from ${where} within ${days} days.`;
}

/** Archiving keeps a thread recoverable for {@link ARCHIVE_RETENTION_MS}; the next launch drops what outlived that. */
export function retainedThreads<T extends Thread>(threads: T[], at: number): T[] {
  let retained: T[] | null = null;
  for (let index = 0; index < threads.length; index += 1) {
    const thread = threads[index]!;
    if (thread.archivedAt !== undefined && at - thread.archivedAt >= ARCHIVE_RETENTION_MS) {
      retained ??= threads.slice(0, index);
    } else {
      retained?.push(thread);
    }
  }
  return retained ?? threads;
}
