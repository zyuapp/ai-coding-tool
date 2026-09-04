import type { AppCommand } from "../contracts/commands.js";
import { threadActivityAt, type Thread } from "../domain/thread.js";
import { worktreeName } from "../domain/worktree.js";
import { locationOf, projectFor, worktreeFor } from "./thread-location.js";
import type { WorkspaceState } from "./workspace-state.js";

export const WORKTREE_MENU = "session:location";
export type WorktreeMenuList = "threads" | "destinations";
export type WorktreeMenuSearch = Record<WorktreeMenuList, string>;
export type WorktreeMenuChoice = { id: string; title: string; detail: string; current?: boolean; disabled?: boolean; command: AppCommand };

function status(thread: Thread, busy: Set<string>, blocked: Set<string>) {
  if (blocked.has(thread.id)) return "Needs input";
  if (busy.has(thread.id)) return "Working";
  if (thread.outcome === "failed") return "Failed";
  if (thread.outcome === "stopped") return "Stopped";
  if (thread.outcome === "finished") return "Done";
  return "Idle";
}

/** Local has no thread list. Worktree membership is independent of Priority and dismissal. */
export function worktreeMenuView(state: WorkspaceState, current: Thread | undefined, visible: Thread[], busy: Set<string>, blocked: Set<string>) {
  const project = projectFor(state, current);
  if (!current || !project) return null;
  const worktree = worktreeFor(state, current);
  const members = worktree ? visible.filter((thread) => thread.worktreeId === worktree.id) : [];
  const search = state.worktreeMenuSearch;
  const open = state.openMenu === WORKTREE_MENU;
  const threadQuery = search.threads.trim().toLocaleLowerCase();
  const threads: WorktreeMenuChoice[] = [];
  if (open) {
    const matching = members.filter((thread) => thread.title.toLocaleLowerCase().includes(threadQuery));
    matching.sort((a, b) => Number(b.id === current.id) - Number(a.id === current.id) || threadActivityAt(b) - threadActivityAt(a));
    for (const thread of matching) threads.push({ id: thread.id, title: thread.title, detail: thread.id === current.id ? "Current thread" : status(thread, busy, blocked), current: thread.id === current.id, command: { type: "task.select", taskId: thread.id } });
  }
  const managed = new Map(state.managedWorktrees?.map((item) => [item.root, item]));
  const deleting = new Set(state.deletingWorktrees);
  const releasing = new Set(state.releasingWorktrees);
  const releasingCheckouts = new Set<string>();
  for (const thread of state.threads) if (thread.worktreeId && releasing.has(thread.id)) releasingCheckouts.add(thread.worktreeId);
  const destinations: WorktreeMenuChoice[] = [];
  if (open) {
    const query = search.destinations.trim().toLocaleLowerCase();
    const checkouts = state.worktrees.filter((item) => item.projectId === project.id && item.id !== current.worktreeId).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    for (const checkout of checkouts) {
      const record = managed.get(checkout.root);
      const environment = state.environments[checkout.workspaceId];
      const name = worktreeName(checkout);
      let branch = record ? record.branch ?? "Detached" : "Branch not loaded";
      if (environment?.status === "available") branch = environment.branch ?? "Detached";
      if (!`${name} ${branch}`.toLocaleLowerCase().includes(query)) continue;
      const missing = state.managedWorktrees !== null && !record;
      const removing = deleting.has(checkout.root) || releasingCheckouts.has(checkout.id);
      if (missing) branch = "Folder missing";
      else if (record?.repository === null) branch = "Repository unavailable";
      else if (removing) branch = "Deleting…";
      destinations.push({ id: checkout.id, title: name, detail: branch, disabled: state.worktreeManagementLoading || missing || removing || record?.repository === null || busy.has(current.id), command: { type: "task.move-worktree", taskId: current.id, destination: { kind: "worktree", id: checkout.id } } });
    }
  }
  const busyCount = worktree ? state.threads.filter((thread) => thread.worktreeId === worktree.id && busy.has(thread.id)).length : 0;
  return {
    threadId: current.id,
    projectId: project.id,
    location: locationOf(state, current),
    worktreeId: worktree?.id,
    count: members.length,
    threads,
    destinations,
    search,
    canMove: !busy.has(current.id) && Boolean(project.workspaceId),
    deleteRoot: worktree?.root ?? null,
    busyCount,
    canDelete: Boolean(worktree && !busyCount && !deleting.has(worktree.root) && !releasingCheckouts.has(worktree.id)),
    loading: state.worktreeManagementLoading,
    error: state.worktreeManagementError,
  };
}

export type WorktreeMenuView = NonNullable<ReturnType<typeof worktreeMenuView>>;
