import { realpath, stat } from "node:fs/promises";
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

/** How many places one link is allowed to be looked for, so a deep path cannot fan out without end. */
const MAX_FILE_CANDIDATES = 256;

/** A path written with a Windows drive, which is absolute even where `path` is POSIX. */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

function isAbsoluteWritten(candidate: string) {
  return path.isAbsolute(candidate) || WINDOWS_DRIVE.test(candidate);
}

/**
 * The places a written path might really be, nearest the thread first. A path that exists as written
 * is that file. Anything else is repaired by re-anchoring its tail on each checkout, which is what
 * finds a file named from the wrong folder or from a sibling checkout of the same project.
 */
function fileCandidates(roots: string[], named: string): string[] {
  const segments = named.split(/[\\/]+/).filter((part) => part && part !== ".");
  const exact = isAbsoluteWritten(named) ? [path.resolve(named)] : roots.map((root) => path.resolve(root, named));
  const tails = segments.slice(1).map((_, index) => segments.slice(index + 1).join(path.sep));
  const repairs = roots.flatMap((root) => tails.map((tail) => path.resolve(root, tail)));
  return [...new Set([...exact, ...repairs])].slice(0, MAX_FILE_CANDIDATES);
}

async function isReadableFile(target: string) {
  return stat(target).then((entry) => entry.isFile(), () => false);
}

/**
 * The file a link names, as an absolute path the desktop can open. A message is only prose, so the
 * path it wrote is a guess: it is looked for in the thread's checkout, in the project's, and in the
 * project's other checkouts, before being taken as written. A file outside all of them still opens,
 * since the user may well have asked the run to work on one.
 */
export async function openableFile(roots: unknown, candidate: unknown) {
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string" || !root)) throw new Error("Invalid folder.");
  if (typeof candidate !== "string" || !candidate || candidate.length > MAX_FILE_PATH) throw new Error("Invalid file path.");
  const named = candidate.startsWith("~/") ? path.join(homedir(), candidate.slice(2)) : candidate;
  for (const target of fileCandidates(roots as string[], named)) {
    if (await isReadableFile(target)) return realpath(target).catch(() => target);
  }
  throw new Error(`AI Coding Tool could not find ${candidate} on this machine.`);
}
