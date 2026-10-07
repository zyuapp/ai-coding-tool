/**
 * The cards in the window's corner. Each one schedules its own leaving as it arrives, unless it waits
 * for the user, and the user can close any of them sooner.
 */
import { MAX_REMEMBERED_TOASTS, MAX_TOASTS, TOAST_LIFETIME_MS, type Toast } from "../domain/toast.js";
import { viewPreferences } from "./view-preferences.js";
import type { WorkspaceEffect, WorkspaceInput, WorkspaceTransition } from "./workspace-reducer/types.js";
import type { WorkspaceState } from "./workspace-state.js";

type ToastInput = Extract<WorkspaceInput, { type: "view.dismiss-toast" | "app.launched" }>;

export type ToastEffect = Extract<WorkspaceEffect, { type: "schedule-toast-dismissal" }>;

/** When a toast leaves on its own, or null for one that waits for the user. */
function leaving(toast: Pick<Toast, "persistent">, now: number) {
  return toast.persistent ? null : now + TOAST_LIFETIME_MS;
}

/**
 * Puts a toast up with the effect that takes it down. One about the same subject as a toast still up
 * takes that toast's place and its time, so a result replaces the progress it ends; any other joins
 * the stack, pushing the oldest out past the most the corner holds.
 */
export function withToast(state: WorkspaceState, toast: Omit<Toast, "id">, now = Date.now()): { state: WorkspaceState; effects: ToastEffect[] } {
  const replaced = toast.subject ? state.toasts.find((item) => item.subject === toast.subject) : undefined;
  if (replaced) {
    const toasts = state.toasts.map((item) => item === replaced ? { id: replaced.id, ...toast } : item);
    return { state: { ...state, toasts }, effects: [{ type: "schedule-toast-dismissal", id: replaced.id, at: leaving(toast, now) }] };
  }
  const id = state.toastSequence + 1;
  const toasts = [...state.toasts, { id, ...toast }].slice(-MAX_TOASTS);
  const at = leaving(toast, now);
  return { state: { ...state, toasts, toastSequence: id }, effects: at === null ? [] : [{ type: "schedule-toast-dismissal", id, at }] };
}

/**
 * Gives every toast that leaves on its own its full time again from now. A toast raised while the
 * app was starting would otherwise spend its time before the window had drawn it.
 */
export function rescheduledToasts(state: WorkspaceState, now = Date.now()): ToastEffect[] {
  return state.toasts.flatMap((toast) => toast.persistent ? [] : [{ type: "schedule-toast-dismissal" as const, id: toast.id, at: now + TOAST_LIFETIME_MS }]);
}

export function reduceToasts(state: WorkspaceState, input: ToastInput): WorkspaceTransition {
  if (input.type === "app.launched") return withToast(state, { tone: "success", title: "AI Coding Tool updated", message: `Now on ${input.version}.` });
  const toast = state.toasts.find((item) => item.id === input.id);
  if (!toast) return { state, effects: [] };
  const toasts = state.toasts.filter((item) => item !== toast);
  if (!toast.remember || state.dismissedToasts.includes(toast.remember)) return { state: { ...state, toasts }, effects: [] };
  const next = { ...state, toasts, dismissedToasts: [...state.dismissedToasts, toast.remember].slice(-MAX_REMEMBERED_TOASTS) };
  return { state: next, effects: [{ type: "persist-preferences", preferences: viewPreferences(next) }] };
}
