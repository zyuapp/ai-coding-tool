import { WORKSPACE_ERRORS, type WorkspaceEffect, type WorkspaceEvent } from "../../application/workspace-reducer";
import type { DesktopAPI } from "../../contracts/ipc";

type ResolveEffect = Extract<WorkspaceEffect, { type: "resolve-run-workspace" }>;

/** What resolving a run's checkout needs from the outside, and nothing more. */
export type ResolveDesktop = Pick<DesktopAPI, "createBranch" | "checkoutBranch" | "createWorktree" | "projectlessWorkspace" | "openFolder">;

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Git says what went wrong but not what was being attempted, so each step names itself on the way out. */
async function step<T>(attempt: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new Error(`Could not ${attempt}: ${message(error)}`);
  }
}

/**
 * Turns a resolution request into the event that answers it. A workspace the reducer already named
 * is handed straight back, so nothing here ever decides what kind of checkout a run happens in.
 */
export async function resolveRunWorkspace(effect: ResolveEffect, desktop: ResolveDesktop): Promise<WorkspaceEvent> {
  const { pendingId } = effect;
  try {
    /** A branch named but not yet in the repository has to exist before anything starts from it. */
    if (effect.createBranch) {
      const { workspaceId, branch } = effect.createBranch;
      await step(`create the branch ${branch}`, () => desktop.createBranch(workspaceId, branch));
    }
    /** A branch a thread starts from moves the project checkout, so it happens before the run. */
    if (effect.checkout) {
      const { workspaceId, branch } = effect.checkout;
      await step(`check out ${branch}`, () => desktop.checkoutBranch(workspaceId, branch));
    }
    if (effect.createWorktree) {
      const making = effect.createWorktree;
      const worktree = await step("create the worktree", () => desktop.createWorktree(making));
      return { type: "run.resolved", pendingId, workspace: { id: worktree.workspaceId, kind: "worktree", root: worktree.root }, worktree };
    }
    if (effect.workspace) return { type: "run.resolved", pendingId, workspace: effect.workspace };
    if (!effect.picker) return { type: "run.resolved", pendingId, workspace: await desktop.projectlessWorkspace() };
    const selected = await desktop.openFolder();
    if (!selected) return { type: "run.unresolved", pendingId, message: WORKSPACE_ERRORS.reopenProject };
    if (selected.root !== effect.root) return { type: "run.unresolved", pendingId, message: WORKSPACE_ERRORS.sameProject };
    return { type: "run.resolved", pendingId, workspace: selected };
  } catch (error) {
    return { type: "run.unresolved", pendingId, message: message(error) };
  }
}
