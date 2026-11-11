/**
 * Where the window is: the thread on screen and how the user got there, and the draft of the next
 * thread when none is. Only the functions here change them, so putting the user on a thread is one
 * thing however a command gets there.
 */
import { docksOf, editDock, focusDockTabIn, showDockTabIn } from "./dock-tabs.js";
import { refreshThreadEnvironment } from "./environment.js";
import { followUps } from "./shared.js";
import { afterward, andThen, applied, ownFields, type Step } from "./slice.js";
import { readIn, rowReadIn, threadsOf } from "./thread-edits.js";
import type { WorkspaceTransition } from "./types.js";
import { projectFor } from "../thread-location.js";
import { withoutMatching } from "../removals.js";
import { dockFor, type WorkspaceState } from "../workspace-state.js";
import type { NavigationState } from "../state/navigation.js";
import type { NewThreadDraftState } from "../state/new-thread-draft.js";
import type { AgentDraft } from "../../domain/agent-draft.js";
import { coordinatorOf } from "../../domain/coordination.js";
import type { ThreadRole } from "../../domain/thread-role.js";

type NavigationView = NavigationState & NewThreadDraftState;

/** Where the window is as one input leaves it. Only the functions here make one. */
class NavigationChange {
  private declare readonly owned: never;
  constructor(readonly view: NavigationView) {}
}

export type NavigationEdit = NavigationChange;

export function navigationOf(state: NavigationView): NavigationEdit {
  return new NavigationChange(ownFields<NavigationView>(state, {
    lastFolder: true, currentId: true, history: true, historyIndex: true, draftProjectId: true, draftPolicy: true, draftBranch: true,
    draftWorktree: true, draftWorktreeId: true, draftRole: true, draftEngine: true, draftModel: true, draftEffort: true, draftFastMode: true,
  }));
}

/** The window on a thread, the draft's project and the folder following it there. */
export function onThreadIn(edit: NavigationEdit, taskId: string, projectId: string | null, folder: string | undefined): NavigationEdit {
  return new NavigationChange({ ...edit.view, currentId: taskId, draftProjectId: projectId, lastFolder: folder ?? edit.view.lastFolder });
}

/** Threads gone for good, gone from history, the cursor staying on the visit it was on or the one before it. */
export function visitsForgottenIn(edit: NavigationEdit, removed: Set<string>): NavigationEdit {
  const { view } = edit;
  const history = withoutMatching(view.history, (threadId) => removed.has(threadId));
  let historyIndex = -1;
  for (let index = 0; index <= view.historyIndex && index < view.history.length; index += 1) {
    if (!removed.has(view.history[index]!)) historyIndex += 1;
  }
  return new NavigationChange({ ...view, history, historyIndex: Math.min(historyIndex, history.length - 1) });
}

/** The place in history back or forward lands on. */
export function historyAtIn(edit: NavigationEdit, index: number): NavigationEdit {
  return new NavigationChange({ ...edit.view, historyIndex: index });
}

/** No thread on screen, and a fresh draft in `projectId`, in the checkout it names if any, with nothing else of the last draft's placement. */
export function freshDraftIn(edit: NavigationEdit, projectId: string | null, worktreeId: string | null, folder: string | undefined): NavigationEdit {
  return new NavigationChange({
    ...edit.view, currentId: null, draftProjectId: projectId, draftBranch: null, draftWorktree: false, draftWorktreeId: worktreeId, draftRole: null,
    lastFolder: folder ?? edit.view.lastFolder,
  });
}

/** A folder just opened: the window leaves any thread for a draft there. */
export function projectOpenedIn(edit: NavigationEdit, projectId: string, root: string): NavigationEdit {
  return new NavigationChange({ ...edit.view, currentId: null, draftProjectId: projectId, lastFolder: root });
}

/** The last folder opened, without the window moving. */
export function folderOpenedIn(edit: NavigationEdit, root: string): NavigationEdit {
  return edit.view.lastFolder === root ? edit : new NavigationChange({ ...edit.view, lastFolder: root });
}

/** A project that is gone: off screen if its thread was, out of the draft, and no longer the last folder. */
export function projectLeftIn(edit: NavigationEdit, projectId: string, root: string | undefined, onScreen: boolean): NavigationEdit {
  const { view } = edit;
  return new NavigationChange({
    ...view,
    currentId: onScreen ? null : view.currentId,
    draftProjectId: view.draftProjectId === projectId ? null : view.draftProjectId,
    lastFolder: root === view.lastFolder ? null : view.lastFolder,
  });
}

/** A project that moved folders takes the last folder with it when it was that one. */
export function folderMovedIn(edit: NavigationEdit, root: string): NavigationEdit {
  return new NavigationChange({ ...edit.view, lastFolder: root });
}

/** The part the next new thread plays. */
export function draftRoleIn(edit: NavigationEdit, role: ThreadRole | null): NavigationEdit {
  return new NavigationChange({ ...edit.view, draftRole: role });
}

/** The agent choices the next new thread starts with, already held to its engine. */
export function draftChoiceIn(edit: NavigationEdit, draft: AgentDraft): NavigationEdit {
  return new NavigationChange({ ...edit.view, draftEngine: draft.engine, draftModel: draft.model, draftEffort: draft.effort, draftPolicy: draft.policy, draftFastMode: draft.fastMode });
}

/** Puts the user on a thread: what it holds becomes read, and the app follows it to its folder. */
export function landed(state: WorkspaceState, taskId: string): Step {
  const thread = state.threads.find((item) => item.id === taskId);
  const project = projectFor(state, thread);
  return { edits: [onThreadIn(navigationOf(state), taskId, thread?.projectId ?? null, project?.root), rowReadIn(threadsOf(state), taskId)], clearsError: true };
}

/** Back or forward to the thread at `index` in history, landing on it as any visit does. */
export function visited(state: WorkspaceState, index: number): Step {
  return andThen(state, { edits: [historyAtIn(navigationOf(state), index)] }, (moved) => landed(moved, state.history[index]));
}

/** {@link landed}, on the whole state. */
export function landOnThread(state: WorkspaceState, taskId: string): WorkspaceState {
  return afterward(state, landed(state, taskId));
}

/** A side chat, or a thread under a coordinator, opens as a tab in the dock of the thread it belongs to. */
export function selected(state: WorkspaceState, chosen: string): Step {
  const chat = state.sideChats.find((item) => item.id === chosen);
  const lead = chat ? undefined : coordinatorOf(state.threads, state.threads.find((item) => item.id === chosen));
  const taskId = chat?.sourceThreadId ?? lead?.id ?? chosen;
  const landing = landed(state, taskId);
  if (taskId === chosen) return landing;
  return andThen(state, landing, (onThread) => {
    const tabs = dockFor(onThread, taskId).threadTabs;
    const opened = lead && !tabs.includes(chosen) ? editDock(docksOf(onThread), taskId, { threadTabs: [...tabs, chosen] }) : docksOf(onThread);
    const focused = focusDockTabIn(showDockTabIn(opened, taskId, chosen), taskId, chosen);
    return {
      edits: [readIn(threadsOf(onThread), chosen), focused.docks],
      effects: lead ? [...focused.effects, ...followUps(refreshThreadEnvironment(onThread, chosen))] : focused.effects,
    };
  });
}

/** {@link selected}, on the whole state. */
export function selectThread(state: WorkspaceState, chosen: string): WorkspaceTransition {
  return applied(state, selected(state, chosen));
}
