import { array, boolean, literals, nullableText, optionalBoolean, optionalText, text, type Declarations } from "./command-declaration.js";
import { isString } from "./ipc.js";

/** Manual worktree management. Deletion snapshots loose work before removing the directory. */
export type WorktreeCommand =
  | { type: "worktree.menu-open"; list: "threads" | "destinations" }
  | { type: "worktree.menu-search"; list: "threads" | "destinations"; query: string }
  | { type: "worktree.refresh" }
  | { type: "worktree.filter-project"; project: string | null }
  | { type: "worktree.confirm-delete"; root: string | null }
  | { type: "worktree.confirm-delete-safe"; open: boolean }
  /** Deletes each named checkout that is still safe to delete; the rest stay. */
  | { type: "worktree.delete-safe"; roots: string[] }
  | { type: "worktree.set-missing-open"; open: boolean }
  | { type: "worktree.set-threads-open"; root: string; open: boolean }
  | { type: "worktree.open-thread"; taskId: string }
  | { type: "worktree.reveal"; root: string }
  /** Names the checkout by `worktreeId`, by `root`, or as the one `taskId` works in. */
  | { type: "worktree.delete"; taskId?: string; root?: string; worktreeId?: string; missingOnly?: boolean };

/** An id, never a path or the thread on screen, and never the folder-is-gone shortcut. */
function deletesWorktreeById(command: Extract<WorktreeCommand, { type: "worktree.delete" }>): boolean {
  return isString(command.worktreeId) && command.taskId === undefined && command.root === undefined && command.missingOnly === undefined;
}

export const worktreeCommands = {
  "worktree.menu-open": { fields: { list: literals("threads", "destinations") }, at: "own" },
  "worktree.menu-search": { fields: { list: literals("threads", "destinations"), query: text }, at: "local" },
  "worktree.refresh": { fields: {}, at: "local" },
  "worktree.filter-project": { fields: { project: nullableText }, at: "local" },
  "worktree.confirm-delete": { fields: { root: nullableText }, at: "own" },
  "worktree.confirm-delete-safe": { fields: { open: boolean }, at: "local" },
  "worktree.delete-safe": { fields: { roots: array(text) }, at: "local" },
  "worktree.set-missing-open": { fields: { open: boolean }, at: "local" },
  "worktree.set-threads-open": { fields: { root: text, open: boolean }, at: "local" },
  "worktree.open-thread": { fields: { taskId: text }, at: "select", leaves: true },
  "worktree.reveal": { fields: { root: text }, at: "own" },
  "worktree.delete": { fields: { taskId: optionalText, root: optionalText, worktreeId: optionalText, missingOnly: optionalBoolean }, at: "own", agent: deletesWorktreeById },
} satisfies Declarations<WorktreeCommand>;
