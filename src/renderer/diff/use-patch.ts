import { useEffect, useState } from "react";
import type { DiffPatchResult } from "../../contracts/ipc";
import { parseFilePatch, rangeKey, type DiffFile, type DiffRange } from "../../domain/diff";

export type PatchState =
  | { status: "reading" }
  | { status: "available"; file: DiffFile }
  | { status: "too-large"; limit: number }
  | { status: "error"; message: string };

/**
 * One file's patch, read when that file is opened and dropped when another is. A patch is contents
 * rather than a record, so it lives here beside the view that draws it and never becomes state.
 */
export function usePatch(workspaceId: string | undefined, range: DiffRange, path: string | null) {
  const [patch, setPatch] = useState<PatchState | null>(null);
  const key = rangeKey(range);

  useEffect(() => {
    if (!workspaceId || !path) {
      setPatch(null);
      return;
    }
    let cancelled = false;
    setPatch({ status: "reading" });
    void window.desktop.diffPatch(workspaceId, range, path)
      .then((result: DiffPatchResult) => {
        if (cancelled) return;
        setPatch(result.status === "available"
          ? { status: "available", file: parseFilePatch(result.patch, path) }
          : result);
      })
      .catch((error: unknown) => {
        if (!cancelled) setPatch({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => { cancelled = true; };
    /** Keyed by what the comparison reduces to: a fresh object still names the same two sides. */
  }, [workspaceId, key, path]);

  return patch;
}
