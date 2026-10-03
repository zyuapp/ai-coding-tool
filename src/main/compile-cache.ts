import { enableCompileCache, flushCompileCache } from "node:module";
import os from "node:os";
import path from "node:path";

/**
 * Caches compiled code for every module loaded after this one, across launches. Shared by every
 * build and process of the app: Node keys entries by its own version and each file's content.
 */
enableCompileCache?.(path.join(os.tmpdir(), "ai-coding-tool-compile-cache"));

/** Writes what has been compiled so far, since a process that is killed never writes it itself. */
export function persistCompileCache() {
  flushCompileCache?.();
}
