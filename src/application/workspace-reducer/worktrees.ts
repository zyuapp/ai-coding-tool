/** Where a thread works: the branch it starts from, and the checkouts the app keeps. */
import { reduceDiffs } from "./diffs.js";
import { SWITCH_PROJECT_ERROR, SWITCH_RUNNING_ERROR, WORKTREE_CREATING_ERROR, WORKTREE_MISSING_ERROR, WORKTREE_PROJECT_ERROR, WORKTREE_RELEASING_ERROR, WORKTREE_RUNNING_ERROR, dropWorktree, leaveWorktree, now, releaseWorktrees, rereadDiff, runsInWorkspace, settled, targetId, threadBusy, withCreatingWorktree, withReleasingWorktree, withoutCreatingWorktree, withoutReleasingWorktree } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { applyTask } from "../task-workspace.js";
import { leavingTaskIds, projectFor, taskWorkspaceId, withoutWorktreeRoot, worktreeFor, type WorkspaceState } from "../workspace-state.js";
import { createTaskMessage } from "../../domain/task.js";
import type { Worktree } from "../../domain/worktree.js";

type WorktreeInput = Extract<WorkspaceInput, {
  type: "view.move-worktree" | "task.set-worktree" | "task.set-branch" | "task.checkout-branch" | "worktree.refresh" | "worktree.reveal"
    | "worktree.delete" | "worktree.created" | "worktree.failed" | "worktrees.loaded" | "worktrees.failed"
    | "worktree.released" | "worktree.release-failed" | "worktree.deleted";
}>;

export function reduceWorktrees(state: WorkspaceState, input: WorktreeInput): WorkspaceTransition {
  /** A move that goes ahead answers the confirmation, so the question never outlives its answer. */
  if (input.type === "task.set-worktree" && state.worktreeMove) return reduceWorktrees({ ...state, worktreeMove: null }, input);

  switch (input.type) {
    /**
     * Asks before moving, but only where the answer could cost something. A thread with no checkout
     * yet, and a clean one walking back to the project, have nothing to lose, so they just go.
     */
    case "view.move-worktree": {
      if (input.worktree === null) return settled({ ...state, worktreeMove: null });
      const taskId = targetId(state, undefined);
      const task = taskId ? state.tasks.find((item) => item.id === taskId) : undefined;
      const move = { type: "task.set-worktree", worktree: input.worktree } as const;
      if (!task) return reduceWorktrees(state, move);
      if (input.worktree === Boolean(task.worktreeId)) return settled(state);
      const workspaceId = taskWorkspaceId(state, task);
      const environment = workspaceId ? state.environments[workspaceId] : undefined;
      const holding = environment?.status === "available" ? environment.files.length : 0;
      if (!input.worktree && !holding) return reduceWorktrees(state, move);
      return settled({ ...state, worktreeMove: { taskId: task.id, worktree: input.worktree } });
    }

    /**
     * Moves the thread there and then, so it is never left saying it will move later. Turning it off
     * takes this thread's claim off the checkout; the last claim to go takes the directory with it,
     * and what it still holds is committed first.
     */
    case "task.set-worktree": {
      const taskId = targetId(state, input.taskId);
      const task = taskId ? state.tasks.find((item) => item.id === taskId) : undefined;
      /** With no thread yet the answer is a draft: the checkout is made when the first message goes. */
      /** Asking for a checkout of its own is asking for a new one, so it drops any the user had picked. */
      if (!task) return settled(input.taskId === undefined ? { ...state, draftWorktree: input.worktree, draftWorktreeId: null } : state);
      if (state.creatingWorktrees.includes(task.id)) return settled({ ...state, actionError: WORKTREE_CREATING_ERROR });
      if (leavingTaskIds(state).has(task.id)) return settled({ ...state, actionError: WORKTREE_RELEASING_ERROR });
      if (threadBusy(state, task.id)) return settled({ ...state, actionError: WORKTREE_RUNNING_ERROR });
      if (input.worktree) {
        if (task.worktreeId) return settled(state);
        const project = projectFor(state, task);
        if (!project?.workspaceId) return settled({ ...state, actionError: WORKTREE_PROJECT_ERROR });
        return settled(withCreatingWorktree(state, task.id), [{ type: "create-worktree", taskId: task.id, projectRoot: project.root }]);
      }
      const leaving = worktreeFor(state, task);
      if (!leaving) return settled(state);
      const releasing = releaseWorktrees(state, [task]);
      /** A checkout other threads are still in stays where it is; only this thread walks out of it. */
      if (!releasing.length) {
        return settled(leaveWorktree({ ...state, actionError: null }, task.id, createTaskMessage(
          "system",
          "Returned to the project checkout. The worktree is still there, and other threads are still working in it.",
          leaving.root,
        )));
      }
      return settled(withReleasingWorktree({ ...state, actionError: null }, releasing.map((effect) => effect.taskId)), releasing);
    }

    /** Only a thread yet to be created can be told where to start; an existing one already is. */
    case "task.set-branch":
      return settled({
        ...state,
        draftBranch: input.branch === null ? null : { name: input.branch, create: Boolean(input.create) },
        actionError: null,
      });

    /**
     * Moves the checkout itself, which everything working in it sees, so nothing may be running
     * there. A thread that does not exist yet has no checkout to move: it only records where to start.
     */
    case "task.checkout-branch": {
      const taskId = targetId(state, input.taskId);
      const task = taskId ? state.tasks.find((item) => item.id === taskId) : undefined;
      if (!task) return reduceWorktrees(state, { type: "task.set-branch", branch: input.branch, ...(input.create ? { create: true } : {}) });
      const workspaceId = taskWorkspaceId(state, task);
      if (!workspaceId) return settled({ ...state, actionError: SWITCH_PROJECT_ERROR });
      if (state.creatingWorktrees.includes(task.id)) return settled({ ...state, actionError: WORKTREE_CREATING_ERROR });
      if (leavingTaskIds(state).has(task.id)) return settled({ ...state, actionError: WORKTREE_RELEASING_ERROR });
      if (runsInWorkspace(state, workspaceId) || threadBusy(state, task.id)) return settled({ ...state, actionError: SWITCH_RUNNING_ERROR });
      return settled({ ...state, actionError: null }, [{
        type: "checkout-branch",
        workspaceId,
        branch: input.branch,
        ...(input.create ? { create: true } : {}),
      }]);
    }

    case "worktree.refresh":
      return settled({ ...state, managedWorktrees: null, worktreeManagementError: null, worktreeManagementNotice: null }, [{ type: "list-worktrees" }]);

    case "worktree.reveal": {
      const worktree = state.managedWorktrees?.find((item) => item.root === input.root);
      if (!worktree) return settled({ ...state, worktreeManagementError: WORKTREE_MISSING_ERROR });
      return settled({ ...state, worktreeManagementError: null }, [{ type: "reveal-worktree", root: worktree.root }]);
    }

    /** Manual deletion snapshots loose work first and refuses to move the ground under a run. */
    case "worktree.delete": {
      const taskId = targetId(state, input.taskId), task = taskId ? state.tasks.find((item) => item.id === taskId) : undefined;
      const current = worktreeFor(state, task), recorded = input.root ? state.worktrees.find((item) => item.root === input.root) : current;
      const managed = input.root ? state.managedWorktrees?.find((item) => item.root === input.root) : undefined;
      const worktree = recorded ?? managed;
      if (!worktree) return settled({ ...state, worktreeManagementError: WORKTREE_MISSING_ERROR });
      if (state.deletingWorktrees.includes(worktree.root)) return settled(state);
      const claimants = state.tasks.filter((claimant) => claimant.worktreeId === worktree.id);
      if (claimants.some((claimant) => threadBusy(state, claimant.id))) return settled({ ...state, actionError: WORKTREE_RUNNING_ERROR, worktreeManagementError: WORKTREE_RUNNING_ERROR });
      /** A checkout a thread is already walking out of is on its way; asking again would remove it twice. */
      if (claimants.some((claimant) => state.releasingWorktrees.includes(claimant.id))) return settled({ ...state, worktreeManagementError: WORKTREE_RELEASING_ERROR });
      return settled({ ...state, deletingWorktrees: [...state.deletingWorktrees, worktree.root], actionError: null, worktreeManagementError: null, worktreeManagementNotice: null }, [{ type: "delete-worktree", worktreeId: worktree.id, root: worktree.root, title: worktree.root.split("/").filter(Boolean).at(-1) ?? worktree.id }]);
    }

    case "worktree.created": {
      const settling = withoutCreatingWorktree(state, input.taskId);
      const task = settling.tasks.find((item) => item.id === input.taskId);
      /** A checkout that outlives the request stays on disk for manual management. */
      if (!task || !task.projectId) return settled(settling);
      if (task.worktreeId) return settled(settling);
      const worktree: Worktree = { ...input.worktree, projectId: task.projectId };
      const note = createTaskMessage("system", `Moved into a worktree at ${worktree.root}`, `Detached at ${worktree.baseCommit.slice(0, 7)}`);
      return rereadDiff(applyTask({ ...settling, worktrees: [...settling.worktrees, worktree] }, input.taskId, (item) => ({
        ...item,
        worktreeId: worktree.id,
        messages: [...item.messages, note],
        updatedAt: now(),
      })), input.taskId);
    }

    case "worktree.failed":
      return settled({ ...withoutCreatingWorktree(state, input.taskId), actionError: input.message });

    /** The checkout is still there and the thread is still in it, so only the wait and the error change. */
    case "worktree.release-failed":
      return settled({ ...withoutReleasingWorktree(state, [input.taskId]), actionError: input.message });

    case "worktrees.loaded": return settled({ ...state, managedWorktrees: input.worktrees, worktreeManagementError: null });

    /** A failed delete leaves the checkout on the list, so only its wait and the error change. */
    case "worktrees.failed": return settled({ ...state, ...(input.root ? { deletingWorktrees: withoutWorktreeRoot(state, input.root) } : { managedWorktrees: [] }), worktreeManagementError: input.message });

    case "worktree.released": {
      const task = state.tasks.find((item) => item.id === input.taskId);
      const worktree = worktreeFor(state, task);
      if (!worktree) return settled(state);
      const { commit, shortCommit, ref } = input.snapshot;
      const text = commit
        ? `Returned to the project checkout. Uncommitted work was committed as ${shortCommit ?? commit.slice(0, 7)}, and the worktree was removed.`
        : "Returned to the project checkout. The worktree had nothing uncommitted, and was removed.";
      return rereadDiff(dropWorktree(state, worktree.id, () => createTaskMessage("system", text, ref ? `Recover it with git show ${ref}` : undefined)), input.taskId);
    }

    case "worktree.deleted": {
      const worktree = state.worktrees.find((item) => item.id === input.worktreeId || item.root === input.root);
      const { commit, shortCommit, ref } = input.snapshot;
      const text = commit ? `Worktree deleted. Loose work was committed as ${shortCommit ?? commit.slice(0, 7)} first.` : "Worktree deleted. Back on the project checkout.";
      const dropped = worktree ? dropWorktree(state, worktree.id, () => createTaskMessage("system", text, ref ? `Recover it with git show ${ref}` : undefined)) : state;
      const notice = ref ? `Deleted ${input.root}. Recover it with git show ${ref}.` : commit ? `Deleted ${input.root}. Recover loose work with git show ${shortCommit ?? commit}.` : `Deleted ${input.root}.`;
      return reduceDiffs({ ...dropped, managedWorktrees: dropped.managedWorktrees?.filter((item) => item.root !== input.root) ?? null, deletingWorktrees: withoutWorktreeRoot(dropped, input.root), worktreeManagementError: null, worktreeManagementNotice: notice }, { type: "view.refresh-environment" });
    }
  }
}
