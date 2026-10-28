import type { AgentEngine } from "./agent-engine.js";
import type { WorktreeDestination } from "./worktree.js";

/** How a toast reads at a glance: something on offer, something under way, something done, or something that went wrong. */
export type ToastTone = "update" | "progress" | "success" | "error";

/** What a toast's button sends: an engine update, or the command that takes back what the user just did. */
export type ToastCommand =
  | { type: "engine.update"; engine: AgentEngine }
  | { type: "task.restore"; taskId: string }
  | { type: "task.undismiss"; taskIds: string[] }
  | { type: "task.move-worktree"; taskId: string; destination: Exclude<WorktreeDestination, { kind: "new" }> };

/** The one button a toast can carry, and the command it sends. */
export type ToastAction = { label: string; command: ToastCommand };

/** The subject every Undo toast shares, so a newer one takes the place of the last. */
export const UNDO_SUBJECT = "undo";

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
