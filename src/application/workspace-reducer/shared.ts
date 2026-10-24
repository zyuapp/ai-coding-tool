/** The plumbing every handler in this folder shares: how a transition is made, and who it is about. */
import type { WorkspaceCommandResult, WorkspaceEffect, WorkspaceTransition } from "./types.js";
import type { WorkspaceState } from "../workspace-state.js";

export function now() {
  return Date.now();
}

export function sameStrings(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function settled(state: WorkspaceState, effects: WorkspaceEffect[] = [], result?: WorkspaceCommandResult): WorkspaceTransition {
  const transition: WorkspaceTransition = { state, effects };
  if (result) transition.result = result;
  return transition;
}

/** Marks effects as follow-ups: work that keeps a view current, which the input does not wait for. */
export function followUps(effects: WorkspaceEffect[]): WorkspaceEffect[] {
  return effects.map((effect) => effect.followUp ? effect : { ...effect, followUp: true });
}

/** A refusal belongs to this transition even when the same message is already on screen. */
export function rejected(state: WorkspaceState, message: string, effects: WorkspaceEffect[] = []): WorkspaceTransition {
  return { state: { ...state, actionError: message }, effects, result: { ok: false, message } };
}

/** A thread's own request turned down: nothing changes, the user is shown nothing, and the reason answers the thread. */
export function declined(state: WorkspaceState, reason: string): WorkspaceTransition {
  return settled(state, [], { ok: true, answer: { recorded: false, reason } });
}

/** A thread's own request carried out, answered with what was recorded. */
export function recorded(transition: WorkspaceTransition, noteId?: string): WorkspaceTransition {
  return { ...transition, result: { ok: true, answer: { recorded: true, ...(noteId ? { noteId } : {}) } } };
}

/** A named thread has to exist; an unnamed command falls back to the one the user is looking at. */
export function targetId(state: WorkspaceState, taskId: string | undefined): string | null {
  if (taskId === undefined) return state.currentId;
  return state.threads.some((thread) => thread.id === taskId) ? taskId : null;
}
