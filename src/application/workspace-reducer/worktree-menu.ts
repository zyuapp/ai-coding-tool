import type { WorktreeCommand } from "../../contracts/commands.js";
import { activeComputer, type ComputersSliceState } from "../state/computers.js";
import type { WorktreesState } from "../state/worktrees.js";
import type { SliceTransition } from "./slice.js";

export const WORKTREE_MENU_INPUTS = ["worktree.menu-open", "worktree.menu-search"] as const;

type MenuState = Pick<WorktreesState, "worktreeMenuSearch" | "worktreeManagementLoading" | "worktreeManagementError">;

export function reduceWorktreeMenu(state: MenuState & ComputersSliceState, input: Extract<WorktreeCommand, { type: (typeof WORKTREE_MENU_INPUTS)[number] }>): SliceTransition<MenuState> {
  const query = input.type === "worktree.menu-search" ? input.query : "";
  const worktreeMenuSearch = { ...state.worktreeMenuSearch, [input.list]: query };
  if (input.type === "worktree.menu-search" || input.list === "threads" || state.worktreeManagementLoading) return { patch: { worktreeMenuSearch } };
  /** The checkouts offered are the ones beside the thread on screen, which a paired computer lists itself. */
  if (activeComputer(state)) return { patch: { worktreeMenuSearch } };
  return { patch: { worktreeMenuSearch, worktreeManagementLoading: true, worktreeManagementError: null }, effects: [{ type: "list-worktrees" }] };
}
