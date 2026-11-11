/** Where a thread works: the branch it starts from, and the checkouts the app keeps. */
import { reduceWorktreeMove, relocateThread, withFollowUp } from "./worktree-moves.js";
import { openWorktreeThread, reduceWorktreeSettings } from "./worktree-settings.js";
import { rereadDiff } from "./diff-reads.js";
import { refreshEnvironment } from "./environment.js";
import { SWITCH_PROJECT_ERROR, SWITCH_RUNNING_ERROR, WORKTREE_CREATING_ERROR, WORKTREE_MISSING_ERROR, WORKTREE_PROJECT_ERROR, WORKTREE_RELEASING_ERROR, WORKTREE_RUNNING_ERROR } from "./errors.js";
import { drainQueue, drained } from "./run-queue.js";
import { afterward, applied, type SliceTransition } from "./slice.js";
import { followUps, now, settled, targetId, rejected } from "./shared.js";
import { dropWorktree, leaveWorktree, releaseWorktrees, withCreatingWorktree, withReleasingWorktree, withoutCreatingWorktree, withoutReleasingWorktree } from "./worktree-claims.js";
import type { WorkspaceEffect, WorkspaceInput, WorkspaceTransition } from "./types.js";
import { updateThread } from "../thread-run-state.js";
import { runsInWorkspace } from "../run-record.js";
import { isWorking, threadActivity } from "../thread-activity.js";
import { worktreeSettingsViews } from "../worktree-settings.js";
import { leavingThreadIds, projectFor, threadWorkspaceId, worktreeById, worktreeClaimants, worktreeFor } from "../thread-location.js";
import type { WorkspaceState } from "../workspace-state.js";
import { withoutWorktreeRoot, type WorktreesState } from "../state/worktrees.js";
import { createConversationMessage } from "../../domain/conversation.js";
import { dismissed } from "../../domain/attention.js";
import type { Worktree } from "../../domain/worktree.js";
import type { CreatedWorktree, WorktreeSnapshotResult } from "../../contracts/ipc.js";
import type { ManagedWorktree } from "../../domain/worktree.js";

export const WORKTREE_INPUTS = [
  "worktree.open-thread", "view.move-worktree", "task.set-worktree", "task.move-worktree", "task.set-branch", "task.checkout-branch",
  "worktree.created", "worktree.released", "worktree.deleted", "checkout.finished"
] as const;
type WorktreeInput = Extract<WorkspaceInput, { type: (typeof WORKTREE_INPUTS)[number] }>;

/** The checkouts Settings lists and manages, which change only the worktrees' own state. */
export const WORKTREE_MANAGEMENT_INPUTS = [
  "worktree.filter-project", "worktree.confirm-delete", "worktree.confirm-delete-safe", "worktree.delete-safe", "worktree.set-missing-open", "worktree.set-threads-open",
  "worktree.refresh", "worktree.reveal", "worktree.delete", "worktree.failed", "worktrees.loaded", "worktrees.failed", "worktree.release-failed"
] as const;
type ManagementInput = Extract<WorkspaceInput, { type: (typeof WORKTREE_MANAGEMENT_INPUTS)[number] }>;

type Own = WorktreesState;

export type WorktreeEvent =
  | { type: "worktree.created"; taskId: string; worktree: CreatedWorktree; move?: boolean; projectId?: string; then?: string }
  | { type: "worktree.failed"; taskId: string; message: string }
  | { type: "worktrees.loaded"; worktrees: ManagedWorktree[] }
  | { type: "worktrees.failed"; message: string; root?: string }
  | { type: "worktree.released"; taskId: string; snapshot: WorktreeSnapshotResult }
  | { type: "worktree.release-failed"; taskId: string; message: string }
  /** A branch checkout is over, with what went wrong when it did not happen. */
  | { type: "checkout.finished"; message?: string }
  | { type: "worktree.deleted"; worktreeId: string; root: string; snapshot: WorktreeSnapshotResult; missingOnly?: boolean };

export type WorktreeEffect =
  | { type: "create-worktree"; taskId: string; projectRoot: string; move?: boolean; name?: string; projectId?: string; then?: string }
  | { type: "release-worktree"; taskId: string; worktreeId: string; root: string; title: string }
  | { type: "list-worktrees" }
  | { type: "reveal-worktree"; root: string }
  | { type: "delete-worktree"; worktreeId: string; root: string; title: string; missingOnly?: boolean }
  /** Moves a checkout onto a branch, making it at that checkout's HEAD first when `create`. */
  | { type: "checkout-branch"; workspaceId: string; branch: string; create?: boolean };

export function reduceWorktrees(state: WorkspaceState, input: WorktreeInput): WorkspaceTransition {
  /** A move that goes ahead answers the confirmation, so the question never outlives its answer. */
  if (input.type === "task.set-worktree" && state.worktreeMove) return reduceWorktrees({ ...state, worktreeMove: null }, input);

  switch (input.type) {
    case "task.move-worktree": return reduceWorktreeMove(state, input);

    case "worktree.open-thread":
      return openWorktreeThread(state, input);

    /**
     * Asks before moving, but only where the answer could cost something. A thread with no checkout
     * yet, and a clean one walking back to the project, have nothing to lose, so they just go.
     */
    case "view.move-worktree": {
      if (input.worktree === null) return settled({ ...state, worktreeMove: null });
      const taskId = targetId(state, undefined);
      const thread = taskId ? state.threads.find((item) => item.id === taskId) : undefined;
      const move = { type: "task.set-worktree", worktree: input.worktree } as const;
      if (!thread) return reduceWorktrees(state, move);
      if (input.worktree === Boolean(thread.worktreeId)) return settled(state);
      const workspaceId = threadWorkspaceId(state, thread);
      const environment = workspaceId ? state.environments[workspaceId] : undefined;
      const holding = environment?.status === "available" ? environment.files.length : 0;
      if (!input.worktree && !holding) return reduceWorktrees(state, move);
      return settled({ ...state, worktreeMove: { taskId: thread.id, worktree: input.worktree } });
    }

    /**
     * Moves the thread there and then, so it is never left saying it will move later. Turning it off
     * takes this thread's claim off the checkout; the last claim to go takes the directory with it,
     * and what it still holds is committed first.
     */
    case "task.set-worktree": {
      const taskId = targetId(state, input.taskId);
      const thread = taskId ? state.threads.find((item) => item.id === taskId) : undefined;
      /** With no thread yet the answer is a draft: the checkout is made when the first message goes. */
      /** Asking for a checkout of its own is asking for a new one, so it drops any the user had picked. */
      if (!thread) return settled(input.taskId === undefined ? { ...state, draftWorktree: input.worktree, draftWorktreeId: null } : state);
      if (state.creatingWorktrees.includes(thread.id)) return rejected(state, WORKTREE_CREATING_ERROR);
      if (leavingThreadIds(state).has(thread.id)) return rejected(state, WORKTREE_RELEASING_ERROR);
      if (isWorking(state, thread.id)) return rejected(state, WORKTREE_RUNNING_ERROR);
      if (input.worktree) {
        if (thread.worktreeId) return settled(state);
        const project = projectFor(state, thread);
        if (!project?.workspaceId) return rejected(state, WORKTREE_PROJECT_ERROR);
        return settled(withCreatingWorktree(state, thread.id), [{ type: "create-worktree", taskId: thread.id, projectRoot: project.root }]);
      }
      const leaving = worktreeFor(state, thread);
      if (!leaving) return settled(state);
      const releasing = releaseWorktrees(state, [thread]);
      /** A checkout other threads are still in stays where it is; only this thread walks out of it. */
      if (!releasing.length) {
        return settled(leaveWorktree({ ...state, actionError: null }, thread.id, createConversationMessage(
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

    case "task.checkout-branch": case "checkout.finished":
      return reduceCheckout(state, input);

    case "worktree.created": {
      const settling = withoutCreatingWorktree(state, input.taskId);
      const thread = settling.threads.find((item) => item.id === input.taskId);
      /** A checkout that outlives the request stays on disk for manual management. */
      if (!thread || !thread.projectId) return settled(settling);
      if (thread.worktreeId && !input.move) return settled(settling);
      const worktree: Worktree = { ...input.worktree, projectId: input.projectId ?? thread.projectId };
      if (input.move) {
        if (!state.creatingWorktrees.includes(thread.id)) return settled(settling);
        const next = { ...settling, worktrees: [...settling.worktrees, worktree], managedWorktrees: null, worktreeManagementLoading: true };
        if (thread.projectId !== worktree.projectId) return settled(next, [{ type: "list-worktrees" }]);
        const moved = relocateThread(next, thread, worktree);
        /** What the thread said it goes on with, then what was queued behind the run that asked to move, starts here. */
        const drained = drainQueue(withFollowUp(moved.state, thread.id, input.then), thread.id, "deliver");
        return { state: drained.state, effects: [...moved.effects, { type: "list-worktrees" }, ...drained.effects] };
      }
      const note = createConversationMessage("system", `Moved into a worktree at ${worktree.root}`, `Detached at ${worktree.baseCommit.slice(0, 7)}`);
      return rereadDiff(updateThread({ ...settling, worktrees: [...settling.worktrees, worktree] }, input.taskId, (item) => ({
        ...item,
        worktreeId: worktree.id,
        messages: [...item.messages, note],
        updatedAt: now(),
      })), input.taskId);
    }

    case "worktree.released": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      const worktree = worktreeFor(state, thread);
      if (!worktree) return settled(state);
      const { commit, shortCommit, ref } = input.snapshot;
      const text = commit
        ? `Returned to the project checkout. Uncommitted work was committed as ${shortCommit ?? commit.slice(0, 7)}, and the worktree was removed.`
        : "Returned to the project checkout. The worktree had nothing uncommitted, and was removed.";
      return rereadDiff(dropWorktree(state, worktree.id, () => createConversationMessage("system", text, ref ? `Recover it with git show ${ref}` : undefined)), input.taskId);
    }

    case "worktree.deleted": {
      const worktree = state.worktrees.find((item) => item.id === input.worktreeId || item.root === input.root);
      const { commit, shortCommit, ref } = input.snapshot;
      let text = "Worktree deleted. Back on the project checkout.";
      if (input.missingOnly) text = "Missing worktree folder forgotten. Back on the project checkout.";
      else if (commit) text = `Worktree deleted. Loose work was committed as ${shortCommit ?? commit.slice(0, 7)} first.`;
      let dropped = state;
      if (worktree) {
        /** Successful deletion files away every linked thread, keeping its conversation history. */
        const claimants = new Set(worktreeClaimants(state, worktree.id).map((thread) => thread.id));
        const filed = { ...state, threads: dismissed(state.threads, claimants) };
        dropped = dropWorktree(filed, worktree.id, () => createConversationMessage("system", text, ref ? `Recover it with git show ${ref}` : undefined));
      }
      let recovery = "";
      if (!input.missingOnly && ref) recovery = `git show ${ref}`;
      else if (!input.missingOnly && commit) recovery = `git show ${shortCommit ?? commit}`;
      let notice = `Deleted ${input.root}.`;
      if (input.missingOnly) notice = `Forgot ${input.root}. Thread history kept.`;
      else if (ref) notice += ` Recover it with ${recovery}.`;
      else if (commit) notice += ` Recover loose work with ${recovery}.`;
      const bulk = dropped.worktreeSettings.bulk;
      const inBulk = Boolean(bulk?.pending.includes(input.root));
      const recover = recovery ? `Recover ${input.root.split("/").filter(Boolean).at(-1)} with ${recovery}.` : null;
      const worktreeSettings = settleBulk(dropped, input.root, { recover });
      if (bulk && inBulk) notice = bulkNotice(bulk, recover);
      const next = { ...dropped, worktreeSettings, managedWorktrees: dropped.managedWorktrees?.filter((item) => item.root !== input.root) ?? null, deletingWorktrees: withoutWorktreeRoot(dropped, input.root), worktreeManagementError: inBulk ? dropped.worktreeManagementError : null, worktreeManagementNotice: notice };
      return settled(next, followUps(refreshEnvironment(next)));
    }
  }
}

export function reduceWorktreeManagement(state: WorkspaceState, input: ManagementInput): SliceTransition<Own> {
  switch (input.type) {
    case "worktree.filter-project": case "worktree.confirm-delete": case "worktree.confirm-delete-safe": case "worktree.set-missing-open": case "worktree.set-threads-open":
      return reduceWorktreeSettings(state, input);

    case "worktree.refresh":
      if (state.worktreeManagementLoading) return {};
      return {
        patch: { worktreeManagementLoading: true, worktreeSettings: { ...state.worktreeSettings, confirming: null, confirmingSafe: false }, worktreeManagementError: null, worktreeManagementNotice: null },
        effects: [{ type: "list-worktrees" }],
      };

    case "worktree.reveal": {
      /** The Settings list loads on demand, so a checkout a thread records is revealable before it has. */
      const worktree = state.managedWorktrees?.find((item) => item.root === input.root) ?? state.worktrees.find((item) => item.root === input.root);
      if (!worktree) return { patch: { worktreeManagementError: WORKTREE_MISSING_ERROR }, result: { ok: false, message: WORKTREE_MISSING_ERROR } };
      return { patch: { worktreeManagementError: null }, effects: [{ type: "reveal-worktree", root: worktree.root }] };
    }

    case "worktree.delete": return deleteWorktree(state, input);

    case "worktree.delete-safe": return deleteSafe(state, input.roots);

    case "worktree.failed": {
      /** A thread that never moved runs what it had queued where it already is. */
      const patch = { creatingWorktrees: withoutCreatingWorktree(state, input.taskId).creatingWorktrees };
      return { patch, ...drained(afterward(state, { patch }), input.taskId, "deliver"), refusal: input.message };
    }

    /** The checkout is still there and the thread is still in it, so only the wait and the error change. */
    case "worktree.release-failed":
      return { patch: { releasingWorktrees: withoutReleasingWorktree(state, [input.taskId]).releasingWorktrees }, refusal: input.message };

    case "worktrees.loaded": return { patch: { managedWorktrees: input.worktrees, worktreeManagementLoading: false, worktreeManagementError: null } };

    /** A failed delete leaves the checkout on the list, so only its wait and the error change. */
    case "worktrees.failed": return {
      patch: { deletingWorktrees: input.root ? withoutWorktreeRoot(state, input.root) : state.deletingWorktrees, worktreeSettings: input.root ? settleBulk(state, input.root, null) : state.worktreeSettings, worktreeManagementLoading: input.root ? state.worktreeManagementLoading : false, worktreeManagementError: input.message },
      result: { ok: false, message: input.message },
    };
  }
}

/** Manual deletion snapshots loose work first and refuses to move the ground under a run. */
function deleteWorktree(state: WorkspaceState, input: Extract<ManagementInput, { type: "worktree.delete" }>): SliceTransition<Own> {
  const taskId = targetId(state, input.taskId), thread = taskId ? state.threads.find((item) => item.id === taskId) : undefined;
  const current = worktreeFor(state, thread);
  const recorded = input.worktreeId ? worktreeById(state, input.worktreeId) : input.root ? state.worktrees.find((item) => item.root === input.root) : current;
  const managed = input.root ? state.managedWorktrees?.find((item) => item.root === input.root) : undefined;
  const worktree = recorded ?? managed;
  if (!worktree) return { patch: { worktreeManagementError: WORKTREE_MISSING_ERROR }, result: { ok: false, message: WORKTREE_MISSING_ERROR } };
  if (state.deletingWorktrees.includes(worktree.root)) return {};
  const claimants = state.threads.filter((claimant) => claimant.worktreeId === worktree.id);
  /** A checkout a thread is already walking out of is on its way; asking again would remove it twice. */
  if (claimants.some((claimant) => state.releasingWorktrees.includes(claimant.id))) return { patch: { worktreeManagementError: WORKTREE_RELEASING_ERROR }, result: { ok: false, message: WORKTREE_RELEASING_ERROR } };
  if (claimants.some((claimant) => isWorking(state, claimant.id))) return { patch: { worktreeManagementError: WORKTREE_RUNNING_ERROR }, refusal: WORKTREE_RUNNING_ERROR };
  const effect: WorkspaceEffect = { type: "delete-worktree", worktreeId: worktree.id, root: worktree.root, title: worktree.root.split("/").filter(Boolean).at(-1) ?? worktree.id };
  if (input.missingOnly) effect.missingOnly = true;
  return {
    patch: { worktreeSettings: { ...state.worktreeSettings, confirming: null }, deletingWorktrees: [...state.deletingWorktrees, worktree.root], worktreeManagementError: null, worktreeManagementNotice: null },
    clearsError: true,
    effects: [effect],
  };
}

/** Each checkout is judged again here, so one that changed since the confirmation stays. A bulk still running takes the new roots in. */
function deleteSafe(state: WorkspaceState, requested: string[]): SliceTransition<Own> {
  const views = worktreeSettingsViews(state, threadActivity(state).working) ?? [];
  const safe = new Set(views.filter((view) => view.safe).map((view) => view.root));
  let next: WorkspaceState = { ...state, worktreeSettings: { ...state.worktreeSettings, confirmingSafe: false } };
  const effects: WorkspaceEffect[] = [];
  const pending: string[] = [];
  for (const root of new Set(requested)) {
    if (!safe.has(root)) continue;
    const deleted = applied(next, deleteWorktree(next, { type: "worktree.delete", root }));
    if (!deleted.state.deletingWorktrees.includes(root)) continue;
    next = deleted.state;
    effects.push(...deleted.effects);
    pending.push(root);
  }
  const running = state.worktreeSettings.bulk;
  const bulk = running ? { ...running, pending: [...running.pending, ...pending] } : pending.length ? { pending, deleted: 0, recover: [] } : null;
  const { deletingWorktrees, worktreeManagementError, worktreeManagementNotice } = next;
  return {
    patch: { worktreeSettings: { ...next.worktreeSettings, bulk }, deletingWorktrees, worktreeManagementError, worktreeManagementNotice },
    ...pending.length ? { clearsError: true as const } : {},
    effects,
  };
}

type Bulk = NonNullable<WorkspaceState["worktreeSettings"]["bulk"]>;

/** Takes a finished root off the bulk delete, counting it and keeping its recovery pointer when it went. */
function settleBulk(state: WorkspaceState, root: string, deleted: { recover: string | null } | null): WorkspaceState["worktreeSettings"] {
  const bulk = state.worktreeSettings.bulk;
  if (!bulk?.pending.includes(root)) return state.worktreeSettings;
  const pending = bulk.pending.filter((item) => item !== root);
  const next: Bulk = { pending, deleted: bulk.deleted + (deleted ? 1 : 0), recover: deleted?.recover ? [...bulk.recover, deleted.recover] : bulk.recover };
  return { ...state.worktreeSettings, bulk: pending.length ? next : null };
}

function bulkNotice(bulk: Bulk, recover: string | null) {
  const count = bulk.deleted + 1;
  return [`Deleted ${count} ${count === 1 ? "worktree" : "worktrees"}.`, ...bulk.recover, ...(recover ? [recover] : [])].join(" ");
}

function reduceCheckout(state: WorkspaceState, input: Extract<WorktreeInput, { type: "task.checkout-branch" | "checkout.finished" }>): WorkspaceTransition {
  /** A failed checkout may still have made the branch, so Git is read either way, as a follow-up. */
  if (input.type === "checkout.finished") {
    const reads = followUps(refreshEnvironment(state));
    return input.message ? rejected(state, input.message, reads) : settled(state, reads);
  }
  /**
   * Moves the checkout itself, which everything working in it sees, so nothing may be running
   * there. A thread that does not exist yet has no checkout to move: it only records where to start.
   */
  const taskId = targetId(state, input.taskId);
  const thread = taskId ? state.threads.find((item) => item.id === taskId) : undefined;
  if (!thread) return reduceWorktrees(state, { type: "task.set-branch", branch: input.branch, ...(input.create ? { create: true } : {}) });
  const workspaceId = threadWorkspaceId(state, thread);
  if (!workspaceId) return rejected(state, SWITCH_PROJECT_ERROR);
  if (state.creatingWorktrees.includes(thread.id)) return rejected(state, WORKTREE_CREATING_ERROR);
  if (leavingThreadIds(state).has(thread.id)) return rejected(state, WORKTREE_RELEASING_ERROR);
  if (runsInWorkspace(state, workspaceId) || isWorking(state, thread.id)) return rejected(state, SWITCH_RUNNING_ERROR);
  return settled({ ...state, actionError: null }, [{
    type: "checkout-branch",
    workspaceId,
    branch: input.branch,
    ...(input.create ? { create: true } : {}),
  }]);
}
