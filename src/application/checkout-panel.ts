import type { Thread } from "../domain/thread.js";
import { threadActivityAt } from "../domain/thread.js";
import { worktreeName, type WorktreeDestination } from "../domain/worktree.js";
import { locationOf, projectFor, worktreeFor } from "./thread-location.js";
import type { WorkspaceState } from "./workspace-state.js";

export type CheckoutPanelState = {
  open: boolean;
  mode: "threads" | "move";
  query: string;
  destination: WorktreeDestination | null;
};

export const EMPTY_CHECKOUT_PANEL: CheckoutPanelState = { open: false, mode: "threads", query: "", destination: null };

export type CheckoutThread = {
  id: string;
  title: string;
  engine: Thread["engine"];
  current: boolean;
  status: "Needs input" | "Working" | "Failed" | "Stopped" | "Done" | "Idle";
};

export type CheckoutDestination = {
  id: string;
  destination: WorktreeDestination;
  name: string;
  branch: string;
  disabled: boolean;
  selected: boolean;
};

export type CheckoutPanelView = CheckoutPanelState & {
  threadId: string;
  projectId: string;
  worktreeId?: string;
  name: string;
  root: string;
  transition: string | null;
  threadCount: number;
  threads: CheckoutThread[];
  destinations: CheckoutDestination[];
  canMove: boolean;
  canConfirm: boolean;
  deleteRoot: string | null;
  busyCount: number;
  deleteDisabled: boolean;
  loading: boolean;
  error: string | null;
};

function threadStatus(thread: Thread, busy: Set<string>, blocked: Set<string>): CheckoutThread["status"] {
  if (blocked.has(thread.id)) return "Needs input";
  if (busy.has(thread.id)) return "Working";
  if (thread.outcome === "failed") return "Failed";
  if (thread.outcome === "stopped") return "Stopped";
  if (thread.outcome === "finished") return "Done";
  return "Idle";
}

/** Membership comes from all visible conversations, independently of Priority and dismissal. */
export function checkoutPanelView(state: WorkspaceState, current: Thread | undefined, visible: Thread[], busy: Set<string>, blocked: Set<string>): CheckoutPanelView | null {
  const project = projectFor(state, current);
  if (!current || !project) return null;
  const worktree = worktreeFor(state, current);
  const location = locationOf(state, current);
  const panel = state.checkoutPanel;
  const query = panel.query.trim().toLocaleLowerCase();
  const byCheckout = new Map<string, Thread[]>();
  for (const thread of visible) {
    if (thread.projectId !== project.id) continue;
    const key = thread.worktreeId ?? "local";
    const members = byCheckout.get(key);
    if (members) members.push(thread);
    else byCheckout.set(key, [thread]);
  }
  const members = byCheckout.get(current.worktreeId ?? "local") ?? [];
  const managed = new Map(state.managedWorktrees?.map((item) => [item.root, item]));
  const deleting = new Set(state.deletingWorktrees);
  const releasing = new Set(state.releasingWorktrees);
  const releasingCheckouts = new Set<string>();
  for (const thread of state.threads) {
    if (thread.worktreeId && releasing.has(thread.id)) releasingCheckouts.add(thread.worktreeId);
  }
  const selected = panel.destination;
  const destinations: CheckoutDestination[] = [];
  if (panel.mode === "move" && current.worktreeId) {
    const environment = project.workspaceId ? state.environments[project.workspaceId] : undefined;
    const branch = environment?.status === "available" ? environment.branch ?? "Detached" : "Project checkout";
    const local = byCheckout.get("local") ?? [];
    if (["Local", branch, ...local.map((thread) => thread.title)].some((text) => text.toLocaleLowerCase().includes(query))) {
      destinations.push({ id: "local", destination: { kind: "local" }, name: "Local", branch, disabled: !project.workspaceId, selected: selected?.kind === "local" });
    }
  }
  const checkouts = panel.mode === "move" ? state.worktrees.filter((item) => item.projectId === project.id && item.id !== current.worktreeId) : [];
  checkouts.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  for (const checkout of checkouts) {
    const record = managed.get(checkout.root);
    const environment = state.environments[checkout.workspaceId];
    let branch = record ? record.branch ?? "Detached" : "Branch not loaded";
    if (environment?.status === "available") branch = environment.branch ?? "Detached";
    const name = worktreeName(checkout);
    const linked = byCheckout.get(checkout.id) ?? [];
    if (![name, branch, ...linked.map((thread) => thread.title)].some((text) => text.toLocaleLowerCase().includes(query))) continue;
    const missing = state.managedWorktrees !== null && !record;
    const removing = deleting.has(checkout.root) || releasingCheckouts.has(checkout.id);
    const disabled = removing || missing || record?.repository === null;
    if (missing) branch = "Folder missing";
    else if (record?.repository === null) branch = "Repository unavailable";
    else if (removing) branch = "Deleting…";
    destinations.push({ id: checkout.id, destination: { kind: "worktree", id: checkout.id }, name, branch, disabled, selected: selected?.kind === "worktree" && selected.id === checkout.id });
  }
  const canMove = !busy.has(current.id) && Boolean(project.workspaceId);
  const busyCount = state.threads.filter((thread) => thread.worktreeId === current.worktreeId && thread.projectId === project.id && busy.has(thread.id)).length;
  let transition: string | null = null;
  if (location.kind === "creating") transition = "Creating worktree…";
  if (location.kind === "releasing") transition = "Removing worktree…";
  const threads = panel.open && panel.mode === "threads" ? members.filter((thread) => thread.title.toLocaleLowerCase().includes(query)) : [];
  threads.sort((a, b) => Number(b.id === current.id) - Number(a.id === current.id) || Number(busy.has(b.id)) - Number(busy.has(a.id)) || threadActivityAt(b) - threadActivityAt(a));
  return {
    ...panel,
    threadId: current.id,
    projectId: project.id,
    worktreeId: current.worktreeId,
    name: worktree ? worktreeName(worktree) : "Local",
    root: worktree?.root ?? project.root,
    transition,
    threadCount: members.length,
    threads: threads.map((thread) => ({ id: thread.id, title: thread.title, engine: thread.engine, current: thread.id === current.id, status: threadStatus(thread, busy, blocked) })),
    destinations,
    canMove,
    canConfirm: canMove && !state.worktreeManagementLoading && Boolean(selected && (selected.kind === "new" || destinations.some((item) => item.selected && !item.disabled))),
    deleteRoot: worktree?.root ?? null,
    busyCount,
    deleteDisabled: busyCount > 0 || Boolean(worktree && deleting.has(worktree.root)),
    loading: state.worktreeManagementLoading,
    error: state.worktreeManagementError,
  };
}
