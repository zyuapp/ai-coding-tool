import type { ThreadWait } from "./thread-activity.js";
import type { ReadingPoint } from "../contracts/commands.js";
import { effortRoleOf } from "../domain/coordination.js";
import { normalizeDraft, type AgentDraft } from "../domain/agent-draft.js";
import type { RunTransitionState } from "./thread-run-state.js";
import { threadWorkspaceRoot } from "./thread-location.js";
import { initialThreadsState, type ThreadsState } from "./state/threads.js";
import { initialNavigationState, type NavigationState } from "./state/navigation.js";
import { initialProjectsState, type ProjectsState } from "./state/projects.js";
import { NO_PROJECT_ADD, type ProjectAddWorkspaceState } from "./state/project-add.js";
import { initialWorktreesState, type WorktreesState } from "./state/worktrees.js";
import { draftOf, initialNewThreadDraftState, type NewThreadDraftState } from "./state/new-thread-draft.js";
import { catalogOf, initialEnginesState, type EnginesState } from "./state/engines.js";
import { initialComposerState, NEW_THREAD_DRAFT, type ComposerState } from "./state/composer.js";
import { initialDialogsState, type DialogsState } from "./state/dialogs.js";
import { initialSettingsState, type SettingsState } from "./state/settings.js";
import { initialDocksState, type DocksState } from "./state/dock.js";
import { initialFindBarState, type FindBarState } from "./state/find.js";
import { initialBrowserState, type BrowserState } from "./state/browser.js";
import { initialSimulatorState, type SimulatorSliceState } from "./state/simulator.js";
import { initialDictationState, type DictationSliceState } from "./state/dictation.js";
import { initialGitState, type GitState } from "./state/pull-requests.js";
import { initialDesktopState, type DesktopState } from "./state/desktop.js";
import { initialCliState, initialComputerUseState, initialPlanUsageState, type CliSliceState, type ComputerUseSliceState, type PlanUsageSliceState } from "./state/machine-access.js";
import { initialAutomationsState, type AutomationsState } from "./state/automations.js";
import { initialRunsState, type RunsState } from "./state/runs.js";
import { initialSideChatsState, type SideChatsState } from "./state/side-chats.js";
import { initialRemoteState, type RemoteState } from "./state/remote.js";
import { initialAppUpdatesState, type AppUpdatesState } from "./state/app-updates.js";
import { initialToastsState, type ToastsState } from "./state/toasts.js";
import { initialComputersState, selectedComputer, type ComputersSliceState } from "./state/computers.js";
import { initialErrorsState, initialStoreState, type ErrorsState, type StoreState } from "./state/store.js";

export type { ReadingPoint, ThreadWait };
export type { ProjectEdit } from "./state/projects.js";
export type { DraftBranch } from "./state/new-thread-draft.js";
export type { ForkName, ReviewPicker } from "./state/dialogs.js";
export type { DesktopShortcutUnavailable } from "./state/settings.js";
export type { FindState, JumpState } from "./state/find.js";
export type { PendingRun, QueuedMessage } from "./state/runs.js";
export type { SideChat } from "./state/side-chats.js";
export type { PairedComputer } from "./state/computers.js";
export {
  AUTOMATION_PANEL, DIFF_PANEL, DOCK_PICKER, DRAFT_DOCK, OVERVIEW_PANEL, SIMULATOR_PANEL, WORKFLOW_PANEL, browserTarget,
  dockFor, dockSubject, dockHoldsTab, dockOwner, dockSideChats, dockTabAfterClosing, dockTabIds, dockTabKind, frontDock,
  keyboardTerminalId, keyboardThreadId, ownerOfBrowserTab, ownerOfTerminal, shownThreadTab, terminalTarget, withDock, type ThreadDock,
} from "./workspace-dock.js";
export { diffFor, diffMatches, foldedOnLoad, retainedViews, withDiff, type DiffState } from "./workspace-diff.js";

/**
 * Everything the window holds, joined from the state each slice owns. It stays one flat record: it is
 * persisted, mirrored to paired computers, and read by the phone.
 */
export type WorkspaceState =
  & ProjectAddWorkspaceState
  & ThreadsState
  & ProjectsState
  & WorktreesState
  & NavigationState
  & NewThreadDraftState
  & EnginesState
  & ComposerState
  & DialogsState
  & SettingsState
  & DocksState
  & FindBarState
  & BrowserState
  & SimulatorSliceState
  & DictationSliceState
  & GitState
  & DesktopState
  & CliSliceState
  & PlanUsageSliceState
  & ComputerUseSliceState
  & AutomationsState
  & RunsState
  & SideChatsState
  & RemoteState
  & AppUpdatesState
  & ToastsState
  & ComputersSliceState
  & RunTransitionState
  & StoreState
  & ErrorsState;

export function emptyWorkspaceState(storageError: string | null = null): WorkspaceState {
  return {
    ...initialThreadsState(),
    ...initialProjectsState(),
    ...initialWorktreesState(),
    ...initialNavigationState(),
    ...initialNewThreadDraftState(),
    ...initialEnginesState(),
    ...initialComposerState(),
    ...NO_PROJECT_ADD,
    ...initialDialogsState(),
    ...initialSettingsState(),
    ...initialDocksState(),
    ...initialFindBarState(),
    ...initialBrowserState(),
    ...initialSimulatorState(),
    ...initialDictationState(),
    ...initialGitState(),
    ...initialDesktopState(),
    ...initialCliState(),
    ...initialPlanUsageState(),
    ...initialComputerUseState(),
    ...initialAutomationsState(),
    ...initialRunsState(),
    ...initialSideChatsState(),
    ...initialRemoteState(),
    ...initialAppUpdatesState(),
    ...initialToastsState(),
    ...initialComputersState(),
    ...initialStoreState(storageError),
    ...initialErrorsState(),
  };
}

/** The folder the app is pointed at: the thread's own checkout, else its project, else the last one opened. */
export function currentFolder(state: WorkspaceState): string | null {
  const thread = state.threads.find((item) => item.id === state.currentId);
  const draft = state.draftProjectId ? state.projects.find((project) => project.id === state.draftProjectId)?.root : undefined;
  return threadWorkspaceRoot(state, thread) ?? draft ?? state.lastFolder;
}

/** The draft with `change` made and held to its engine, which is how its agent choices are ever written. */
export function withDraft(state: WorkspaceState, change: Partial<AgentDraft>): WorkspaceState {
  const draft = normalizeDraft(catalogOf(state), { ...draftOf(state), ...change }, effortRoleOf(undefined, state.draftRole));
  return { ...state, draftEngine: draft.engine, draftModel: draft.model, draftEffort: draft.effort, draftPolicy: draft.policy, draftFastMode: draft.fastMode };
}

/**
 * Which composer the window is typing into. While a paired computer's thread is on screen it is that
 * thread's, so the draft typed for it stays keyed to it here and never travels as keystrokes.
 */
export function promptKey(state: Pick<WorkspaceState, "currentId"> & { computers?: WorkspaceState["computers"] }): string {
  const remote = state.computers ? selectedComputer({ computers: state.computers })?.state : undefined;
  return (remote ?? state).currentId ?? NEW_THREAD_DRAFT;
}

/** Where the cursor lands moving `step` through history, stepping over threads that are gone or archived. */
export function reachableVisit(state: WorkspaceState, step: -1 | 1): number | null {
  for (let index = state.historyIndex + step, misses = 0, reachable: Set<string> | null = null;
    index >= 0 && index < state.history.length; index += step) {
    const id = state.history[index];
    if (reachable ? reachable.has(id) : state.threads.some((thread) => thread.id === id && thread.archivedAt === undefined)) return index;
    /** Short gaps are common. Index only once a long gap repays the allocation. */
    if (++misses === 128) reachable = new Set(state.threads.filter((thread) => thread.archivedAt === undefined).map((thread) => thread.id));
  }
  return null;
}

/** Remembers where the app took the user, dropping the forward entries the way a browser does. */
export function recordVisit(state: WorkspaceState, threadId: string): WorkspaceState {
  const history = state.history.slice(0, state.historyIndex + 1);
  if (history[history.length - 1] !== threadId) history.push(threadId);
  return { ...state, history, historyIndex: history.length - 1 };
}
