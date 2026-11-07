import { worktreeName } from "../domain/worktree.js";
import type { MobileWorktreeChoice } from "../contracts/mobile.js";
import type { WorkspaceState } from "./workspace-state.js";

/** The project's checkouts a draft can start in, most recently used first, without the one it is in. */
export function worktreeChoices(state: Pick<WorkspaceState, "worktrees" | "managedWorktrees" | "deletingWorktrees" | "environments">, projectId: string, except: string | undefined): MobileWorktreeChoice[] {
  const managed = state.managedWorktrees ? new Map(state.managedWorktrees.map((item) => [item.root, item])) : null;
  const deleting = new Set(state.deletingWorktrees);
  return state.worktrees
    .filter((worktree) => worktree.projectId === projectId && worktree.id !== except && !deleting.has(worktree.root))
    .filter((worktree) => !managed || managed.get(worktree.root)?.repository)
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
    .map((worktree) => {
      const environment = state.environments[worktree.workspaceId];
      const branch = environment?.status === "available" ? environment.branch : managed?.get(worktree.root)?.branch ?? null;
      return { id: worktree.id, name: worktreeName(worktree), branch };
    });
}
