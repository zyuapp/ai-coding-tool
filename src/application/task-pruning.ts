import type { WorkspaceState } from "./workspace-state.js";

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

/** A permanently deleted thread leaves no session-only record holding its data or making it reachable. */
export function pruneDeletedTasks(state: WorkspaceState, removed: Set<string>): WorkspaceState {
  if (!removed.size) return state;
  const history = withoutMatching(state.history, (taskId) => removed.has(taskId));
  let historyIndex = -1;
  for (let index = 0; index <= state.historyIndex && index < state.history.length; index += 1) {
    if (!removed.has(state.history[index]!)) historyIndex += 1;
  }
  const docks = withoutTaskKeys(state.docks, removed);
  let focusedTerminalId = state.focusedTerminalId;
  if (focusedTerminalId) {
    let found = false;
    for (const owner in docks) {
      if (docks[owner]!.terminals.some((terminal) => terminal.id === focusedTerminalId)) {
        found = true;
        break;
      }
    }
    if (!found) focusedTerminalId = null;
  }
  return {
    ...state,
    creatingWorktrees: withoutMatching(state.creatingWorktrees, (taskId) => removed.has(taskId)),
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
    sideChats: withoutMatching(state.sideChats, (chat) => removed.has(chat.id) || removed.has(chat.sourceTaskId)),
    lastRunIds: withoutTaskKeys(state.lastRunIds, removed),
    activeRuns: withoutTaskKeys(state.activeRuns, removed),
    runStatuses: withoutTaskKeys(state.runStatuses, removed),
    approvals: withoutMatchingValues(state.approvals, (approval) => removed.has(approval.taskId)),
    streamingTails: withoutTaskKeys(state.streamingTails, removed),
    backgroundProcesses: withoutTaskKeys(state.backgroundProcesses, removed),
    workflows: withoutTaskKeys(state.workflows, removed),
    automations: withoutMatching(state.automations, (automation) => removed.has(automation.taskId)),
    dockFocus: state.dockFocus && (removed.has(state.dockFocus.owner) || removed.has(state.dockFocus.tab)) ? null : state.dockFocus,
    focusedTerminalId,
    browserApproval: state.browserApproval && !removed.has(state.browserApproval.taskId) ? state.browserApproval : null,
  };
}
