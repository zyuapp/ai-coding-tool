import type { ChangedFilesResult } from "../contracts/ipc.js";
import type { Thread } from "../domain/thread.js";
import { worktreeName, type ManagedWorktree, type Worktree } from "../domain/worktree.js";

type MemberWorktreeState = {
  threads: Thread[];
  worktrees: Worktree[];
  environments: Record<string, ChangedFilesResult>;
  managedWorktrees: ManagedWorktree[] | null;
  deletingWorktrees: string[];
  releasingWorktrees: string[];
};

/** A checkout a coordinator's threads work in, with what stands between it and deletion. */
export type MemberWorktree = {
  id: string;
  root: string;
  name: string;
  branch: string | null;
  /** The coordinator's threads in it, archived ones included, since archiving keeps the checkout. */
  threads: Thread[];
  busy: boolean;
  deleting: boolean;
};

const NO_MEMBER_WORKTREES: MemberWorktree[] = [];

export function memberWorktreesView(state: MemberWorktreeState, lead: Thread | undefined, busy: Set<string>): MemberWorktree[] {
  if (!lead) return NO_MEMBER_WORKTREES;
  const members = new Map<string, Thread[]>();
  const claimants = new Map<string, Thread[]>();
  for (const thread of state.threads) {
    if (!thread.worktreeId) continue;
    claimants.set(thread.worktreeId, [...claimants.get(thread.worktreeId) ?? [], thread]);
    if (thread.parentId === lead.id && thread.role !== "coordinator") members.set(thread.worktreeId, [...members.get(thread.worktreeId) ?? [], thread]);
  }
  if (!members.size) return NO_MEMBER_WORKTREES;
  const managed = new Map(state.managedWorktrees?.map((item) => [item.root, item]));
  const deleting = new Set(state.deletingWorktrees);
  const releasing = new Set(state.releasingWorktrees);
  const checkouts = state.worktrees.filter((worktree) => members.has(worktree.id)).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  return checkouts.map((worktree) => {
    const standing = claimants.get(worktree.id) ?? [];
    const environment = state.environments[worktree.workspaceId];
    return {
      id: worktree.id,
      root: worktree.root,
      name: worktreeName(worktree),
      branch: environment?.status === "available" ? environment.branch : managed.get(worktree.root)?.branch ?? null,
      threads: members.get(worktree.id)!,
      busy: standing.some((thread) => busy.has(thread.id)),
      deleting: deleting.has(worktree.root) || standing.some((thread) => releasing.has(thread.id)),
    };
  });
}
