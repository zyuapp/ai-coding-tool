/** What the store hands back for one thread, whether it could be read or written, and what failed on the way out. */
import { historyLoadedIn, threadsOf } from "./thread-edits.js";
import type { WorkspaceInput } from "./types.js";
import type { SliceTransition } from "./slice.js";
import type { StoreState } from "../state/store.js";
import type { WorkspaceState } from "../workspace-state.js";

export const STORE_INPUTS = ["store.thread-loaded", "store.absent", "store.persisted", "store.failed", "action.failed"] as const;
type StoreInput = Extract<WorkspaceInput, { type: (typeof STORE_INPUTS)[number] }>;

export function reduceStore(state: WorkspaceState, input: StoreInput): SliceTransition<StoreState> {
  switch (input.type) {
    case "store.thread-loaded": {
      const thread = state.threads.find((item) => item.id === input.taskId);
      if (!thread?.historySummary) return {};
      return { edits: [historyLoadedIn(threadsOf(state), input.taskId, input.messages)] };
    }

    case "store.absent":
      return { patch: { restored: true } };

    case "store.persisted":
      return { patch: { writable: true, storageError: null } };

    case "store.failed":
      return { patch: { writable: false, storageError: input.message, restored: true } };

    case "action.failed":
      return { error: { message: input.message, page: input.page ?? null }, refusal: input.message };
  }
}

/** The note about threads this build cannot read, put away by the user. */
export function reduceHiddenThreadsDismissed(_state: StoreState): SliceTransition<StoreState> {
  return { patch: { hiddenThreads: 0 } };
}
