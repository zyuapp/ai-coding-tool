import { promptWithAttachments, taskTitleFor } from "./attachments.js";
import { moveTask as moveTaskInList, nextSortIndex } from "./task-order.js";
import {
  applyRunEvent,
  applyTask,
  automationRunLabel,
  automationRunPrompt,
  createTaskMessage,
  withActiveRun,
  withRunStatus,
} from "./task-workspace.js";
import { browserTarget, dockTabAfterClosing, dockTabKind, DOCK_PICKER, projectFor, promptKey, reachableVisit, recordVisit, stateFromData, taskWorkspaceId, terminalFolder, viewPreferences, withPrompt, type DraftBranch, type PendingRun, type QueuedMessage, type SideChat, type WorkspaceState } from "./workspace-state.js";
import type { AppCommand } from "../contracts/commands.js";
import type {
  ApprovalDecisionCommand,
  AutomationAck,
  AutomationFire,
  BrowserPageEvent,
  CancelRunCommand,
  ChangedFilesResult,
  RunEvent,
  StartRunCommand,
  SteerRunCommand,
} from "../contracts/ipc.js";
import type { ViewPreferences } from "../contracts/preferences.js";
import type { AutomationDraft, AutomationPatch, AutomationView } from "../domain/automation.js";
import { browserOrigin, browserUrl, type BrowserAction, type BrowserTab } from "../domain/browser.js";
import { terminalTitle, type TerminalSession, type TerminalUpdate } from "../domain/terminal.js";
import { DEFAULT_EFFORT, DEFAULT_MODEL, type RunStatus, type SubagentActivity } from "../domain/run.js";
import { clampTitle, legacyProjectId, type Project, type Task, type TaskAttention, type TaskStoreData } from "../domain/task.js";
import type { WorkspaceRecord } from "../domain/workspace.js";
import type { Worktree } from "../domain/worktree.js";
import type { WorktreeSnapshotResult } from "../contracts/ipc.js";

/** Things that happened: replies to effects, and pushes from the main process. */
export type WorkspaceEvent =
  | { type: "store.loaded"; data: TaskStoreData }
  | { type: "preferences.loaded"; preferences: ViewPreferences }
  | { type: "store.failed"; message: string }
  | { type: "action.failed"; message: string }
  | { type: "project.opened"; workspace: WorkspaceRecord }
  | { type: "run.event"; event: RunEvent }
  | { type: "run.resolved"; pendingId: string; workspace: WorkspaceRecord; worktree?: Worktree }
  | { type: "run.unresolved"; pendingId: string; message: string }
  | { type: "automation.fired"; fire: AutomationFire }
  | { type: "automations.changed"; automations: AutomationView[] }
  | { type: "title.suggested"; taskId: string; title: string }
  | { type: "worktree.created"; taskId: string; worktree: Worktree }
  | { type: "worktree.failed"; taskId: string; message: string }
  | { type: "worktree.released"; taskId: string; snapshot: WorktreeSnapshotResult }
  | { type: "worktree.deleted"; taskId: string }
  | { type: "environment.updated"; workspaceId: string; taskId?: string; runId?: string; result: ChangedFilesResult }
  /** What a page in the browser panel did. Main watches the page; the reducer keeps the record. */
  | { type: "browser.updated"; page: BrowserPageEvent }
  /** What a shell did. Its output is not here: that goes straight to the view and never becomes state. */
  | { type: "terminal.updated"; update: TerminalUpdate }
  | { type: "subagent.activity.loaded"; taskId: string; subagentId: string; activity: SubagentActivity[] };

/** Work the reducer wants done outside itself. The renderer performs these; nothing else does. */
export type WorkspaceEffect =
  | { type: "pick-project" }
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
  | { type: "send-run-command"; command: CancelRunCommand | ApprovalDecisionCommand | SteerRunCommand }
  | { type: "refresh-environment"; workspaceId: string; taskId?: string; runId?: string }
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
  /** The terminal panel's shells. `start` is idempotent: a terminal that already runs keeps its process. */
  | { type: "terminal.start"; terminalId: string; cwd: string }
  | { type: "terminal.write"; terminalId: string; data: string }
  | { type: "terminal.resize"; terminalId: string; cols: number; rows: number }
  | { type: "terminal.close"; terminalId: string }
  /** Nothing was left in front of the window, so ⌘W means what it always means. */
  | { type: "close-window" };

export type WorkspaceInput = AppCommand | WorkspaceEvent;

export type WorkspaceTransition = { state: WorkspaceState; effects: WorkspaceEffect[] };

const REOPEN_PROJECT_ERROR = "Reopen this project folder before running a task.";
const SAME_PROJECT_ERROR = "Choose the same project folder to continue this task.";
const MISSING_PROJECT_ERROR = "This task's project is unavailable. Reopen the project folder before running it.";
const RUNNING_PROJECT_ERROR = "Stop the running tasks before removing this project.";
const BUSY_AUTOMATION_ERROR = "This task is already running. The automation will run on its next tick.";
const WORKTREE_PROJECT_ERROR = "Open this thread in a project folder before giving it a worktree.";
const TERMINAL_FOLDER_ERROR = "Open a project folder before starting a terminal.";
const WORKTREE_RUNNING_ERROR = "Stop this thread's run before changing where it works.";
const CHECKOUT_RUNNING_ERROR = "Stop the threads running in this project before starting one on another branch.";

export const WORKSPACE_ERRORS = {
  reopenProject: REOPEN_PROJECT_ERROR,
  sameProject: SAME_PROJECT_ERROR,
  busyAutomation: BUSY_AUTOMATION_ERROR,
  worktreeProject: WORKTREE_PROJECT_ERROR,
  terminalFolder: TERMINAL_FOLDER_ERROR,
  worktreeRunning: WORKTREE_RUNNING_ERROR,
  checkoutRunning: CHECKOUT_RUNNING_ERROR,
} as const;

function now() {
  return Date.now();
}

function settled(state: WorkspaceState, effects: WorkspaceEffect[] = []): WorkspaceTransition {
  return { state, effects };
}

/** A named task has to exist; an unnamed command falls back to the one the user is looking at. */
function targetId(state: WorkspaceState, taskId: string | undefined): string | null {
  if (taskId === undefined) return state.currentId;
  return state.tasks.some((task) => task.id === taskId) ? taskId : null;
}

/** A run only earns a dot when it settles on its own; cancelling is the user's own doing. */
function attentionFor(event: RunEvent): TaskAttention | null {
  if (event.type === "approval.requested") return "approval";
  if (event.type !== "run.status") return null;
  if (event.status === "succeeded") return "finished";
  if (event.status === "failed") return "failed";
  return null;
}

function withoutAttention(state: WorkspaceState, taskId: string | null): WorkspaceState {
  if (!taskId || !state.tasks.some((task) => task.id === taskId && task.attention)) return state;
  return applyTask(state, taskId, ({ attention: _seen, ...task }) => task);
}

/** An archived task is unreachable, so its automation would tick forever with nowhere to run. */
function retireAutomations(state: WorkspaceState, taskIds: Iterable<string>): WorkspaceEffect[] {
  const scheduled = new Set(state.automations.map((automation) => automation.taskId));
  return [...taskIds].filter((taskId) => scheduled.has(taskId)).map((taskId) => ({ type: "automation.delete" as const, taskId }));
}

const BROWSER_URL_ERROR = "That is not a page the browser can open.";
const BROWSER_TAB_ERROR = "The browser has no page open to act on.";

/** Brings a tab to the front, so a page or a shell nobody asked to see still lands somewhere visible. */
function showDockTab(state: WorkspaceState, tab: string): WorkspaceState {
  return { ...state, dockOpen: true, dockTab: tab };
}

/**
 * A thread switch clears the dock back to the picker. A page and a shell belong to the window rather
 * than to a thread, so their tabs stay, and one of them showing keeps showing.
 */
function resetDock(state: WorkspaceState): WorkspaceState {
  const kind = dockTabKind(state, state.dockTab);
  return { ...state, dockPanels: [], dockTab: kind === "browser" || kind === "terminal" ? state.dockTab : DOCK_PICKER };
}

function withBrowserTabs(state: WorkspaceState, tabs: BrowserTab[]): WorkspaceState {
  return { ...state, browserTabs: tabs };
}

function patchBrowserTab(state: WorkspaceState, tabId: string, patch: Partial<BrowserTab>): WorkspaceState {
  return withBrowserTabs(state, state.browserTabs.map((tab) => tab.id === tabId ? { ...tab, ...patch } : tab));
}

function persistView(state: WorkspaceState): WorkspaceEffect[] {
  return [{ type: "persist-preferences", preferences: viewPreferences(state) }];
}

/**
 * Loads the page, in the tab named or a new one. The origin is remembered when the user is the one
 * asking, which is what lets a run reach a site the user has already signed into.
 */
function loadBrowserPage(state: WorkspaceState, url: string, tabId: string | undefined, newTab: boolean, byUser: boolean): WorkspaceTransition {
  const origin = browserOrigin(url);
  const allowing = byUser && origin && !state.browserOrigins.includes(origin);
  const remembered = allowing ? { ...state, browserOrigins: [...state.browserOrigins, origin] } : state;
  const target = newTab ? undefined : browserTarget(remembered, tabId);
  const cleared = { ...remembered, browserApproval: null, actionError: null };
  if (target) {
    const navigating = patchBrowserTab(showDockTab(cleared, target.id), target.id, { url, loading: true, error: undefined });
    return settled({ ...navigating, browserTabId: target.id }, [
      { type: "browser.navigate", tabId: target.id, url },
      ...persistView(navigating),
    ]);
  }
  const tab: BrowserTab = { id: crypto.randomUUID(), url, title: "", loading: true, canGoBack: false, canGoForward: false };
  const opened = { ...withBrowserTabs(showDockTab(cleared, tab.id), [...cleared.browserTabs, tab]), browserTabId: tab.id };
  return settled(opened, [
    { type: "browser.open", tabId: tab.id, url },
    { type: "browser.show", tabId: tab.id },
    ...persistView(opened),
  ]);
}

/** A page waiting for an address. It is a dock tab of its own from the moment it exists. */
function withBlankTab(state: WorkspaceState) {
  const tab: BrowserTab = { id: crypto.randomUUID(), url: "", title: "", loading: false, canGoBack: false, canGoForward: false };
  const opened = { ...withBrowserTabs(showDockTab(state, tab.id), [...state.browserTabs, tab]), browserTabId: tab.id };
  return { state: opened, tab };
}

/**
 * Puts the navigation to the user. The ask always names the tab it would load in — a blank one when
 * the run wanted a new page — so it is shown in that tab rather than needing a panel of its own.
 */
function askToBrowse(state: WorkspaceState, url: string, taskId: string, tabId: string | undefined, newTab: boolean): WorkspaceTransition {
  const target = newTab ? undefined : browserTarget(state, tabId);
  if (target) return settled({ ...showDockTab(state, target.id), browserApproval: { url, taskId, tabId: target.id } });
  const { state: opened, tab } = withBlankTab(state);
  return settled({ ...opened, browserApproval: { url, taskId, tabId: tab.id } }, [
    { type: "browser.open", tabId: tab.id },
    { type: "browser.show", tabId: tab.id },
  ]);
}

/** Closing a page hands the dock its neighbour, and the panel whichever page that turns out to be. */
function closeBrowserTab(state: WorkspaceState, tabId: string | undefined, options: { onlyIfBlank?: boolean } = {}): WorkspaceTransition {
  const index = state.browserTabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return settled(state);
  if (options.onlyIfBlank && state.browserTabs[index].url) return settled(state);
  const dockTab = state.dockTab === tabId ? dockTabAfterClosing(state, tabId) : state.dockTab;
  const browserTabs = state.browserTabs.filter((tab) => tab.id !== tabId);
  const next = state.browserTabId === tabId ? browserTabs[index - 1] ?? browserTabs[index] ?? null : browserTabs.find((tab) => tab.id === state.browserTabId) ?? null;
  const closed = { ...withBrowserTabs(state, browserTabs), browserTabId: next?.id ?? null, dockTab };
  const showing = browserTabs.find((tab) => tab.id === dockTab);
  return settled(closed, [
    { type: "browser.close", tabId: tabId! },
    ...(showing ? browserEffectsForTab(closed, showing.id) : [{ type: "browser.show" as const, tabId: null }]),
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
function browserEffectsForTab(state: WorkspaceState, dockTab: string): WorkspaceEffect[] {
  const tab = state.browserTabs.find((page) => page.id === dockTab);
  if (!tab) return [];
  return [{ type: "browser.open", tabId: tab.id, ...(tab.url ? { url: tab.url } : {}) }, { type: "browser.show", tabId: tab.id }];
}

function withPending(state: WorkspaceState, pending: PendingRun): WorkspaceState {
  return { ...state, pendingRuns: { ...state.pendingRuns, [pending.id]: pending }, actionError: null };
}

function withoutPending(state: WorkspaceState, pendingId: string): WorkspaceState {
  const { [pendingId]: _settled, ...pendingRuns } = state.pendingRuns;
  return { ...state, pendingRuns };
}

function queuedFor(state: WorkspaceState, taskId: string): QueuedMessage[] {
  return state.queuedMessages[taskId] ?? [];
}

function withQueued(state: WorkspaceState, taskId: string, messages: QueuedMessage[]): WorkspaceState {
  if (messages.length) return { ...state, queuedMessages: { ...state.queuedMessages, [taskId]: messages } };
  const { [taskId]: _drained, ...queuedMessages } = state.queuedMessages;
  return { ...state, queuedMessages };
}

function startRunCommand(task: Task, runId: string, prompt: string, workspaceId: string, policy = task.executionPolicy): StartRunCommand {
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

/** Records the run against the task and marks it the task's latest, so stale replies can be dropped. */
function beginRun(state: WorkspaceState, taskId: string, runId: string): WorkspaceState {
  return withRunStatus(
    withActiveRun({ ...state, actionError: null, lastRunIds: { ...state.lastRunIds, [taskId]: runId } }, taskId, { taskId, runId, sequence: 0, status: "running" }),
    taskId,
    "running",
  );
}

/** A steered message joined the run, so it leaves the queue and takes its place in the thread. */
function withDeliveredMessage(state: WorkspaceState, taskId: string, messageId: string): WorkspaceState {
  const queued = queuedFor(state, taskId);
  const delivered = queued.find((message) => message.id === messageId);
  if (!delivered) return state;
  return applyTask(withQueued(state, taskId, queued.filter((message) => message.id !== messageId)), taskId, (task) => ({
    ...task,
    messages: [...task.messages, createTaskMessage("user", delivered.text, undefined, delivered.attachments)],
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
    return settled(withPrompt(withQueued(state, taskId, []), taskId, text));
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
    queuedIds: [next.id],
  };
  return settled(withPending(state, pending), [resolveWorkspaceEffect(pending.id, task, project, false)]);
}

/**
 * Where a run happens: the thread's own checkout once it has one, a checkout made on the way if the
 * thread has asked for one, and otherwise the project itself. A thread that is moving takes its
 * uncommitted work with it; a thread starting in a worktree begins from a clean checkout.
 */
function resolveWorkspaceEffect(pendingId: string, task: Task | undefined, project: Project | undefined, wantsWorktree: boolean, branch?: DraftBranch | null): WorkspaceEffect {
  const worktree = task?.worktree;
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

/** A thread that has let go of its checkout is local again, and says so in its own timeline. */
function clearWorktree(state: WorkspaceState, taskId: string, note: ReturnType<typeof createTaskMessage>): WorkspaceState {
  return applyTask(state, taskId, ({ worktree: _released, ...task }) => ({
    ...task,
    messages: [...task.messages, note],
    updatedAt: now(),
  }));
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
    next = withPrompt(withQueued(withRunStatus(withActiveRun(next, chat.id, null), chat.id, "idle"), chat.id, []), chat.id, "");
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
      dockTab: closed.has(next.dockTab) ? dockTabAfterClosing(next, next.dockTab) : next.dockTab,
      pendingRuns: Object.fromEntries(Object.entries(next.pendingRuns).filter(([, pending]) => !(pending.taskId && closed.has(pending.taskId)))),
    },
    effects,
  };
}

/**
 * The single writer for workspace state. Commands come from the UI (and, later, from anything else
 * driving the app); events report what the outside world did back. Nothing here touches Electron.
 */
export function reduce(state: WorkspaceState, input: WorkspaceInput): WorkspaceTransition {
  const transition = apply(state, input);
  if (transition.state.currentId === state.currentId) return transition;
  const landed = transition.state.currentId !== null && input.type !== "view.go-back" && input.type !== "view.go-forward"
    ? recordVisit(transition.state, transition.state.currentId)
    : transition.state;
  if (!landed.sideChats.length) return { ...transition, state: resetDock(landed) };
  const closed = closeSideChats(landed, landed.sideChats);
  return { state: resetDock({ ...closed.state, sideChatSequence: 0 }), effects: [...transition.effects, ...closed.effects] };
}

function apply(state: WorkspaceState, input: WorkspaceInput): WorkspaceTransition {
  switch (input.type) {
    case "task.new": {
      const project = input.projectId ? state.projects.find((item) => item.id === input.projectId) : undefined;
      return settled({
        ...state,
        currentId: null,
        draftProjectId: input.projectId ?? null,
        draftBranch: null,
        draftWorktree: false,
        actionError: null,
        lastFolder: project?.root ?? state.lastFolder,
        expandedProjects: input.projectId ? new Set(state.expandedProjects).add(input.projectId) : state.expandedProjects,
      });
    }

    case "task.select": {
      const task = state.tasks.find((item) => item.id === input.taskId);
      const project = projectFor(state, task);
      return settled(withoutAttention({
        ...state,
        currentId: input.taskId,
        draftProjectId: task?.projectId ?? null,
        lastFolder: project?.root ?? state.lastFolder,
        actionError: null,
      }, input.taskId));
    }

    /** Archiving a running task cancels its run; the task leaves the sidebar without waiting for the run to settle. */
    case "task.archive": {
      const active = state.activeRuns[input.taskId];
      return settled({
        ...state,
        tasks: state.tasks.map((task) => task.id === input.taskId ? { ...task, archivedAt: now() } : task),
        currentId: state.currentId === input.taskId ? null : state.currentId,
      }, [
        ...retireAutomations(state, [input.taskId]),
        ...(active ? [{ type: "send-run-command" as const, command: { type: "cancel" as const, taskId: active.taskId, runId: active.runId } }] : []),
      ]);
    }

    /** Restoring leaves the retired automation gone; the user re-arms it themselves. */
    case "task.restore": {
      const task = state.tasks.find((item) => item.id === input.taskId);
      if (!task || task.archivedAt === undefined) return settled(state);
      return settled(applyTask(state, input.taskId, ({ archivedAt: _restored, ...item }) => item));
    }

    case "task.clear-archive": {
      const tasks = state.tasks.filter((task) => task.archivedAt === undefined);
      if (tasks.length === state.tasks.length) return settled(state);
      return settled({
        ...state,
        tasks,
        currentId: tasks.some((task) => task.id === state.currentId) ? state.currentId : null,
      });
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
     * Moves the thread there and then, so it is never left saying it will move later. Turning it
     * off hands the checkout back: what it still holds is committed first, and the directory goes.
     */
    case "task.set-worktree": {
      const taskId = targetId(state, input.taskId);
      const task = taskId ? state.tasks.find((item) => item.id === taskId) : undefined;
      /** With no thread yet the answer is a draft: the checkout is made when the first message goes. */
      if (!task) return settled(input.taskId === undefined ? { ...state, draftWorktree: input.worktree } : state);
      if (threadBusy(state, task.id)) return settled({ ...state, actionError: WORKTREE_RUNNING_ERROR });
      if (input.worktree) {
        if (task.worktree) return settled(state);
        const project = projectFor(state, task);
        if (!project?.workspaceId) return settled({ ...state, actionError: WORKTREE_PROJECT_ERROR });
        return settled({ ...state, actionError: null }, [{ type: "create-worktree", taskId: task.id, projectRoot: project.root }]);
      }
      if (!task.worktree) return settled(state);
      return settled({ ...state, actionError: null }, [{
        type: "release-worktree",
        taskId: task.id,
        worktreeId: task.worktree.id,
        root: task.worktree.root,
        title: task.title,
      }]);
    }

    /** Only a thread yet to be created can be told where to start; an existing one already is. */
    case "task.set-branch":
      return settled({
        ...state,
        draftBranch: input.branch === null ? null : { name: input.branch, create: Boolean(input.create) },
        actionError: null,
      });

    /** Unlike switching back, this keeps nothing: the checkout and everything loose in it go. */
    case "worktree.delete": {
      const taskId = targetId(state, input.taskId);
      const task = taskId ? state.tasks.find((item) => item.id === taskId) : undefined;
      if (!task?.worktree) return settled(state);
      if (threadBusy(state, task.id)) return settled({ ...state, actionError: WORKTREE_RUNNING_ERROR });
      return settled({ ...state, actionError: null }, [{ type: "delete-worktree", taskId: task.id, root: task.worktree.root }]);
    }

    case "worktree.created": {
      const task = state.tasks.find((item) => item.id === input.taskId);
      if (!task || task.worktree) return settled(state);
      const note = createTaskMessage("system", `Moved into a worktree at ${input.worktree.root}`, `Detached at ${input.worktree.baseCommit.slice(0, 7)}`);
      return settled(applyTask(state, input.taskId, (item) => ({
        ...item,
        worktree: input.worktree,
        messages: [...item.messages, note],
        updatedAt: now(),
      })));
    }

    case "worktree.failed":
      return settled({ ...state, actionError: input.message });

    case "worktree.released": {
      const task = state.tasks.find((item) => item.id === input.taskId);
      if (!task?.worktree) return settled(state);
      const { commit, shortCommit, ref } = input.snapshot;
      const text = commit
        ? `Returned to the project checkout. Uncommitted work was committed as ${shortCommit ?? commit.slice(0, 7)}, and the worktree was removed.`
        : "Returned to the project checkout. The worktree had nothing uncommitted, and was removed.";
      return settled(clearWorktree(state, task.id, createTaskMessage("system", text, ref ? `Recover it with git show ${ref}` : undefined)));
    }

    case "worktree.deleted": {
      const task = state.tasks.find((item) => item.id === input.taskId);
      if (!task?.worktree) return settled(state);
      return settled(clearWorktree(state, task.id, createTaskMessage("system", "Worktree deleted. Back on the project checkout.")));
    }

    case "task.send": {
      const attachments = input.attachments ?? [];
      /** A send that carries its own text is not the composer's: it neither reads nor clears a draft. */
      const draftKey = input.text === undefined ? input.taskId ?? promptKey(state) : undefined;
      const text = (input.text ?? (draftKey === undefined ? undefined : state.prompts[draftKey]) ?? "").trim();
      const alreadySending = draftKey !== undefined && Object.values(state.pendingRuns).some((pending) => pending.draftKey === draftKey);
      if ((!text && attachments.length === 0) || alreadySending) return settled(state);
      if (input.taskId !== undefined && !targetId(state, input.taskId)) return settled(state);
      /** A side chat has nothing to say until the thread it forks from has a session to fork. */
      if (input.taskId !== undefined && state.sideChats.some((chat) => chat.id === input.taskId) && !forkableContinuation(state, input.taskId)) return settled(state);
      /** Only the composer's own send falls back to the current task; a send with its own text starts a thread. */
      const task = state.tasks.find((item) => item.id === (input.taskId ?? (draftKey === undefined ? null : state.currentId)));
      if (task && state.activeRuns[task.id]) {
        const queued: QueuedMessage = {
          id: crypto.randomUUID(),
          text,
          prompt: promptWithAttachments(text, attachments),
          attachments: attachments.map((attachment) => attachment.path),
        };
        const next = withQueued(draftKey === undefined ? state : withPrompt(state, draftKey, ""), task.id, [...queuedFor(state, task.id), queued]);
        return input.steer ? apply(next, { type: "task.steer-queued", taskId: task.id, messageId: queued.id }) : settled(next);
      }
      const projectId = task?.projectId ?? input.projectId ?? (draftKey === undefined ? null : state.draftProjectId);
      const project = projectId ? state.projects.find((item) => item.id === projectId) : undefined;
      if (projectId && !project) return settled({ ...state, actionError: MISSING_PROJECT_ERROR });
      const pending: PendingRun = {
        id: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        origin: "composer",
        ...(task ? { taskId: task.id } : {}),
        ...(project ? { projectId: project.id } : {}),
        ...(draftKey === undefined ? {} : { draftKey }),
        text,
        prompt: promptWithAttachments(text, attachments),
        attachments: attachments.map((attachment) => attachment.path),
      };
      /** Only a thread being created here reads the draft answers; an existing one keeps its own. */
      /** Only a thread yet to exist can start in a checkout of its own; one that exists already moved. */
      const wantsWorktree = task ? false : (input.worktree ?? state.draftWorktree);
      const branch = task ? null : state.draftBranch;
      /** Starting from a branch without a checkout of its own moves the project, so nothing may be running in it. */
      if (branch && !wantsWorktree && project && runsInWorkspace(state, project.workspaceId)) {
        return settled({ ...state, actionError: CHECKOUT_RUNNING_ERROR });
      }
      return settled(withPending(state, pending), [resolveWorkspaceEffect(pending.id, task, project, wantsWorktree, branch)]);
    }

    case "task.steer-queued": {
      const taskId = targetId(state, input.taskId);
      const active = taskId ? state.activeRuns[taskId] : undefined;
      const queued = taskId ? queuedFor(state, taskId) : [];
      const message = queued.find((item) => item.id === input.messageId);
      if (!taskId || !active || !message || message.steering) return settled(state);
      return settled(
        withQueued(state, taskId, queued.map((item) => item.id === message.id ? { ...item, steering: true } : item)),
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

    case "project.opened": {
      const id = legacyProjectId(input.workspace.root);
      const projects = state.projects.some((project) => project.id === id)
        ? state.projects.map((project) => project.id === id ? { ...project, root: input.workspace.root, workspaceId: input.workspace.id } : project)
        : [{ id, root: input.workspace.root, workspaceId: input.workspace.id }, ...state.projects];
      return settled({
        ...state,
        projects,
        currentId: null,
        draftProjectId: id,
        lastFolder: input.workspace.root,
        actionError: null,
        expandedProjects: new Set(state.expandedProjects).add(id),
      });
    }

    case "project.remove": {
      if (state.tasks.some((task) => task.projectId === input.projectId && state.activeRuns[task.id])) {
        return settled({ ...state, actionError: RUNNING_PROJECT_ERROR });
      }
      const effects = retireAutomations(state, state.tasks.filter((task) => task.projectId === input.projectId).map((task) => task.id));
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
        openMenu: null,
        actionError: null,
      }, effects);
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

    case "run.decide": {
      const taskId = input.taskId ?? state.currentId;
      const active = taskId ? state.activeRuns[taskId] : undefined;
      const approval = active ? state.approvals[active.runId] : undefined;
      if (!active || !approval) return settled(state);
      const { [active.runId]: _decided, ...approvals } = state.approvals;
      return settled({ ...state, approvals }, [{
        type: "send-run-command",
        command: { type: "approval", taskId: active.taskId, runId: active.runId, approvalId: approval.approvalId, allow: input.allow },
      }]);
    }

    case "run.event": {
      const { event } = input;
      const active = state.activeRuns[event.taskId];
      if (!active || event.runId !== active.runId || event.sequence <= active.sequence) return settled(state);
      const applied = applyRunEvent(state, event);
      const attention = attentionFor(event);
      let next = attention && !(state.focused && state.currentId === event.taskId)
        ? applyTask(applied, event.taskId, (task) => ({ ...task, attention }))
        : applied;
      if (event.type === "computer-use.setup-required") next = { ...next, computerUseSetup: true };
      if (event.type === "queued.delivered") next = withDeliveredMessage(next, event.taskId, event.messageId);
      const finished = event.type === "run.status" && (event.status === "succeeded" || event.status === "failed");
      const workspaceId = taskWorkspaceId(state, state.tasks.find((task) => task.id === event.taskId));
      const environment: WorkspaceEffect[] = finished && workspaceId
        ? [{ type: "refresh-environment", workspaceId, taskId: event.taskId, runId: event.runId }]
        : [];
      if (event.type !== "run.status" || event.status === "running" || event.status === "awaiting-approval") return settled(next, environment);
      const drained = drainQueue(next, event.taskId, event.status);
      return settled(drained.state, [...environment, ...drained.effects]);
    }

    /** The scheduler owns the cadence; the workspace decides whether this tick can actually run. */
    case "automation.fired": {
      const { fire } = input;
      const decline: WorkspaceEffect[] = [{ type: "automation.ack", ack: { automationId: fire.automationId, runId: fire.runId, started: false } }];
      const task = state.tasks.find((item) => item.id === fire.taskId);
      /** A send still resolving is a run too, and two of them would make two checkouts. */
      if (!task || task.archivedAt !== undefined || threadBusy(state, fire.taskId)) return settled(state, decline);
      const project = projectFor(state, task);
      if (task.projectId && !project?.workspaceId) return settled(state, decline);
      const pending: PendingRun = {
        id: crypto.randomUUID(),
        runId: fire.runId,
        origin: "automation",
        taskId: fire.taskId,
        ...(project ? { projectId: project.id } : {}),
        text: fire.prompt,
        prompt: automationRunPrompt(fire.prompt, fire.runNumber),
        detail: automationRunLabel(fire.runNumber),
        attachments: [],
        ...(fire.policy ? { policy: fire.policy } : {}),
        automationId: fire.automationId,
      };
      return settled(withPending(state, pending), [resolveWorkspaceEffect(pending.id, task, project, false)]);
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
      return settled({
        ...state,
        tasks: [...state.tasks, task],
        sideChats: [...state.sideChats, { id: input.chatId, sourceTaskId: source.id, error: null }],
        sideChatSequence: sequence,
        dockOpen: true,
        dockTab: input.chatId,
      });
    }

    case "side-chat.close": {
      const chat = state.sideChats.find((item) => item.id === input.chatId);
      return chat ? closeSideChats(state, [chat]) : settled(state);
    }

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
      const currentProject = currentTask
        ? projectFor(state, currentTask)
        : (state.draftProjectId ? state.projects.find((project) => project.id === state.draftProjectId) : undefined);
      const workspaceId = currentTask ? taskWorkspaceId(state, currentTask) : currentProject?.workspaceId;
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

    case "environment.updated": {
      if (input.taskId && input.runId && state.lastRunIds[input.taskId] !== input.runId) return settled(state);
      const next: WorkspaceState = { ...state, environment: { workspaceId: input.workspaceId, result: input.result } };
      if (!input.taskId || input.result.status !== "available") return settled(next);
      const files = input.result.files;
      return settled(applyTask(next, input.taskId, (task) => ({ ...task, lastChangeSnapshot: { files, capturedAt: now() }, updatedAt: now() })));
    }

    case "store.loaded":
      return settled({
        ...stateFromData(input.data),
        automations: state.automations,
        focused: state.focused,
        sessionPanelOpen: state.sessionPanelOpen,
        dockOpen: state.dockOpen,
        dockPanels: state.dockPanels,
        dockTab: state.dockTab,
        browserTabs: state.browserTabs,
        browserTabId: state.browserTabId,
        browserOrigins: state.browserOrigins,
      });

    case "preferences.loaded": {
      /** A restored page keeps its record and gets its view back when the panel first shows it. */
      const browserTabs = (input.preferences.browserTabs ?? []).flatMap((url): BrowserTab[] => {
        const loadable = browserUrl(url);
        return loadable ? [{ id: crypto.randomUUID(), url: loadable, title: "", loading: false, canGoBack: false, canGoForward: false }] : [];
      });
      return settled({
        ...state,
        sessionPanelOpen: input.preferences.sessionPanelOpen,
        browserTabs,
        browserTabId: browserTabs[0]?.id ?? null,
        browserOrigins: input.preferences.browserOrigins ?? [],
      });
    }

    case "store.failed":
      return settled({ ...state, writable: false, storageError: input.message });

    case "action.failed":
      return settled({ ...state, actionError: input.message });

    case "view.set-prompt":
      return settled(withPrompt(state, input.taskId ?? promptKey(state), input.prompt));

    case "view.toggle-project": {
      const expandedProjects = new Set(state.expandedProjects);
      if (expandedProjects.has(input.projectId)) expandedProjects.delete(input.projectId);
      else expandedProjects.add(input.projectId);
      return settled({ ...state, expandedProjects });
    }

    case "view.set-projects-open":
      return settled({ ...state, projectsOpen: input.open });

    case "view.set-recents-open":
      return settled({ ...state, recentsOpen: input.open });

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

    case "view.set-session-panel-open": {
      if (state.sessionPanelOpen === input.open) return settled(state);
      const next = { ...state, sessionPanelOpen: input.open };
      return settled(next, [{ type: "persist-preferences", preferences: viewPreferences(next) }]);
    }

    case "view.set-settings-open":
      return settled({ ...state, settingsOpen: input.open, ...(input.open ? { dockOpen: false } : { computerUseSetup: false }) });

    case "view.close-tab": {
      if (state.settingsOpen || state.computerUseSetup) return settled({ ...state, settingsOpen: false, computerUseSetup: false });
      if (!state.dockOpen) return settled(state, [{ type: "close-window" }]);
      const kind = dockTabKind(state, state.dockTab);
      if (kind === "picker") return settled({ ...state, dockOpen: false });
      if (kind === "browser") return apply(state, { type: "browser.close-tab", tabId: state.dockTab });
      if (kind === "terminal") return apply(state, { type: "terminal.close", terminalId: state.dockTab });
      return apply(state, kind === "side-chat"
        ? { type: "side-chat.close", chatId: state.dockTab }
        : { type: "view.close-dock-panel", panel: state.dockTab });
    }

    case "view.set-dock-open":
      return settled(state.dockOpen === input.open ? state : { ...state, dockOpen: input.open });

    case "view.open-dock-panel": {
      const dockPanels = state.dockPanels.includes(input.panel) ? state.dockPanels : [...state.dockPanels, input.panel];
      const opened = { ...state, dockOpen: true, dockPanels, dockTab: input.panel };
      return settled(opened, browserEffectsForTab(opened, input.panel));
    }

    case "view.close-dock-panel": {
      if (!state.dockPanels.includes(input.panel)) return settled(state);
      const dockTab = state.dockTab === input.panel ? dockTabAfterClosing(state, input.panel) : state.dockTab;
      const closed = { ...state, dockPanels: state.dockPanels.filter((panel) => panel !== input.panel), dockTab };
      return settled(closed, browserEffectsForTab(closed, dockTab));
    }

    case "view.select-dock-tab": {
      const kind = dockTabKind(state, input.tab);
      const selected = {
        ...state,
        dockTab: input.tab,
        dockOpen: true,
        ...(kind === "browser" ? { browserTabId: input.tab } : {}),
        ...(kind === "terminal" ? { terminalId: input.tab } : {}),
      };
      return settled(selected, browserEffectsForTab(selected, input.tab));
    }

    case "browser.open": {
      const url = browserUrl(input.url);
      if (!url) return settled({ ...state, actionError: BROWSER_URL_ERROR });
      const byUser = input.taskId === undefined;
      if (!byUser && !browserAllowed(state, input.taskId!, url)) return askToBrowse(state, url, input.taskId!, input.tabId, input.newTab === true);
      return loadBrowserPage(state, url, input.tabId, input.newTab === true, byUser);
    }

    case "browser.new-tab": {
      const { state: opened, tab } = withBlankTab(state);
      return settled(opened, [{ type: "browser.open", tabId: tab.id }, { type: "browser.show", tabId: tab.id }]);
    }

    case "browser.decide": {
      const approval = state.browserApproval;
      if (!approval) return settled(state);
      /** A blank tab only existed to carry the ask, so blocking takes it away again. */
      if (!input.allow) return closeBrowserTab({ ...state, browserApproval: null }, approval.tabId, { onlyIfBlank: true });
      const origin = browserOrigin(approval.url);
      const allowed = origin ? { ...state, browserOrigins: [...state.browserOrigins, origin] } : state;
      return loadBrowserPage(allowed, approval.url, approval.tabId, approval.tabId === undefined, false);
    }

    case "browser.select-tab": {
      const tab = state.browserTabs.find((item) => item.id === input.tabId);
      if (!tab) return settled(state);
      return settled({ ...showDockTab(state, tab.id), browserTabId: tab.id }, browserEffectsForTab(state, tab.id));
    }

    case "browser.close-tab":
      return closeBrowserTab(state, input.tabId);

    case "browser.go":
    case "browser.reload":
    case "browser.act": {
      const target = browserTarget(state, input.tabId);
      if (!target) return settled({ ...state, actionError: BROWSER_TAB_ERROR });
      if (input.type === "browser.act") return settled(state, [{ type: "browser.act", tabId: target.id, action: input.action }]);
      const effect: WorkspaceEffect = input.type === "browser.go"
        ? { type: "browser.history", tabId: target.id, delta: input.delta }
        : { type: "browser.reload", tabId: target.id };
      return settled(patchBrowserTab(state, target.id, { loading: true, error: undefined }), [effect]);
    }

    case "browser.clear-data": {
      const cleared = { ...state, browserOrigins: [] };
      return settled(cleared, [{ type: "browser.clear-data" }, ...persistView(cleared)]);
    }

    case "terminal.open": {
      const cwd = input.cwd ?? terminalFolder(state);
      if (!cwd) return settled({ ...state, actionError: TERMINAL_FOLDER_ERROR });
      const terminal: TerminalSession = {
        id: crypto.randomUUID(),
        title: terminalTitle(cwd),
        cwd,
        taskId: state.currentId,
        status: "running",
      };
      const opened = showDockTab({ ...state, terminals: [...state.terminals, terminal], terminalId: terminal.id, actionError: null }, terminal.id);
      return settled(opened, [{ type: "terminal.start", terminalId: terminal.id, cwd }]);
    }

    case "terminal.select": {
      if (!state.terminals.some((terminal) => terminal.id === input.terminalId)) return settled(state);
      return settled({ ...showDockTab(state, input.terminalId), terminalId: input.terminalId });
    }

    case "terminal.close": {
      const index = state.terminals.findIndex((terminal) => terminal.id === input.terminalId);
      if (index === -1) return settled(state);
      const dockTab = state.dockTab === input.terminalId ? dockTabAfterClosing(state, input.terminalId) : state.dockTab;
      const terminals = state.terminals.filter((terminal) => terminal.id !== input.terminalId);
      const next = state.terminalId === input.terminalId
        ? terminals[index - 1] ?? terminals[index] ?? null
        : terminals.find((terminal) => terminal.id === state.terminalId) ?? null;
      return settled({ ...state, terminals, terminalId: next?.id ?? null, dockTab }, [{ type: "terminal.close", terminalId: input.terminalId }]);
    }

    /** Keystrokes and the size the shell believes it has. Neither is state, so only the effect happens. */
    case "terminal.input":
      return settled(state, [{ type: "terminal.write", terminalId: input.terminalId, data: input.data }]);

    case "terminal.resize":
      return settled(state, [{ type: "terminal.resize", terminalId: input.terminalId, cols: input.cols, rows: input.rows }]);

    case "terminal.updated": {
      const { terminalId, ...patch } = input.update;
      if (!state.terminals.some((terminal) => terminal.id === terminalId)) return settled(state);
      return settled({
        ...state,
        terminals: state.terminals.map((terminal) => terminal.id === terminalId ? { ...terminal, ...patch } : terminal),
      });
    }

    case "browser.updated": {
      const { tabId, ...patch } = input.page;
      const current = state.browserTabs.find((tab) => tab.id === tabId);
      if (!current) return settled(state);
      /** Landing on a different page clears the error the page before it left behind. */
      const clearing = current.error !== undefined && patch.error === undefined && patch.url !== undefined && patch.url !== current.url;
      const updated = patchBrowserTab(state, tabId, clearing ? { ...patch, error: undefined } : patch);
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
      return settled(withoutAttention({
        ...state,
        historyIndex: index,
        currentId: taskId,
        draftProjectId: task?.projectId ?? null,
        lastFolder: projectFor(state, task)?.root ?? state.lastFolder,
        actionError: null,
      }, taskId));
    }

    case "view.set-focused":
      return settled(input.focused ? withoutAttention({ ...state, focused: true }, state.currentId) : { ...state, focused: false });

    case "view.dismiss-computer-use-setup":
      return settled({ ...state, computerUseSetup: false });
  }
}

function startComposerRun(state: WorkspaceState, pending: PendingRun, workspace: WorkspaceRecord, worktree?: Worktree): WorkspaceTransition {
  const existing = pending.taskId ? state.tasks.find((item) => item.id === pending.taskId) : undefined;
  if (pending.taskId && (!existing || state.activeRuns[pending.taskId])) return settled(state);
  /** The first run inside a checkout forks the session rather than resuming it from a new place. */
  const arriving = worktree ?? existing?.worktree;
  const entering = Boolean(arriving && !arriving.enteredAt);
  const task: Task = existing ?? {
    id: crypto.randomUUID(),
    title: taskTitleFor(pending.text, pending.attachments.map((path) => ({ path, labels: [] }))),
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
  const message = createTaskMessage("user", pending.text, undefined, pending.attachments);
  const arrival = entering && worktree ? [createTaskMessage("system", `Moved into a worktree at ${worktree.root}`, `Detached at ${worktree.baseCommit.slice(0, 7)}`)] : [];
  /** Every run through a worktree touches it, which is what an eviction rule would sort on. */
  const located = arriving ? { ...task, worktree: { ...arriving, lastUsedAt: now(), enteredAt: arriving.enteredAt ?? now() } } : task;
  const updated = { ...located, messages: [...located.messages, ...arrival, message], updatedAt: now() };
  const tasks = existing ? state.tasks.map((item) => item.id === task.id ? updated : item) : [updated, ...state.tasks];
  /** Only a task the user's own send just created needs looking at; anything else leaves them where they are. */
  const focusing = !existing && pending.draftKey !== undefined;
  const spent = existing ? {} : { draftBranch: null, draftWorktree: false };
  const started = beginRun({ ...state, tasks, ...spent, ...(focusing ? { currentId: task.id } : {}) }, task.id, pending.runId);
  const drained = pending.queuedIds
    ? withQueued(started, task.id, queuedFor(started, task.id).filter((message) => !pending.queuedIds!.includes(message.id)))
    : started;
  const titling: WorkspaceEffect[] = existing || (!pending.text && pending.attachments.length === 0) ? [] : [{ type: "suggest-title", taskId: task.id, text: pending.text, attachments: pending.attachments }];
  const command = {
    ...startRunCommand(updated, pending.runId, pending.prompt, workspace.id),
    ...(entering && updated.continuation ? { forkContinuation: true as const } : {}),
    ...sideChannelFor(state, updated),
  };
  return settled(
    pending.draftKey ? withPrompt(drained, pending.draftKey, "") : drained,
    [{ type: "start-run", command }, ...titling],
  );
}

function startAutomationRun(state: WorkspaceState, pending: PendingRun, workspace: WorkspaceRecord, worktree?: Worktree): WorkspaceTransition {
  const taskId = pending.taskId!;
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task || task.archivedAt !== undefined || state.activeRuns[taskId]) return settled(state, ack(pending, false));
  const message = createTaskMessage("user", pending.text, pending.detail);
  const entered = worktree ?? task.worktree;
  const withMessage = applyTask(state, taskId, (item) => ({
    ...item,
    ...(entered ? { worktree: { ...entered, lastUsedAt: now(), enteredAt: entered.enteredAt ?? now() } } : {}),
    messages: [...item.messages, message],
    updatedAt: now(),
  }));
  return settled(beginRun(withMessage, taskId, pending.runId), [
    { type: "start-run", command: startRunCommand(task, pending.runId, pending.prompt, workspace.id, pending.policy ?? task.executionPolicy) },
    ...ack(pending, true),
  ]);
}
