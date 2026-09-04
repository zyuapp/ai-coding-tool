import type { WorktreeCommand } from "../../contracts/commands.js";
import { busyThreadIds, type WorkspaceState } from "../workspace-state.js";
import { worktreeSettingsViews } from "../worktree-settings.js";
import { worktreeClaimants } from "../thread-location.js";
import { settled } from "./shared.js";
import { reduceSettings } from "./settings.js";
import { reduceThreadCommands } from "./thread-commands.js";
import type { WorkspaceTransition } from "./types.js";

type Input = Extract<WorktreeCommand, { type: "worktree.filter-project" | "worktree.confirm-delete" | "worktree.set-missing-open" | "worktree.set-threads-open" | "worktree.open-thread" }>;

export function reduceWorktreeSettings(state: WorkspaceState, input: Input): WorkspaceTransition {
  const settings = state.worktreeSettings;
  switch (input.type) {
    case "worktree.filter-project":
      return settled({ ...state, worktreeSettings: { ...settings, project: input.project, confirming: null } });
    case "worktree.confirm-delete": {
      if (input.root === null) return settled({ ...state, worktreeSettings: { ...settings, confirming: null } });
      const worktree = worktreeSettingsViews(state, busyThreadIds(state))?.find((item) => item.root === input.root);
      if (worktree) {
        if (worktree.busy || worktree.deleting) return settled(state);
        return settled({ ...state, worktreeSettings: { ...settings, confirming: input.root } });
      }
      const recorded = state.worktrees.find((item) => item.root === input.root);
      if (!recorded || state.deletingWorktrees.includes(recorded.root)) return settled(state);
      const busy = busyThreadIds(state);
      if (worktreeClaimants(state, recorded.id).some((thread) => busy.has(thread.id))) return settled(state);
      const next = { ...state, worktreeSettings: { ...settings, confirming: input.root }, worktreeManagementLoading: true, worktreeManagementError: null };
      return settled(next, state.worktreeManagementLoading ? [] : [{ type: "list-worktrees" }]);
    }
    case "worktree.set-missing-open":
      return settled({ ...state, worktreeSettings: { ...settings, missingOpen: input.open } });
    case "worktree.set-threads-open": {
      const expandedThreads = settings.expandedThreads.filter((root) => root !== input.root);
      if (input.open) expandedThreads.push(input.root);
      return settled({ ...state, worktreeSettings: { ...settings, expandedThreads } });
    }
    case "worktree.open-thread": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      if (!thread?.worktreeId) return settled(state);
      const closed = reduceSettings(state, { type: "view.set-settings-open", open: false });
      const selected = reduceThreadCommands(closed.state, { type: "task.select", taskId: thread.id });
      return { state: selected.state, effects: [...closed.effects, ...selected.effects] };
    }
  }
}
