import type { ShortcutOverrides } from "../domain/shortcuts.js";
import type { ThemeMode } from "../domain/theme.js";
import type { SidebarMode } from "../domain/sidebar.js";
import type { SubagentGroups } from "../domain/run.js";

/** Presentation choices the window remembers between launches. */
export type ViewPreferences = {
  /** The theme the window paints in, by id. Themes the app no longer ships fall back to the default. */
  theme: string;
  /** The ground the user asked for, which "auto" leaves to the system's own appearance. */
  themeMode: ThemeMode;
  /** The family the window's chrome and prose are set in, by id or as an installed family's name. */
  uiFont: string;
  /** The family code, diffs, and the terminal are set in, by id or as an installed family's name. */
  monoFont: string;
  /** How big a conversation reads, and how big the terminal draws, in px. Chrome follows neither. */
  readingSize: number;
  terminalSize: number;
  sessionPanelOpen: boolean;
  sidebarOpen: boolean;
  /** Whether grabbing a window plays the shutter, which is the only feedback that lands as it happens. */
  captureSound: boolean;
  /** Whether grabbing a window brings AI Coding Tool forward, so the caption can be typed where the shot landed. */
  captureFocus: boolean;
  /** Which shape the sidebar reopens in. Which of its lists are folded is not remembered. */
  sidebarMode: SidebarMode;
  /** Which subagent groups are unfolded: the sidebar's list, and each status heading in the panel. */
  subagentGroups: SubagentGroups;
  /** Whether runs answer in the Simplified Technical English output style the app installs. */
  plainEnglish: boolean;
  /** Whether a run reaches the user's own Chrome through the Claude in Chrome extension. */
  chromeBrowser: boolean;
  /** Whether a run may see and operate other applications. On when absent. */
  computerUse: boolean;
  /** Whether a run may drive the browser panel. The user's own tabs stay usable either way. */
  browserTools: boolean;
  /** Whether a thread that needs the user reaches the desktop while the window is behind something else. */
  notifications: boolean;
  /** Only the bindings that differ from the defaults; an action bound to nothing is stored as null. */
  shortcuts?: ShortcutOverrides;
  /** The pages each thread's dock reopens, keyed by thread id, and the origins a run may reach without asking again. */
  browserTabs?: Record<string, string[]>;
  browserOrigins?: string[];
};
