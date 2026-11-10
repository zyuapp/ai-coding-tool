import type { ManagedWorktree, MoveAfterRun, Worktree } from "../../domain/worktree.js";
import type { WorktreeMenuSearch } from "../worktree-menu.js";
import type { WorktreeSettingsState } from "../worktree-settings.js";

export type WorktreesState = {
  /**
   * Every checkout the app has recorded. A checkout outlives the thread that asked for it and stays
   * until the user explicitly returns from or deletes it.
   */
  worktrees: Worktree[];
  /** Directories found under app-owned roots for the manual Settings list. Null until that list lands. */
  managedWorktrees: ManagedWorktree[] | null;
  worktreeSettings: WorktreeSettingsState;
  worktreeMenuSearch: WorktreeMenuSearch;
  worktreeManagementLoading: boolean;
  worktreeManagementError: string | null;
  worktreeManagementNotice: string | null;
  /** Threads whose checkout is being made, so nothing asks for a second one while the first lands. */
  creatingWorktrees: string[];
  /** Threads giving up their checkout, so the wait is shown and nothing asks to leave twice. */
  releasingWorktrees: string[];
  /** Roots of checkouts being deleted, so the list shows the wait and refuses a second delete. */
  deletingWorktrees: string[];
  /** Where each thread that moved itself goes once the run that asked has ended, and what it goes on with there. */
  movesAfterRun: Record<string, MoveAfterRun>;
  /** The move the confirmation is open on: the thread asked to move, and where it would go. */
  worktreeMove: { taskId: string; worktree: boolean } | null;
};

export function initialWorktreesState(): WorktreesState {
  return {
    worktrees: [],
    managedWorktrees: null,
    worktreeSettings: { project: null, confirming: null, missingOpen: null, expandedThreads: [], confirmingSafe: false, bulk: null },
    worktreeMenuSearch: { threads: "", destinations: "" },
    worktreeManagementLoading: false,
    worktreeManagementError: null,
    worktreeManagementNotice: null,
    creatingWorktrees: [],
    releasingWorktrees: [],
    deletingWorktrees: [],
    movesAfterRun: {},
    worktreeMove: null,
  };
}

export function withoutWorktreeRoot(state: Pick<WorktreesState, "deletingWorktrees">, root: string) {
  return state.deletingWorktrees.filter((item) => item !== root);
}
