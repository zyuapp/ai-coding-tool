import type { OverviewFolds } from "../../domain/coordination.js";
import type { DiffState } from "../workspace-diff.js";
import type { ThreadDock } from "../workspace-dock.js";

/** Each thread's dock, its reviews, and which view in it has the keys. */
export type DocksState = {
  /** Per coordinator, how the user left the groups of its Overview. Not kept across launches. */
  overviewFolds: Record<string, OverviewFolds>;
  /**
   * The dock view that last asked for the keyboard: whose dock it is in, which tab, and a count
   * bumped each time one asks. A view takes the keys when the count it is drawn with changes.
   */
  dockFocus: { owner: string; tab: string; count: number } | null;
  /** One dock per thread, keyed by thread id, so moving between threads leaves each one as it was. */
  docks: Record<string, ThreadDock>;
  /** One review per thread, keyed the way `docks` is, so each thread keeps its own place in a diff. */
  diffs: Record<string, DiffState>;
  /** Which dock tab the keyboard is in, so ⌘F knows whether it means that view or the thread. */
  keyboardTab: string | null;
};

export function initialDocksState(): DocksState {
  return { overviewFolds: {}, dockFocus: null, docks: {}, diffs: {}, keyboardTab: null };
}
