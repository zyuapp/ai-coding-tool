import { errorMessage } from "./errors";
import type { EffectHandlers, EffectHost, EnvironmentRefreshEffect } from "./effect-host";

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

/** The project's folder, its checkouts, and what Git says about them. */
export const projectEffects = {
  "pick-project": async (_effect, { dispatch, desktop }) => {
    try {
      const workspace = await desktop.openFolder();
      if (workspace) await dispatch({ type: "project.opened", workspace });
    } catch (error) {
      await dispatch({ type: "action.failed", message: errorMessage(error) });
    }
  },

  "register-project": async (effect, { dispatch, desktop }) => {
    try {
      const workspace = await desktop.registerProject(effect.root);
      await dispatch({ type: "project.registered", projectId: effect.projectId, workspace });
    } catch (error) {
      await dispatch({ type: "project.register-failed", projectId: effect.projectId, message: errorMessage(error) });
    }
  },

  "create-worktree": async (effect, { dispatch, desktop }) => {
    try {
      const worktree = await desktop.createWorktree({ projectRoot: effect.projectRoot, carryChanges: !effect.move });
      if (effect.name) worktree.name = effect.name;
      await dispatch({ type: "worktree.created", taskId: effect.taskId, worktree, move: effect.move, projectId: effect.projectId });
    } catch (error) {
      await dispatch({ type: "worktree.failed", taskId: effect.taskId, message: `Could not create the worktree: ${errorMessage(error)}` });
    }
  },

  "release-worktree": async (effect, { dispatch, desktop }) => {
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
      await dispatch({ type: "worktree.release-failed", taskId: effect.taskId, message: errorMessage(error) });
    }
  },

  "list-worktrees": async (_effect, { dispatch, desktop }) => {
    try {
      await dispatch({ type: "worktrees.loaded", worktrees: await desktop.listManagedWorktrees() });
    } catch (error) {
      await dispatch({ type: "worktrees.failed", message: errorMessage(error) });
    }
  },

  "reveal-worktree": async (effect, { dispatch, desktop }) => {
    try {
      await desktop.revealWorktree(effect.root);
    } catch (error) {
      await dispatch({ type: "worktrees.failed", message: errorMessage(error) });
    }
  },

  "delete-worktree": async (effect, { dispatch, desktop }) => {
    try {
      const snapshot = await desktop.releaseWorktree({
        worktreeId: effect.worktreeId,
        root: effect.root,
        taskId: null,
        title: effect.title,
        release: "deleted",
        missingOnly: effect.missingOnly,
      });
      await dispatch({ type: "worktree.deleted", worktreeId: effect.worktreeId, root: effect.root, snapshot, missingOnly: effect.missingOnly });
    } catch (error) {
      await dispatch({ type: "worktrees.failed", root: effect.root, message: errorMessage(error) });
    }
  },

  "refresh-environment": (effect, host) => refreshEnvironment(effect, host),

  "read-diff": async (effect, { dispatch, desktop }) => {
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
  },

  "checkout-branch": async (effect, { dispatch, desktop }) => {
    try {
      if (effect.create) await desktop.createBranch(effect.workspaceId, effect.branch);
      await desktop.checkoutBranch(effect.workspaceId, effect.branch);
    } catch (error) {
      await dispatch({ type: "action.failed", message: errorMessage(error) });
    }
    await dispatch({ type: "view.refresh-environment" });
  },
} satisfies Partial<EffectHandlers>;
