/** The first dotted number in what a `--version` flag printed, whatever the command wrapped it in. */
export function readVersion(output: string): string | null {
  return /\d+(?:\.\d+)+/.exec(output)?.[0] ?? null;
}

/** Negative when `left` is older, zero when they match, positive when `left` is newer. */
export function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** A version that could not be read counts as old enough to warn about. */
export function isOlderThan(version: string | null, baseline: string): boolean {
  return version === null || compareVersions(version, baseline) < 0;
}
