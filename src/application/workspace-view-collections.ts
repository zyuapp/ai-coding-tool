import type { AutomationView } from "../domain/automation.js";
import type { Thread } from "../domain/thread.js";
import { remoteCollections, type PairedComputer } from "./computers.js";
import type { Project } from "../domain/project.js";
import { orderProjects } from "./project-order.js";
import type { ComputerLink } from "../domain/computers.js";
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
    state.activeRuns, state.pendingRuns, state.creatingWorktrees, state.releasingWorktrees, state.deletingWorktrees, state.workflows,
    state.deletingWorktrees.length ? state.threads : null,
    state.deletingWorktrees.length ? state.worktrees : null,
  ],
  busyThreadIds,
  sameIds,
);

const blocked = selector((state) => [state.activeRuns], blockedThreadIds, sameIds);

/** The paired computers' threads, gathered once per change to any of them. */
const remote = selector(
  (state) => [state.computers.paired, state.computers.filter],
  (state) => remoteCollections(state.computers),
);

function linkOf({ id, name, host, status, error, pairedAt }: PairedComputer): ComputerLink {
  return { id, name, host, status, error, pairedAt };
}

function sameLinks(before: ComputerLink[], next: ComputerLink[]) {
  return before.length === next.length && before.every((link, index) => {
    const other = next[index]!;
    return link.id === other.id && link.name === other.name && link.host === other.host && link.status === other.status && link.error === other.error;
  });
}

/** The paired computers without their states, which the chrome draws and which move only when a line does. */
const links = selector((state) => [state.computers.paired], (state) => state.computers.paired.map(linkOf), sameLinks);

function union(own: Set<string>, others: Set<string>) {
  if (!others.size) return own;
  return new Set([...own, ...others]);
}

/** Every computer's running and blocked threads together, which is what the rows of a merged list read. */
const everyBusy = selector((state) => [busy(state), remote(state)], (state) => union(busy(state), remote(state).busy), sameIds);
const everyBlocked = selector((state) => [blocked(state), remote(state)], (state) => union(blocked(state), remote(state).blocked), sameIds);

/** The sidebar draws every computer's threads together, filed under every computer's folders. */
const sidebar = selector(
  (state) => [threadLists(state).visibleThreads, state.projects, everyBusy(state), everyBlocked(state), remote(state), state.sidebarMode, state.sections, state.expandedProjects],
  (state) => {
    const others = remote(state);
    /** A filter naming one paired computer leaves this computer's own out. */
    const own = state.computers.filter === "all" || state.computers.filter === "this";
    const projects = others.projects.length ? [...(own ? state.projects : []), ...others.projects] : own ? state.projects : [];
    const visible = own ? threadLists(state).visibleThreads : [];
    const threads = others.threads.length ? [...visible, ...others.threads] : visible;
    return sidebarLists(state, projects, threads, everyBusy(state), everyBlocked(state));
  },
);

/**
 * Every computer's projects, this one's first, for a draft to start in. The sidebar's filter narrows
 * what is listed, never where a thread may begin, so the draft's own project is always among these.
 * A computer whose line is down takes no thread, so its projects wait with it.
 */
const startProjects = selector(
  (state) => [state.projects, state.computers.paired],
  (state) => {
    const own = orderProjects(state.projects);
    const others: Project[] = [];
    for (const computer of state.computers.paired) if (computer.state && computer.status === "connected") others.push(...orderProjects(computer.state.projects));
    return others.length ? [...own, ...others] : own;
  },
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
  (state) => [state.threads, state.sideChats, remote(state)],
  (state) => {
    const own = unreadView(state, threadLists(state).listedThreads);
    return { ...own, unreadCount: own.unreadCount + remote(state).unreadCount };
  },
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
    startProjects: startProjects(state),
    busy: busy(state),
    blocked: blocked(state),
    everyBusy: everyBusy(state),
    everyBlocked: everyBlocked(state),
    remote: remote(state),
    computerLinks: links(state),
    managedWorktrees: managed(state),
    worktreeSettings: settings(state),
    worktreeGroups: groups(state),
    schedules: schedules(state),
  };
}
