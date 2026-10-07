/** How a toast reads at a glance: something under way, something done, or something that went wrong. */
export type ToastTone = "progress" | "success" | "error";

/** A short card in the corner of the window, which leaves on its own or when the user closes it. */
export type Toast = {
  id: number;
  tone: ToastTone;
  title: string;
  message?: string;
  /** What the toast is about. A later toast about the same thing takes its place rather than stacking under it. */
  subject?: string;
};

/** How long a toast stays before it leaves on its own. */
export const TOAST_LIFETIME_MS = 5_000;

/** The most toasts on screen at once; a newer one pushes the oldest out. */
export const MAX_TOASTS = 4;
