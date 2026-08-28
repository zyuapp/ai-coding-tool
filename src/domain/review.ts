/** What Codex reviews when the user starts a native review turn. */
export type ReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title: string | null }
  | { type: "custom"; instructions: string };

/** The app server receives review targets across IPC, so their free text stays bounded. */
export function isReviewTarget(value: unknown): value is ReviewTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  if (target.type === "uncommittedChanges") return true;
  if (target.type === "baseBranch") return bounded(target.branch, 4_096);
  if (target.type === "commit") return bounded(target.sha, 256) && (target.title === null || bounded(target.title, 10_000));
  if (target.type === "custom") return bounded(target.instructions, 1_000_000);
  return false;
}

function bounded(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit;
}
