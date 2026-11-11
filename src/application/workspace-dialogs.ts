import type { Project } from "../domain/project.js";
import { threadWorkspaceId, worktreeClaimants, worktreeFor } from "./thread-location.js";
import type { WorkspaceState } from "./workspace-state.js";
import { computerOfThread } from "./computers.js";
import { ownFields } from "./workspace-reducer/slice.js";
import type { DialogsState, ForkName, ReviewPicker } from "./state/dialogs.js";

/** The menus and confirmations as one input leaves them. Only the functions here make one. */
class DialogsChange {
  private declare readonly owned: never;
  constructor(readonly view: DialogsState) {}
}

export type DialogsEdit = DialogsChange;

export function dialogsOf(state: DialogsState): DialogsEdit {
  return new DialogsChange(ownFields<DialogsState>(state, { forkName: true, archivePrompt: true, openMenu: true, reviewPicker: true }));
}

/** The menu open over the window, or none. */
export function menuIn(edit: DialogsEdit, menu: string | null): DialogsEdit {
  return new DialogsChange({ ...edit.view, openMenu: menu });
}

/** The fork naming dialog, open on a fork or closed. */
export function forkNameIn(edit: DialogsEdit, forkName: ForkName | null): DialogsEdit {
  return new DialogsChange({ ...edit.view, forkName });
}

/** The archive confirmation, open on a thread or closed. */
export function archivePromptIn(edit: DialogsEdit, taskId: string | null): DialogsEdit {
  return new DialogsChange({ ...edit.view, archivePrompt: taskId });
}

/** The review picker, open on a thread at a step or closed. */
export function reviewPickerIn(edit: DialogsEdit, picker: ReviewPicker | null): DialogsEdit {
  return new DialogsChange({ ...edit.view, reviewPicker: picker });
}

/** The folder editor as the dialog draws it: the folder being edited, and how the last save went. */
export type ProjectEditorView = { project: Project; checkouts: number; saving: boolean; error: string | null };

export function projectEditorView(state: WorkspaceState): ProjectEditorView | null {
  const edit = state.projectEdit;
  const project = edit && state.projects.find((item) => item.id === edit.projectId);
  if (!edit || !project) return null;
  const checkouts = state.worktrees.filter((worktree) => worktree.projectId === project.id).length;
  return { project, checkouts, saving: edit.saving, error: edit.error };
}

/** The pending move as the confirmation draws it: where it goes, and what the thread is holding. */
export type WorktreeMoveView = {
  worktree: boolean;
  /** Uncommitted files in the checkout the thread is leaving, which the move commits first. */
  changes: number;
  /** Threads left in the worktree once this one goes, so the text can say whether it stays. */
  others: number;
};

export function worktreeMoveView(state: WorkspaceState): WorktreeMoveView | null {
  const move = state.worktreeMove;
  const thread = move && state.threads.find((item) => item.id === move.taskId);
  if (!move || !thread) return null;
  const workspaceId = threadWorkspaceId(state, thread);
  const environment = workspaceId ? state.environments[workspaceId] : undefined;
  const worktree = worktreeFor(state, thread);
  return {
    worktree: move.worktree,
    changes: environment?.status === "available" ? environment.files.length : 0,
    others: worktree ? Math.max(worktreeClaimants(state, worktree.id).length - 1, 0) : 0,
  };
}

/** The thread the archive confirmation asks about, wherever it is held, and whether archiving stops a run. */
export type ArchivePromptView = { taskId: string; title: string; running: boolean };

/** Null once the thread is gone or already archived, so the question never outlives what it asks about. */
export function archivePromptView(state: WorkspaceState, taskId = state.archivePrompt): ArchivePromptView | null {
  if (taskId === null) return null;
  const holder = computerOfThread(state, taskId)?.state ?? state;
  const thread = holder.threads.find((item) => item.id === taskId);
  if (!thread || thread.archivedAt !== undefined) return null;
  return { taskId, title: thread.title, running: holder.activeRuns[taskId] !== undefined };
}

export function settledArchivePrompt(state: WorkspaceState): WorkspaceState {
  return state.archivePrompt !== null && !archivePromptView(state) ? { ...state, archivePrompt: null } : state;
}

/** Dialogs always describe the window that opened them, including over a remote thread. */
export function workspaceDialogsView(state: WorkspaceState) {
  return { projectAdd: state.projectAdd, projectEditor: projectEditorView(state), worktreeMove: worktreeMoveView(state), forkName: state.forkName, archivePrompt: archivePromptView(state) };
}
