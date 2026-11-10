import type { Toast } from "../../domain/toast.js";

export type ToastsState = {
  /** The cards in the window's corner, oldest first. Session-only. */
  toasts: Toast[];
  /** The id the last toast took, so each one has its own. */
  toastSequence: number;
  /** The pointer or the caret is on the toasts, so none leaves on its own. Session-only. */
  toastsHeld: boolean;
  /** What the user closed toasts about, so the same ones are not raised again. Kept between launches. */
  dismissedToasts: string[];
};

export function initialToastsState(): ToastsState {
  return { toasts: [], toastSequence: 0, toastsHeld: false, dismissedToasts: [] };
}
