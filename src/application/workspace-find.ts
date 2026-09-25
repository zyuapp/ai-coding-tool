/**
 * The find bar as it is drawn. A thread is counted here, because its messages are in the state; every
 * other view counts its own matches and reports them back.
 */
import { memoizedFindHits, searchesItself, type FindHit, type FindTarget } from "../domain/find.js";
import { selectedComputer, NO_COMPUTERS } from "./computers.js";
import { DIFF_PANEL, frontDock, dockTabKind } from "./workspace-dock.js";
import type { ShortcutSurface } from "../domain/shortcuts.js";
import type { Thread } from "../domain/thread.js";
import type { FindState, WorkspaceState } from "./workspace-state.js";

export type FindView = FindState & { matches: number; counting: boolean; hit: FindHit | null };

export function findView(state: WorkspaceState, currentThread: Thread | undefined): FindView | null {
  const find = state.find;
  if (!find) return null;
  const target = find.target;
  if (target.kind === "thread") {
    /** A side chat is a thread like any other, so naming it is all the same search needs. */
    const thread = target.taskId === (currentThread?.id ?? null)
      ? currentThread
      : state.threads.find((item) => item.id === target.taskId);
    const hits = memoizedFindHits(thread?.messages ?? [], find.query);
    const index = hits.length ? Math.min(find.index, hits.length - 1) : 0;
    return { ...find, index, matches: hits.length, counting: false, hit: hits[index] ?? null };
  }
  const reported = state.findResults;
  const matches = reported?.matches ?? 0;
  if (searchesItself(find.target)) {
    return { ...find, matches, index: reported?.index ?? 0, counting: false, hit: null };
  }
  /** Nothing reported yet is a view still counting, not a view that found nothing. */
  const counting = reported ? reported.counting ?? false : find.query.trim().length > 0;
  return { ...find, matches, index: matches ? Math.min(find.index, matches - 1) : 0, counting, hit: null };
}

/**
 * What ⌘F searches: the page when the keystroke came from one and the dock is showing it, else the
 * dock view holding the keys — a shell, a side chat's thread, the review, a panel — else the thread
 * being read. A keystroke is the only thing that knows about the page, because a page swallows it.
 */
export function findTargetFor(state: WorkspaceState, surface: ShortcutSurface): FindTarget {
  const remote = selectedComputer(state)?.state;
  if (remote) return findTargetFor({ ...remote, computers: NO_COMPUTERS }, surface);
  const { owner, dock } = frontDock(state);
  /** The page holding the keys is the one the dock is showing, which a run's page never is. */
  const page = dock.browserTabs.find((tab) => tab.id === dock.tab);
  if (surface === "browser" && page) return { kind: "browser", tabId: page.id };
  const thread: FindTarget = { kind: "thread", taskId: state.currentId };
  const tab = state.keyboardTab;
  if (!tab) return thread;
  switch (dockTabKind(state, owner, tab)) {
    case "browser": return { kind: "browser", tabId: tab };
    case "terminal": return { kind: "terminal", terminalId: tab };
    case "side-chat":
    case "thread": return { kind: "thread", taskId: tab };
    case "panel": return tab === DIFF_PANEL ? { kind: "review", owner } : { kind: "panel", owner, panel: tab };
    case "picker": return thread;
  }
}
