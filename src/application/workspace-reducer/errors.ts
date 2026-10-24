/** The refusals the workspace reports, and the names the renderer knows them by. */
import { isCoordinator, MAX_OPEN_DECISIONS } from "../../domain/coordination.js";
import type { Thread } from "../../domain/thread.js";
import type { ThreadRole } from "../../domain/thread-role.js";
import type { WorktreeDestination } from "../../domain/worktree.js";

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
export const ARCHIVED_SEND_ERROR = "This thread is archived, so only the user can pick it back up, by writing to it or restoring it from Archived threads in Settings.";
export const WORKTREE_COORDINATOR_ERROR = "A coordinator stays in its project's checkout, since it changes nothing itself. Start a thread with start_thread and worktree: true to do the work in a worktree.";
export const COORDINATOR_ROLE_ERROR = "A coordinator keeps its role until the user changes it from the thread menu.";
export const WORKTREE_COORDINATOR_ROLE_ERROR = "A coordinator stays in its project's checkout, since it changes nothing itself, and this thread works in a worktree. Start a coordinator with start_thread and role \"coordinator\" instead.";

/**
 * What no thread asks of a coordinator, here or on a paired computer: a coordinator does no work itself,
 * so none moves one into a worktree, takes its role away, or makes one in a worktree, or getting one,
 * a coordinator. The user still can, from the thread's menu.
 */
export function coordinatorAskRefusal(
  subject: Thread,
  ask: { type: "task.move-worktree"; destination: WorktreeDestination } | { type: "task.set-role"; role: ThreadRole | null },
  creatingWorktree: boolean,
): string | undefined {
  if (ask.type === "task.move-worktree") return ask.destination.kind !== "local" && isCoordinator(subject) ? WORKTREE_COORDINATOR_ERROR : undefined;
  if (ask.role !== "coordinator") return subject.role === "coordinator" ? COORDINATOR_ROLE_ERROR : undefined;
  return subject.worktreeId !== undefined || creatingWorktree ? WORKTREE_COORDINATOR_ROLE_ERROR : undefined;
}

/** What a thread's own report, decision or memory change is told when nothing was recorded. */
export const NO_COORDINATOR = "This thread works under no coordinator, so there is no one to report to and nothing was recorded. Say it in your reply instead.";
export const OUTSIDE_COORDINATION = "Only a coordinator and the threads working under it can raise decisions, so nothing was recorded. Ask the user in your reply instead.";
export const DECISIONS_FULL = `This thread already has ${MAX_OPEN_DECISIONS} decisions waiting on the user, so this one was not raised. Wait for their answers, or ask in your reply instead.`;
export const NO_MEMORY = "Only a coordinator keeps a memory.";

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
  worktreeCoordinator: WORKTREE_COORDINATOR_ERROR,
  worktreeCoordinatorRole: WORKTREE_COORDINATOR_ROLE_ERROR,
  coordinatorRole: COORDINATOR_ROLE_ERROR,
  checkoutRunning: CHECKOUT_RUNNING_ERROR,
  switchRunning: SWITCH_RUNNING_ERROR,
  switchProject: SWITCH_PROJECT_ERROR,
  fileFolder: FILE_FOLDER_ERROR,
  appFolder: APP_FOLDER_ERROR,
} as const;
