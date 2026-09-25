/** The refusals the workspace reports, and the names the renderer knows them by. */

const REOPEN_PROJECT_ERROR = "Reopen this project folder before running a task.";
const SAME_PROJECT_ERROR = "Choose the same project folder to continue this task.";
export const MISSING_PROJECT_ERROR = "This task's project is unavailable. Reopen the project folder before running it.";
export const RUNNING_PROJECT_ERROR = "Stop the running tasks before removing this project.";
export const PROJECT_WORKTREES_ERROR = "Delete this project's worktrees before removing the project.";
const BUSY_AUTOMATION_ERROR = "This task is already running. The automation will run on its next tick.";
export const WORKTREE_PROJECT_ERROR = "Open this thread in a project folder before giving it a worktree.";
export const WORKTREE_MISSING_ERROR = "That worktree is not one this app is keeping.";
export const WORKTREE_ELSEWHERE_ERROR = "That worktree is a checkout of another project.";
export const TERMINAL_FOLDER_ERROR = "Open a project folder before starting a terminal.";
export const WORKTREE_RUNNING_ERROR = "Stop this thread's run before changing where it works.";
export const WORKTREE_CREATING_ERROR = "This thread's worktree is still being created.";
export const WORKTREE_RELEASING_ERROR = "This thread's worktree is still being removed.";

export const CHECKOUT_RUNNING_ERROR = "Stop the threads running in this project before starting one on another branch.";
export const SWITCH_RUNNING_ERROR = "Stop the threads running in this checkout before switching it to another branch.";
export const SWITCH_PROJECT_ERROR = "Open this thread in a project folder before switching branches.";
export const FILE_FOLDER_ERROR = "Open this thread in a project folder before opening a file from it.";
export const APP_FOLDER_ERROR = "Open this thread in a project folder before opening it in another application.";

export const BROWSER_URL_ERROR = "That is not a page the browser can open.";
export const BROWSER_TAB_ERROR = "The browser has no page open to act on.";

export const WORKSPACE_ERRORS = {
  reopenProject: REOPEN_PROJECT_ERROR,
  sameProject: SAME_PROJECT_ERROR,
  busyAutomation: BUSY_AUTOMATION_ERROR,
  projectWorktrees: PROJECT_WORKTREES_ERROR,
  worktreeProject: WORKTREE_PROJECT_ERROR,
  worktreeMissing: WORKTREE_MISSING_ERROR,
  worktreeElsewhere: WORKTREE_ELSEWHERE_ERROR,
  terminalFolder: TERMINAL_FOLDER_ERROR,
  worktreeRunning: WORKTREE_RUNNING_ERROR,
  worktreeCreating: WORKTREE_CREATING_ERROR,
  worktreeReleasing: WORKTREE_RELEASING_ERROR,
  checkoutRunning: CHECKOUT_RUNNING_ERROR,
  switchRunning: SWITCH_RUNNING_ERROR,
  switchProject: SWITCH_PROJECT_ERROR,
  fileFolder: FILE_FOLDER_ERROR,
  appFolder: APP_FOLDER_ERROR,
} as const;
