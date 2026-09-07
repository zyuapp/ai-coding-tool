import type { Project } from "../domain/project.js";
import type { Thread } from "../domain/thread.js";
import type { Worktree } from "../domain/worktree.js";

/** Where a thread's runs happen, including the two transitions that temporarily have no checkout. */
export type ThreadLocation =
  | { kind: "local" }
  | { kind: "creating" }
  | { kind: "releasing" }
  /** `threads` counts everyone in the checkout, which says whether leaving it takes it away. */
  | { kind: "worktree"; worktree: Worktree; threads: number };

type ProjectState = { projects: Project[] };
type WorktreeState = { worktrees: Worktree[] };
type ClaimState = { threads: Thread[] };
type LeavingState = ClaimState & WorktreeState & { releasingWorktrees: string[]; deletingWorktrees: string[] };
type LocationState = LeavingState & { creatingWorktrees: string[] };

export function projectFor(state: ProjectState, thread: Thread | undefined) {
  return thread?.projectId ? state.projects.find((project) => project.id === thread.projectId) : undefined;
}

export function worktreeById(state: WorktreeState, worktreeId: string | undefined) {
  return worktreeId ? state.worktrees.find((worktree) => worktree.id === worktreeId) : undefined;
}

/** The checkout a thread works in, when it works in one rather than in its project. */
export function worktreeFor(state: WorktreeState, thread: Thread | undefined) {
  return worktreeById(state, thread?.worktreeId);
}

/** Every thread still linked to a checkout, including archived threads. */
export function worktreeClaimants(state: ClaimState, worktreeId: string) {
  return state.threads.filter((thread) => thread.worktreeId === worktreeId);
}

/** The folder a thread works in: the checkout it shares once it has one, otherwise its project's. */
export function threadWorkspaceRoot(state: ProjectState & WorktreeState, thread: Thread | undefined) {
  return worktreeFor(state, thread)?.root ?? projectFor(state, thread)?.root;
}

/**
 * Where a file a message named is looked for, nearest the thread first: the checkout it works in,
 * its project's own checkout, then the project's other checkouts, most recently used first.
 */
export function threadFileRoots(state: ProjectState & WorktreeState, thread: Thread | undefined): string[] {
  const project = projectFor(state, thread);
  const siblings = project
    ? [...state.worktrees.filter((worktree) => worktree.projectId === project.id)]
        .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
        .map((worktree) => worktree.root)
    : [];
  const roots = [worktreeFor(state, thread)?.root, project?.root, ...siblings];
  return [...new Set(roots.filter((root): root is string => !!root))];
}

/** Where a thread's runs happen: the checkout it shares once it has one, otherwise its project's. */
export function threadWorkspaceId(state: ProjectState & WorktreeState, thread: Thread | undefined) {
  return worktreeFor(state, thread)?.workspaceId ?? projectFor(state, thread)?.workspaceId;
}

/**
 * Threads whose checkout is going: the ones that asked to leave, and every thread in a checkout the
 * user is deleting, whichever thread or Settings asked for it.
 */
export function leavingThreadIds(state: LeavingState): Set<string> {
  const leaving = new Set(state.releasingWorktrees);
  if (state.deletingWorktrees.length === 0) return leaving;
  const going = new Set(state.worktrees.filter((worktree) => state.deletingWorktrees.includes(worktree.root)).map((worktree) => worktree.id));
  for (const thread of state.threads) if (thread.worktreeId && going.has(thread.worktreeId)) leaving.add(thread.id);
  return leaving;
}

export function locationOf(state: LocationState, thread: Thread | undefined): ThreadLocation {
  if (thread && leavingThreadIds(state).has(thread.id)) return { kind: "releasing" };
  if (thread && state.creatingWorktrees.includes(thread.id)) return { kind: "creating" };
  const worktree = worktreeFor(state, thread);
  if (worktree) return { kind: "worktree", worktree, threads: worktreeClaimants(state, worktree.id).length };
  return { kind: "local" };
}
