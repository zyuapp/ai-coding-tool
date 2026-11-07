import { createContext } from "react";
import type { Thread } from "../domain/thread";

/** Each thread's title by ID, so a tool call that names a thread reads by what the thread is called. */
export const ThreadNames = createContext<ReadonlyMap<string, string>>(new Map());

/** The thread a tool call named: by its ID, an unambiguous prefix of one, or its exact title. */
export function resolveThread(names: ReadonlyMap<string, string>, reference: string): { id: string; title: string } | null {
  const exact = names.get(reference);
  if (exact !== undefined) return { id: reference, title: exact };
  let found: { id: string; title: string } | null = null;
  for (const [id, title] of names) {
    if (title !== reference && !id.startsWith(reference)) continue;
    if (found) return null;
    found = { id, title };
  }
  return found;
}

/** Titles by ID, handing back the map from before when no title or thread changed. */
export function threadNamesOf(threads: readonly Thread[], previous: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const same = threads.length === previous.size && threads.every((thread) => previous.get(thread.id) === thread.title);
  return same ? previous : new Map(threads.map((thread) => [thread.id, thread.title]));
}
