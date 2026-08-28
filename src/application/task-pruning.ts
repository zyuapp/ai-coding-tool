import type { SideChat, ThreadDock, WorkspaceState } from "./workspace-state.js";

function withoutTaskKeys<T>(record: Record<string, T>, removed: Set<string>): Record<string, T> {
  let cleaned: Record<string, T> | null = null;
  for (const taskId of removed) {
    if (!Object.hasOwn(record, taskId)) continue;
    cleaned ??= { ...record };
    delete cleaned[taskId];
  }
  return cleaned ?? record;
}

function withoutMatchingValues<T>(record: Record<string, T>, matches: (value: T) => boolean): Record<string, T> {
  let cleaned: Record<string, T> | null = null;
  for (const key in record) {
    if (!matches(record[key]!)) continue;
    cleaned ??= { ...record };
    delete cleaned[key];
  }
  return cleaned ?? record;
}

function withoutMatching<T>(items: T[], matches: (item: T) => boolean): T[] {
  const first = items.findIndex(matches);
  if (first === -1) return items;
  const kept = items.slice(0, first);
  for (let index = first + 1; index < items.length; index += 1) {
    if (!matches(items[index]!)) kept.push(items[index]!);
  }
  return kept;
}

/** Whether any dock still draws this tab: a panel, a page, a shell, or a side chat of its own. */
function dockKeeps(docks: Record<string, ThreadDock>, sideChats: SideChat[], tab: string): boolean {
  if (sideChats.some((chat) => chat.id === tab)) return true;
  for (const owner in docks) {
    const dock = docks[owner]!;
    if (dock.panels.includes(tab)
      || dock.browserTabs.some((page) => page.id === tab)
      || dock.terminals.some((terminal) => terminal.id === tab)) return true;
  }
  return false;
}

/** A permanently deleted thread leaves no session-only record holding its data or making it reachable. */
export function pruneDeletedTasks(state: WorkspaceState, removed: Set<string>): WorkspaceState {
  if (!removed.size) return state;
  const history = withoutMatching(state.history, (taskId) => removed.has(taskId));
  let historyIndex = -1;
  for (let index = 0; index <= state.historyIndex && index < state.history.length; index += 1) {
    if (!removed.has(state.history[index]!)) historyIndex += 1;
  }
  const docks = withoutTaskKeys(state.docks, removed);
  const sideChats = withoutMatching(state.sideChats, (chat) => removed.has(chat.id) || removed.has(chat.sourceTaskId));
  return {
    ...state,
    creatingWorktrees: withoutMatching(state.creatingWorktrees, (taskId) => removed.has(taskId)),
    releasingWorktrees: withoutMatching(state.releasingWorktrees, (taskId) => removed.has(taskId)),
    history,
    historyIndex: Math.min(historyIndex, history.length - 1),
    prompts: withoutTaskKeys(state.prompts, removed),
    annotations: withoutTaskKeys(state.annotations, removed),
    pastes: withoutTaskKeys(state.pastes, removed),
    images: withoutTaskKeys(state.images, removed),
    docks,
    diffs: withoutTaskKeys(state.diffs, removed),
    readingPoints: withoutTaskKeys(state.readingPoints, removed),
    pendingRuns: withoutMatchingValues(state.pendingRuns, (pending) => Boolean(pending.taskId && removed.has(pending.taskId))),
    queuedMessages: withoutTaskKeys(state.queuedMessages, removed),
    sideChats,
    lastRunIds: withoutTaskKeys(state.lastRunIds, removed),
    activeRuns: withoutTaskKeys(state.activeRuns, removed),
    runStatuses: withoutTaskKeys(state.runStatuses, removed),
    approvals: withoutMatchingValues(state.approvals, (approval) => removed.has(approval.taskId)),
    streamingTails: withoutTaskKeys(state.streamingTails, removed),
    backgroundProcesses: withoutTaskKeys(state.backgroundProcesses, removed),
    workflows: withoutTaskKeys(state.workflows, removed),
    subagents: withoutTaskKeys(state.subagents, removed),
    automations: withoutMatching(state.automations, (automation) => removed.has(automation.taskId)),
    dockFocus: state.dockFocus && (removed.has(state.dockFocus.owner) || removed.has(state.dockFocus.tab)) ? null : state.dockFocus,
    keyboardTab: state.keyboardTab && dockKeeps(docks, sideChats, state.keyboardTab) ? state.keyboardTab : null,
    browserApproval: state.browserApproval && !removed.has(state.browserApproval.taskId) ? state.browserApproval : null,
  };
}
