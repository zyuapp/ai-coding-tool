/**
 * A checkout of a project that any number of threads can work in. Each of them keeps its project and
 * its place in the sidebar; only the directory its runs happen in changes. The checkout outlives any
 * one of them and goes when the last one lets go, so when a thread's session forked into it is the
 * thread's own to record, not the checkout's.
 */
export type Worktree = {
  /** Names the directory and the ref a snapshot commit is kept alive by. */
  id: string;
  /** The project whose repository this is a checkout of, which is where the sidebar lists it. */
  projectId: string;
  root: string;
  workspaceId: string;
  /** The commit the worktree was created detached at. */
  baseCommit: string;
  createdAt: number;
  /** Moved by every run in here, whichever thread asked for it. */
  lastUsedAt: number;
};

/** Why a worktree let go of its thread. A snapshot commit records this in its message. */
export type WorktreeRelease = "returned-to-local" | "evicted";

export const CLAUDEX_REF_NAMESPACE = "refs/claudex";

export function worktreeRef(worktreeId: string) {
  return `${CLAUDEX_REF_NAMESPACE}/${worktreeId}`;
}

const RELEASE_REASONS: Record<WorktreeRelease, string> = {
  "returned-to-local": "returned to local",
  evicted: "reaped, no thread claimed it",
};

export function releaseReason(release: WorktreeRelease) {
  return RELEASE_REASONS[release];
}

/**
 * The snapshot a worktree is force-committed to before it lets go of its thread. The subject is
 * prefixed so these never read as hand-written work and `git log --grep=claudex` finds them all.
 */
export function snapshotMessage(title: string, taskId: string | null, release: WorktreeRelease, ref: string | null) {
  return [
    `claudex: snapshot "${title}"`,
    "",
    [taskId ? `Thread ${taskId}` : "No thread", releaseReason(release)].join(" · "),
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

/**
 * The id inside a directory the app made, so a checkout found on disk can be snapshotted under the
 * same ref its thread would have used. A name from anywhere else stands in for itself.
 */
export function worktreeIdFromDirectoryName(name: string) {
  return /-([0-9a-f]{8})$/.exec(name)?.[1] ?? name.replace(/[^A-Za-z0-9-]+/g, "-");
}

export function isWorktree(value: unknown): value is Worktree {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const worktree = value as Record<string, unknown>;
  return nonEmptyString(worktree.id)
    && nonEmptyString(worktree.projectId)
    && nonEmptyString(worktree.root)
    && nonEmptyString(worktree.workspaceId)
    && nonEmptyString(worktree.baseCommit)
    && finiteNumber(worktree.createdAt)
    && finiteNumber(worktree.lastUsedAt);
}

/** How the sidebar and the session panel name a checkout: the directory `git worktree list` shows. */
export function worktreeName(worktree: Worktree) {
  return worktree.root.split("/").filter(Boolean).at(-1) ?? worktree.id;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
