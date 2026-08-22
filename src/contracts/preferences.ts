import type { ShortcutOverrides } from "../domain/shortcuts.js";
import type { SidebarMode } from "../domain/sidebar.js";

/** Presentation choices the window remembers between launches. */
export type ViewPreferences = {
  /** The theme the window paints in, by id. Themes the app no longer ships fall back to the default. */
  theme: string;
  /** The family the window's chrome and prose are set in, by id. */
  uiFont: string;
  /** The family code, diffs, and the terminal are set in, by id. */
  monoFont: string;
  /** How big a conversation reads, and how big the terminal draws. Chrome follows neither. */
  readingSize: string;
  terminalSize: string;
  sessionPanelOpen: boolean;
  sidebarOpen: boolean;
  /** Which shape the sidebar reopens in. Which of its lists are folded is not remembered. */
  sidebarMode: SidebarMode;
  /** Only the bindings that differ from the defaults; an action bound to nothing is stored as null. */
  shortcuts?: ShortcutOverrides;
  /** The pages each thread's dock reopens, keyed by thread id, and the origins a run may reach without asking again. */
  browserTabs?: Record<string, string[]>;
  browserOrigins?: string[];
};
