import { nextSnoozeExpiry, withoutSnooze } from "../domain/thread-snooze.js";
import type { WorkspaceInput, WorkspaceTransition } from "./workspace-reducer/types.js";
import type { WorkspaceState } from "./workspace-state.js";

/** Deadlines are durable; expiry and the one timer watching them belong to the reducer. */
export function reconcileSnoozes(previous: WorkspaceState, transition: WorkspaceTransition, input: WorkspaceInput): WorkspaceTransition {
  const check = input.type === "snoozes.elapsed" || input.type === "store.loaded" || input.type === "store.absent"
    || input.type === "view.set-focused" && input.focused;
  if (!check && previous.threads === transition.state.threads) return transition;
  const before = nextSnoozeExpiry(previous.threads);
  let next = nextSnoozeExpiry(transition.state.threads);
  if (check && next !== null) {
    const at = input.type === "snoozes.elapsed" ? input.at : Date.now();
    if (next <= at) {
      transition = { ...transition, state: { ...transition.state, threads: transition.state.threads.map((thread) =>
        thread.snoozedUntil !== undefined && thread.snoozedUntil <= at ? withoutSnooze(thread) : thread) } };
      next = nextSnoozeExpiry(transition.state.threads);
    }
  }
  if (next === before && !(check && next !== null)) return transition;
  return { ...transition, effects: [...transition.effects, { type: "schedule-snooze-expiry", at: next }] };
}
