/**
 * The Undo offered after the user archives, dismisses or moves a thread: one toast, on every screen
 * that shows toasts, whose button sends the command that takes the action back.
 */
import { UNDO_SUBJECT, type ToastCommand } from "../domain/toast.js";
import type { Thread } from "../domain/thread.js";
import { worktreeName, type WorktreeDestination } from "../domain/worktree.js";
import { projectName } from "../domain/project.js";
import { supportsComputerCommand } from "../contracts/computer-capabilities.js";
import { computerOfThread } from "./computers.js";
import { projectFor, worktreeById } from "./thread-location.js";
import { withToast } from "./toasts.js";
import type { WorkspaceInput, WorkspaceTransition } from "./workspace-reducer/types.js";
import type { WorkspaceState } from "./workspace-state.js";

/** A thread as an Undo names it. */
export function quotedTitle(thread: Pick<Thread, "title">): string {
  return `“${thread.title || "Untitled thread"}”`;
}

/** Puts the Undo up beside what the transition already decided, in place of any Undo still up. */
export function offerUndo(transition: WorkspaceTransition, title: string, command: ToastCommand, at = Date.now()): WorkspaceTransition {
  const shown = withToast(transition.state, { tone: "success", title, subject: UNDO_SUBJECT, action: { label: "Undo", command } }, at);
  return { ...transition, state: shown.state, effects: [...transition.effects, ...shown.effects] };
}

/** Whether the input is the command of the Undo that is up, which is used once and goes. */
export function usesUndo(state: WorkspaceState, input: WorkspaceInput): boolean {
  if (!state.toasts.some((toast) => toast.subject === UNDO_SUBJECT)) return false;
  const sent = JSON.stringify(input);
  return state.toasts.some((toast) => toast.subject === UNDO_SUBJECT && JSON.stringify(toast.action?.command) === sent);
}

export function withoutUndo(state: WorkspaceState): WorkspaceState {
  return state.toasts.some((toast) => toast.subject === UNDO_SUBJECT) ? { ...state, toasts: state.toasts.filter((toast) => toast.subject !== UNDO_SUBJECT) } : state;
}

/**
 * Where a move takes the thread back to: the project's own checkout, or the checkout it left while
 * another thread still works there. Null for a move into a new checkout, which has no way back.
 */
export function moveBack(holder: WorkspaceState, thread: Thread, destination: WorktreeDestination): Exclude<WorktreeDestination, { kind: "new" }> | null {
  if (destination.kind === "new") return null;
  if (!thread.worktreeId) return { kind: "local" };
  const shared = holder.threads.some((other) => other.id !== thread.id && other.worktreeId === thread.worktreeId);
  return shared ? { kind: "worktree", id: thread.worktreeId } : null;
}

/** What a move's toast calls where the thread went. */
export function destinationLabel(holder: WorkspaceState, thread: Thread, destination: Exclude<WorktreeDestination, { kind: "new" }>): string {
  if (destination.kind === "worktree") {
    const worktree = worktreeById(holder, destination.id);
    return worktree ? worktreeName(worktree) : "the worktree";
  }
  const project = projectFor(holder, thread);
  return project ? projectName(project) : "Local";
}

/** The Undo for a move the user asked for. A thread moving itself, or asked by another, offers none. */
export function moveUndo(holder: WorkspaceState, thread: Thread, input: Extract<WorkspaceInput, { type: "task.move-worktree" }>): { title: string; command: ToastCommand } | null {
  if (input.afterRun || input.sender || input.then !== undefined) return null;
  const { destination } = input;
  if (destination.kind === "new" || (destination.kind === "local" ? !thread.worktreeId : destination.id === thread.worktreeId)) return null;
  const back = moveBack(holder, thread, destination);
  return back && { title: `Moved to ${destinationLabel(holder, thread, destination)}`, command: { type: "task.move-worktree", taskId: thread.id, destination: back } };
}

/**
 * The Undo for an action carried to the paired computer holding its thread, offered here where the
 * user acted. The computer must know the command that takes it back.
 */
export function forwardedUndo(state: WorkspaceState, input: WorkspaceInput, transition: WorkspaceTransition): WorkspaceTransition {
  if (input.type !== "task.archive" && input.type !== "task.dismiss" && input.type !== "task.move-worktree") return transition;
  const computer = computerOfThread(state, input.taskId);
  const thread = computer?.state?.threads.find((item) => item.id === input.taskId);
  if (!computer?.state || !thread) return transition;
  const offer: { title: string; command: ToastCommand } | null = input.type === "task.archive"
    ? thread.archivedAt === undefined ? { title: `Archived ${quotedTitle(thread)}`, command: { type: "task.restore", taskId: thread.id } } : null
    : input.type === "task.dismiss"
      ? { title: `Dismissed ${quotedTitle(thread)}`, command: { type: "task.undismiss", taskIds: [thread.id] } }
      : moveUndo(computer.state, thread, input);
  if (!offer || !supportsComputerCommand(computer.capabilities, offer.command)) return transition;
  return offerUndo(transition, offer.title, offer.command);
}
