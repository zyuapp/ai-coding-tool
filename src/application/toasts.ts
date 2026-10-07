/**
 * The cards in the window's corner. Each one schedules its own leaving as it arrives, and the user
 * can close it sooner; nothing else takes one away.
 */
import { MAX_TOASTS, TOAST_LIFETIME_MS, type Toast } from "../domain/toast.js";
import type { WorkspaceEffect, WorkspaceInput, WorkspaceTransition } from "./workspace-reducer/types.js";
import type { WorkspaceState } from "./workspace-state.js";

type ToastInput = Extract<WorkspaceInput, { type: "view.dismiss-toast" | "app.launched" }>;

export type ToastEffect = Extract<WorkspaceEffect, { type: "schedule-toast-dismissal" }>;

/**
 * Puts a toast up with the effect that takes it down. One about the same subject as a toast still up
 * takes that toast's place and its full time again, so a result replaces the progress it ends; any
 * other joins the stack, pushing the oldest out past the most the corner holds.
 */
export function withToast(state: WorkspaceState, toast: Omit<Toast, "id">, now = Date.now()): { state: WorkspaceState; effects: ToastEffect[] } {
  const replaced = toast.subject ? state.toasts.find((item) => item.subject === toast.subject) : undefined;
  if (replaced) {
    const toasts = state.toasts.map((item) => item === replaced ? { id: replaced.id, ...toast } : item);
    return { state: { ...state, toasts }, effects: [{ type: "schedule-toast-dismissal", id: replaced.id, at: now + TOAST_LIFETIME_MS }] };
  }
  const id = state.toastSequence + 1;
  const toasts = [...state.toasts, { id, ...toast }].slice(-MAX_TOASTS);
  return { state: { ...state, toasts, toastSequence: id }, effects: [{ type: "schedule-toast-dismissal", id, at: now + TOAST_LIFETIME_MS }] };
}

/**
 * Gives every toast its full time again from now. A toast raised while the app was starting would
 * otherwise spend its time before the window had drawn it.
 */
export function rescheduledToasts(state: WorkspaceState, now = Date.now()): ToastEffect[] {
  return state.toasts.map((toast) => ({ type: "schedule-toast-dismissal", id: toast.id, at: now + TOAST_LIFETIME_MS }));
}

export function reduceToasts(state: WorkspaceState, input: ToastInput): WorkspaceTransition {
  if (input.type === "app.launched") return withToast(state, { tone: "success", title: "AI Coding Tool updated", message: `Now on ${input.version}.` });
  if (!state.toasts.some((toast) => toast.id === input.id)) return { state, effects: [] };
  return { state: { ...state, toasts: state.toasts.filter((toast) => toast.id !== input.id) }, effects: [] };
}
