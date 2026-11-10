/** A fork waiting on its name: the thread to copy, whether the copy gets a worktree, and the name it starts with. */
export type ForkName = { taskId: string; worktree: boolean; title: string };

/** The native review picker follows the thread it was opened from and never persists. */
export type ReviewPicker = {
  taskId: string;
  step: "targets" | "base" | "commit" | "custom";
};

/** The menus and confirmations open over the window. */
export type DialogsState = {
  /** The fork the naming dialog is open on: the thread to copy, where the copy goes, and the name it suggests. */
  forkName: ForkName | null;
  /** The thread the archive confirmation is open on. */
  archivePrompt: string | null;
  openMenu: string | null;
  reviewPicker: ReviewPicker | null;
};

export function initialDialogsState(): DialogsState {
  return { forkName: null, archivePrompt: null, openMenu: null, reviewPicker: null };
}

/** The new-thread composer's project picker, as an `openMenu` value. */
export const THREAD_START_PROJECT_MENU = "thread-start:project";
