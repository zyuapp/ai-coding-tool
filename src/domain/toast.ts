import type { AgentEngine } from "./agent-engine.js";

/** How a toast reads at a glance: something on offer, something under way, something done, or something that went wrong. */
export type ToastTone = "update" | "progress" | "success" | "error";

/** The one button a toast can carry, and the command it sends. */
export type ToastAction = { label: string; command: { type: "engine.update"; engine: AgentEngine } };

/** A short card in the corner of the window, which leaves on its own or when the user closes it. */
export type Toast = {
  id: number;
  tone: ToastTone;
  title: string;
  message?: string;
  /** What the toast is about. A later toast about the same thing takes its place rather than stacking under it. */
  subject?: string;
  /** Stays until the user closes it or another toast about the same thing replaces it. */
  persistent?: true;
  action?: ToastAction;
  /** Kept once the user closes the toast, so the same one is not raised again. */
  remember?: string;
};

/** How long a toast stays before it leaves on its own. */
export const TOAST_LIFETIME_MS = 5_000;

/** The most toasts on screen at once; a newer one pushes the oldest out. */
export const MAX_TOASTS = 4;

/** The most closed toasts remembered; the oldest are forgotten first. */
export const MAX_REMEMBERED_TOASTS = 50;
