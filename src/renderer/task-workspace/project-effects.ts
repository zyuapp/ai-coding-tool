import type { WorkspaceEffect } from "../../application/workspace-reducer";
import { errorMessage } from "./errors";
import type { EffectHost, EnvironmentRefreshEffect } from "./effect-host";

/** The project's folder, its checkouts, and what Git says about them. */
export type ProjectEffect = Extract<WorkspaceEffect, {
  type: "pick-project" | "register-project" | "create-worktree" | "release-worktree" | "list-worktrees"
    | "reveal-worktree" | "delete-worktree" | "refresh-environment" | "read-diff" | "checkout-branch";
}>;

/** One Git scan per checkout. A tick during a slow scan replaces the one follow-up still needed. */
async function refreshEnvironment(first: EnvironmentRefreshEffect, host: EffectHost) {
  const { dispatch, environmentRefreshes } = host;
  if (environmentRefreshes.current.has(first.workspaceId)) {
    environmentRefreshes.current.set(first.workspaceId, first);
    return;
  }
  environmentRefreshes.current.set(first.workspaceId, null);
  let effect: EnvironmentRefreshEffect | null = first;
  try {
    while (effect) {
      try {
        const result = await host.desktop.changedFiles(effect.workspaceId);
        await dispatch({ type: "environment.updated", workspaceId: effect.workspaceId, ...(effect.taskId ? { taskId: effect.taskId } : {}), ...(effect.runId ? { runId: effect.runId } : {}), result });
      } catch (error) {
        await dispatch({ type: "environment.updated", workspaceId: effect.workspaceId, result: { status: "error", message: errorMessage(error) } });
      }
      effect = environmentRefreshes.current.get(first.workspaceId) ?? null;
      environmentRefreshes.current.set(first.workspaceId, null);
    }
  } finally {
    environmentRefreshes.current.delete(first.workspaceId);
  }
}

export async function runProjectEffect(effect: ProjectEffect, host: EffectHost): Promise<void> {
  const { dispatch, desktop } = host;
  switch (effect.type) {
    case "pick-project":
      try {
        const workspace = await desktop.openFolder();
        if (workspace) await dispatch({ type: "project.opened", workspace });
      } catch (error) {
        await dispatch({ type: "action.failed", message: errorMessage(error) });
      }
      return;

    case "register-project":
      try {
        const workspace = await desktop.registerProject(effect.root);
        await dispatch({ type: "project.registered", projectId: effect.projectId, workspace });
      } catch (error) {
        await dispatch({ type: "project.register-failed", projectId: effect.projectId, message: errorMessage(error) });
      }
      return;

    case "create-worktree":
      try {
        const worktree = await desktop.createWorktree({ projectRoot: effect.projectRoot, carryChanges: true });
        await dispatch({ type: "worktree.created", taskId: effect.taskId, worktree });
      } catch (error) {
        await dispatch({ type: "worktree.failed", taskId: effect.taskId, message: `Could not create the worktree: ${errorMessage(error)}` });
      }
      return;

    case "release-worktree":
      try {
        const snapshot = await desktop.releaseWorktree({
          worktreeId: effect.worktreeId,
          root: effect.root,
          taskId: effect.taskId,
          title: effect.title,
          release: "returned-to-local",
        });
        await dispatch({ type: "worktree.released", taskId: effect.taskId, snapshot });
      } catch (error) {
        await dispatch({ type: "action.failed", message: errorMessage(error) });
      }
      return;

    case "list-worktrees":
      try {
        await dispatch({ type: "worktrees.loaded", worktrees: await desktop.listManagedWorktrees() });
      } catch (error) {
        await dispatch({ type: "worktrees.failed", message: errorMessage(error) });
      }
      return;

    case "reveal-worktree":
      try {
        await desktop.revealWorktree(effect.root);
      } catch (error) {
        await dispatch({ type: "worktrees.failed", message: errorMessage(error) });
      }
      return;

    case "delete-worktree":
      try {
        const snapshot = await desktop.releaseWorktree({
          worktreeId: effect.worktreeId,
          root: effect.root,
          taskId: null,
          title: effect.title,
          release: "deleted",
        });
        await dispatch({ type: "worktree.deleted", worktreeId: effect.worktreeId, root: effect.root, snapshot });
      } catch (error) {
        await dispatch({ type: "worktrees.failed", root: effect.root, message: errorMessage(error) });
      }
      return;

    case "refresh-environment":
      return refreshEnvironment(effect, host);

    case "read-diff":
      try {
        const result = await desktop.diffSummary(effect.workspaceId, effect.range, effect.ignoreWhitespace);
        await dispatch({ type: "diff.loaded", owner: effect.owner, workspaceId: effect.workspaceId, range: effect.range, result });
      } catch (error) {
        await dispatch({
          type: "diff.loaded",
          owner: effect.owner,
          workspaceId: effect.workspaceId,
          range: effect.range,
          result: { status: "error", message: errorMessage(error) },
        });
      }
      return;

    case "checkout-branch":
      try {
        if (effect.create) await desktop.createBranch(effect.workspaceId, effect.branch);
        await desktop.checkoutBranch(effect.workspaceId, effect.branch);
      } catch (error) {
        await dispatch({ type: "action.failed", message: errorMessage(error) });
      }
      await dispatch({ type: "view.refresh-environment" });
      return;
  }
}
