/**
 * A checkout of a project that belongs to one thread. The thread keeps its project and its place in
 * the sidebar; only the directory its runs happen in changes.
 */
export type Worktree = {
  /** Names the directory and the ref a snapshot commit is kept alive by. */
  id: string;
  root: string;
  workspaceId: string;
  /** The commit the worktree was created detached at. */
  baseCommit: string;
  createdAt: number;
  lastUsedAt: number;
  /** Set by the first run that happens here. Before that the thread's session has yet to fork. */
  enteredAt?: number;
};

/** Why a worktree let go of its thread. A snapshot commit records this in its message. */
export type WorktreeRelease = "returned-to-local" | "evicted";

export const CLAUDEX_REF_NAMESPACE = "refs/claudex";

export function worktreeRef(worktreeId: string) {
  return `${CLAUDEX_REF_NAMESPACE}/${worktreeId}`;
}

const RELEASE_REASONS: Record<WorktreeRelease, string> = {
  "returned-to-local": "returned to local",
  evicted: "evicted at the worktree limit",
};

export function releaseReason(release: WorktreeRelease) {
  return RELEASE_REASONS[release];
}

/**
 * The snapshot a worktree is force-committed to before it lets go of its thread. The subject is
 * prefixed so these never read as hand-written work and `git log --grep=claudex` finds them all.
 */
export function snapshotMessage(title: string, taskId: string, release: WorktreeRelease, ref: string | null) {
  return [
    `claudex: snapshot "${title}"`,
    "",
    `Thread ${taskId} · ${releaseReason(release)}`,
    ...(ref ? [`Ref ${ref}`] : []),
  ].join("\n");
}

const SLUG_LIMIT = 24;

/** The directory a worktree gets: the project's name, so `git worktree list` stays readable, plus its id. */
export function worktreeDirectoryName(projectRoot: string, worktreeId: string) {
  const name = projectRoot.split("/").filter(Boolean).at(-1) ?? "project";
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, SLUG_LIMIT);
  return `${slug || "project"}-${worktreeId}`;
}

export function isWorktree(value: unknown): value is Worktree {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const worktree = value as Record<string, unknown>;
  return nonEmptyString(worktree.id)
    && nonEmptyString(worktree.root)
    && nonEmptyString(worktree.workspaceId)
    && nonEmptyString(worktree.baseCommit)
    && finiteNumber(worktree.createdAt)
    && finiteNumber(worktree.lastUsedAt)
    && (worktree.enteredAt === undefined || finiteNumber(worktree.enteredAt));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
