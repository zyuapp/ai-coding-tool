/** What the handlers in this folder share: the state helpers, and the errors they report. */
import type { WorkspaceEffect, WorkspaceTransition } from "./types.js";
import { promptWithAnnotations } from "../annotations.js";
import { promptWithAttachments } from "../attachments.js";
import { annotationsFor, composerDraft, filesFor, focusedTab, imagesFor, pastesFor, withAnnotations, withFiles, withImages, withPastes } from "../composer-drafts.js";
import { promptWithFiles } from "../files.js";
import { promptWithPastes } from "../pastes.js";
import { pruneDeletedTasks } from "../task-pruning.js";
import { ATTENDED_RUN, applyTask, threadMark, withActiveRun, withBackgroundProcesses, withRunStatus, type RunProvenance, type ThreadMark } from "../task-workspace.js";
import { viewPreferences } from "../view-preferences.js";
import { DIFF_PANEL, DRAFT_DOCK, WORKFLOW_PANEL, browserTarget, dockFor, dockHoldsTab, dockOwner, dockSideChats, dockTabAfterClosing, frontDock, ownerOfBrowserTab, ownerOfTerminal, projectFor, taskWorkspaceId, withDiff, withDock, withPrompt, workflowById, worktreeClaimants, worktreeFor, type DiffState, type DraftBranch, type FindState, type PendingRun, type QueuedMessage, type SideChat, type ThreadDock, type WorkspaceState } from "../workspace-state.js";
import type { ChangedFilesResult, StartRunCommand } from "../../contracts/ipc.js";
import { withoutOutcome } from "../../domain/attention.js";
import { browserOrigin, type BrowserTab } from "../../domain/browser.js";
import type { DiffRange } from "../../domain/diff.js";
import { searchesItself, type FindTarget } from "../../domain/find.js";
import { PLAIN_ENGLISH_STYLE } from "../../domain/output-style.js";
import { DEFAULT_EFFORT, DEFAULT_MODEL, type RunStatus } from "../../domain/run.js";
import { createTaskMessage, type Annotation, type AttachedFile, type PastedText, type Project, type RunAttachment, type Task } from "../../domain/task.js";
import type { Worktree } from "../../domain/worktree.js";

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

export const CHECKOUT_RUNNING_ERROR = "Stop the threads running in this project before starting one on another branch.";
export const SWITCH_RUNNING_ERROR = "Stop the threads running in this checkout before switching it to another branch.";
export const SWITCH_PROJECT_ERROR = "Open this thread in a project folder before switching branches.";
export const FILE_FOLDER_ERROR = "Open this thread in a project folder before opening a file from it.";
export const APP_FOLDER_ERROR = "Open this thread in a project folder before opening it in another application.";

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
  checkoutRunning: CHECKOUT_RUNNING_ERROR,
  switchRunning: SWITCH_RUNNING_ERROR,
  switchProject: SWITCH_PROJECT_ERROR,
  fileFolder: FILE_FOLDER_ERROR,
  appFolder: APP_FOLDER_ERROR,
} as const;

export function now() {
  return Date.now();
}

export function sameStrings(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function sameChangedFiles(left: ChangedFilesResult | null, right: ChangedFilesResult) {
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

export function settled(state: WorkspaceState, effects: WorkspaceEffect[] = []): WorkspaceTransition {
  return { state, effects };
}

/** A named task has to exist; an unnamed command falls back to the one the user is looking at. */
export function targetId(state: WorkspaceState, taskId: string | undefined): string | null {
  if (taskId === undefined) return state.currentId;
  return state.tasks.some((task) => task.id === taskId) ? taskId : null;
}

/** An archived task is unreachable, so its automation would tick forever with nowhere to run. */
export function retireAutomations(state: WorkspaceState, taskIds: Iterable<string>): WorkspaceEffect[] {
  const scheduled = new Set(state.automations.map((automation) => automation.taskId));
  return [...taskIds].filter((taskId) => scheduled.has(taskId)).map((taskId) => ({ type: "automation.delete" as const, taskId }));
}

export const BROWSER_URL_ERROR = "That is not a page the browser can open.";
export const BROWSER_TAB_ERROR = "The browser has no page open to act on.";

/** Brings a tab to the front of its own dock, so a page or a shell nobody asked to see still lands somewhere. */
export function showDockTab(state: WorkspaceState, owner: string, tab: string): WorkspaceState {
  return withDock(state, owner, { open: true, tab });
}

/**
 * Hands a dock tab the keyboard. The view watches the count rather than being told to focus, and the
 * window takes the keys back on its way, because only a page can hold them itself.
 */
export function focusDockTab(state: WorkspaceState, owner: string, tab: string): WorkspaceTransition {
  const focused = focusedTab(state, owner, tab);
  const page = dockFor(focused, owner).browserTabs.find((item) => item.id === tab);
  return settled(focused, page?.url ? [] : TAKE_KEYS);
}

/** Puts the caret in the composer, taking the keys back from a page that swallows them. */
/** The window has the keys again, which a page in the panel is otherwise holding. */
export const TAKE_KEYS: WorkspaceEffect[] = [{ type: "focus-window" }];

function withBrowserTabs(state: WorkspaceState, owner: string, browserTabs: BrowserTab[]): WorkspaceState {
  return withDock(state, owner, { browserTabs });
}

export function patchBrowserTab(state: WorkspaceState, owner: string, tabId: string, patch: Partial<BrowserTab>): WorkspaceState {
  return withBrowserTabs(state, owner, dockFor(state, owner).browserTabs.map((tab) => tab.id === tabId ? { ...tab, ...patch } : tab));
}

export function persistView(state: WorkspaceState): WorkspaceEffect[] {
  return [{ type: "persist-preferences", preferences: viewPreferences(state) }];
}

/**
 * Loads the page, in the tab named or a new one. The origin is remembered when the user is the one
 * asking, which is what lets a run reach a site the user has already signed into. Only the user's
 * own load takes the panel: a run leaves the dock on whatever tab it was showing, open or closed,
 * and its page loads parked out of sight.
 */
export function loadBrowserPage(state: WorkspaceState, owner: string, url: string, tabId: string | undefined, newTab: boolean, byUser: boolean): WorkspaceTransition {
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
export function withBlankTab(state: WorkspaceState, owner: string) {
  const tab: BrowserTab = { id: crypto.randomUUID(), url: "", title: "", loading: false, canGoBack: false, canGoForward: false };
  const opened = withDock(showDockTab(state, owner, tab.id), owner, { browserTabs: [...dockFor(state, owner).browserTabs, tab], browserTabId: tab.id });
  return { state: opened, tab };
}

/**
 * Puts the navigation to the user. The ask always names the tab it would load in — a blank one when
 * the run wanted a new page — so it is shown in that tab rather than needing a panel of its own.
 */
export function askToBrowse(state: WorkspaceState, owner: string, url: string, taskId: string, tabId: string | undefined, newTab: boolean): WorkspaceTransition {
  const target = newTab ? undefined : browserTarget(dockFor(state, owner), tabId);
  if (target) return settled({ ...showDockTab(state, owner, target.id), browserApproval: { url, taskId, tabId: target.id } });
  const { state: opened, tab } = withBlankTab(state, owner);
  return settled({ ...opened, browserApproval: { url, taskId, tabId: tab.id } }, [
    { type: "browser.open", tabId: tab.id },
    { type: "browser.show", tabId: tab.id },
  ]);
}

/** Closing a page hands the dock its neighbour, and the panel whichever page that turns out to be. */
export function closeBrowserTab(state: WorkspaceState, owner: string, tabId: string | undefined, options: { onlyIfBlank?: boolean } = {}): WorkspaceTransition {
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
export function browserAllowed(state: WorkspaceState, taskId: string, url: string) {
  const origin = browserOrigin(url);
  if (origin && state.browserOrigins.includes(origin)) return true;
  return state.tasks.find((task) => task.id === taskId)?.executionPolicy === "autonomous";
}

/** Bringing a page to the front is what gives a restored one its view, and only then. */
export function browserEffectsForTab(state: WorkspaceState, owner: string, dockTab: string): WorkspaceEffect[] {
  const tab = dockFor(state, owner).browserTabs.find((page) => page.id === dockTab);
  if (!tab) return [];
  return [{ type: "browser.open", tabId: tab.id, ...(tab.url ? { url: tab.url } : {}) }, { type: "browser.show", tabId: tab.id }];
}

/**
 * Which page the panel draws once the dock on screen changes. One panel serves every dock, so the
 * thread the user lands on hands it its own page, or takes the page away when it has none.
 */
export function shownPageEffects(state: WorkspaceState): WorkspaceEffect[] {
  const { owner, dock } = frontDock(state);
  const effects = browserEffectsForTab(state, owner, dock.tab);
  return effects.length ? effects : [{ type: "browser.show", tabId: null }];
}

/** The dock a draft was composed in belongs to the thread that send creates, pages, shells and all. */
export function handOverDraftDock(state: WorkspaceState, taskId: string): WorkspaceState {
  const { [DRAFT_DOCK]: draft, ...docks } = state.docks;
  const { [DRAFT_DOCK]: draftDiff, ...diffs } = state.diffs;
  const moved = draft ? { ...state, docks: { ...docks, [taskId]: draft } } : state;
  return draftDiff ? { ...moved, diffs: { ...diffs, [taskId]: draftDiff } } : moved;
}

/** A thread that is gone for good takes its dock with it: its pages close and its shells stop. */
export function disposeDocks(state: WorkspaceState, owners: Iterable<string>): WorkspaceTransition {
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

export function withPending(state: WorkspaceState, pending: PendingRun): WorkspaceState {
  return { ...state, pendingRuns: { ...state.pendingRuns, [pending.id]: pending }, actionError: null };
}

export function withoutPending(state: WorkspaceState, pendingId: string): WorkspaceState {
  const { [pendingId]: _settled, ...pendingRuns } = state.pendingRuns;
  return { ...state, pendingRuns };
}

/**
 * A checkout takes minutes to make, and until it lands the thread is neither where it was nor where
 * it is going. Marking it here is what keeps a second ask from making a second, orphaned checkout.
 */
export function withCreatingWorktree(state: WorkspaceState, taskId: string): WorkspaceState {
  return { ...state, creatingWorktrees: [...state.creatingWorktrees, taskId], actionError: null };
}

export function withoutCreatingWorktree(state: WorkspaceState, taskId: string): WorkspaceState {
  if (!state.creatingWorktrees.includes(taskId)) return state;
  return { ...state, creatingWorktrees: state.creatingWorktrees.filter((item) => item !== taskId) };
}

export function queuedFor(state: WorkspaceState, taskId: string): QueuedMessage[] {
  return state.queuedMessages[taskId] ?? [];
}

export function withQueued(state: WorkspaceState, taskId: string, messages: QueuedMessage[]): WorkspaceState {
  if (messages.length) return { ...state, queuedMessages: { ...state.queuedMessages, [taskId]: messages } };
  const { [taskId]: _drained, ...queuedMessages } = state.queuedMessages;
  return { ...state, queuedMessages };
}

/** Everything drafted alongside the text, flattened into the one prompt the agent reads. */
export function sentPrompt(text: string, pastes: PastedText[], annotations: Annotation[], attachments: RunAttachment[], files: AttachedFile[]) {
  return promptWithFiles(promptWithAttachments(promptWithAnnotations(promptWithPastes(text, pastes), annotations), attachments), files);
}

/** A composer that has just sent: text, annotations, pastes, images, and attached files all go. */
export function clearedDraft(state: WorkspaceState, draftKey: string): WorkspaceState {
  return withFiles(withImages(withPastes(withAnnotations(withPrompt(state, draftKey, ""), draftKey, []), draftKey, []), draftKey, []), draftKey, []);
}

export function startRunCommand(state: WorkspaceState, task: Task, runId: string, prompt: string, workspaceId: string, policy = task.executionPolicy): StartRunCommand {
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
    ...(state.plainEnglish ? { outputStyle: PLAIN_ENGLISH_STYLE } : {}), ...(state.chromeBrowser ? { chromeBrowser: true as const } : {}), ...(state.computerUse ? {} : { computerUseTools: false as const }), ...(state.browserTools ? {} : { browserTools: false as const }),
    ...(task.continuation ? { continuation: task.continuation } : {}),
  };
}

/** A side chat's first turn forks the source thread; every turn after resumes its own branch. */
export function sideChannelFor(state: WorkspaceState, task: Task): Partial<StartRunCommand> {
  if (!state.sideChats.some((chat) => chat.id === task.id)) return {};
  if (task.continuation) return { channel: "side" };
  const continuation = forkableContinuation(state, task.id);
  return continuation ? { channel: "side", continuation, forkContinuation: true } : { channel: "side" };
}

/** The continuation a side chat starts from: its own once it has one, the source thread's before that. */
export function forkableContinuation(state: WorkspaceState, taskId: string) {
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
export function beginRun(state: WorkspaceState, taskId: string, runId: string, provenance: RunProvenance = ATTENDED_RUN, before?: ThreadMark): WorkspaceState {
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
export function withAttendedRun(state: WorkspaceState, taskId: string): WorkspaceState {
  const active = state.activeRuns[taskId];
  if (!active || active.origin === "composer") return state;
  return withActiveRun(state, taskId, { ...active, origin: "composer" });
}

/** A steered message joined the run, so it leaves the queue and takes its place in the thread. */
export function withDeliveredMessage(state: WorkspaceState, taskId: string, messageId: string): WorkspaceState {
  const queued = queuedFor(state, taskId);
  const delivered = queued.find((message) => message.id === messageId);
  if (!delivered) return state;
  return applyTask(withAttendedRun(withQueued(state, taskId, queued.filter((message) => message.id !== messageId)), taskId), taskId, (task) => ({
    ...task,
    messages: [...task.messages, createTaskMessage("user", delivered.text, undefined, delivered.attachments, delivered.annotations, delivered.pastes, delivered.files)],
    updatedAt: now(),
  }));
}

/**
 * A finished run hands its queue on one message at a time, so each queued message gets its own run
 * and the ones behind it wait for that run to finish. A run the user stopped hands the whole queue
 * back to the composer instead of speaking for them.
 */
export function drainQueue(state: WorkspaceState, taskId: string, status: RunStatus): WorkspaceTransition {
  const queued = queuedFor(state, taskId);
  if (!queued.length) return settled(state);
  if (status === "cancelled") {
    const text = [...queued.map((message) => message.text), state.prompts[taskId] ?? ""].filter(Boolean).join("\n\n");
    const annotations = [...queued.flatMap((message) => message.annotations ?? []), ...annotationsFor(state, taskId)];
    const pastes = [...queued.flatMap((message) => message.pastes ?? []), ...pastesFor(state, taskId)];
    const files = [...queued.flatMap((message) => message.files ?? []), ...filesFor(state, taskId)];
    const images = queued.flatMap((message) => message.attachments);
    const handed = withFiles(withPastes(withAnnotations(withPrompt(withQueued(state, taskId, []), taskId, text), taskId, annotations), taskId, pastes), taskId, files);
    return settled(images.length ? composerDraft(handed, { type: "image.recall", taskId, paths: [...images, ...imagesFor(state, taskId).map((image) => image.path)] }, taskId) : handed);
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
    ...(next.files ? { files: next.files } : {}),
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
export function resolveWorkspaceEffect(pendingId: string, task: Task | undefined, project: Project | undefined, worktree: Worktree | undefined, wantsWorktree: boolean, branch?: DraftBranch | null): Extract<WorkspaceEffect, { type: "resolve-run-workspace" }> {
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
export function threadBusy(state: WorkspaceState, taskId: string) {
  return Boolean(state.activeRuns[taskId]) || Object.values(state.pendingRuns).some((pending) => pending.taskId === taskId);
}

/** Whether a run is going in a checkout, so nothing moves the ground under it. */
export function runsInWorkspace(state: WorkspaceState, workspaceId: string | undefined) {
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
export function leaveWorktree(state: WorkspaceState, taskId: string, note: ReturnType<typeof createTaskMessage>): WorkspaceState {
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
export function dropWorktree(state: WorkspaceState, worktreeId: string, note: () => ReturnType<typeof createTaskMessage>): WorkspaceState {
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

/** Hands back a checkout only when every linked thread explicitly leaves it. */
export function releaseWorktrees(state: WorkspaceState, leaving: Task[]): WorkspaceEffect[] {
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
export function withUsedWorktree(state: WorkspaceState, created: Worktree | undefined, worktreeId: string | undefined): WorkspaceState {
  if (!worktreeId) return state;
  const known = created && !state.worktrees.some((item) => item.id === created.id) ? [...state.worktrees, created] : state.worktrees;
  return { ...state, worktrees: known.map((item) => item.id === worktreeId ? { ...item, lastUsedAt: now() } : item) };
}

export function ack(pending: PendingRun, started: boolean): WorkspaceEffect[] {
  return pending.automationId ? [{ type: "automation.ack", ack: { automationId: pending.automationId, runId: pending.runId, started } }] : [];
}

export function withSideChat(state: WorkspaceState, chatId: string, update: (chat: SideChat) => SideChat): WorkspaceState {
  return { ...state, sideChats: state.sideChats.map((chat) => chat.id === chatId ? update(chat) : chat) };
}

/** Closing a side chat discards the thread itself, so its run, queue, and draft go with it. */
export function closeSideChats(state: WorkspaceState, closing: SideChat[]): WorkspaceTransition {
  const effects: WorkspaceEffect[] = [];
  let next = state;
  for (const chat of closing) {
    const active = next.activeRuns[chat.id];
    if (active) {
      effects.push({ type: "send-run-command", command: { type: "cancel", taskId: chat.id, runId: active.runId } });
      const { [active.runId]: _abandoned, ...approvals } = next.approvals;
      next = { ...next, approvals };
    }
    next = clearedDraft(withQueued(withRunStatus(withActiveRun(withBackgroundProcesses(next, chat.id, []), chat.id, null), chat.id, "idle"), chat.id, []), chat.id);
  }
  const closed = new Set(closing.map((chat) => chat.id));
  /** Nothing a side chat can reach schedules one today; this keeps that true if the tool table changes. */
  effects.push(...retireAutomations(next, closed));
  return {
    state: pruneDeletedTasks({
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
    }, closed),
    effects,
  };
}

/** What a search asks of whoever holds the text. A thread and a review are counted where they are drawn. */
export function searchEffects(find: FindState, { findNext, forward }: { findNext: boolean; forward: boolean }): WorkspaceEffect[] {
  const query = find.query.trim();
  if (!query || !searchesItself(find.target)) return [];
  return find.target.kind === "browser"
    ? [{ type: "find-in-page", tabId: find.target.tabId, query, forward, findNext }]
    : find.target.kind === "terminal" ? [{ type: "find-in-terminal", terminalId: find.target.terminalId, query, forward }] : [];
}

/** A page and a shell keep highlighting what was found until they are told to stop. */
export function stopSearchEffects(find: FindState | null): WorkspaceEffect[] {
  if (!find || !searchesItself(find.target)) return [];
  return find.target.kind === "browser"
    ? [{ type: "stop-find-in-page", tabId: find.target.tabId }]
    : find.target.kind === "terminal" ? [{ type: "stop-find-in-terminal", terminalId: find.target.terminalId }] : [];
}

/** Find belongs to the view it is searching, so it goes when that view does. */
function findViewGone(state: WorkspaceState, target: FindTarget): boolean {
  const { owner, dock } = frontDock(state);
  switch (target.kind) {
    case "thread": return target.taskId !== state.currentId
      && !dockSideChats(state, owner).some((chat) => chat.id === target.taskId);
    case "browser": return !ownerOfBrowserTab(state, target.tabId);
    case "terminal": return !ownerOfTerminal(state, target.terminalId);
    case "review": return target.owner !== owner || !dock.panels.includes(DIFF_PANEL);
    case "panel": return target.owner !== owner || !dock.panels.includes(target.panel);
  }
}

/**
 * Runs at the end of every reduce, which is also what validates an externally supplied target: a
 * review or a panel naming a dock that is not in front is cleared on the reduce that opened it.
 */
export function prunedFind(state: WorkspaceState): WorkspaceState {
  const keyboardTab = state.keyboardTab && dockHoldsTab(state, state.keyboardTab) ? state.keyboardTab : null;
  const gone = state.find !== null && findViewGone(state, state.find.target);
  if (!gone && keyboardTab === state.keyboardTab) return state;
  return { ...state, keyboardTab, ...(gone ? { find: null, findResults: null } : {}) };
}

/** A dock follows a workflow only while its record is there, so a run that clears one closes its panel. */
const validWorkflowPanels = new WeakMap<WorkspaceState["docks"], WeakSet<WorkspaceState["workflows"]>>();

export function prunedWorkflowPanels(state: WorkspaceState): WorkspaceState {
  if (validWorkflowPanels.get(state.docks)?.has(state.workflows)) return state;
  let next = state;
  for (const [owner, dock] of Object.entries(state.docks)) {
    if (!dock.workflowId || workflowById(state, dock.workflowId)) continue;
    const panels = dock.panels.filter((panel) => panel !== WORKFLOW_PANEL), tab = dock.tab === WORKFLOW_PANEL ? dockTabAfterClosing(next, owner, WORKFLOW_PANEL) : dock.tab;
    next = withDock(next, owner, { workflowId: null, panels, tab });
  }
  if (next === state) { const workflows = validWorkflowPanels.get(state.docks) ?? new WeakSet(); workflows.add(state.workflows); validWorkflowPanels.set(state.docks, workflows); }
  return next;
}
export { DIFF_PANEL, WORKFLOW_PANEL };

/** The checkout the thread in front works in: what Git is read from, for its diff as for its status. */
export function currentWorkspaceId(state: WorkspaceState) {
  const currentTask = state.tasks.find((task) => task.id === state.currentId);
  if (currentTask) return taskWorkspaceId(state, currentTask);
  return state.draftProjectId ? state.projects.find((project) => project.id === state.draftProjectId)?.workspaceId : undefined;
}

/**
 * What a review opens on. The session panel counts from where HEAD left the origin default branch, so
 * a review reached from that row starts on the same comparison and reports the same totals. Without
 * an origin to measure from there is nothing but the working tree, which is what it falls back to.
 */
export function initialRange(state: WorkspaceState, diff: DiffState): DiffRange {
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
export function readDiffFrom(state: WorkspaceState, owner: string, workspaceId: string | undefined, range: DiffRange, patch: Partial<DiffState> = {}): WorkspaceTransition {
  if (!workspaceId) return settled(withDiff(state, owner, { ...patch, range, workspaceId: null, result: null, loading: false }));
  return settled(
    withDiff(state, owner, { ...patch, range, workspaceId, loading: true }),
    [{ type: "read-diff", owner, workspaceId, range }],
  );
}

/** The same, for the thread the user is looking at. */
export function readDiff(state: WorkspaceState, owner: string, range: DiffRange, patch: Partial<DiffState> = {}): WorkspaceTransition {
  return readDiffFrom(state, owner, currentWorkspaceId(state), range, patch);
}

/**
 * A thread whose checkout changed is reviewing the wrong one until it reads again. Nothing to do for a
 * thread with no review open, which is most of them.
 */
export function rereadDiff(state: WorkspaceState, taskId: string): WorkspaceTransition {
  const diff = state.diffs[taskId];
  if (!diff) return settled(state);
  const workspaceId = taskWorkspaceId(state, state.tasks.find((task) => task.id === taskId));
  return diff.workspaceId === workspaceId ? settled(state) : readDiffFrom(state, taskId, workspaceId, diff.range, { result: null, collapsed: [], viewed: {} });
}

/** Settings stop waiting for a keystroke the moment they are no longer the thing in front. */
export function stopCapture(state: WorkspaceState): WorkspaceEffect[] {
  return state.capturingShortcut === null ? [] : [{ type: "capture-shortcut", capturing: false }];
}
