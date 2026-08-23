import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Bigger than any path anyone writes, and small enough that nothing chokes on the argument. */
const MAX_FILE_PATH = 4_096;

/**
 * The file a message named, as an absolute path the desktop can open. A message is only prose, so
 * the path it wrote has to land inside the checkout the thread works in before anything opens it.
 */
export async function fileInCheckout(root: unknown, candidate: unknown) {
  if (typeof root !== "string" || !root) throw new Error("Invalid folder.");
  if (typeof candidate !== "string" || !candidate || candidate.length > MAX_FILE_PATH) throw new Error("Invalid file path.");
  const named = candidate.startsWith("~/") ? path.join(homedir(), candidate.slice(2)) : candidate;
  try {
    const [checkout, file] = await Promise.all([realpath(root), realpath(path.resolve(root, named))]);
    if (!isPathInside(checkout, file)) throw new Error("That file is outside this thread's folder.");
    return file;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("That file is not there any more.");
    throw error;
  }
}

export function isPathInside(root: string, candidate: string) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

async function canonicalWritePath(candidate: string) {
  let pending = path.resolve(candidate);
  const suffix: string[] = [];

  while (true) {
    try {
      const existing = await realpath(pending);
      return suffix.reduceRight((current, part) => path.join(current, part), existing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
      const parent = path.dirname(pending);
      if (parent === pending) return null;
      suffix.push(path.basename(pending));
      pending = parent;
    }
  }
}

export async function isWritePathInside(root: string, candidate: string) {
  const rootedCandidate = path.isAbsolute(candidate) ? candidate : path.resolve(root, candidate);
  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    canonicalWritePath(root),
    canonicalWritePath(rootedCandidate),
  ]);
  return canonicalRoot !== null && canonicalCandidate !== null && isPathInside(canonicalRoot, canonicalCandidate);
}
