/**
 * Running totals by key, each read off a report of everything its key has spent so far. A report
 * adds only what its total grew by since the key was last seen, so one sent again, or one behind a
 * later one, adds nothing. A key seen for the first time starts from `baseline`, such as what a
 * resumed thread spent before this session.
 */
export class RunningTotals extends Map<string, number> {
  /** What `key`'s total grew by, now taken as seen; nothing for a total that did not grow or is no count at all. */
  grow(key: string, total: number, baseline = 0): number {
    if (!Number.isSafeInteger(total) || total < 0) return 0;
    const seen = this.get(key) ?? baseline;
    this.set(key, Math.max(seen, total));
    return Math.max(0, total - seen);
  }
}
