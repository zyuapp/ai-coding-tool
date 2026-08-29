import type { Thread } from "./thread.js";

export const ARCHIVE_RETENTION_MS = 5 * 24 * 60 * 60 * 1000;

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
