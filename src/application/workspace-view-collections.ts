import type { AutomationView } from "../domain/automation.js";
import type { Thread } from "../domain/thread.js";
import { remoteCollections, type PairedComputer } from "./computers.js";
import type { Project } from "../domain/project.js";
import { orderProjects } from "./project-order.js";
import type { ComputerLink } from "../domain/computers.js";
import { sidebarLists } from "./sidebar-lists.js";
import { coordinationView } from "./coordination.js";
import { memberPullRequestsView } from "./pull-request-view.js";
import { memberWorktreesView } from "./member-worktrees.js";
import { isCoordinator } from "../domain/coordination.js";
import type { WorkspaceState, WorktreeGroup } from "./workspace-state.js";
import { threadActivity, threadLists } from "./thread-activity.js";
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

/** Each of this computer's activity sets, kept by identity while its members stay the same. */
const busy = selector((state) => [threadActivity(state).working], (state) => threadActivity(state).working, sameIds);
const blocked = selector((state) => [threadActivity(state).blocked], (state) => threadActivity(state).blocked, sameIds);
const ranked = selector((state) => [threadActivity(state).ranked], (state) => threadActivity(state).ranked, sameIds);

/** The threads that can take others under them, for the menu that moves a thread under one. */
const coordinators = selector((state) => [threadLists(state).listedThreads], (state) => threadLists(state).listedThreads.filter((thread) => isCoordinator(thread)));

/** What the open thread shows: a coordinator's threads and open decisions, or a thread's coordinator and brief. */
const coordination = selector(
  (state) => [state.threads, state.currentId, busy(state), blocked(state)],
  (state) => coordinationView(state.threads, state.threads.find((thread) => thread.id === state.currentId), busy(state), blocked(state)),
);

/** The pull requests the open coordinator's threads work on. */
const memberPullRequests = selector(
  (state) => [state.threads, state.currentId, state.projects, state.worktrees, state.environments, state.memberPullRequests],
  (state) => {
    const current = state.threads.find((thread) => thread.id === state.currentId);
    return memberPullRequestsView(state, isCoordinator(current) ? current : undefined);
  },
);

/** The checkouts the open coordinator's threads work in, which its panel offers to clean up. */
const memberWorktrees = selector(
  (state) => [state.threads, state.currentId, state.worktrees, state.environments, state.managedWorktrees, state.deletingWorktrees, state.releasingWorktrees, busy(state)],
  (state) => {
    const current = state.threads.find((thread) => thread.id === state.currentId);
    return memberWorktreesView(state, isCoordinator(current) ? current : undefined, busy(state));
  },
);

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
/** What the activity list ranks as running: every busy thread, and every thread a live watch holds between its ticks. */
const everyRanked = selector((state) => [ranked(state), remote(state)], (state) => union(ranked(state), remote(state).ranked), sameIds);
const everyBlocked = selector((state) => [blocked(state), remote(state)], (state) => union(blocked(state), remote(state).blocked), sameIds);
const everyWorktree = selector((state) => [threadLists(state).worktreeThreadIds, remote(state)], (state) => union(threadLists(state).worktreeThreadIds, remote(state).worktreeThreadIds), sameIds);

/** The sidebar draws every computer's threads together, filed under every computer's folders. */
const sidebar = selector(
  (state) => [threadLists(state).visibleThreads, state.projects, everyRanked(state), everyBlocked(state), remote(state), state.computers.filter, state.sidebarMode, state.sections, state.expandedProjects],
  (state) => {
    const others = remote(state);
    /** A filter naming one paired computer leaves this computer's own out. */
    const own = state.computers.filter === "all" || state.computers.filter === "this";
    const projects = others.projects.length ? [...(own ? state.projects : []), ...others.projects] : own ? state.projects : [];
    const visible = own ? threadLists(state).visibleThreads : [];
    const threads = others.threads.length ? [...visible, ...others.threads] : visible;
    return sidebarLists(state, projects, threads, everyRanked(state), everyBlocked(state), others.projectHosts);
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
    for (const computer of state.computers.paired) {
      const shown = computer.state;
      if (shown && computer.status === "connected") others.push(...orderProjects(shown.projects.filter((project) => !project.unlisted || project.id === shown.draftProjectId)));
    }
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
  (state) => [sidebar(state).orderedThreads, state.worktrees, remote(state)],
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
    return [...state.worktrees, ...remote(state).worktrees].map((worktree): WorktreeGroup => ({ worktree, threads: byWorktree.get(worktree.id) ?? [] }));
  },
);


const schedules = selector(
  (state) => [state.automations],
  (state) => new Map<string, AutomationView>(state.automations.map((automation) => [automation.taskId, automation])),
);

/** Workspace-wide collections do not rebuild when only a composer, streaming tail, or panel changes. */
export function workspaceViewCollections(state: WorkspaceState) {
  const lists = threadLists(state);
  return {
    listedThreads: lists.listedThreads,
    visibleThreads: lists.visibleThreads,
    archivedThreads: lists.archivedThreads,
    worktreeThreadIds: everyWorktree(state),
    sideChatAttention: lists.sideChatAttention,
    unreadCount: lists.unreadCount + remote(state).unreadCount,
    lists: sidebar(state),
    startProjects: startProjects(state),
    busy: busy(state),
    blocked: blocked(state),
    everyBusy: everyBusy(state),
    everyRanked: everyRanked(state),
    everyBlocked: everyBlocked(state),
    remote: remote(state),
    computerLinks: links(state),
    managedWorktrees: managed(state),
    worktreeSettings: settings(state),
    worktreeGroups: groups(state),
    schedules: schedules(state),
    coordinators: coordinators(state),
    coordination: coordination(state),
    memberPullRequests: memberPullRequests(state),
    memberWorktrees: memberWorktrees(state),
  };
}
