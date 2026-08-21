import { useEffect, useRef, useState } from "react";
import { languageForPath, parseFilePatch, rangeKey, type DiffFile, type DiffRange } from "../../domain/diff";
import { ensureLanguage } from "./highlight";

export type PatchState =
  | { status: "reading" }
  | { status: "available"; file: DiffFile }
  | { status: "too-large"; limit: number }
  | { status: "error"; message: string };

/**
 * A file to read. `version` names that file at those counts, so it is both the cache's key and what
 * makes a file that has been rewritten under the user get read again rather than drawn from before.
 */
export type PatchRequest = { path: string; previousPath?: string; version: string };

/** How many patches are read at once. Git is a process per file, so they are not all asked for. */
const CONCURRENCY = 4;

/**
 * The patches for the files on screen, read as they are asked for and held beside the view. A patch
 * is contents rather than a record, so it never becomes state: the reducer holds the list of files
 * and this holds what is in them, the way a page's contents live with the page.
 *
 * A fresh map is published on every arrival, so whatever draws these can memoise on it.
 */
export function usePatches(workspaceId: string | undefined, range: DiffRange, requests: PatchRequest[]) {
  const key = `${workspaceId ?? ""}|${rangeKey(range)}`;
  const cache = useRef(new Map<string, PatchState>());
  const [patches, setPatches] = useState<Map<string, PatchState>>(cache.current);
  const wanted = requests.map((request) => request.version).join("\n");

  useEffect(() => {
    if (!workspaceId) return;
    const missing = requests.filter((request) => !cache.current.has(`${key}|${request.version}`));
    if (missing.length === 0) return;
    let cancelled = false;
    for (const request of missing) cache.current.set(`${key}|${request.version}`, { status: "reading" });
    setPatches(new Map(cache.current));

    const queue = [...missing];
    const read = async () => {
      while (!cancelled) {
        const request = queue.shift();
        if (!request) return;
        /** The grammar is fetched beside the patch, so the lines are coloured the moment they are drawn. */
        const [state] = await Promise.all([
          window.desktop.diffPatch(workspaceId, range, request.path, request.previousPath)
            .then((result): PatchState => result.status === "available"
              ? { status: "available", file: parseFilePatch(result.patch, request.path) }
              : result)
            .catch((error: unknown): PatchState => ({ status: "error", message: error instanceof Error ? error.message : String(error) })),
          ensureLanguage(languageForPath(request.path)),
        ]);
        if (cancelled) return;
        cache.current.set(`${key}|${request.version}`, state);
        setPatches(new Map(cache.current));
      }
    };
    void Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, read));

    return () => {
      cancelled = true;
      /**
       * A read that never finished must not be remembered as still reading, or its file never loads
       * again. That covers both the ones still queued and the one a worker was part way through.
       */
      for (const request of missing) {
        const held = `${key}|${request.version}`;
        if (cache.current.get(held)?.status === "reading") cache.current.delete(held);
      }
    };
    /** Keyed by what the comparison reduces to and by what is being asked for, not by fresh objects. */
  }, [workspaceId, key, wanted]);

  /** Nothing outside the comparison on screen is worth holding, so the cache cannot grow past it. */
  useEffect(() => {
    const live = new Set(requests.map((request) => `${key}|${request.version}`));
    let dropped = false;
    for (const held of [...cache.current.keys()]) {
      if (live.has(held)) continue;
      cache.current.delete(held);
      dropped = true;
    }
    if (dropped) setPatches(new Map(cache.current));
  }, [key, wanted]);

  return { patches, at: (version: string) => patches.get(`${key}|${version}`) };
}
