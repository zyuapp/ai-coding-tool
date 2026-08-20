import type { ShortcutOverrides } from "../domain/shortcuts.js";

/** Presentation choices the window remembers between launches. */
export type ViewPreferences = {
  sessionPanelOpen: boolean;
  sidebarOpen: boolean;
  /** Only the bindings that differ from the defaults; an action bound to nothing is stored as null. */
  shortcuts?: ShortcutOverrides;
  /** The pages each thread's dock reopens, keyed by thread id, and the origins a run may reach without asking again. */
  browserTabs?: Record<string, string[]>;
  browserOrigins?: string[];
};
