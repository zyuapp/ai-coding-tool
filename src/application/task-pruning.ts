import type { WorkspaceState } from "./workspace-state.js";

function withoutTaskKeys<T>(record: Record<string, T>, removed: Set<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([taskId]) => !removed.has(taskId)));
}

/** A permanently deleted thread leaves no session-only record holding its data or making it reachable. */
export function pruneDeletedTasks(state: WorkspaceState, removed: Set<string>): WorkspaceState {
  if (!removed.size) return state;
  const history = state.history.filter((taskId) => !removed.has(taskId));
  const historyIndex = state.history
    .slice(0, state.historyIndex + 1)
    .filter((taskId) => !removed.has(taskId)).length - 1;
  const docks = withoutTaskKeys(state.docks, removed);
  const focusedTerminalId = state.focusedTerminalId
    && Object.values(docks).some((dock) => dock.terminals.some((terminal) => terminal.id === state.focusedTerminalId))
    ? state.focusedTerminalId
    : null;
  return {
    ...state,
    creatingWorktrees: state.creatingWorktrees.filter((taskId) => !removed.has(taskId)),
    history,
    historyIndex: Math.min(historyIndex, history.length - 1),
    prompts: withoutTaskKeys(state.prompts, removed),
    annotations: withoutTaskKeys(state.annotations, removed),
    pastes: withoutTaskKeys(state.pastes, removed),
    images: withoutTaskKeys(state.images, removed),
    docks,
    diffs: withoutTaskKeys(state.diffs, removed),
    readingPoints: withoutTaskKeys(state.readingPoints, removed),
    pendingRuns: Object.fromEntries(Object.entries(state.pendingRuns).filter(([, pending]) => !pending.taskId || !removed.has(pending.taskId))),
    queuedMessages: withoutTaskKeys(state.queuedMessages, removed),
    sideChats: state.sideChats.filter((chat) => !removed.has(chat.id) && !removed.has(chat.sourceTaskId)),
    lastRunIds: withoutTaskKeys(state.lastRunIds, removed),
    activeRuns: withoutTaskKeys(state.activeRuns, removed),
    runStatuses: withoutTaskKeys(state.runStatuses, removed),
    approvals: Object.fromEntries(Object.entries(state.approvals).filter(([, approval]) => !removed.has(approval.taskId))),
    streamingTails: withoutTaskKeys(state.streamingTails, removed),
    backgroundProcesses: withoutTaskKeys(state.backgroundProcesses, removed),
    workflows: withoutTaskKeys(state.workflows, removed),
    automations: state.automations.filter((automation) => !removed.has(automation.taskId)),
    dockFocus: state.dockFocus && (removed.has(state.dockFocus.owner) || removed.has(state.dockFocus.tab)) ? null : state.dockFocus,
    focusedTerminalId,
    browserApproval: state.browserApproval && !removed.has(state.browserApproval.taskId) ? state.browserApproval : null,
  };
}
