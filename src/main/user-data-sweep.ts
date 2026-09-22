import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { isSavedAttachmentName } from "./attachment-store.js";

const CONTEXT_SUFFIX = ".context.json";

/** How long an attachment nothing names stays: a composer or a paired device may still be about to send it. */
export const ORPHAN_ATTACHMENT_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type SweepResult = { files: number; bytes: number };

/**
 * Removes attachments no stored message names, with their context sidecars, once they are older than
 * anything still in flight could be. A sidecar whose image is gone goes the same way.
 */
export async function sweepOrphanAttachments(directory: string, referenced: ReadonlySet<string>, options: { now: number; minAgeMs: number }): Promise<SweepResult> {
  const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const result: SweepResult = { files: 0, bytes: 0 };
  for (const name of entries) {
    const image = name.endsWith(CONTEXT_SUFFIX) ? name.slice(0, -CONTEXT_SUFFIX.length) : name;
    if (!isSavedAttachmentName(image) || referenced.has(image)) continue;
    const file = path.join(directory, name);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || info.mtimeMs > options.now - options.minAgeMs) continue;
    await rm(file, { force: true });
    result.files += 1;
    result.bytes += info.size;
  }
  return result;
}

/** What each stored message names, by file name, so the sweep can compare against the directory. */
export function attachmentNames(paths: Iterable<string>): Set<string> {
  const names = new Set<string>();
  for (const file of paths) names.add(path.basename(file));
  return names;
}

/**
 * A reverted build once gave Codex a home under the app's data folder. The private home replaced
 * it and nothing has read it since, so it goes wherever the caller sends it, such as the Trash.
 */
export async function retireLegacyCodexHome(userData: string, discard: (target: string) => Promise<void>): Promise<boolean> {
  const legacy = path.join(userData, "codex");
  const info = await stat(legacy).catch(() => null);
  if (!info?.isDirectory()) return false;
  await discard(legacy);
  return true;
}
