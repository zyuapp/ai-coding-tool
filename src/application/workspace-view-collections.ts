import type { AutomationView } from "../domain/automation.js";
import type { Thread } from "../domain/thread.js";
import { sidebarLists } from "./sidebar-lists.js";
import { unreadView } from "./thread-attention.js";
import { busyThreadIds, blockedThreadIds, sideChatIds, type WorkspaceState, type WorktreeGroup } from "./workspace-state.js";
import { worktreeSettingsPage, worktreeSettingsViews } from "./worktree-settings.js";

/** A selector retains one projection while its immutable input references stay unchanged. */
function selector<Value>(
  inputs: (state: WorkspaceState) => readonly unknown[],
  project: (state: WorkspaceState) => Value,
  equal?: (before: Value, next: Value) => boolean,
) {
  let held: { inputs: readonly unknown[]; value: Value } | undefined;
  return (state: WorkspaceState): Value => {
    const nextInputs = inputs(state);
    const previous = held;
    if (previous && nextInputs.every((value, index) => value === previous.inputs[index])) return previous.value;
    let value = project(state);
    if (held && equal?.(held.value, value)) value = held.value;
    held = { inputs: nextInputs, value };
    return value;
  };
}

function sameIds(before: Set<string>, next: Set<string>) {
  return before.size === next.size && [...next].every((id) => before.has(id));
}

const threadLists = selector(
  (state) => [state.threads, state.sideChats],
  (state) => {
    const forked = sideChatIds(state);
    const listedThreads = state.sideChats.length ? state.threads.filter((thread) => !forked.has(thread.id)) : state.threads;
    const visibleThreads: Thread[] = [];
    const archivedThreads: Thread[] = [];
    const worktreeThreadIds = new Set<string>();
    for (const thread of listedThreads) {
      if (thread.archivedAt === undefined) visibleThreads.push(thread);
      else archivedThreads.push(thread);
      if (thread.worktreeId) worktreeThreadIds.add(thread.id);
    }
    archivedThreads.sort((left, right) => right.archivedAt! - left.archivedAt!);
    return { listedThreads, visibleThreads, archivedThreads, worktreeThreadIds };
  },
);

const busy = selector(
  (state) => [
    state.activeRuns, state.pendingRuns, state.creatingWorktrees, state.releasingWorktrees, state.deletingWorktrees,
    state.deletingWorktrees.length ? state.threads : null,
    state.deletingWorktrees.length ? state.worktrees : null,
  ],
  busyThreadIds,
  sameIds,
);

const blocked = selector((state) => [state.activeRuns], blockedThreadIds, sameIds);

const sidebar = selector(
  (state) => [threadLists(state).visibleThreads, state.projects, busy(state), blocked(state), state.sidebarMode, state.sections, state.expandedProjects],
  (state) => sidebarLists(state, state.projects, threadLists(state).visibleThreads, busy(state), blocked(state)),
);

const managed = selector(
  (state) => [state.managedWorktrees, state.projects, state.worktrees, state.threads, state.deletingWorktrees, state.releasingWorktrees, busy(state)],
  (state) => worktreeSettingsViews(state, busy(state)),
);

const settings = selector(
  (state) => [managed(state), state.projects, state.worktreeSettings, state.worktreeManagementLoading],
  (state) => worktreeSettingsPage(state, managed(state)),
);

const groups = selector(
  (state) => [sidebar(state).orderedThreads, state.worktrees],
  (state) => {
    const byWorktree = new Map<string, Thread[]>();
    for (const thread of sidebar(state).orderedThreads) {
      if (!thread.worktreeId) continue;
      let threads = byWorktree.get(thread.worktreeId);
      if (!threads) {
        threads = [];
        byWorktree.set(thread.worktreeId, threads);
      }
      threads.push(thread);
    }
    return state.worktrees.map((worktree): WorktreeGroup => ({ worktree, threads: byWorktree.get(worktree.id) ?? [] }));
  },
);

const attention = selector(
  (state) => [state.threads, state.sideChats],
  (state) => unreadView(state, threadLists(state).listedThreads),
);

const schedules = selector(
  (state) => [state.automations],
  (state) => new Map<string, AutomationView>(state.automations.map((automation) => [automation.taskId, automation])),
);

/** Workspace-wide collections do not rebuild when only a composer, streaming tail, or panel changes. */
export function workspaceViewCollections(state: WorkspaceState) {
  return {
    ...threadLists(state),
    ...attention(state),
    lists: sidebar(state),
    busy: busy(state),
    blocked: blocked(state),
    managedWorktrees: managed(state),
    worktreeSettings: settings(state),
    worktreeGroups: groups(state),
    schedules: schedules(state),
  };
}
