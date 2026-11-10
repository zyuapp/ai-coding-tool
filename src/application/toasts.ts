/**
 * The cards in the window's corner. Each one schedules its own leaving as it arrives, unless it waits
 * for the user, and the user can close any of them sooner.
 */
import { MAX_REMEMBERED_TOASTS, MAX_TOASTS, TOAST_LIFETIME_MS, type Toast } from "../domain/toast.js";
import type { WorkspaceEffect, WorkspaceInput } from "./workspace-reducer/types.js";
import type { OwnPatch, SliceTransition } from "./workspace-reducer/slice.js";
import type { WorkspaceState } from "./workspace-state.js";
import type { ToastsState } from "./state/toasts.js";

/** The toasts as one input leaves them. Only the functions here make one, so a slice changes the toasts through them. */
class ToastsChange {
  private declare readonly owned: never;
  constructor(readonly view: ToastsState) {}
}

export type ToastsEdit = ToastsChange;

export function toastsOf(state: ToastsState): ToastsEdit {
  const { toasts, toastSequence, toastsHeld, dismissedToasts } = state;
  return new ToastsChange({ toasts, toastSequence, toastsHeld, dismissedToasts });
}

/** The pointer or the caret left the toasts, so each leaves on its own time again. */
export function releasedToasts(edit: ToastsEdit): ToastsEdit {
  return edit.view.toastsHeld ? new ToastsChange({ ...edit.view, toastsHeld: false }) : edit;
}

type ToastInput = Extract<WorkspaceInput, { type: "view.dismiss-toast" | "view.hold-toasts" | "app.launched" }>;

export type ToastEffect = Extract<WorkspaceEffect, { type: "schedule-toast-dismissal" }>;

/** When a toast leaves on its own, or null for one that waits for the user or is held. */
function leaving(state: Pick<WorkspaceState, "toastsHeld">, toast: Pick<Toast, "persistent">, now: number) {
  return toast.persistent || state.toastsHeld ? null : now + TOAST_LIFETIME_MS;
}

/**
 * Puts a toast up with the effect that takes it down. One about the same subject as a toast still up
 * takes that toast's place and its time, so a result replaces the progress it ends; any other joins
 * the stack, pushing the oldest out past the most the corner holds.
 */
export function withToast(state: WorkspaceState, toast: Omit<Toast, "id">, now = Date.now()): { state: WorkspaceState; effects: ToastEffect[] } {
  const raised = raisedToast(state, toast, now);
  return { state: { ...state, ...raised.patch }, effects: raised.effects };
}

/** {@link withToast}, answered as the toasts' own patch. */
function raisedToast(state: ToastsState, toast: Omit<Toast, "id">, now: number): { patch: OwnPatch<ToastsState>; effects: ToastEffect[] } {
  const replaced = toast.subject ? state.toasts.find((item) => item.subject === toast.subject) : undefined;
  if (replaced) {
    const toasts = state.toasts.map((item) => item === replaced ? { id: replaced.id, ...toast } : item);
    return { patch: { toasts }, effects: [{ type: "schedule-toast-dismissal", id: replaced.id, at: leaving(state, toast, now) }] };
  }
  const id = state.toastSequence + 1;
  const toasts = [...state.toasts, { id, ...toast }].slice(-MAX_TOASTS);
  const at = leaving(state, toast, now);
  return { patch: { toasts, toastSequence: id }, effects: at === null ? [] : [{ type: "schedule-toast-dismissal", id, at }] };
}

/**
 * Gives every toast that leaves on its own its full time again from now. A toast raised while the
 * app was starting would otherwise spend its time before the window had drawn it.
 */
export function rescheduledToasts(state: Pick<WorkspaceState, "toasts" | "toastsHeld">, now = Date.now()): ToastEffect[] {
  return state.toasts.flatMap((toast) => toast.persistent ? [] : [{ type: "schedule-toast-dismissal" as const, id: toast.id, at: leaving(state, toast, now) }]);
}

const zenToasts = new WeakMap<Toast[], Toast[]>();

/** The toasts the corner shows: all of them, or in zen mode only the errors, held so a redraw keeps the same list. */
export function visibleToasts(state: Pick<WorkspaceState, "toasts" | "zen">): Toast[] {
  if (!state.zen) return state.toasts;
  let errors = zenToasts.get(state.toasts);
  if (!errors) {
    errors = state.toasts.filter((toast) => toast.tone === "error");
    zenToasts.set(state.toasts, errors);
  }
  return errors;
}

export function reduceToasts(state: ToastsState, input: ToastInput): SliceTransition<ToastsState> {
  if (input.type === "app.launched") return raisedToast(state, { tone: "success", title: "AI Coding Tool updated", message: `Now on ${input.version}.` }, Date.now());
  if (input.type === "view.hold-toasts") {
    if (input.held === state.toastsHeld) return {};
    return { patch: { toastsHeld: input.held }, effects: rescheduledToasts({ toasts: state.toasts, toastsHeld: input.held }) };
  }
  const toast = state.toasts.find((item) => item.id === input.id);
  if (!toast) return {};
  const toasts = state.toasts.filter((item) => item !== toast);
  if (!toast.remember || state.dismissedToasts.includes(toast.remember)) return { patch: { toasts } };
  return { patch: { toasts, dismissedToasts: [...state.dismissedToasts, toast.remember].slice(-MAX_REMEMBERED_TOASTS) }, persists: true };
}
