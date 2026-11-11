import type { WorktreeCommand } from "../../contracts/commands.js";
import { activeComputer } from "../state/computers.js";
import type { WorkspaceState } from "../workspace-state.js";
import { threadActivity } from "../thread-activity.js";
import { worktreeSettingsViews } from "../worktree-settings.js";
import { worktreeClaimants } from "../thread-location.js";
import { settingsShown } from "./settings.js";
import { selected } from "./thread-select.js";
import { andThen, type SliceTransition, type Step } from "./slice.js";
import type { WorktreesState } from "../state/worktrees.js";

type Input = Extract<WorktreeCommand, { type: "worktree.filter-project" | "worktree.confirm-delete" | "worktree.confirm-delete-safe" | "worktree.set-missing-open" | "worktree.set-threads-open" }>;

export function reduceWorktreeSettings(state: WorkspaceState, input: Input): SliceTransition<WorktreesState> {
  const settings = state.worktreeSettings;
  switch (input.type) {
    case "worktree.filter-project":
      return { patch: { worktreeSettings: { ...settings, project: input.project, confirming: null, confirmingSafe: false } } };
    case "worktree.confirm-delete-safe":
      return { patch: { worktreeSettings: { ...settings, confirming: null, confirmingSafe: input.open } } };
    case "worktree.confirm-delete": {
      if (input.root === null) return { patch: { worktreeSettings: { ...settings, confirming: null } } };
      const worktree = worktreeSettingsViews(state, threadActivity(state).working)?.find((item) => item.root === input.root);
      if (worktree) {
        if (worktree.busy || worktree.deleting) return {};
        return { patch: { worktreeSettings: { ...settings, confirming: input.root } } };
      }
      /** A paired computer's checkout is judged by its list, which the confirmation is drawn from. */
      if (activeComputer(state)) return { patch: { worktreeSettings: { ...settings, confirming: input.root } } };
      const recorded = state.worktrees.find((item) => item.root === input.root);
      if (!recorded || state.deletingWorktrees.includes(recorded.root)) return {};
      const busy = threadActivity(state).working;
      if (worktreeClaimants(state, recorded.id).some((thread) => busy.has(thread.id))) return {};
      return {
        patch: { worktreeSettings: { ...settings, confirming: input.root }, worktreeManagementLoading: true, worktreeManagementError: null },
        effects: state.worktreeManagementLoading ? [] : [{ type: "list-worktrees" }],
      };
    }
    case "worktree.set-missing-open":
      return { patch: { worktreeSettings: { ...settings, missingOpen: input.open } } };
    case "worktree.set-threads-open": {
      const expandedThreads = settings.expandedThreads.filter((root) => root !== input.root);
      if (input.open) expandedThreads.push(input.root);
      return { patch: { worktreeSettings: { ...settings, expandedThreads } } };
    }
  }
}

/** A thread a checkout in Settings lists, opened: Settings closes and the thread is selected. */
export function openWorktreeThread(state: WorkspaceState, input: Extract<WorktreeCommand, { type: "worktree.open-thread" }>): Step {
  const thread = state.threads.find((item) => item.id === input.taskId);
  if (!thread?.worktreeId) return {};
  return andThen(state, settingsShown(state, false), (next) => selected(next, thread.id));
}
