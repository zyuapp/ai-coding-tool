import { clampQuote, promptWithAnnotations } from "./annotations.js";
import { promptWithAttachments, taskTitleFor } from "./attachments.js";
import { pasteTitle, promptWithPastes } from "./pastes.js";
import { threadHandleOptions } from "./thread-projection.js";
import { expandThreadHandles } from "../domain/thread-handles.js";
import { reduceProjects, type ProjectEvent, type RegisterProjectEffect } from "./project-commands.js";
import { activitySections, moveTask as moveTaskInList, nextSortIndex, orderTasks } from "./task-order.js";
import { dismissableTasks, dismissed, readAttention, withoutOutcome } from "../domain/attention.js";
import { declinedTick, raisedFinding, whyTickCannotRun } from "./findings.js";
import { outcomeFor, whyRunSurfaces, withNothingToReport, withSettledTick } from "./run-testimony.js";
import {
  applyRunEvent,
  applyTask,
  applyWorkflowEvent,
  ATTENDED_RUN,
  automationRunLabel,
  automationRunPrompt,
  threadMark,
  withActiveRun,
  withBackgroundProcesses,
  withRunStatus,
  withWorkflows,
  type RunProvenance,
  type ThreadMark,
} from "./task-workspace.js";
import { annotationsFor, imagesFor, withImages, blockedTaskIds, busyTaskIds, findTargetFor, browserTarget, diffFor, diffMatches, dockFor, dockOwner, DRAFT_DOCK, dockTabAfterClosing, dockTabIds, dockTabKind, workflowById, ownerOfBrowserTab, ownerOfTerminal, pastesFor, projectFor, promptKey, reachableVisit, recordVisit, sameReadingPoint, sideChatIds, taskWorkspaceId, taskWorkspaceRoot, terminalFolder, viewPreferences, withAnnotations, withDiff, withDock, withPastes, retainedViews, withPrompt, withStoreData, worktreeById, worktreeClaimants, worktreeFor, type DraftBranch, type FindState, type PendingRun, type QueuedMessage, type DiffState, type SideChat, type ThreadDock, type WorkspaceState } from "./workspace-state.js";
import type { AppCommand } from "../contracts/commands.js";
import type {
  ApprovalDecisionCommand,
  AutomationAck,
  AutomationFire,
  BrowserPageEvent,
  CancelRunCommand,
  ChangedFilesResult,
  DiffSummaryResult,
  FindingNotice,
  RunEvent,
  StartRunCommand,
  SteerRunCommand,
  StopProcessCommand,
  WorkflowEvent,
} from "../contracts/ipc.js";
import type { ViewPreferences } from "../contracts/preferences.js";
import type { AutomationDraft, AutomationPatch, AutomationView } from "../domain/automation.js";
import { browserOrigin, browserUrl, type BrowserAction, type BrowserTab } from "../domain/browser.js";
import { fileFingerprint, rangeKey, type DiffRange } from "../domain/diff.js";
import { PLAIN_ENGLISH_STYLE } from "../domain/output-style.js";
import { findHits, sameFindTarget, stepMatch, type FindResults, type FindTarget } from "../domain/find.js";
import { dockTabShortcutIndex, shortcutAction, shortcutProblem, withShortcut, type ShortcutOverrides, type ShortcutSurface } from "../domain/shortcuts.js";
import { isThemeMode, themeById, themeFor, themeModeOrDefault, themeOrDefault, variantFor } from "../domain/theme.js";
import { READING_SIZE, TERMINAL_SIZE, monoFontById, monoFontOrDefault, sizeById, sizeOrDefault, uiFontById, uiFontOrDefault } from "../domain/typography.js";
import { terminalTitle, type TerminalSession, type TerminalUpdate } from "../domain/terminal.js";
import { DEFAULT_EFFORT, DEFAULT_MODEL, type RunStatus, type SubagentActivity } from "../domain/run.js";
import type { CaptureOptions } from "../domain/capture.js";
import { clampTitle, createTaskMessage, findProject, legacyProjectId, MAX_ATTACHMENTS, sameRoot, type Annotation, type PastedText, type Project, type RunAttachment, type Task, type TaskStoreData } from "../domain/task.js";
import type { WorkspaceRecord } from "../domain/workspace.js";
import type { Worktree } from "../domain/worktree.js";
import type { CreatedWorktree, WorktreeSnapshotResult } from "../contracts/ipc.js";

/** Things that happened: replies to effects, and pushes from the main process. */
export type WorkspaceEvent =
  | { type: "store.loaded"; data: TaskStoreData }
  /** The store has nothing to hand over: a first run, with no threads to restore. */
  | { type: "store.absent" }
  | { type: "preferences.loaded"; preferences: ViewPreferences }
  | { type: "store.failed"; message: string }
  | { type: "action.failed"; message: string }
  | ProjectEvent
  | { type: "run.event"; event: RunEvent }
  /** A workflow reports to its thread rather than to a run, which may be long over by then. */
  | { type: "workflow.event"; event: WorkflowEvent }
  | { type: "run.resolved"; pendingId: string; workspace: WorkspaceRecord; worktree?: CreatedWorktree }
  | { type: "run.unresolved"; pendingId: string; message: string }
  | { type: "automation.fired"; fire: AutomationFire }
  | { type: "automations.changed"; automations: AutomationView[] }
  | { type: "title.suggested"; taskId: string; title: string }
  | { type: "worktree.created"; taskId: string; worktree: CreatedWorktree }
  | { type: "worktree.failed"; taskId: string; message: string }
  | { type: "worktree.released"; taskId: string; snapshot: WorktreeSnapshotResult }
  | { type: "worktree.deleted"; taskId: string }
  | { type: "environment.updated"; workspaceId: string; taskId?: string; runId?: string; result: ChangedFilesResult }
  /** A comparison's file list, named by the dock that asked so a slow read cannot land in another. */
  | { type: "diff.loaded"; owner: string; workspaceId: string; range: DiffRange; result: DiffSummaryResult }
  /** What a page in the browser panel did. Main watches the page; the reducer keeps the record. */
  | { type: "browser.updated"; page: BrowserPageEvent }
  /** What a shell did. Its output is not here: that goes straight to the view and never becomes state. */
  | { type: "terminal.updated"; update: TerminalUpdate }
  | { type: "subagent.activity.loaded"; taskId: string; subagentId: string; activity: SubagentActivity[] }
  /** The keystroke settings were waiting for, or null when the user pressed Escape instead. */
  | { type: "shortcut.captured"; binding: string | null }
  /** What a page or a shell found, counted by whoever holds the text. `index` counts from zero. */
  | { type: "find.results"; target: FindTarget; results: FindResults };

/** Work the reducer wants done outside itself. The renderer performs these; nothing else does. */
export type WorkspaceEffect =
  | { type: "pick-project" }
  | RegisterProjectEffect
  | { type: "persist-preferences"; preferences: ViewPreferences }
  | {
      type: "resolve-run-workspace";
      pendingId: string;
      picker: boolean;
      /** Where the run happens, when the reducer already knows. Carried whole so nothing downstream infers its kind. */
      workspace?: WorkspaceRecord;
      /** The project folder a picker has to match. */
      root?: string;
      createWorktree?: { projectRoot: string; carryChanges: boolean; branch?: string };
      /** Makes the branch the thread starts from, at the project's own HEAD, before anything reads it. */
      createBranch?: { workspaceId: string; branch: string };
      /** Moves the project checkout onto a branch first, for a thread that is not getting its own. */
      checkout?: { workspaceId: string; branch: string };
    }
  | { type: "create-worktree"; taskId: string; projectRoot: string }
  | { type: "release-worktree"; taskId: string; worktreeId: string; root: string; title: string }
  | { type: "delete-worktree"; taskId: string; root: string }
  | { type: "start-run"; command: StartRunCommand }
  | { type: "send-run-command"; command: CancelRunCommand | ApprovalDecisionCommand | SteerRunCommand | StopProcessCommand }
  | { type: "refresh-environment"; workspaceId: string; taskId?: string; runId?: string }
  | { type: "read-diff"; owner: string; workspaceId: string; range: DiffRange }
  /** Moves a checkout onto a branch, making it at that checkout's HEAD first when `create`. */
  | { type: "checkout-branch"; workspaceId: string; branch: string; create?: boolean }
  | { type: "suggest-title"; taskId: string; text: string; attachments: string[] }
  | { type: "load-subagent-activity"; taskId: string; subagentId: string }
  | { type: "automation.save"; draft: AutomationDraft }
  | { type: "automation.update"; taskId: string; patch: AutomationPatch }
  | { type: "automation.delete"; taskId: string }
  | { type: "automation.run-now"; taskId: string }
  | { type: "automation.ack"; ack: AutomationAck }
  /** The browser panel's pages. `open` is idempotent: a tab that already has a view keeps it. */
  | { type: "browser.open"; tabId: string; url?: string }
  | { type: "browser.navigate"; tabId: string; url: string }
  | { type: "browser.history"; tabId: string; delta: -1 | 1 }
  | { type: "browser.reload"; tabId: string }
  | { type: "browser.act"; tabId: string; action: BrowserAction }
  | { type: "browser.close"; tabId: string }
  /** Which tab the panel shows. Where it shows is the panel's own to report. */
  | { type: "browser.show"; tabId: string | null }
  | { type: "browser.clear-data" }
  /** A file the desktop opens for the reader. `root` is the checkout it has to sit inside. */
  | { type: "file.open"; root: string; path: string; line: number | null }
  /** The terminal panel's shells. `start` is idempotent: a terminal that already runs keeps its process. */
  | { type: "terminal.start"; terminalId: string; cwd: string }
  | { type: "terminal.write"; terminalId: string; data: string }
  | { type: "terminal.resize"; terminalId: string; cols: number; rows: number }
  | { type: "terminal.close"; terminalId: string }
  /** Nothing was left in front of the window, so ⌘W means what it always means. */
  | { type: "close-window" }
  /** The keystrokes the window matches. Only main sees the ones a page in the panel swallows. */
  | { type: "apply-shortcuts"; overrides: ShortcutOverrides }
  | { type: "apply-capture-options"; options: CaptureOptions }
  /** While settings wait for a keystroke, main hands every one of them over instead of acting. */
  | { type: "capture-shortcut"; capturing: boolean }
  /**
   * Find, in the things that hold their own text. The transcript needs no effect: the timeline reads
   * the match out of state and reveals it, folds and virtual rows and all.
   */
  | { type: "find-in-page"; tabId: string; query: string; forward: boolean; findNext: boolean }
  | { type: "stop-find-in-page"; tabId: string }
  | { type: "focus-browser"; tabId: string }
  | { type: "find-in-terminal"; terminalId: string; query: string; forward: boolean }
  | { type: "stop-find-in-terminal"; terminalId: string }
  /** Takes the keyboard off a page in the panel, which is the only way the find bar can have it. */
  | { type: "focus-window" }
  /** A finding on its way to the desktop, which is the only place a user who is elsewhere can be reached. */
  | { type: "announce-finding"; notice: FindingNotice };

export type WorkspaceInput = AppCommand | WorkspaceEvent;

export type WorkspaceTransition = { state: WorkspaceState; effects: WorkspaceEffect[] };

const REOPEN_PROJECT_ERROR = "Reopen this project folder before running a task.";
const SAME_PROJECT_ERROR = "Choose the same project folder to continue this task.";
const MISSING_PROJECT_ERROR = "This task's project is unavailable. Reopen the project folder before running it.";
const RUNNING_PROJECT_ERROR = "Stop the running tasks before removing this project.";
const BUSY_AUTOMATION_ERROR = "This task is already running. The automation will run on its next tick.";
const WORKTREE_PROJECT_ERROR = "Open this thread in a project folder before giving it a worktree.";
const WORKTREE_MISSING_ERROR = "That worktree is not one this app is keeping.";
const WORKTREE_ELSEWHERE_ERROR = "That worktree is a checkout of another project.";
const TERMINAL_FOLDER_ERROR = "Open a project folder before starting a terminal.";
const WORKTREE_RUNNING_ERROR = "Stop this thread's run before changing where it works.";
const WORKTREE_CREATING_ERROR = "This thread's worktree is still being created.";

const TOO_MANY_IMAGES_ERROR = `You can attach up to ${MAX_ATTACHMENTS} images.`;
const CHECKOUT_RUNNING_ERROR = "Stop the threads running in this project before starting one on another branch.";
const SWITCH_RUNNING_ERROR = "Stop the threads running in this checkout before switching it to another branch.";
const SWITCH_PROJECT_ERROR = "Open this thread in a project folder before switching branches.";
const FILE_FOLDER_ERROR = "Open this thread in a project folder before opening a file from it.";

export const WORKSPACE_ERRORS = {
  reopenProject: REOPEN_PROJECT_ERROR,
  sameProject: SAME_PROJECT_ERROR,
  busyAutomation: BUSY_AUTOMATION_ERROR,
  worktreeProject: WORKTREE_PROJECT_ERROR,
  worktreeMissing: WORKTREE_MISSING_ERROR,
  worktreeElsewhere: WORKTREE_ELSEWHERE_ERROR,
  terminalFolder: TERMINAL_FOLDER_ERROR,
  worktreeRunning: WORKTREE_RUNNING_ERROR,
  worktreeCreating: WORKTREE_CREATING_ERROR,
  checkoutRunning: CHECKOUT_RUNNING_ERROR,
  switchRunning: SWITCH_RUNNING_ERROR,
  switchProject: SWITCH_PROJECT_ERROR,
  fileFolder: FILE_FOLDER_ERROR,
} as const;

function now() {
  return Date.now();
}

function sameStrings(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameChangedFiles(left: ChangedFilesResult | null, right: ChangedFilesResult) {
  if (!left || left.status !== right.status) return false;
  if (left.status === "available" && right.status === "available") {
    return left.branch === right.branch
      && left.baseline === right.baseline
      && left.additions === right.additions
      && left.deletions === right.deletions
      && sameStrings(left.files, right.files);
  }
  if (left.status === "unavailable" && right.status === "unavailable") return left.reason === right.reason;
  if (left.status === "unknown" && right.status === "unknown") return left.workspaceId === right.workspaceId;
  if (left.status === "error" && right.status === "error") return left.message === right.message;
  return false;
}

function settled(state: WorkspaceState, effects: WorkspaceEffect[] = []): WorkspaceTransition {
  return { state, effects };
}

/** A named task has to exist; an unnamed command falls back to the one the user is looking at. */
function targetId(state: WorkspaceState, taskId: string | undefined): string | null {
  if (taskId === undefined) return state.currentId;
  return state.tasks.some((task) => task.id === taskId) ? taskId : null;
}

/** An archived task is unreachable, so its automation would tick forever with nowhere to run. */
function retireAutomations(state: WorkspaceState, taskIds: Iterable<string>): WorkspaceEffect[] {
  const scheduled = new Set(state.automations.map((automation) => automation.taskId));
  return [...taskIds].filter((taskId) => scheduled.has(taskId)).map((taskId) => ({ type: "automation.delete" as const, taskId }));
}

const BROWSER_URL_ERROR = "That is not a page the browser can open.";
const BROWSER_TAB_ERROR = "The browser has no page open to act on.";

/** Brings a tab to the front of its own dock, so a page or a shell nobody asked to see still lands somewhere. */
function showDockTab(state: WorkspaceState, owner: string, tab: string): WorkspaceState {
  return withDock(state, owner, { open: true, tab });
}

/**
 * Hands a dock tab the keyboard. The view watches the count rather than being told to focus, and the
 * window takes the keys back on its way, because only a page can hold them itself.
 */
function focusDockTab(state: WorkspaceState, owner: string, tab: string): WorkspaceTransition {
  const focused = { ...state, dockFocus: { owner, tab, count: (state.dockFocus?.count ?? 0) + 1 } };
  const page = dockFor(focused, owner).browserTabs.find((item) => item.id === tab);
  return settled(focused, page?.url ? [] : TAKE_KEYS);
}

/** Puts the caret in the composer, taking the keys back from a page that swallows them. */
function focusComposer(state: WorkspaceState): WorkspaceState {
  return { ...state, composerFocus: state.composerFocus + 1 };
}

/** The window has the keys again, which a page in the panel is otherwise holding. */
const TAKE_KEYS: WorkspaceEffect[] = [{ type: "focus-window" }];

function withBrowserTabs(state: WorkspaceState, owner: string, browserTabs: BrowserTab[]): WorkspaceState {
  return withDock(state, owner, { browserTabs });
}

function patchBrowserTab(state: WorkspaceState, owner: string, tabId: string, patch: Partial<BrowserTab>): WorkspaceState {
  return withBrowserTabs(state, owner, dockFor(state, owner).browserTabs.map((tab) => tab.id === tabId ? { ...tab, ...patch } : tab));
}

function persistView(state: WorkspaceState): WorkspaceEffect[] {
  return [{ type: "persist-preferences", preferences: viewPreferences(state) }];
}

/**
 * Loads the page, in the tab named or a new one. The origin is remembered when the user is the one
 * asking, which is what lets a run reach a site the user has already signed into. Only the user's
 * own load takes the panel: a run leaves the dock on whatever tab it was showing, open or closed,
 * and its page loads parked out of sight.
 */
function loadBrowserPage(state: WorkspaceState, owner: string, url: string, tabId: string | undefined, newTab: boolean, byUser: boolean): WorkspaceTransition {
  const origin = browserOrigin(url);
  const allowing = byUser && origin && !state.browserOrigins.includes(origin);
  const remembered = allowing ? { ...state, browserOrigins: [...state.browserOrigins, origin] } : state;
  const target = newTab ? undefined : browserTarget(dockFor(remembered, owner), tabId);
  const cleared = { ...remembered, browserApproval: null, actionError: null };
  if (target) {
    const surfaced = byUser ? showDockTab(cleared, owner, target.id) : cleared;
    const shown = withDock(patchBrowserTab(surfaced, owner, target.id, { url, loading: true, error: undefined }), owner, { browserTabId: target.id });
    const navigating = byUser ? focusDockTab(shown, owner, target.id) : settled(shown);
    return settled(navigating.state, [
      { type: "browser.navigate", tabId: target.id, url },
      ...persistView(navigating.state),
      ...navigating.effects,
    ]);
  }
  const tab: BrowserTab = { id: crypto.randomUUID(), url, title: "", loading: true, canGoBack: false, canGoForward: false };
  const surfaced = byUser ? showDockTab(cleared, owner, tab.id) : cleared;
  const shown = withDock(surfaced, owner, { browserTabs: [...dockFor(cleared, owner).browserTabs, tab], browserTabId: tab.id });
  const opened = byUser ? focusDockTab(shown, owner, tab.id) : settled(shown);
  return settled(opened.state, [
    { type: "browser.open", tabId: tab.id, url },
    /** The panel draws one page, so a tab nobody is looking at never claims it. */
    ...(byUser ? [{ type: "browser.show" as const, tabId: tab.id }] : []),
    ...persistView(opened.state),
    ...opened.effects,
  ]);
}

/** A page waiting for an address. It is a dock tab of its own from the moment it exists. */
function withBlankTab(state: WorkspaceState, owner: string) {
  const tab: BrowserTab = { id: crypto.randomUUID(), url: "", title: "", loading: false, canGoBack: false, canGoForward: false };
  const opened = withDock(showDockTab(state, owner, tab.id), owner, { browserTabs: [...dockFor(state, owner).browserTabs, tab], browserTabId: tab.id });
  return { state: opened, tab };
}

/**
 * Puts the navigation to the user. The ask always names the tab it would load in — a blank one when
 * the run wanted a new page — so it is shown in that tab rather than needing a panel of its own.
 */
function askToBrowse(state: WorkspaceState, owner: string, url: string, taskId: string, tabId: string | undefined, newTab: boolean): WorkspaceTransition {
  const target = newTab ? undefined : browserTarget(dockFor(state, owner), tabId);
  if (target) return settled({ ...showDockTab(state, owner, target.id), browserApproval: { url, taskId, tabId: target.id } });
  const { state: opened, tab } = withBlankTab(state, owner);
  return settled({ ...opened, browserApproval: { url, taskId, tabId: tab.id } }, [
    { type: "browser.open", tabId: tab.id },
    { type: "browser.show", tabId: tab.id },
  ]);
}

/** Closing a page hands the dock its neighbour, and the panel whichever page that turns out to be. */
function closeBrowserTab(state: WorkspaceState, owner: string, tabId: string | undefined, options: { onlyIfBlank?: boolean } = {}): WorkspaceTransition {
  const dock = dockFor(state, owner);
  const index = dock.browserTabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return settled(state);
  if (options.onlyIfBlank && dock.browserTabs[index].url) return settled(state);
  const tab = dock.tab === tabId ? dockTabAfterClosing(state, owner, tabId) : dock.tab;
  const browserTabs = dock.browserTabs.filter((page) => page.id !== tabId);
  const next = dock.browserTabId === tabId ? browserTabs[index - 1] ?? browserTabs[index] ?? null : browserTabs.find((page) => page.id === dock.browserTabId) ?? null;
  const closed = withDock(state, owner, { browserTabs, browserTabId: next?.id ?? null, tab });
  const showing = browserTabs.find((page) => page.id === tab);
  /** Only the dock on screen owns the panel, so closing a page in a dock behind it changes nothing there. */
  const shows = owner === dockOwner(state)
    ? showing ? browserEffectsForTab(closed, owner, showing.id) : [{ type: "browser.show" as const, tabId: null }]
    : [];
  return settled(closed, [
    { type: "browser.close", tabId: tabId! },
    ...shows,
    ...persistView(closed),
  ]);
}

/**
 * Whether a run may load this page without asking. One session serves the whole app, so a run browses
 * with every login the user has: an origin the user has never visited is theirs to allow, unless the
 * thread is already trusted to act without asking.
 */
function browserAllowed(state: WorkspaceState, taskId: string, url: string) {
  const origin = browserOrigin(url);
  if (origin && state.browserOrigins.includes(origin)) return true;
  return state.tasks.find((task) => task.id === taskId)?.executionPolicy === "autonomous";
}

/** Bringing a page to the front is what gives a restored one its view, and only then. */
function browserEffectsForTab(state: WorkspaceState, owner: string, dockTab: string): WorkspaceEffect[] {
  const tab = dockFor(state, owner).browserTabs.find((page) => page.id === dockTab);
  if (!tab) return [];
  return [{ type: "browser.open", tabId: tab.id, ...(tab.url ? { url: tab.url } : {}) }, { type: "browser.show", tabId: tab.id }];
}

/**
 * Which page the panel draws once the dock on screen changes. One panel serves every dock, so the
 * thread the user lands on hands it its own page, or takes the page away when it has none.
 */
function shownPageEffects(state: WorkspaceState): WorkspaceEffect[] {
  const owner = dockOwner(state);
  const dock = dockFor(state, owner);
  const effects = browserEffectsForTab(state, owner, dock.tab);
  return effects.length ? effects : [{ type: "browser.show", tabId: null }];
}

/** The dock a draft was composed in belongs to the thread that send creates, pages, shells and all. */
function handOverDraftDock(state: WorkspaceState, taskId: string): WorkspaceState {
  const { [DRAFT_DOCK]: draft, ...docks } = state.docks;
  const { [DRAFT_DOCK]: draftDiff, ...diffs } = state.diffs;
  const moved = draft ? { ...state, docks: { ...docks, [taskId]: draft } } : state;
  return draftDiff ? { ...moved, diffs: { ...diffs, [taskId]: draftDiff } } : moved;
}

/** A thread that is gone for good takes its dock with it: its pages close and its shells stop. */
function disposeDocks(state: WorkspaceState, owners: Iterable<string>): WorkspaceTransition {
  const docks = { ...state.docks };
  const diffs = { ...state.diffs };
  const effects: WorkspaceEffect[] = [];
  let emptied = false;
  for (const owner of owners) {
    if (diffs[owner]) {
      delete diffs[owner];
      emptied = true;
    }
    const dock = docks[owner];
    if (!dock) continue;
    effects.push(...dock.browserTabs.map((tab): WorkspaceEffect => ({ type: "browser.close", tabId: tab.id })));
    effects.push(...dock.terminals.map((terminal): WorkspaceEffect => ({ type: "terminal.close", terminalId: terminal.id })));
    delete docks[owner];
    emptied = true;
  }
  return emptied ? { state: { ...state, docks, diffs }, effects } : settled(state);
}

function withPending(state: WorkspaceState, pending: PendingRun): WorkspaceState {
  return { ...state, pendingRuns: { ...state.pendingRuns, [pending.id]: pending }, actionError: null };
}

function withoutPending(state: WorkspaceState, pendingId: string): WorkspaceState {
  const { [pendingId]: _settled, ...pendingRuns } = state.pendingRuns;
  return { ...state, pendingRuns };
}

/**
 * A checkout takes minutes to make, and until it lands the thread is neither where it was nor where
 * it is going. Marking it here is what keeps a second ask from making a second, orphaned checkout.
 */
function withCreatingWorktree(state: WorkspaceState, taskId: string): WorkspaceState {
  return { ...state, creatingWorktrees: [...state.creatingWorktrees, taskId], actionError: null };
}

function withoutCreatingWorktree(state: WorkspaceState, taskId: string): WorkspaceState {
  if (!state.creatingWorktrees.includes(taskId)) return state;
  return { ...state, creatingWorktrees: state.creatingWorktrees.filter((item) => item !== taskId) };
}

function queuedFor(state: WorkspaceState, taskId: string): QueuedMessage[] {
  return state.queuedMessages[taskId] ?? [];
}

function withQueued(state: WorkspaceState, taskId: string, messages: QueuedMessage[]): WorkspaceState {
  if (messages.length) return { ...state, queuedMessages: { ...state.queuedMessages, [taskId]: messages } };
  const { [taskId]: _drained, ...queuedMessages } = state.queuedMessages;
  return { ...state, queuedMessages };
}

/** Everything drafted alongside the text, flattened into the one prompt the agent reads. */
function sentPrompt(text: string, pastes: PastedText[], annotations: Annotation[], attachments: RunAttachment[]) {
  return promptWithAttachments(promptWithAnnotations(promptWithPastes(text, pastes), annotations), attachments);
}

function startRunCommand(state: WorkspaceState, task: Task, runId: string, prompt: string, workspaceId: string, policy = task.executionPolicy): StartRunCommand {
  return {
    type: "start",
    channel: "main",
    taskId: task.id,
    runId,
    prompt,
    workspaceId,
    policy,
    model: task.model ?? DEFAULT_MODEL,
    effort: task.effort ?? DEFAULT_EFFORT,
    ...(state.plainEnglish ? { outputStyle: PLAIN_ENGLISH_STYLE } : {}),
    ...(task.continuation ? { continuation: task.continuation } : {}),
  };
}

/** A side chat's first turn forks the source thread; every turn after resumes its own branch. */
function sideChannelFor(state: WorkspaceState, task: Task): Partial<StartRunCommand> {
  if (!state.sideChats.some((chat) => chat.id === task.id)) return {};
  if (task.continuation) return { channel: "side" };
  const continuation = forkableContinuation(state, task.id);
  return continuation ? { channel: "side", continuation, forkContinuation: true } : { channel: "side" };
}

/** The continuation a side chat starts from: its own once it has one, the source thread's before that. */
function forkableContinuation(state: WorkspaceState, taskId: string) {
  const chat = state.sideChats.find((item) => item.id === taskId);
  if (!chat) return undefined;
  const task = state.tasks.find((item) => item.id === taskId);
  return task?.continuation ?? state.tasks.find((item) => item.id === chat.sourceTaskId)?.continuation;
}

/**
 * Records the run against the task and marks it the task's latest, so stale replies can be dropped.
 * The new run supersedes whatever the last one concluded, so its verdict never outlives it, and it
 * keeps where the thread stood, which is what a run that settles unseen puts back.
 */
function beginRun(state: WorkspaceState, taskId: string, runId: string, provenance: RunProvenance = ATTENDED_RUN, before?: ThreadMark): WorkspaceState {
  const tasks = withoutOutcome(state.tasks, new Set([taskId]));
  const messagesBefore = tasks.find((task) => task.id === taskId)?.messages.length ?? 0;
  const mark = before ?? threadMark(state.tasks.find((task) => task.id === taskId));
  return withRunStatus(
    withActiveRun({ ...state, tasks, actionError: null, lastRunIds: { ...state.lastRunIds, [taskId]: runId } }, taskId, { taskId, runId, sequence: 0, status: "running", ...provenance, notified: false, acknowledged: false, reportedIssues: [], messagesBefore, before: mark }),
    taskId,
    "running",
  );
}

/** A human who joins a scheduled run owns it from then on: what it finds is an answer to them. */
function withAttendedRun(state: WorkspaceState, taskId: string): WorkspaceState {
  const active = state.activeRuns[taskId];
  if (!active || active.origin === "composer") return state;
  return withActiveRun(state, taskId, { ...active, origin: "composer" });
}

/** A steered message joined the run, so it leaves the queue and takes its place in the thread. */
function withDeliveredMessage(state: WorkspaceState, taskId: string, messageId: string): WorkspaceState {
  const queued = queuedFor(state, taskId);
  const delivered = queued.find((message) => message.id === messageId);
  if (!delivered) return state;
  return applyTask(withAttendedRun(withQueued(state, taskId, queued.filter((message) => message.id !== messageId)), taskId), taskId, (task) => ({
    ...task,
    messages: [...task.messages, createTaskMessage("user", delivered.text, undefined, delivered.attachments, delivered.annotations, delivered.pastes)],
    updatedAt: now(),
  }));
}

/**
 * A finished run hands its queue on one message at a time, so each queued message gets its own run
 * and the ones behind it wait for that run to finish. A run the user stopped hands the whole queue
 * back to the composer instead of speaking for them.
 */
function drainQueue(state: WorkspaceState, taskId: string, status: RunStatus): WorkspaceTransition {
  const queued = queuedFor(state, taskId);
  if (!queued.length) return settled(state);
  if (status === "cancelled") {
    const text = [...queued.map((message) => message.text), state.prompts[taskId] ?? ""].filter(Boolean).join("\n\n");
    const annotations = [...queued.flatMap((message) => message.annotations ?? []), ...annotationsFor(state, taskId)];
    const pastes = [...queued.flatMap((message) => message.pastes ?? []), ...pastesFor(state, taskId)];
    return settled(withPastes(withAnnotations(withPrompt(withQueued(state, taskId, []), taskId, text), taskId, annotations), taskId, pastes));
  }
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return settled(withQueued(state, taskId, []));
  const [next] = queued;
  const project = projectFor(state, task);
  const pending: PendingRun = {
    id: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    origin: "composer",
    taskId,
    ...(project ? { projectId: project.id } : {}),
    text: next.text,
    prompt: next.prompt,
    attachments: next.attachments,
    ...(next.annotations ? { annotations: next.annotations } : {}),
    ...(next.pastes ? { pastes: next.pastes } : {}),
    queuedIds: [next.id],
  };
  return settled(withPending(state, pending), [resolveWorkspaceEffect(pending.id, task, project, worktreeFor(state, task), false)]);
}

/**
 * Where a run happens: the checkout the thread is already in or was started in, one made on the way
 * if the thread asked for a new one, and otherwise the project itself. A thread that is moving takes
 * its uncommitted work with it; a thread starting in a worktree begins from that checkout as it
 * stands, which is also why a branch to start from has nothing left to say once one is named.
 */
function resolveWorkspaceEffect(pendingId: string, task: Task | undefined, project: Project | undefined, worktree: Worktree | undefined, wantsWorktree: boolean, branch?: DraftBranch | null): Extract<WorkspaceEffect, { type: "resolve-run-workspace" }> {
  if (worktree) {
    return { type: "resolve-run-workspace", pendingId, picker: false, workspace: { id: worktree.workspaceId, kind: "worktree", root: worktree.root } };
  }
  /** A branch the user named but the repository does not have yet is made before either path reads it. */
  const making = branch?.create && project?.workspaceId
    ? { createBranch: { workspaceId: project.workspaceId, branch: branch.name } }
    : {};
  if (wantsWorktree && project?.workspaceId) {
    return {
      type: "resolve-run-workspace",
      pendingId,
      picker: false,
      root: project.root,
      ...making,
      createWorktree: { projectRoot: project.root, carryChanges: Boolean(task), ...(branch ? { branch: branch.name } : {}) },
    };
  }
  return {
    type: "resolve-run-workspace",
    pendingId,
    picker: Boolean(project && !project.workspaceId),
    ...(project?.workspaceId ? { workspace: { id: project.workspaceId, kind: "project" as const, root: project.root } } : {}),
    ...(project ? { root: project.root } : {}),
    ...making,
    /** Without a checkout of its own, starting from a branch means moving the project onto it. */
    ...(branch && project?.workspaceId ? { checkout: { workspaceId: project.workspaceId, branch: branch.name } } : {}),
  };
}

/**
 * Whether a thread is working, counting the moment between a send and the checkout it resolves to.
 * A run that has not started yet still has an answer on its way about where it will happen.
 */
function threadBusy(state: WorkspaceState, taskId: string) {
  return Boolean(state.activeRuns[taskId]) || Object.values(state.pendingRuns).some((pending) => pending.taskId === taskId);
}

/** Whether a run is going in a checkout, so nothing moves the ground under it. */
function runsInWorkspace(state: WorkspaceState, workspaceId: string | undefined) {
  if (!workspaceId) return false;
  return Object.keys(state.activeRuns).some((taskId) => {
    const task = state.tasks.find((item) => item.id === taskId);
    return task ? taskWorkspaceId(state, task) === workspaceId : false;
  });
}

/**
 * One thread walks out of a checkout the others keep. It is local again and says so in its own
 * timeline; the directory and every other claim on it are untouched.
 */
function leaveWorktree(state: WorkspaceState, taskId: string, note: ReturnType<typeof createTaskMessage>): WorkspaceState {
  return applyTask(state, taskId, ({ worktreeId: _left, worktreeEnteredAt: _forked, ...task }) => ({
    ...task,
    messages: [...task.messages, note],
    updatedAt: now(),
  }));
}

/**
 * The checkout itself is gone, so every thread that claimed it is local again and hears why, and a
 * draft pointed at it goes back to the project. The record goes with the directory: nothing is left
 * pointing at a folder that is not there.
 */
function dropWorktree(state: WorkspaceState, worktreeId: string, note: () => ReturnType<typeof createTaskMessage>): WorkspaceState {
  return {
    ...state,
    worktrees: state.worktrees.filter((worktree) => worktree.id !== worktreeId),
    ...(state.draftWorktreeId === worktreeId ? { draftWorktreeId: null } : {}),
    tasks: state.tasks.map((task) => {
      if (task.worktreeId !== worktreeId) return task;
      const { worktreeId: _gone, worktreeEnteredAt: _forked, ...local } = task;
      return { ...local, messages: [...task.messages, note()], updatedAt: now() };
    }),
  };
}

/**
 * Hands back every checkout the threads that are leaving were the last to claim, so no directory
 * outlives its threads and none is pulled out from under a thread that is staying. A release commits
 * what is still loose in there first, exactly as switching back would.
 */
function releaseWorktrees(state: WorkspaceState, leaving: Task[]): WorkspaceEffect[] {
  const going = new Set(leaving.map((task) => task.id));
  const released = new Set<string>();
  return leaving.flatMap((task) => {
    const worktree = worktreeFor(state, task);
    if (!worktree || released.has(worktree.id)) return [];
    if (worktreeClaimants(state, worktree.id).some((claimant) => !going.has(claimant.id))) return [];
    released.add(worktree.id);
    return [{ type: "release-worktree" as const, taskId: task.id, worktreeId: worktree.id, root: worktree.root, title: task.title }];
  });
}

/** Records a checkout a run just made, and marks the one the run happens in as touched. */
function withUsedWorktree(state: WorkspaceState, created: Worktree | undefined, worktreeId: string | undefined): WorkspaceState {
  if (!worktreeId) return state;
  const known = created && !state.worktrees.some((item) => item.id === created.id) ? [...state.worktrees, created] : state.worktrees;
  return { ...state, worktrees: known.map((item) => item.id === worktreeId ? { ...item, lastUsedAt: now() } : item) };
}

function ack(pending: PendingRun, started: boolean): WorkspaceEffect[] {
  return pending.automationId ? [{ type: "automation.ack", ack: { automationId: pending.automationId, runId: pending.runId, started } }] : [];
}

function withSideChat(state: WorkspaceState, chatId: string, update: (chat: SideChat) => SideChat): WorkspaceState {
  return { ...state, sideChats: state.sideChats.map((chat) => chat.id === chatId ? update(chat) : chat) };
}

/** Closing a side chat discards the thread itself, so its run, queue, and draft go with it. */
function closeSideChats(state: WorkspaceState, closing: SideChat[]): WorkspaceTransition {
  const effects: WorkspaceEffect[] = [];
  let next = state;
  for (const chat of closing) {
    const active = next.activeRuns[chat.id];
    if (active) {
      effects.push({ type: "send-run-command", command: { type: "cancel", taskId: chat.id, runId: active.runId } });
      const { [active.runId]: _abandoned, ...approvals } = next.approvals;
      next = { ...next, approvals };
    }
    next = withImages(withPastes(withAnnotations(withPrompt(withQueued(withRunStatus(withActiveRun(withBackgroundProcesses(next, chat.id, []), chat.id, null), chat.id, "idle"), chat.id, []), chat.id, ""), chat.id, []), chat.id, []), chat.id, []);
  }
  const closed = new Set(closing.map((chat) => chat.id));
  /** Nothing a side chat can reach schedules one today; this keeps that true if the tool table changes. */
  effects.push(...retireAutomations(next, closed));
  return {
    state: {
      ...next,
      automations: next.automations.filter((automation) => !closed.has(automation.taskId)),
      tasks: next.tasks.filter((task) => !closed.has(task.id)),
      sideChats: next.sideChats.filter((chat) => !closed.has(chat.id)),
      docks: Object.fromEntries(Object.entries(next.docks).map(([owner, dock]): [string, ThreadDock] => [
        owner,
        closed.has(dock.tab) ? { ...dock, tab: dockTabAfterClosing(next, owner, dock.tab) } : dock,
      ])),
      pendingRuns: Object.fromEntries(Object.entries(next.pendingRuns).filter(([, pending]) => !(pending.taskId && closed.has(pending.taskId)))),
      readingPoints: Object.fromEntries(Object.entries(next.readingPoints).filter(([taskId]) => !closed.has(taskId))),
    },
    effects,
  };
}

/** What a search asks of whoever holds the text. A thread's own matches are counted in the view. */
function searchEffects(find: FindState, { findNext, forward }: { findNext: boolean; forward: boolean }): WorkspaceEffect[] {
  const query = find.query.trim();
  if (!query || find.target.kind === "transcript") return [];
  return find.target.kind === "browser"
    ? [{ type: "find-in-page", tabId: find.target.tabId, query, forward, findNext }]
    : [{ type: "find-in-terminal", terminalId: find.target.terminalId, query, forward }];
}

/** A page and a shell keep highlighting what was found until they are told to stop. */
function stopSearchEffects(find: FindState | null): WorkspaceEffect[] {
  if (!find || find.target.kind === "transcript") return [];
  return find.target.kind === "browser"
    ? [{ type: "stop-find-in-page", tabId: find.target.tabId }]
    : [{ type: "stop-find-in-terminal", terminalId: find.target.terminalId }];
}

/** Find belongs to what it is searching, so it goes when that thread, page, or shell does. */
function prunedFind(state: WorkspaceState, before: WorkspaceState): WorkspaceState {
  const focusedTerminalId = state.focusedTerminalId && ownerOfTerminal(state, state.focusedTerminalId) ? state.focusedTerminalId : null;
  const find = state.find;
  const gone = !find
    ? false
    : find.target.kind === "transcript"
      ? state.currentId !== before.currentId
      : find.target.kind === "browser"
        ? !ownerOfBrowserTab(state, find.target.tabId)
        : !ownerOfTerminal(state, find.target.terminalId);
  if (!gone && focusedTerminalId === state.focusedTerminalId) return state;
  return { ...state, focusedTerminalId, ...(gone ? { find: null, findResults: null } : {}) };
}

/** A dock follows a workflow only while its record is there, so a run that clears one closes its panel. */
function prunedWorkflowPanels(state: WorkspaceState): WorkspaceState {
  const stale = Object.entries(state.docks).filter(([, dock]) => dock.workflowId && !workflowById(state, dock.workflowId));
  if (!stale.length) return state;
  let next = state;
  for (const [owner] of stale) {
    const dock = dockFor(next, owner);
    const panels = dock.panels.filter((panel) => panel !== WORKFLOW_PANEL);
    const tab = dock.tab === WORKFLOW_PANEL ? dockTabAfterClosing(next, owner, WORKFLOW_PANEL) : dock.tab;
    next = withDock(next, owner, { workflowId: null, panels, tab });
  }
  return next;
}

/**
 * The single writer for workspace state. Commands come from the UI (and, later, from anything else
 * driving the app); events report what the outside world did back. Nothing here touches Electron.
 */
export function reduce(state: WorkspaceState, input: WorkspaceInput): WorkspaceTransition {
  /** A keystroke is whatever the user could have clicked, so it re-enters here as those commands. */
  if (input.type === "view.shortcut") {
    return shortcutCommands(state, input.action, input.surface).reduce<WorkspaceTransition>((transition, command) => {
      const next = reduce(transition.state, command);
      return { state: next.state, effects: [...transition.effects, ...next.effects] };
    }, settled(state));
  }
  const applied = apply(state, input);
  const transition = { state: prunedWorkflowPanels(prunedFind(applied.state, state)), effects: applied.effects };
  if (transition.state.currentId === state.currentId) return transition;
  const landed = transition.state.currentId !== null && input.type !== "view.go-back" && input.type !== "view.go-forward"
    ? recordVisit(transition.state, transition.state.currentId)
    : transition.state;
  /**
   * The dock the thread was left in comes back as it was; only the panel's own page has to follow. The
   * keys come back to the window too, since the page they were on belongs to the thread just left.
   */
  return { state: landed, effects: [...transition.effects, ...shownPageEffects(landed), ...(landed.focused ? TAKE_KEYS : [])] };
}

/** The project a new thread starts in: the one the current thread is in, else the one being drafted. */
function currentProjectId(state: WorkspaceState): string | undefined {
  const task = state.tasks.find((item) => item.id === state.currentId);
  return (state.currentId ? task?.projectId : state.draftProjectId) ?? undefined;
}

/**
 * What a bound keystroke means. Only the surface it was pressed on decides between a thread and a
 * page: everything else reads the same state the buttons do.
 */
export function shortcutCommands(state: WorkspaceState, action: string, surface: ShortcutSurface): AppCommand[] {
  const tab = dockTabShortcutIndex(action);
  if (tab !== null) return [{ type: "view.select-dock-index", index: tab }];
  const projectId = currentProjectId(state);
  const newThread: AppCommand = { type: "task.new", ...(projectId ? { projectId } : {}) };
  /** Settings are drawn over the whole window, so a keystroke that moves the user somewhere leaves them. */
  const leaving: AppCommand[] = state.settingsOpen || state.computerUseSetup ? [{ type: "view.set-settings-open", open: false }] : [];
  switch (action) {
    case "thread.new": return [...leaving, newThread];
    case "thread.new-worktree": return [...leaving, newThread, { type: "task.set-worktree", worktree: true }];
    case "run.cancel": return [{ type: "run.cancel" }];
    case "run.allow": return [{ type: "run.decide", allow: true }];
    case "run.deny": return [{ type: "run.decide", allow: false }];
    case "composer.focus": return [{ type: "view.focus-composer" }];
    /** A bar that is already open is the one being asked for again, so it keeps what it was searching. */
    case "find.open": return [state.find ? { type: "view.find-open" } : { type: "view.find-open", target: findTargetFor(state, surface) }];
    case "find.next":
    case "find.previous": {
      const delta = action === "find.next" ? 1 as const : -1 as const;
      return state.find ? [{ type: "view.find-step", delta }] : [{ type: "view.find-open", target: findTargetFor(state, surface) }];
    }
    case "nav.back": return surface === "browser" ? [{ type: "browser.go", delta: -1 }] : [...leaving, { type: "view.go-back" }];
    case "nav.forward": return surface === "browser" ? [{ type: "browser.go", delta: 1 }] : [...leaving, { type: "view.go-forward" }];
    case "page.reload": return [{ type: "browser.reload" }];
    case "tab.new": return [{ type: "view.new-tab" }];
    /** A shell is asked for, not a second one: the dock's newest answers before a new one is spun up. */
    case "terminal.focus": {
      const latest = dockFor(state, dockOwner(state)).terminals.at(-1);
      return [...leaving, latest ? { type: "terminal.select", terminalId: latest.id } : { type: "terminal.open" }];
    }
    case "tab.close": return [{ type: "view.close-tab" }];
    case "dock.toggle": return [{ type: "view.set-dock-open", open: !dockFor(state, dockOwner(state)).open }];
    case "dock.expand": return [{ type: "view.set-dock-expanded", expanded: !dockFor(state, dockOwner(state)).expanded }];
    case "sidebar.toggle": return [{ type: "view.set-sidebar-open", open: !state.sidebarOpen }];
    case "settings.toggle": return [{ type: "view.set-settings-open", open: !state.settingsOpen }];
    default: return [];
  }
}

/** The dock tab the review is drawn in, which the picker and the composer both name. */
export const DIFF_PANEL = "diff";

/** The dock tab one workflow is followed in. */
export const WORKFLOW_PANEL = "workflow";

/** The checkout the thread in front works in: what Git is read from, for its diff as for its status. */
function currentWorkspaceId(state: WorkspaceState) {
  const currentTask = state.tasks.find((task) => task.id === state.currentId);
  if (currentTask) return taskWorkspaceId(state, currentTask);
  return state.draftProjectId ? state.projects.find((project) => project.id === state.draftProjectId)?.workspaceId : undefined;
}

/**
 * What a review opens on. The session panel counts from where HEAD left the origin default branch, so
 * a review reached from that row starts on the same comparison and reports the same totals. Without
 * an origin to measure from there is nothing but the working tree, which is what it falls back to.
 */
function initialRange(state: WorkspaceState, diff: DiffState): DiffRange {
  if (diff.result !== null) return diff.range;
  const counted = state.environment && state.environment.workspaceId === currentWorkspaceId(state) ? state.environment.result : null;
  const baseline = counted?.status === "available" ? counted.baseline : null;
  return baseline ? { kind: "branches", base: baseline, compare: null } : diff.range;
}

/**
 * Asks for a comparison, and records in the same breath which checkout was asked. The two have to move
 * together: a reply is only accepted when it names the checkout and comparison the dock is holding, so
 * an effect issued without writing that down is an answer the reducer would throw away.
 */
function readDiffFrom(state: WorkspaceState, owner: string, workspaceId: string | undefined, range: DiffRange, patch: Partial<DiffState> = {}): WorkspaceTransition {
  if (!workspaceId) return settled(withDiff(state, owner, { ...patch, range, workspaceId: null, result: null, loading: false }));
  return settled(
    withDiff(state, owner, { ...patch, range, workspaceId, loading: true }),
    [{ type: "read-diff", owner, workspaceId, range }],
  );
}

/** The same, for the thread the user is looking at. */
function readDiff(state: WorkspaceState, owner: string, range: DiffRange, patch: Partial<DiffState> = {}): WorkspaceTransition {
  return readDiffFrom(state, owner, currentWorkspaceId(state), range, patch);
}

/**
 * A thread whose checkout changed is reviewing the wrong one until it reads again. Nothing to do for a
 * thread with no review open, which is most of them.
 */
function rereadDiff(state: WorkspaceState, taskId: string): WorkspaceTransition {
  const diff = state.diffs[taskId];
  if (!diff) return settled(state);
  const workspaceId = taskWorkspaceId(state, state.tasks.find((task) => task.id === taskId));
  return diff.workspaceId === workspaceId ? settled(state) : readDiffFrom(state, taskId, workspaceId, diff.range, { result: null, collapsed: [], viewed: {} });
}

/** Settings stop waiting for a keystroke the moment they are no longer the thing in front. */
function stopCapture(state: WorkspaceState): WorkspaceEffect[] {
  return state.capturingShortcut === null ? [] : [{ type: "capture-shortcut", capturing: false }];
}

/** Every input but the keystroke, which {@link reduce} has already turned into the commands it means. */
function apply(state: WorkspaceState, input: Exclude<WorkspaceInput, { type: "view.shortcut" }>): WorkspaceTransition {
  switch (input.type) {
    case "task.new": {
      /** A checkout names the project it was cut from, so starting in one settles both answers. */
      const worktree = worktreeById(state, input.worktreeId);
      const projectId = worktree?.projectId ?? input.projectId ?? null;
      const project = projectId ? state.projects.find((item) => item.id === projectId) : undefined;
      /** A fresh draft compares its own project, not whatever the last draft was left looking at. */
      const { [DRAFT_DOCK]: _lastDraft, ...diffs } = state.diffs;
      /** A new thread is asked for in order to type in it, so the caret goes to the empty composer. */
      return settled(focusComposer({
        ...state,
        diffs,
        currentId: null,
        draftProjectId: projectId,
        draftBranch: null,
        draftWorktree: false,
        draftWorktreeId: worktree?.id ?? null,
        actionError: null,
        lastFolder: project?.root ?? state.lastFolder,
        expandedProjects: projectId ? new Set(state.expandedProjects).add(projectId) : state.expandedProjects,
      }), TAKE_KEYS);
    }

    case "task.select": {
      const task = state.tasks.find((item) => item.id === input.taskId);
      const project = projectFor(state, task);
      return settled(readAttention({
        ...state,
        currentId: input.taskId,
        draftProjectId: task?.projectId ?? null,
        lastFolder: project?.root ?? state.lastFolder,
        actionError: null,
      }, input.taskId));
    }

    case "task.dismiss": {
      const tasks = dismissed(state.tasks, new Set([input.taskId]));
      return settled(tasks === state.tasks ? state : { ...state, tasks });
    }

    case "task.dismiss-all": {
      /** Only what the button offers: the Priority rows. A thread still working has yet to show what it found. */
      const listed = state.tasks.filter((task) => task.archivedAt === undefined && !sideChatIds(state).has(task.id));
      const { priority } = activitySections(listed, busyTaskIds(state), blockedTaskIds(state));
      const dotted = new Set(dismissableTasks(priority).map((task) => task.id));
      return settled(dotted.size ? { ...state, tasks: dismissed(state.tasks, dotted) } : state);
    }

    /**
     * Archiving a running task cancels its run; the task leaves the sidebar without waiting for the
     * run to settle. Its checkout goes back too, so an archived thread never holds one for good.
     */
    case "task.archive": {
      const active = state.activeRuns[input.taskId];
      const archived = state.tasks.filter((task) => task.id === input.taskId);
      return settled({
        ...state,
        tasks: state.tasks.map((task) => task.id === input.taskId ? { ...task, archivedAt: now() } : task),
        currentId: state.currentId === input.taskId ? null : state.currentId,
      }, [
        ...retireAutomations(state, [input.taskId]),
        ...(active ? [{ type: "send-run-command" as const, command: { type: "cancel" as const, taskId: active.taskId, runId: active.runId } }] : []),
        /** Cancelling first, so nothing is still working in the checkout when it is handed back. */
        ...releaseWorktrees(state, archived),
      ]);
    }

    /** Restoring leaves the retired automation gone; the user re-arms it themselves. */
    case "task.restore": {
      const task = state.tasks.find((item) => item.id === input.taskId);
      if (!task || task.archivedAt === undefined) return settled(state);
      return settled(applyTask(state, input.taskId, ({ archivedAt: _restored, ...item }) => item));
    }

    case "task.clear-archive": {
      if (state.tasks.every((task) => task.archivedAt === undefined)) return settled(state);
      const archived = state.tasks.filter((task) => task.archivedAt !== undefined);
      const discarded = new Set(archived.map((task) => task.id));
      /** A fork of a thread that is gone has nowhere left to be shown, so it goes with it. */
      const forks = closeSideChats(state, state.sideChats.filter((chat) => discarded.has(chat.sourceTaskId)));
      const disposed = disposeDocks(forks.state, discarded);
      const tasks = disposed.state.tasks.filter((task) => !discarded.has(task.id));
      return {
        state: {
          ...disposed.state,
          tasks,
          /** A checkout nothing claims any more has no thread left to record it against. */
          worktrees: disposed.state.worktrees.filter((worktree) => tasks.some((task) => task.worktreeId === worktree.id)),
          currentId: tasks.some((task) => task.id === state.currentId) ? state.currentId : null,
        },
        /** Without this the checkouts would linger until the next launch reconciled them away. */
        effects: [...forks.effects, ...disposed.effects, ...releaseWorktrees(state, archived)],
      };
    }

    case "task.rename": {
      const title = clampTitle(input.title);
      if (!title || !state.tasks.some((task) => task.id === input.taskId)) return settled(state);
      return settled(applyTask(state, input.taskId, (task) => ({ ...task, title, titleByUser: true, updatedAt: now() })));
    }

    /** A name the user typed outranks a suggested one, whenever the suggestion lands. */
    case "title.suggested": {
      const task = state.tasks.find((item) => item.id === input.taskId);
      const title = clampTitle(input.title);
      if (!task || task.titleByUser || !title || title === task.title) return settled(state);
      return settled(applyTask(state, input.taskId, (item) => ({ ...item, title })));
    }

    /** A drag reveals every folder so it can be dropped into, so the drop leaves the folding alone. */
    case "task.move": {
      const tasks = moveTaskInList(state.tasks, input.taskId, input.target);
      if (tasks === state.tasks) return settled(state);
      return settled({ ...state, tasks, openMenu: null });
    }

    case "task.set-policy": {
      const taskId = targetId(state, input.taskId);
      const drafted = input.taskId === undefined ? { ...state, draftPolicy: input.policy } : state;
      return settled(taskId ? applyTask(drafted, taskId, (task) => ({ ...task, executionPolicy: input.policy, updatedAt: now() })) : drafted);
    }

    case "task.set-model": {
      const taskId = targetId(state, input.taskId);
      const drafted = input.taskId === undefined ? { ...state, draftModel: input.model } : state;
      return settled(taskId ? applyTask(drafted, taskId, (task) => ({ ...task, model: input.model, updatedAt: now() })) : drafted);
    }

    case "task.set-effort": {
      const taskId = targetId(state, input.taskId);
      const drafted = input.taskId === undefined ? { ...state, draftEffort: input.effort } : state;
      return settled(taskId ? applyTask(drafted, taskId, (task) => ({ ...task, effort: input.effort, updatedAt: now() })) : drafted);
    }

    /**
     * Moves the thread there and then, so it is never left saying it will move later. Turning it off
     * takes this thread's claim off the checkout; the last claim to go takes the directory with it,
     * and what it still holds is committed first.
     */
    case "task.set-worktree": {
      const taskId = targetId(state, input.taskId);
      const task = taskId ? state.tasks.find((item) => item.id === taskId) : undefined;
      /** With no thread yet the answer is a draft: the checkout is made when the first message goes. */
      /** Asking for a checkout of its own is asking for a new one, so it drops any the user had picked. */
      if (!task) return settled(input.taskId === undefined ? { ...state, draftWorktree: input.worktree, draftWorktreeId: null } : state);
      if (state.creatingWorktrees.includes(task.id)) return settled({ ...state, actionError: WORKTREE_CREATING_ERROR });
      if (threadBusy(state, task.id)) return settled({ ...state, actionError: WORKTREE_RUNNING_ERROR });
      if (input.worktree) {
        if (task.worktreeId) return settled(state);
        const project = projectFor(state, task);
        if (!project?.workspaceId) return settled({ ...state, actionError: WORKTREE_PROJECT_ERROR });
        return settled(withCreatingWorktree(state, task.id), [{ type: "create-worktree", taskId: task.id, projectRoot: project.root }]);
      }
      const leaving = worktreeFor(state, task);
      if (!leaving) return settled(state);
      const releasing = releaseWorktrees(state, [task]);
      /** A checkout other threads are still in stays where it is; only this thread walks out of it. */
      if (!releasing.length) {
        return settled(leaveWorktree({ ...state, actionError: null }, task.id, createTaskMessage(
          "system",
          "Returned to the project checkout. The worktree is still there, and other threads are still working in it.",
          leaving.root,
        )));
      }
      return settled({ ...state, actionError: null }, releasing);
    }

    /** Only a thread yet to be created can be told where to start; an existing one already is. */
    case "task.set-branch":
      return settled({
        ...state,
        draftBranch: input.branch === null ? null : { name: input.branch, create: Boolean(input.create) },
        actionError: null,
      });

    /**
     * Moves the checkout itself, which everything working in it sees, so nothing may be running
     * there. A thread that does not exist yet has no checkout to move: it only records where to start.
     */
    case "task.checkout-branch": {
      const taskId = targetId(state, input.taskId);
      const task = taskId ? state.tasks.find((item) => item.id === taskId) : undefined;
      if (!task) return apply(state, { type: "task.set-branch", branch: input.branch, ...(input.create ? { create: true } : {}) });
      const workspaceId = taskWorkspaceId(state, task);
      if (!workspaceId) return settled({ ...state, actionError: SWITCH_PROJECT_ERROR });
      if (state.creatingWorktrees.includes(task.id)) return settled({ ...state, actionError: WORKTREE_CREATING_ERROR });
      if (runsInWorkspace(state, workspaceId) || threadBusy(state, task.id)) return settled({ ...state, actionError: SWITCH_RUNNING_ERROR });
      return settled({ ...state, actionError: null }, [{
        type: "checkout-branch",
        workspaceId,
        branch: input.branch,
        ...(input.create ? { create: true } : {}),
      }]);
    }

    /**
     * Unlike switching back, this keeps nothing: the checkout and everything loose in it go, for
     * every thread in it. A thread still working in there would lose the ground under it, so one
     * busy claimant stops the whole thing.
     */
    case "worktree.delete": {
      const taskId = targetId(state, input.taskId);
      const task = taskId ? state.tasks.find((item) => item.id === taskId) : undefined;
      const worktree = worktreeFor(state, task);
      if (!task || !worktree) return settled(state);
      const claimants = worktreeClaimants(state, worktree.id);
      if (claimants.some((claimant) => threadBusy(state, claimant.id))) return settled({ ...state, actionError: WORKTREE_RUNNING_ERROR });
      return settled({ ...state, actionError: null }, [{ type: "delete-worktree", taskId: task.id, root: worktree.root }]);
    }

    case "worktree.created": {
      const settling = withoutCreatingWorktree(state, input.taskId);
      const task = settling.tasks.find((item) => item.id === input.taskId);
      /**
       * A thread that was archived, discarded, or left without a project while its checkout was being
       * made has nothing left to work in it. The checkout is seconds old and untouched, so it goes
       * now rather than waiting for the next launch to reap it.
       */
      if (!task || task.archivedAt !== undefined || !task.projectId) {
        if (task?.worktreeId) return settled(settling);
        return settled(settling, [{ type: "delete-worktree", taskId: input.taskId, root: input.worktree.root }]);
      }
      if (task.worktreeId) return settled(settling);
      const worktree: Worktree = { ...input.worktree, projectId: task.projectId };
      const note = createTaskMessage("system", `Moved into a worktree at ${worktree.root}`, `Detached at ${worktree.baseCommit.slice(0, 7)}`);
      return rereadDiff(applyTask({ ...settling, worktrees: [...settling.worktrees, worktree] }, input.taskId, (item) => ({
        ...item,
        worktreeId: worktree.id,
        messages: [...item.messages, note],
        updatedAt: now(),
      })), input.taskId);
    }

    case "worktree.failed":
      return settled({ ...withoutCreatingWorktree(state, input.taskId), actionError: input.message });

    case "worktree.released": {
      const task = state.tasks.find((item) => item.id === input.taskId);
      const worktree = worktreeFor(state, task);
      if (!worktree) return settled(state);
      const { commit, shortCommit, ref } = input.snapshot;
      const text = commit
        ? `Returned to the project checkout. Uncommitted work was committed as ${shortCommit ?? commit.slice(0, 7)}, and the worktree was removed.`
        : "Returned to the project checkout. The worktree had nothing uncommitted, and was removed.";
      return rereadDiff(dropWorktree(state, worktree.id, () => createTaskMessage("system", text, ref ? `Recover it with git show ${ref}` : undefined)), input.taskId);
    }

    case "worktree.deleted": {
      const task = state.tasks.find((item) => item.id === input.taskId);
      const worktree = worktreeFor(state, task);
      if (!worktree) return settled(state);
      return rereadDiff(dropWorktree(state, worktree.id, () => createTaskMessage("system", "Worktree deleted. Back on the project checkout.")), input.taskId);
    }

    case "task.send": {
      const attachments = input.attachments ?? [];
      /** A send that carries its own text is not the composer's: it neither reads nor clears a draft. */
      const draftKey = input.text === undefined ? input.taskId ?? promptKey(state) : undefined;
      const drafted = (input.text ?? (draftKey === undefined ? undefined : state.prompts[draftKey]) ?? "").trim();
      /** `@handles` are a composer affordance, so only a draft's own text is read for them. */
      const text = draftKey === undefined ? drafted : expandThreadHandles(drafted, threadHandleOptions(state, draftKey));
      /** The anchors mark drafts in the transcript; the sent message keeps only quote and note. */
      const annotations = (draftKey === undefined ? [] : annotationsFor(state, draftKey)).map(({ anchor: _anchored, ...annotation }) => annotation);
      const pastes = draftKey === undefined ? [] : pastesFor(state, draftKey);
      const alreadySending = draftKey !== undefined && Object.values(state.pendingRuns).some((pending) => pending.draftKey === draftKey);
      if ((!text && attachments.length === 0 && annotations.length === 0 && pastes.length === 0) || alreadySending) return settled(state);
      if (input.taskId !== undefined && !targetId(state, input.taskId)) return settled(state);
      /** A side chat has nothing to say until the thread it forks from has a session to fork. */
      if (input.taskId !== undefined && state.sideChats.some((chat) => chat.id === input.taskId) && !forkableContinuation(state, input.taskId)) return settled(state);
      /** Only the composer's own send falls back to the current task; a send with its own text starts a thread. */
      const task = state.tasks.find((item) => item.id === (input.taskId ?? (draftKey === undefined ? null : state.currentId)));
      /** A thread halfway into a checkout of its own has nowhere settled to run, so the send waits for the user. */
      if (task && state.creatingWorktrees.includes(task.id)) return settled({ ...state, actionError: WORKTREE_CREATING_ERROR });
      if (task && state.activeRuns[task.id]) {
        const queued: QueuedMessage = {
          id: crypto.randomUUID(),
          text,
          prompt: sentPrompt(text, pastes, annotations, attachments),
          attachments: attachments.map((attachment) => attachment.path),
          ...(annotations.length ? { annotations } : {}),
          ...(pastes.length ? { pastes } : {}),
        };
        const drafted = draftKey === undefined ? state : withImages(withPastes(withAnnotations(withPrompt(state, draftKey, ""), draftKey, []), draftKey, []), draftKey, []);
        const next = withQueued(drafted, task.id, [...queuedFor(state, task.id), queued]);
        return input.steer ? apply(next, { type: "task.steer-queued", taskId: task.id, messageId: queued.id }) : settled(next);
      }
      /**
       * Which checkout a thread yet to exist starts in: one the caller named, else the one the draft
       * is pointed at. The checkout says which project the thread belongs to, so a `project` that
       * disagrees is a contradiction rather than something to silently pick a winner for.
       */
      const namedWorktreeId = task ? undefined : (input.worktreeId ?? (draftKey === undefined ? undefined : state.draftWorktreeId ?? undefined));
      const namedWorktree = namedWorktreeId ? worktreeById(state, namedWorktreeId) : undefined;
      if (namedWorktreeId && !namedWorktree) return settled({ ...state, actionError: WORKTREE_MISSING_ERROR });
      const named = input.project === undefined ? undefined : findProject(state.projects, input.project);
      if (named && "error" in named) return settled({ ...state, actionError: named.error });
      if (namedWorktree && named && named.project.id !== namedWorktree.projectId) {
        return settled({ ...state, actionError: WORKTREE_ELSEWHERE_ERROR });
      }
      const projectId = task?.projectId ?? namedWorktree?.projectId ?? named?.project.id ?? (draftKey === undefined ? null : state.draftProjectId);
      const project = projectId ? state.projects.find((item) => item.id === projectId) : undefined;
      if (projectId && !project) return settled({ ...state, actionError: MISSING_PROJECT_ERROR });
      const pending: PendingRun = {
        id: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        origin: "composer",
        ...(task ? { taskId: task.id } : {}),
        ...(project ? { projectId: project.id } : {}),
        ...(namedWorktree ? { worktreeId: namedWorktree.id } : {}),
        ...(draftKey === undefined ? {} : { draftKey }),
        text,
        prompt: sentPrompt(text, pastes, annotations, attachments),
        attachments: attachments.map((attachment) => attachment.path),
        ...(annotations.length ? { annotations } : {}),
        ...(pastes.length ? { pastes } : {}),
      };
      /** Only a thread being created here reads the draft answers; an existing one keeps its own. */
      /** Only a thread yet to exist can be told where to start; one that exists already moved. */
      const wantsWorktree = task ? false : !namedWorktree && (input.worktree ?? state.draftWorktree);
      const branch = task ? null : state.draftBranch;
      /** Starting from a branch without a checkout of its own moves the project, so nothing may be running in it. */
      if (branch && !wantsWorktree && project && runsInWorkspace(state, project.workspaceId)) {
        return settled({ ...state, actionError: CHECKOUT_RUNNING_ERROR });
      }
      const resolving = resolveWorkspaceEffect(pending.id, task, project, namedWorktree ?? worktreeFor(state, task), wantsWorktree, branch);
      return settled(withPending(state, { ...pending, ...(resolving.createWorktree ? { creatingWorktree: true } : {}) }), [resolving]);
    }

    case "task.steer-queued": {
      const taskId = targetId(state, input.taskId);
      const active = taskId ? state.activeRuns[taskId] : undefined;
      const queued = taskId ? queuedFor(state, taskId) : [];
      const message = queued.find((item) => item.id === input.messageId);
      if (!taskId || !active || !message || message.steering) return settled(state);
      return settled(
        withAttendedRun(withQueued(state, taskId, queued.map((item) => item.id === message.id ? { ...item, steering: true } : item)), taskId),
        [{ type: "send-run-command", command: { type: "steer", taskId, runId: active.runId, messageId: message.id, prompt: message.prompt } }],
      );
    }

    /** A steered message is already on its way to the agent, so only an unsteered one can be dropped. */
    case "task.drop-queued": {
      const taskId = targetId(state, input.taskId);
      const queued = taskId ? queuedFor(state, taskId) : [];
      const message = queued.find((item) => item.id === input.messageId);
      if (!taskId || !message || message.steering) return settled(state);
      return settled(withQueued(state, taskId, queued.filter((item) => item.id !== message.id)));
    }

    case "project.open":
      return settled(state, [{ type: "pick-project" }]);

    case "project.opened":
    case "project.edit":
    case "project.registered":
    case "project.register-failed":
    case "project.move":
    case "view.edit-project":
    case "view.toggle-project":
      return reduceProjects(state, input);

    case "project.remove": {
      if (state.tasks.some((task) => task.projectId === input.projectId && state.activeRuns[task.id])) {
        return settled({ ...state, actionError: RUNNING_PROJECT_ERROR });
      }
      const leaving = state.tasks.filter((task) => task.projectId === input.projectId);
      const effects = retireAutomations(state, leaving.map((task) => task.id));
      const project = state.projects.find((item) => item.id === input.projectId);
      const expandedProjects = new Set(state.expandedProjects);
      expandedProjects.delete(input.projectId);
      return settled({
        ...state,
        projects: state.projects.filter((item) => item.id !== input.projectId),
        tasks: state.tasks.map((task) => {
          if (task.projectId !== input.projectId) return task;
          const { projectId: _removed, ...projectlessTask } = task;
          return task.archivedAt === undefined ? { ...projectlessTask, archivedAt: now() } : projectlessTask;
        }),
        currentId: state.tasks.find((task) => task.id === state.currentId)?.projectId === input.projectId ? null : state.currentId,
        draftProjectId: state.draftProjectId === input.projectId ? null : state.draftProjectId,
        lastFolder: project?.root === state.lastFolder ? null : state.lastFolder,
        expandedProjects,
        projectEdit: state.projectEdit?.projectId === input.projectId ? null : state.projectEdit,
        openMenu: null,
        actionError: null,
      /** The project's checkouts are checkouts of a repository the app is letting go of. */
      }, [...effects, ...releaseWorktrees(state, leaving)]);
    }

    case "run.resolved": {
      const pending = state.pendingRuns[input.pendingId];
      if (!pending) return settled(state);
      let next = withoutPending(state, input.pendingId);
      const project = pending.projectId ? next.projects.find((item) => item.id === pending.projectId) : undefined;
      /**
       * A project with no workspace of its own adopts the one the picker just opened for the same
       * folder. Where a project lives is the picker's to say, so no run ever moves one.
       */
      const adopts = project && !project.workspaceId && input.workspace.kind === "project" && input.workspace.root === project.root;
      if (adopts) {
        next = { ...next, projects: next.projects.map((item) => item.id === project.id ? { ...item, workspaceId: input.workspace.id } : item) };
      }
      return pending.origin === "automation"
        ? startAutomationRun(next, pending, input.workspace, input.worktree)
        : startComposerRun(next, pending, input.workspace, input.worktree);
    }

    case "run.unresolved": {
      const pending = state.pendingRuns[input.pendingId];
      if (!pending) return settled(state);
      const next = withoutPending(state, input.pendingId);
      if (pending.origin === "automation") return settled(next, ack(pending, false));
      /** A side chat lives in the dock, so its failure belongs there and not in the main thread's banner. */
      if (pending.taskId && next.sideChats.some((chat) => chat.id === pending.taskId)) {
        return settled(withSideChat(next, pending.taskId, (chat) => ({ ...chat, error: input.message })));
      }
      return settled({ ...next, actionError: input.message });
    }

    case "run.cancel": {
      const taskId = targetId(state, input.taskId);
      const active = taskId ? state.activeRuns[taskId] : undefined;
      if (!active) return settled(state);
      return settled(state, [{ type: "send-run-command", command: { type: "cancel", taskId: active.taskId, runId: active.runId } }]);
    }

    /** The kill is the agent process's to make; the row only says a stop is on its way. */
    case "run.stop-process": {
      const taskId = targetId(state, input.taskId);
      if (!taskId) return settled(state);
      const stop: WorkspaceEffect[] = [{ type: "send-run-command", command: { type: "stop-process", taskId, processId: input.processId } }];
      const processes = state.backgroundProcesses[taskId] ?? [];
      const target = processes.find((process) => process.id === input.processId);
      if (target) {
        const marked = processes.map((process) => process.id === target.id ? { ...process, stopping: true } : process);
        return target.stopping ? settled(state) : settled(withBackgroundProcesses(state, taskId, marked), stop);
      }
      /** A workflow is a task of the agent process like any other, so the same stop reaches it. */
      const workflows = state.workflows[taskId] ?? [];
      const workflow = workflows.find((candidate) => candidate.id === input.processId);
      if (!workflow || workflow.stopping || workflow.status !== "running") return settled(state);
      return settled(
        withWorkflows(state, taskId, workflows.map((candidate) => candidate.id === workflow.id ? { ...candidate, stopping: true } : candidate)),
        stop,
      );
    }

    case "run.decide": {
      const taskId = input.taskId ?? state.currentId;
      const active = taskId ? state.activeRuns[taskId] : undefined;
      const approval = active ? state.approvals[active.runId] : undefined;
      if (!active || !approval) return settled(state);
      const { [active.runId]: _decided, ...approvals } = state.approvals;
      /** Answering a run's question is joining it, exactly as steering into it is. */
      return settled(withAttendedRun({ ...state, approvals }, active.taskId), [{
        type: "send-run-command",
        command: { type: "approval", taskId: active.taskId, runId: active.runId, approvalId: approval.approvalId, allow: input.allow },
      }]);
    }

    case "run.event": {
      const { event } = input;
      /** A turn the agent started itself belongs to no run yet, so the thread takes one on for it. */
      const opening = event.type === "run.started" && event.agentInitiated && !state.activeRuns[event.taskId] && state.tasks.some((task) => task.id === event.taskId);
      const opened = opening ? beginRun(state, event.taskId, event.runId) : state;
      const active = opened.activeRuns[event.taskId];
      if (!active || event.runId !== active.runId || event.sequence <= active.sequence) return settled(state);
      const applied = applyRunEvent(opened, event);
      const outcome = outcomeFor(event);
      /** Read before the run is applied: a terminal status takes the run, and its provenance, away. */
      const surfacing = whyRunSurfaces(active, event);
      const unseen = surfacing === null;
      /**
       * Every settled run leaves its verdict, which is what ranks the thread. Only a thread the
       * user was not already on is marked unread by it; the one on screen they cannot have missed.
       * A tick that looked and found nothing leaves neither, and leaves the thread where it was.
       */
      let next = outcome && !unseen
        ? applyTask(applied, event.taskId, (task) => ({
            ...task,
            outcome,
            ...(state.currentId === event.taskId ? {} : { outcomeUnread: true as const }),
          }))
        : applied;
      if (outcome) next = withSettledTick(next, event.taskId, active, surfacing);
      if (event.type === "computer-use.setup-required") next = { ...next, computerUseSetup: true };
      if (event.type === "queued.delivered") next = withDeliveredMessage(next, event.taskId, event.messageId);
      const finished = event.type === "run.status" && (event.status === "succeeded" || event.status === "failed");
      const workspaceId = taskWorkspaceId(state, state.tasks.find((task) => task.id === event.taskId));
      /** A review the thread has open is only as current as the run that was writing under it. */
      const settledDiff = finished && workspaceId && next.diffs[event.taskId]
        ? readDiffFrom(next, event.taskId, workspaceId, next.diffs[event.taskId].range)
        : settled(next);
      next = settledDiff.state;
      const environment: WorkspaceEffect[] = finished && workspaceId
        ? [{ type: "refresh-environment", workspaceId, taskId: event.taskId, runId: event.runId }, ...settledDiff.effects]
        : [];
      if (event.type !== "run.status" || event.status === "running" || event.status === "awaiting-approval") return settled(next, environment);
      const drained = drainQueue(next, event.taskId, event.status);
      return settled(drained.state, [...environment, ...drained.effects]);
    }

    case "workflow.event": {
      const { event } = input;
      if (!state.tasks.some((task) => task.id === event.taskId)) return settled(state);
      return settled(applyWorkflowEvent(state, event));
    }

    /** The scheduler owns the cadence; the workspace decides whether this tick can actually run. */
    case "automation.fired": {
      const { fire } = input;
      const task = state.tasks.find((item) => item.id === fire.taskId);
      const project = task ? projectFor(state, task) : undefined;
      const refusal = whyTickCannotRun(state, fire, task, project);
      if (refusal) return declinedTick(state, fire, task, refusal);
      const pending: PendingRun = {
        id: crypto.randomUUID(),
        runId: fire.runId,
        origin: "automation",
        taskId: fire.taskId,
        ...(project ? { projectId: project.id } : {}),
        text: fire.prompt,
        prompt: automationRunPrompt(fire.prompt, fire.runNumber, fire.surfaceWhen),
        detail: automationRunLabel(fire.runNumber),
        attachments: [],
        ...(fire.policy ? { policy: fire.policy } : {}),
        ...(fire.quiet ? { quiet: true as const } : {}),
        ...(fire.unattended ? { unattended: true as const } : {}),
        automationId: fire.automationId,
      };
      return settled(withPending(state, pending), [resolveWorkspaceEffect(pending.id, task, project, worktreeFor(state, task), false)]);
    }

    case "side-chat.open": {
      const source = state.tasks.find((task) => task.id === state.currentId);
      if (!source) return settled(state);
      const sequence = state.sideChatSequence + 1;
      const task: Task = {
        id: input.chatId,
        title: `Chat ${sequence}`,
        ...(source.projectId ? { projectId: source.projectId } : {}),
        executionPolicy: source.executionPolicy,
        ...(source.model ? { model: source.model } : {}),
        ...(source.effort ? { effort: source.effort } : {}),
        messages: [],
        continuationStatus: "none",
        lastChangeSnapshot: { files: [], capturedAt: now() },
        createdAt: now(),
        updatedAt: now(),
      };
      const opened: WorkspaceState = {
        ...state,
        tasks: [...state.tasks, task],
        sideChats: [...state.sideChats, { id: input.chatId, sourceTaskId: source.id, error: null }],
        sideChatSequence: sequence,
      };
      return focusDockTab(showDockTab(opened, source.id, input.chatId), source.id, input.chatId);
    }

    case "side-chat.close": {
      const chat = state.sideChats.find((item) => item.id === input.chatId);
      return chat ? closeSideChats(state, [chat]) : settled(state);
    }

    case "automation.notify":
      return raisedFinding(state, input);

    case "automation.nothing-to-report":
      return settled(withNothingToReport(state, input.taskId, input.checked, Date.now()));

    case "automation.save": {
      const taskId = targetId(state, input.taskId);
      return taskId ? settled(state, [{ type: "automation.save", draft: { ...input.draft, taskId } }]) : settled(state);
    }

    case "automation.update": {
      const taskId = targetId(state, input.taskId);
      return taskId ? settled(state, [{ type: "automation.update", taskId, patch: input.patch }]) : settled(state);
    }

    case "automation.delete": {
      const taskId = targetId(state, input.taskId);
      return taskId ? settled(state, [{ type: "automation.delete", taskId }]) : settled(state);
    }

    case "automation.run-now": {
      const taskId = targetId(state, input.taskId);
      return taskId ? settled(state, [{ type: "automation.run-now", taskId }]) : settled(state);
    }

    case "automations.changed":
      return settled({ ...state, automations: input.automations });

    case "view.refresh-environment": {
      const currentTask = state.tasks.find((task) => task.id === state.currentId);
      const workspaceId = currentWorkspaceId(state);
      if (!workspaceId) return settled(state.environment === null ? state : { ...state, environment: null });
      const taskId = currentTask?.id;
      const runId = taskId ? state.lastRunIds[taskId] : undefined;
      return settled(state, [{
        type: "refresh-environment",
        workspaceId,
        ...(taskId ? { taskId } : {}),
        ...(runId ? { runId } : {}),
      }]);
    }

    case "diff.toggle": {
      const dock = dockFor(state, dockOwner(state));
      const showing = dock.open && dock.tab === DIFF_PANEL;
      return apply(state, showing
        ? { type: "view.close-dock-panel", panel: DIFF_PANEL }
        : { type: "view.open-dock-panel", panel: DIFF_PANEL });
    }

    case "diff.refresh": {
      const owner = dockOwner(state);
      return readDiff(state, owner, diffFor(state, owner).range);
    }

    case "diff.set-range": {
      const owner = dockOwner(state);
      if (rangeKey(diffFor(state, owner).range) === rangeKey(input.range)) return settled(state);
      /** A different comparison is a different set of files, so nothing carries over but the layout. */
      return readDiff(state, owner, input.range, { result: null, collapsed: [], viewed: {} });
    }

    case "diff.set-collapsed": {
      const owner = dockOwner(state);
      const collapsed = diffFor(state, owner).collapsed;
      return settled(withDiff(state, owner, {
        collapsed: input.collapsed
          ? (collapsed.includes(input.path) ? collapsed : [...collapsed, input.path])
          : collapsed.filter((path) => path !== input.path),
      }));
    }

    case "diff.set-viewed": {
      const owner = dockOwner(state);
      const diff = diffFor(state, owner);
      const file = diff.result?.status === "available" ? diff.result.files.find((item) => item.path === input.path) : undefined;
      if (!file) return settled(state);
      const { [input.path]: _cleared, ...rest } = diff.viewed;
      return settled(withDiff(state, owner, {
        viewed: input.viewed ? { ...rest, [input.path]: fileFingerprint(file) } : rest,
        /** Ticking a file off folds it away, which is what makes working down the list one click. */
        collapsed: input.viewed
          ? (diff.collapsed.includes(input.path) ? diff.collapsed : [...diff.collapsed, input.path])
          : diff.collapsed.filter((path) => path !== input.path),
      }));
    }

    case "diff.set-split":
      return settled(withDiff(state, dockOwner(state), { split: input.split }));

    case "diff.loaded": {
      const diff = diffFor(state, input.owner);
      if (!diffMatches(diff, input.workspaceId, input.range)) return settled(state);
      const viewed = retainedViews(diff.viewed, input.result);
      const present = input.result.status === "available" ? new Set(input.result.files.map((file) => file.path)) : null;
      return settled(withDiff(state, input.owner, {
        result: input.result,
        loading: false,
        viewed,
        /** A file whose tick was dropped changed under the user, so it comes back open to be read again. */
        ...(present ? { collapsed: diff.collapsed.filter((path) => present.has(path) && !(diff.viewed[path] && !viewed[path])) } : {}),
      }));
    }

    case "environment.updated": {
      if (input.taskId && input.runId && state.lastRunIds[input.taskId] !== input.runId) return settled(state);
      const previous = state.environment?.workspaceId === input.workspaceId ? state.environment.result : null;
      const next: WorkspaceState = sameChangedFiles(previous, input.result)
        ? state
        : { ...state, environment: { workspaceId: input.workspaceId, result: input.result } };
      if (!input.taskId || input.result.status !== "available") return settled(next);
      const files = input.result.files;
      const task = state.tasks.find((item) => item.id === input.taskId);
      if (!task || sameStrings(task.lastChangeSnapshot.files, files)) return settled(next);
      return settled(applyTask(next, input.taskId, (task) => ({ ...task, lastChangeSnapshot: { files, capturedAt: now() }, updatedAt: now() })));
    }

    case "store.loaded":
      return settled({ ...withStoreData(state, input.data), restored: true });

    case "store.absent":
      return settled({ ...state, restored: true });

    case "preferences.loaded": {
      /** A restored page keeps its record and gets its view back when the panel first shows it. */
      const docks = { ...state.docks };
      for (const [owner, urls] of Object.entries(input.preferences.browserTabs ?? {})) {
        const browserTabs = urls.flatMap((url): BrowserTab[] => {
          const loadable = browserUrl(url);
          return loadable ? [{ id: crypto.randomUUID(), url: loadable, title: "", loading: false, canGoBack: false, canGoForward: false }] : [];
        });
        if (browserTabs.length) docks[owner] = { ...dockFor(state, owner), browserTabs, browserTabId: browserTabs[0].id };
      }
      return settled({
        ...state,
        theme: themeOrDefault(input.preferences.theme).id,
        themeMode: themeModeOrDefault(input.preferences.themeMode),
        uiFont: uiFontOrDefault(input.preferences.uiFont).id,
        monoFont: monoFontOrDefault(input.preferences.monoFont).id,
        readingSize: sizeOrDefault(READING_SIZE, input.preferences.readingSize),
        terminalSize: sizeOrDefault(TERMINAL_SIZE, input.preferences.terminalSize),
        sessionPanelOpen: input.preferences.sessionPanelOpen,
        captureSound: input.preferences.captureSound ?? true,
        captureFocus: input.preferences.captureFocus ?? true,
        plainEnglish: input.preferences.plainEnglish ?? false,
        sidebarOpen: input.preferences.sidebarOpen,
        sidebarMode: input.preferences.sidebarMode,
        shortcuts: input.preferences.shortcuts ?? {},
        docks,
        browserOrigins: input.preferences.browserOrigins ?? [],
      });
    }

    case "store.failed":
      return settled({ ...state, writable: false, storageError: input.message, restored: true });

    case "action.failed":
      return settled({ ...state, actionError: input.message });

    case "annotation.add": {
      const quote = clampQuote(input.quote);
      if (!quote) return settled(state);
      const key = input.taskId ?? promptKey(state);
      return settled(withAnnotations(state, key, [...annotationsFor(state, key), { id: crypto.randomUUID(), quote, note: input.note ?? "", ...(input.anchor ? { anchor: input.anchor } : {}) }]));
    }

    case "annotation.note": {
      const key = input.taskId ?? promptKey(state);
      return settled(withAnnotations(state, key, annotationsFor(state, key).map((item) => item.id === input.annotationId ? { ...item, note: input.note } : item)));
    }

    case "annotation.remove": {
      const key = input.taskId ?? promptKey(state);
      return settled(withAnnotations(state, key, annotationsFor(state, key).filter((item) => item.id !== input.annotationId)));
    }

    case "paste.add": {
      const key = input.taskId ?? promptKey(state);
      if (!input.text) return settled(state);
      return settled(withPastes(state, key, [...pastesFor(state, key), { id: crypto.randomUUID(), text: input.text }]));
    }

    case "paste.remove": {
      const key = input.taskId ?? promptKey(state);
      return settled(withPastes(state, key, pastesFor(state, key).filter((item) => item.id !== input.pasteId)));
    }

    case "image.add": {
      const key = input.taskId ?? promptKey(state);
      if (!input.path) return settled(state);
      if (imagesFor(state, key).length >= MAX_ATTACHMENTS) return settled({ ...state, actionError: TOO_MANY_IMAGES_ERROR });
      const staged = withImages(state, key, [...imagesFor(state, key), { id: crypto.randomUUID(), path: input.path, label: input.label }]);
      /** An image only ever arrives to be captioned, so the caret goes where the caption is typed. */
      return settled(focusComposer(staged));
    }

    case "image.remove": {
      const key = input.taskId ?? promptKey(state);
      return settled(withImages(state, key, imagesFor(state, key).filter((item) => item.id !== input.imageId)));
    }

    case "view.set-prompt":
      return settled(withPrompt(state, input.taskId ?? promptKey(state), input.prompt));

    /** A place whose row the thread no longer has is dropped when it is next read, not here. */
    case "view.reading-point": {
      const { point } = input;
      const wellFormed = point === null || (point.anchor.length > 0 && Number.isFinite(point.depth));
      if (!wellFormed || !state.tasks.some((task) => task.id === input.taskId)) return settled(state);
      if (sameReadingPoint(state.readingPoints[input.taskId] ?? null, point)) return settled(state);
      return settled({ ...state, readingPoints: { ...state.readingPoints, [input.taskId]: point } });
    }

    case "view.dismiss-action-error":
      return settled({ ...state, actionError: null });

    case "view.set-section-open":
      return settled({ ...state, sections: { ...state.sections, [input.section]: input.open } });

    case "view.set-theme": {
      const chosen = themeById(input.theme);
      if (!chosen) return settled(state);
      /** Naming a theme outright also names the ground it paints on, so the picker stays honest. */
      if (state.theme === chosen.id && state.themeMode === chosen.variant) return settled(state);
      const next = { ...state, theme: chosen.id, themeMode: chosen.variant };
      return settled(next, persistView(next));
    }

    case "view.set-theme-family": {
      const chosen = themeFor(input.family, variantFor(state.themeMode, input.systemDark));
      if (chosen.family !== input.family || state.theme === chosen.id) return settled(state);
      const next = { ...state, theme: chosen.id };
      return settled(next, persistView(next));
    }

    case "view.set-theme-mode": {
      if (!isThemeMode(input.mode)) return settled(state);
      const chosen = themeFor(themeOrDefault(state.theme).family, variantFor(input.mode, input.systemDark));
      if (state.themeMode === input.mode && state.theme === chosen.id) return settled(state);
      const next = { ...state, themeMode: input.mode, theme: chosen.id };
      return settled(next, persistView(next));
    }

    case "view.system-scheme": {
      if (state.themeMode !== "auto") return settled(state);
      const chosen = themeFor(themeOrDefault(state.theme).family, variantFor("auto", input.dark));
      if (state.theme === chosen.id) return settled(state);
      /** The system's own choice is not the user's, so it repaints the window without being written down. */
      return settled({ ...state, theme: chosen.id });
    }

    case "view.set-ui-font": {
      if (!uiFontById(input.font) || state.uiFont === input.font) return settled(state);
      const next = { ...state, uiFont: input.font };
      return settled(next, persistView(next));
    }

    case "view.set-mono-font": {
      if (!monoFontById(input.font) || state.monoFont === input.font) return settled(state);
      const next = { ...state, monoFont: input.font };
      return settled(next, persistView(next));
    }

    case "view.set-reading-size": {
      const size = sizeById(READING_SIZE, input.size);
      if (size === undefined || state.readingSize === size) return settled(state);
      const next = { ...state, readingSize: size };
      return settled(next, persistView(next));
    }

    case "view.set-terminal-size": {
      const size = sizeById(TERMINAL_SIZE, input.size);
      if (size === undefined || state.terminalSize === size) return settled(state);
      const next = { ...state, terminalSize: size };
      return settled(next, persistView(next));
    }

    case "view.set-sidebar-mode": {
      if (state.sidebarMode === input.mode) return settled(state);
      const next = { ...state, sidebarMode: input.mode };
      return settled(next, persistView(next));
    }

    case "view.set-sidebar-open": {
      if (state.sidebarOpen === input.open) return settled(state);
      const next = { ...state, sidebarOpen: input.open };
      return settled(next, persistView(next));
    }

    case "view.focus-composer":
      return settled(focusComposer(state), TAKE_KEYS);

    case "view.set-shortcut": {
      if (!shortcutAction(input.action)) return settled(state);
      const problem = input.binding === null ? null : shortcutProblem(input.binding);
      if (problem) return settled({ ...state, actionError: problem, capturingShortcut: null }, stopCapture(state));
      const shortcuts = withShortcut(state.shortcuts, input.action, input.binding);
      const next = { ...state, shortcuts, capturingShortcut: null, actionError: null };
      return settled(next, [...persistView(next), { type: "apply-shortcuts", overrides: shortcuts }, ...stopCapture(state)]);
    }

    case "view.reset-shortcuts": {
      const next = { ...state, shortcuts: {}, capturingShortcut: null, actionError: null };
      return settled(next, [...persistView(next), { type: "apply-shortcuts", overrides: next.shortcuts }, ...stopCapture(state)]);
    }

    case "view.capture-shortcut": {
      if (input.action !== null && !shortcutAction(input.action)) return settled(state);
      if (state.capturingShortcut === input.action) return settled(state);
      return settled({ ...state, capturingShortcut: input.action, actionError: null }, [{ type: "capture-shortcut", capturing: input.action !== null }]);
    }

    case "shortcut.captured": {
      const action = state.capturingShortcut;
      if (!action) return settled(state);
      if (input.binding === null) return settled({ ...state, capturingShortcut: null }, stopCapture(state));
      return apply(state, { type: "view.set-shortcut", action, binding: input.binding });
    }

    case "view.inspect-subagent": {
      const taskId = targetId(state, input.taskId);
      const task = state.tasks.find((candidate) => candidate.id === taskId);
      const subagent = task?.subagents?.find((candidate) => candidate.id === input.subagentId);
      return subagent && !subagent.activity.length
        ? settled(state, [{ type: "load-subagent-activity", taskId: task!.id, subagentId: subagent.id }])
        : settled(state);
    }

    case "subagent.activity.loaded": {
      const task = state.tasks.find((candidate) => candidate.id === input.taskId);
      if (!task?.subagents?.some((subagent) => subagent.id === input.subagentId)) return settled(state);
      const stored = new Set(input.activity.map((item) => item.id));
      return settled(applyTask(state, input.taskId, (target) => ({
        ...target,
        subagents: target.subagents?.map((subagent) => subagent.id === input.subagentId
          ? { ...subagent, activity: [...input.activity, ...subagent.activity.filter((item) => !stored.has(item.id))] }
          : subagent),
      })));
    }

    case "view.set-capture-options": {
      const next = { ...state, captureSound: input.options.sound, captureFocus: input.options.focus };
      if (next.captureSound === state.captureSound && next.captureFocus === state.captureFocus) return settled(state);
      return settled(next, [...persistView(next), { type: "apply-capture-options", options: input.options }]);
    }

    case "view.set-plain-english": {
      if (state.plainEnglish === input.enabled) return settled(state);
      const next = { ...state, plainEnglish: input.enabled };
      return settled(next, persistView(next));
    }

    case "view.set-session-panel-open": {
      if (state.sessionPanelOpen === input.open) return settled(state);
      const next = { ...state, sessionPanelOpen: input.open };
      return settled(next, [{ type: "persist-preferences", preferences: viewPreferences(next) }]);
    }

    case "view.set-settings-open": {
      const owner = dockOwner(state);
      const settings = { ...state, settingsOpen: input.open, ...(input.open ? {} : { computerUseSetup: false, capturingShortcut: null }) };
      /** Settings are drawn in the window, so a page that was in front cannot be left holding the keys. */
      return settled(input.open ? withDock(settings, owner, { open: false, expanded: false }) : settings, input.open ? TAKE_KEYS : stopCapture(state));
    }

    case "view.close-tab": {
      const owner = dockOwner(state);
      const dock = dockFor(state, owner);
      if (state.projectEdit) return settled({ ...state, projectEdit: null });
      if (state.settingsOpen || state.computerUseSetup) return settled({ ...state, settingsOpen: false, computerUseSetup: false });
      if (!dock.open) return settled(state, [{ type: "close-window" }]);
      /** A dock across the whole workspace is the frontmost thing there is, so it gives that up first. */
      if (dock.expanded) return settled(withDock(state, owner, { expanded: false }));
      const kind = dockTabKind(state, owner, dock.tab);
      const closed = kind === "picker" ? settled(withDock(state, owner, { open: false }))
        : kind === "browser" ? apply(state, { type: "browser.close-tab", tabId: dock.tab })
        : kind === "terminal" ? apply(state, { type: "terminal.close", terminalId: dock.tab })
        : apply(state, kind === "side-chat"
          ? { type: "side-chat.close", chatId: dock.tab }
          : { type: "view.close-dock-panel", panel: dock.tab });
      /** Whatever the closed view was holding is gone with it, so the window takes the keys back. */
      return { state: closed.state, effects: [...closed.effects, ...TAKE_KEYS] };
    }

    /** ⌘W's inverse, answering with whatever the panel is showing rather than one fixed thing. */
    case "view.new-tab": {
      if (state.settingsOpen) return settled(state);
      const owner = dockOwner(state);
      const dock = dockFor(state, owner);
      const kind = dock.open ? dockTabKind(state, owner, dock.tab) : "picker";
      return apply(state, kind === "browser" ? { type: "browser.new-tab" } : { type: "terminal.open" });
    }

    case "view.select-dock-index": {
      const owner = dockOwner(state);
      const tabs = dockTabIds(state, owner);
      const tab = input.index === -1 ? tabs[tabs.length - 1] : tabs[input.index];
      return tab ? apply(state, { type: "view.select-dock-tab", tab }) : settled(state);
    }

    case "view.set-dock-open": {
      const owner = dockOwner(state);
      const dock = dockFor(state, owner);
      if (dock.open === input.open) return settled(state);
      const toggled = withDock(state, owner, { open: input.open });
      /** A panel shown is one to work in; a panel hidden must not leave a page it was drawing with the keys. */
      if (!input.open) return settled(withDock(toggled, owner, { expanded: false }), TAKE_KEYS);
      return dockTabKind(toggled, owner, dock.tab) === "picker" ? settled(toggled) : focusDockTab(toggled, owner, dock.tab);
    }

    case "view.set-dock-expanded": {
      const owner = dockOwner(state);
      const dock = dockFor(state, owner);
      if (dock.expanded === input.expanded) return settled(state);
      /** Taking the whole workspace is also a way of asking for the dock, so expanding shows it. */
      const toggled = withDock(state, owner, { expanded: input.expanded, open: input.expanded || dock.open });
      return dockTabKind(toggled, owner, dock.tab) === "picker" ? settled(toggled) : focusDockTab(toggled, owner, dock.tab);
    }

    case "view.open-dock-panel": {
      const owner = dockOwner(state);
      const dock = dockFor(state, owner);
      const panels = dock.panels.includes(input.panel) ? dock.panels : [...dock.panels, input.panel];
      const shown = focusDockTab(withDock(state, owner, { open: true, panels, tab: input.panel }), owner, input.panel);
      const opened = shown.state;
      const effects = [...browserEffectsForTab(opened, owner, input.panel), ...shown.effects];
      /** However the review is reached, it opens on a list read now rather than one read last time. */
      if (input.panel !== DIFF_PANEL) return settled(opened, effects);
      const diff = diffFor(opened, owner);
      const read = readDiff(opened, owner, initialRange(opened, diff));
      return { state: read.state, effects: [...effects, ...read.effects] };
    }

    case "view.open-workflow": {
      const listed = state.currentId ? state.workflows[state.currentId] ?? [] : [];
      if (!listed.some((workflow) => workflow.id === input.workflowId)) return settled(state);
      const opened = withDock(state, dockOwner(state), { workflowId: input.workflowId });
      return apply(opened, { type: "view.open-dock-panel", panel: WORKFLOW_PANEL });
    }

    case "view.close-dock-panel": {
      const owner = dockOwner(state);
      const dock = dockFor(state, owner);
      if (!dock.panels.includes(input.panel)) return settled(state);
      const tab = dock.tab === input.panel ? dockTabAfterClosing(state, owner, input.panel) : dock.tab;
      const closed = withDock(state, owner, {
        panels: dock.panels.filter((panel) => panel !== input.panel),
        tab,
        ...(input.panel === WORKFLOW_PANEL ? { workflowId: null } : {}),
      });
      return settled(closed, browserEffectsForTab(closed, owner, tab));
    }

    case "view.select-dock-tab": {
      const owner = dockOwner(state);
      const kind = dockTabKind(state, owner, input.tab);
      const shown = withDock(state, owner, {
        tab: input.tab,
        open: true,
        ...(kind === "browser" ? { browserTabId: input.tab } : {}),
        ...(kind === "terminal" ? { terminalId: input.tab } : {}),
      });
      const selected = focusDockTab(shown, owner, input.tab);
      return settled(selected.state, [...browserEffectsForTab(selected.state, owner, input.tab), ...selected.effects]);
    }

    case "browser.open": {
      const owner = dockOwner(state, input.taskId);
      const url = browserUrl(input.url);
      if (!url) return settled({ ...state, actionError: BROWSER_URL_ERROR });
      const byUser = input.taskId === undefined;
      if (!byUser && !browserAllowed(state, input.taskId!, url)) return askToBrowse(state, owner, url, input.taskId!, input.tabId, input.newTab === true);
      return loadBrowserPage(state, owner, url, input.tabId, input.newTab === true, byUser);
    }

    case "browser.new-tab": {
      const owner = dockOwner(state);
      const { state: opened, tab } = withBlankTab(state, owner);
      const focused = focusDockTab(opened, owner, tab.id);
      return settled(focused.state, [{ type: "browser.open", tabId: tab.id }, { type: "browser.show", tabId: tab.id }, ...focused.effects]);
    }

    case "browser.decide": {
      const approval = state.browserApproval;
      if (!approval) return settled(state);
      const owner = dockOwner(state, approval.taskId);
      /** A blank tab only existed to carry the ask, so blocking takes it away again. */
      if (!input.allow) return closeBrowserTab({ ...state, browserApproval: null }, owner, approval.tabId, { onlyIfBlank: true });
      const origin = browserOrigin(approval.url);
      const allowed = origin ? { ...state, browserOrigins: [...state.browserOrigins, origin] } : state;
      return loadBrowserPage(allowed, owner, approval.url, approval.tabId, approval.tabId === undefined, false);
    }

    case "browser.select-tab": {
      const owner = ownerOfBrowserTab(state, input.tabId) ?? dockOwner(state, input.taskId);
      const tab = dockFor(state, owner).browserTabs.find((item) => item.id === input.tabId);
      if (!tab) return settled(state);
      return settled(withDock(showDockTab(state, owner, tab.id), owner, { browserTabId: tab.id }), browserEffectsForTab(state, owner, tab.id));
    }

    case "browser.close-tab":
      return closeBrowserTab(state, ownerOfBrowserTab(state, input.tabId) ?? dockOwner(state, input.taskId), input.tabId);

    case "browser.go":
    case "browser.reload":
    case "browser.act": {
      const owner = (input.tabId ? ownerOfBrowserTab(state, input.tabId) : undefined) ?? dockOwner(state, input.taskId);
      const target = browserTarget(dockFor(state, owner), input.tabId);
      if (!target) return settled({ ...state, actionError: BROWSER_TAB_ERROR });
      if (input.type === "browser.act") return settled(state, [{ type: "browser.act", tabId: target.id, action: input.action }]);
      const effect: WorkspaceEffect = input.type === "browser.go"
        ? { type: "browser.history", tabId: target.id, delta: input.delta }
        : { type: "browser.reload", tabId: target.id };
      return settled(patchBrowserTab(state, owner, target.id, { loading: true, error: undefined }), [effect]);
    }

    case "browser.clear-data": {
      const cleared = { ...state, browserOrigins: [] };
      return settled(cleared, [{ type: "browser.clear-data" }, ...persistView(cleared)]);
    }

    case "file.open": {
      const task = state.tasks.find((item) => item.id === (input.taskId ?? state.currentId));
      const root = taskWorkspaceRoot(state, task);
      if (!root) return settled({ ...state, actionError: FILE_FOLDER_ERROR });
      return settled({ ...state, actionError: null }, [{ type: "file.open", root, path: input.path, line: input.line ?? null }]);
    }

    case "terminal.open": {
      const owner = dockOwner(state);
      const cwd = input.cwd ?? terminalFolder(state);
      if (!cwd) return settled({ ...state, actionError: TERMINAL_FOLDER_ERROR });
      const terminal: TerminalSession = {
        id: crypto.randomUUID(),
        title: terminalTitle(cwd),
        cwd,
        taskId: state.currentId,
        status: "running",
      };
      const dock = dockFor(state, owner);
      const opened = withDock({ ...state, actionError: null }, owner, {
        open: true,
        tab: terminal.id,
        terminals: [...dock.terminals, terminal],
        terminalId: terminal.id,
      });
      const focused = focusDockTab(opened, owner, terminal.id);
      return settled(focused.state, [{ type: "terminal.start", terminalId: terminal.id, cwd }, ...focused.effects]);
    }

    case "terminal.select": {
      const owner = ownerOfTerminal(state, input.terminalId);
      if (!owner) return settled(state);
      return settled(withDock(showDockTab(state, owner, input.terminalId), owner, { terminalId: input.terminalId }));
    }

    case "terminal.close": {
      const owner = ownerOfTerminal(state, input.terminalId);
      if (!owner) return settled(state);
      const dock = dockFor(state, owner);
      const index = dock.terminals.findIndex((terminal) => terminal.id === input.terminalId);
      const tab = dock.tab === input.terminalId ? dockTabAfterClosing(state, owner, input.terminalId) : dock.tab;
      const terminals = dock.terminals.filter((terminal) => terminal.id !== input.terminalId);
      const next = dock.terminalId === input.terminalId
        ? terminals[index - 1] ?? terminals[index] ?? null
        : terminals.find((terminal) => terminal.id === dock.terminalId) ?? null;
      return settled(withDock(state, owner, { terminals, terminalId: next?.id ?? null, tab }), [{ type: "terminal.close", terminalId: input.terminalId }]);
    }

    /** Keystrokes and the size the shell believes it has. Neither is state, so only the effect happens. */
    case "terminal.input":
      return settled(state, [{ type: "terminal.write", terminalId: input.terminalId, data: input.data }]);

    case "terminal.resize":
      return settled(state, [{ type: "terminal.resize", terminalId: input.terminalId, cols: input.cols, rows: input.rows }]);

    case "terminal.focus":
      return settled({ ...state, focusedTerminalId: input.terminalId });

    case "terminal.updated": {
      const { terminalId, ...patch } = input.update;
      const owner = ownerOfTerminal(state, terminalId);
      if (!owner) return settled(state);
      return settled(withDock(state, owner, {
        terminals: dockFor(state, owner).terminals.map((terminal) => terminal.id === terminalId ? { ...terminal, ...patch } : terminal),
      }));
    }

    case "browser.updated": {
      const { tabId, ...patch } = input.page;
      const owner = ownerOfBrowserTab(state, tabId);
      const current = owner ? dockFor(state, owner).browserTabs.find((tab) => tab.id === tabId) : undefined;
      if (!owner || !current) return settled(state);
      /** Landing on a different page clears the error the page before it left behind. */
      const clearing = current.error !== undefined && patch.error === undefined && patch.url !== undefined && patch.url !== current.url;
      const updated = patchBrowserTab(state, owner, tabId, clearing ? { ...patch, error: undefined } : patch);
      return settled(updated, patch.url === undefined ? [] : persistView(updated));
    }

    case "view.set-menu":
      return settled({ ...state, openMenu: input.menu });

    case "view.go-back":
    case "view.go-forward": {
      const index = reachableVisit(state, input.type === "view.go-back" ? -1 : 1);
      if (index === null) return settled(state);
      const taskId = state.history[index];
      const task = state.tasks.find((item) => item.id === taskId);
      return settled(readAttention({
        ...state,
        historyIndex: index,
        currentId: taskId,
        draftProjectId: task?.projectId ?? null,
        lastFolder: projectFor(state, task)?.root ?? state.lastFolder,
        actionError: null,
      }, taskId));
    }

    case "view.set-focused":
      return input.focused
        ? settled(readAttention({ ...state, focused: true }, state.currentId))
        : settled({ ...state, focused: false, capturingShortcut: null }, stopCapture(state));

    case "view.find-open": {
      const target = input.target ?? state.find?.target ?? findTargetFor(state, "any");
      const previous = state.find;
      const same = previous && sameFindTarget(previous.target, target);
      const find: FindState = {
        target,
        query: previous?.query ?? "",
        index: same ? previous.index : 0,
        focus: (previous?.focus ?? 0) + 1,
      };
      /** A page in the panel holds the keyboard, and the bar is no use without it. */
      const takeKeys: WorkspaceEffect[] = target.kind === "browser" ? [{ type: "focus-window" }] : [];
      return settled({ ...state, find, ...(same ? {} : { findResults: null }) }, [
        ...(same ? [] : stopSearchEffects(previous)),
        ...takeKeys,
        ...(same ? [] : searchEffects(find, { findNext: false, forward: true })),
      ]);
    }

    case "view.find-query": {
      if (!state.find) return settled(state);
      const find: FindState = { ...state.find, query: input.query, index: 0 };
      /** An emptied box is no longer searching, so whatever it lit up stops being lit. */
      const effects = find.query.trim() ? searchEffects(find, { findNext: false, forward: true }) : stopSearchEffects(find);
      return settled({ ...state, find, findResults: null }, effects);
    }

    case "view.find-step": {
      const find = state.find;
      if (!find) return settled(state);
      if (find.target.kind !== "transcript") return settled(state, searchEffects(find, { findNext: true, forward: input.delta === 1 }));
      const task = state.tasks.find((item) => item.id === state.currentId);
      const matches = findHits(task?.messages ?? [], find.query).length;
      return settled({ ...state, find: { ...find, index: stepMatch(find.index, input.delta, matches) } });
    }

    case "view.find-close": {
      const focus: WorkspaceEffect[] = state.find?.target.kind === "browser" ? [{ type: "focus-browser", tabId: state.find.target.tabId }] : [];
      return settled({ ...state, find: null, findResults: null }, [...stopSearchEffects(state.find), ...focus]);
    }

    case "find.results": {
      const find = state.find;
      if (!find || !sameFindTarget(find.target, input.target)) return settled(state);
      return settled({ ...state, findResults: input.results });
    }

    case "view.dismiss-computer-use-setup":
      return settled({ ...state, computerUseSetup: false });
  }
}

function startComposerRun(state: WorkspaceState, pending: PendingRun, workspace: WorkspaceRecord, worktree?: CreatedWorktree): WorkspaceTransition {
  const existing = pending.taskId ? state.tasks.find((item) => item.id === pending.taskId) : undefined;
  if (pending.taskId && (!existing || state.activeRuns[pending.taskId])) return settled(state);
  /** A checkout made on the way here has no record yet; it belongs to the project the run resolved in. */
  const created = worktree && pending.projectId ? { ...worktree, projectId: pending.projectId } : undefined;
  /** A thread that does not exist yet claims whichever checkout the send named, if it named one. */
  const arriving = created ?? worktreeFor(state, existing) ?? worktreeById(state, pending.worktreeId);
  /** This thread's own first run inside a checkout forks its session rather than resuming it there. */
  const entering = Boolean(arriving) && existing?.worktreeEnteredAt === undefined;
  const task: Task = existing ?? {
    id: crypto.randomUUID(),
    title: taskTitleFor(pending.text || pasteTitle(pending.pastes ?? []), pending.attachments.map((path) => ({ path, labels: [] }))),
    ...(pending.projectId ? { projectId: pending.projectId } : {}),
    executionPolicy: state.draftPolicy,
    model: state.draftModel,
    effort: state.draftEffort,
    messages: [],
    continuationStatus: "none",
    lastChangeSnapshot: { files: [], capturedAt: now() },
    sortIndex: nextSortIndex(state.tasks),
    createdAt: now(),
    updatedAt: now(),
  };
  const message = createTaskMessage("user", pending.text, undefined, pending.attachments, pending.annotations, pending.pastes);
  /** Only a thread that was somewhere else is arriving; one already in this checkout has said so. */
  const arrival = arriving && existing?.worktreeId !== arriving.id
    ? [createTaskMessage("system", `Moved into a worktree at ${arriving.root}`, `Detached at ${arriving.baseCommit.slice(0, 7)}`)]
    : [];
  const located = arriving ? { ...task, worktreeId: arriving.id, worktreeEnteredAt: task.worktreeEnteredAt ?? now() } : task;
  const updated = { ...located, messages: [...located.messages, ...arrival, message], updatedAt: now() };
  const tasks = existing ? state.tasks.map((item) => item.id === task.id ? updated : item) : [updated, ...state.tasks];
  /** Only a task the user's own send just created needs looking at; anything else leaves them where they are. */
  const focusing = !existing && pending.draftKey !== undefined;
  const spent = existing ? {} : { draftBranch: null, draftWorktree: false, draftWorktreeId: null };
  const owning = withUsedWorktree(focusing ? handOverDraftDock(state, task.id) : state, created, arriving?.id);
  const started = beginRun({ ...owning, tasks, ...spent, ...(focusing ? { currentId: task.id } : {}) }, task.id, pending.runId);
  const drained = pending.queuedIds
    ? withQueued(started, task.id, queuedFor(started, task.id).filter((message) => !pending.queuedIds!.includes(message.id)))
    : started;
  const titling: WorkspaceEffect[] = existing || (!pending.text && pending.attachments.length === 0) ? [] : [{ type: "suggest-title", taskId: task.id, text: pending.text, attachments: pending.attachments }];
  const command = {
    ...startRunCommand(state, updated, pending.runId, pending.prompt, workspace.id),
    ...(entering && updated.continuation ? { forkContinuation: true as const } : {}),
    ...sideChannelFor(state, updated),
  };
  /**
   * A review carried over from the draft was read against the project, and against a dock that no
   * longer exists, so it is asked for again under the thread and the checkout the send settled on.
   */
  const handed = focusing && state.diffs[DRAFT_DOCK];
  const reviewing = handed ? readDiffFrom(drained, task.id, workspace.id, handed.range) : settled(drained);
  return settled(
    pending.draftKey ? withImages(withPastes(withAnnotations(withPrompt(reviewing.state, pending.draftKey, ""), pending.draftKey, []), pending.draftKey, []), pending.draftKey, []) : reviewing.state,
    [{ type: "start-run", command }, ...titling, ...reviewing.effects],
  );
}

function startAutomationRun(state: WorkspaceState, pending: PendingRun, workspace: WorkspaceRecord, worktree?: CreatedWorktree): WorkspaceTransition {
  const taskId = pending.taskId!;
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task || task.archivedAt !== undefined || state.activeRuns[taskId]) return settled(state, ack(pending, false));
  /** A quiet tick's own label counts for nothing in the thread's activity, like the rest of its run. */
  const message = { ...createTaskMessage("user", pending.text, pending.detail), ...(pending.quiet ? { withdrawn: true as const } : {}) };
  const created = worktree && task.projectId ? { ...worktree, projectId: task.projectId } : undefined;
  const entered = created ?? worktreeFor(state, task);
  const withMessage = applyTask(withUsedWorktree(state, created, entered?.id), taskId, (item) => ({
    ...item,
    ...(entered ? { worktreeId: entered.id, worktreeEnteredAt: item.worktreeEnteredAt ?? now() } : {}),
    messages: [...item.messages, message],
    updatedAt: now(),
  }));
  /** Taken before the label lands, so a tick that settles unseen rolls that back with the rest of it. */
  return settled(beginRun(withMessage, taskId, pending.runId, { origin: "automation", quiet: pending.quiet === true }, threadMark(task)), [
    /** Only a tick that settles unseen answers its own questions; every other run waits for the user as it always has. */
    { type: "start-run", command: { ...startRunCommand(state, task, pending.runId, pending.prompt, workspace.id, pending.policy ?? task.executionPolicy), ...(pending.unattended ? { unattended: true as const } : {}) } },
    ...ack(pending, true),
  ]);
}
