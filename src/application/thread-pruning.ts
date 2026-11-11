import { DOCK_PICKER, type ThreadDock } from "./workspace-dock.js";
import type { SideChat, WorkspaceState } from "./workspace-state.js";
import { draftsForgottenIn, composerOf } from "./composer-drafts.js";
import { automationsForgottenIn, automationsOf } from "./workspace-reducer/automations.js";
import { approvalForgottenIn, browserOf } from "./workspace-reducer/browser-tabs.js";
import { docksForgottenIn, docksOf } from "./workspace-reducer/dock-tabs.js";
import { runsForgottenIn, runsOf } from "./workspace-reducer/run-edits.js";
import { sideChatsForgottenIn, sideChatsOf } from "./workspace-reducer/side-chats.js";
import { afterward, type Step } from "./workspace-reducer/slice.js";
import { navigationOf, visitsForgottenIn } from "./workspace-reducer/thread-select.js";
import { checkoutClaimsForgottenIn, worktreesOf } from "./workspace-reducer/worktree-claims.js";

export function withoutThreadKeys<T>(record: Record<string, T>, removed: Set<string>): Record<string, T> {
  let cleaned: Record<string, T> | null = null;
  for (const threadId of removed) {
    if (!Object.hasOwn(record, threadId)) continue;
    cleaned ??= { ...record };
    delete cleaned[threadId];
  }
  return cleaned ?? record;
}

export function withoutMatchingValues<T>(record: Record<string, T>, matches: (value: T) => boolean): Record<string, T> {
  let cleaned: Record<string, T> | null = null;
  for (const key in record) {
    if (!matches(record[key]!)) continue;
    cleaned ??= { ...record };
    delete cleaned[key];
  }
  return cleaned ?? record;
}

export function withoutMatching<T>(items: T[], matches: (item: T) => boolean): T[] {
  const first = items.findIndex(matches);
  if (first === -1) return items;
  const kept = items.slice(0, first);
  for (let index = first + 1; index < items.length; index += 1) {
    if (!matches(items[index]!)) kept.push(items[index]!);
  }
  return kept;
}

/** A deleted thread is no dock's tab, and a dock showing it falls back to the picker. */
export function withoutThreadTabs(docks: Record<string, ThreadDock>, removed: Set<string>): Record<string, ThreadDock> {
  let cleaned: Record<string, ThreadDock> | null = null;
  for (const owner in docks) {
    const dock = docks[owner]!;
    if (!dock.threadTabs.some((id) => removed.has(id))) continue;
    cleaned ??= { ...docks };
    cleaned[owner] = { ...dock, threadTabs: dock.threadTabs.filter((id) => !removed.has(id)), tab: removed.has(dock.tab) ? DOCK_PICKER : dock.tab };
  }
  return cleaned ?? docks;
}

/** Whether any dock still draws this tab: a panel, a page, a shell, a side chat, or a thread. */
export function dockKeeps(docks: Record<string, ThreadDock>, sideChats: SideChat[], tab: string): boolean {
  if (sideChats.some((chat) => chat.id === tab)) return true;
  for (const owner in docks) {
    const dock = docks[owner]!;
    if (dock.panels.includes(tab)
      || dock.browserTabs.some((page) => page.id === tab)
      || dock.terminals.some((terminal) => terminal.id === tab)
      || dock.threadTabs.includes(tab)) return true;
  }
  return false;
}

/**
 * A permanently deleted thread leaves no session-only record holding its data or making it reachable:
 * each owner forgets it in its own state.
 */
export function pruned(state: WorkspaceState, removed: Set<string>): Step {
  if (!removed.size) return {};
  const sideChats = sideChatsForgottenIn(sideChatsOf(state), removed);
  return {
    edits: [
      checkoutClaimsForgottenIn(worktreesOf(state), removed),
      visitsForgottenIn(navigationOf(state), removed),
      draftsForgottenIn(composerOf(state), removed),
      docksForgottenIn(docksOf(state), removed, sideChats.view.sideChats),
      sideChats,
      runsForgottenIn(runsOf(state), removed),
      automationsForgottenIn(automationsOf(state), removed),
      approvalForgottenIn(browserOf(state), removed),
    ],
  };
}

/** {@link pruned}, on the whole state. */
export function pruneDeletedThreads(state: WorkspaceState, removed: Set<string>): WorkspaceState {
  return afterward(state, pruned(state, removed));
}
