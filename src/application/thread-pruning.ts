import type { SideChat, ThreadDock, WorkspaceState } from "./workspace-state.js";

function withoutThreadKeys<T>(record: Record<string, T>, removed: Set<string>): Record<string, T> {
  let cleaned: Record<string, T> | null = null;
  for (const threadId of removed) {
    if (!Object.hasOwn(record, threadId)) continue;
    cleaned ??= { ...record };
    delete cleaned[threadId];
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
export function pruneDeletedThreads(state: WorkspaceState, removed: Set<string>): WorkspaceState {
  if (!removed.size) return state;
  const history = withoutMatching(state.history, (threadId) => removed.has(threadId));
  let historyIndex = -1;
  for (let index = 0; index <= state.historyIndex && index < state.history.length; index += 1) {
    if (!removed.has(state.history[index]!)) historyIndex += 1;
  }
  const docks = withoutThreadKeys(state.docks, removed);
  const sideChats = withoutMatching(state.sideChats, (chat) => removed.has(chat.id) || removed.has(chat.sourceThreadId));
  return {
    ...state,
    creatingWorktrees: withoutMatching(state.creatingWorktrees, (threadId) => removed.has(threadId)),
    releasingWorktrees: withoutMatching(state.releasingWorktrees, (threadId) => removed.has(threadId)),
    history,
    historyIndex: Math.min(historyIndex, history.length - 1),
    prompts: withoutThreadKeys(state.prompts, removed),
    annotations: withoutThreadKeys(state.annotations, removed),
    pastes: withoutThreadKeys(state.pastes, removed),
    images: withoutThreadKeys(state.images, removed),
    docks,
    diffs: withoutThreadKeys(state.diffs, removed),
    readingPoints: withoutThreadKeys(state.readingPoints, removed),
    pendingRuns: withoutMatchingValues(state.pendingRuns, (pending) => Boolean(pending.taskId && removed.has(pending.taskId))),
    queuedMessages: withoutThreadKeys(state.queuedMessages, removed),
    sideChats,
    lastRunIds: withoutThreadKeys(state.lastRunIds, removed),
    activeRuns: withoutThreadKeys(state.activeRuns, removed),
    runStatuses: withoutThreadKeys(state.runStatuses, removed),
    approvals: withoutMatchingValues(state.approvals, (approval) => removed.has(approval.taskId)),
    streamingTails: withoutThreadKeys(state.streamingTails, removed),
    backgroundProcesses: withoutThreadKeys(state.backgroundProcesses, removed),
    workflows: withoutThreadKeys(state.workflows, removed),
    subagents: withoutThreadKeys(state.subagents, removed),
    automations: withoutMatching(state.automations, (automation) => removed.has(automation.taskId)),
    dockFocus: state.dockFocus && (removed.has(state.dockFocus.owner) || removed.has(state.dockFocus.tab)) ? null : state.dockFocus,
    keyboardTab: state.keyboardTab && dockKeeps(docks, sideChats, state.keyboardTab) ? state.keyboardTab : null,
    browserApproval: state.browserApproval && !removed.has(state.browserApproval.taskId) ? state.browserApproval : null,
  };
}
