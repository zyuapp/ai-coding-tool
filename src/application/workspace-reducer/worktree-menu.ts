import type { WorktreeCommand } from "../../contracts/commands.js";
import type { WorkspaceState } from "../workspace-state.js";
import { settled } from "./shared.js";
import type { WorkspaceTransition } from "./types.js";

export function reduceWorktreeMenu(state: WorkspaceState, input: Extract<WorktreeCommand, { type: "worktree.menu-open" | "worktree.menu-search" }>): WorkspaceTransition {
  const query = input.type === "worktree.menu-search" ? input.query : "";
  const next = { ...state, worktreeMenuSearch: { ...state.worktreeMenuSearch, [input.list]: query } };
  if (input.type === "worktree.menu-search" || input.list === "threads" || state.worktreeManagementLoading) return settled(next);
  return settled({ ...next, worktreeManagementLoading: true, worktreeManagementError: null }, [{ type: "list-worktrees" }]);
}
