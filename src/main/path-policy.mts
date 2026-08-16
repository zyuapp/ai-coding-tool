import { realpath } from "node:fs/promises";
import path from "node:path";

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
