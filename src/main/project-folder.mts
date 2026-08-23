import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { projectRootsAreOwn } from "./task-database.mjs";

/**
 * A folder the user typed rather than picked. Everything the picker guarantees has to be checked
 * here instead: that it is a directory, and that it is theirs rather than a checkout the app made.
 */
export async function projectFolder(root: unknown, worktreesRoots: string[]) {
  if (typeof root !== "string" || !root.trim()) throw new Error("Name a folder to open.");
  const named = root.trim();
  const expanded = named === "~" || named.startsWith("~/") ? path.join(homedir(), named.slice(1)) : named;
  if (!path.isAbsolute(expanded)) throw new Error("Name the folder by its full path.");
  if (!projectRootsAreOwn([{ root: expanded }], worktreesRoots)) {
    throw new Error("That folder is a checkout this app made. Name the repository it was cut from.");
  }
  const stats = await stat(expanded).catch(() => null);
  if (!stats) throw new Error(`There is no folder at ${expanded}.`);
  if (!stats.isDirectory()) throw new Error(`${expanded} is a file, not a folder.`);
  return expanded;
}
