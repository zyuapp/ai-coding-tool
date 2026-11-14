import type { DesktopShortcutUnavailable } from "../../contracts/ipc.js";
import type { EngineModel } from "../../domain/agent-engine.js";
import { OPEN_SUBAGENT_GROUPS, type SubagentGroups } from "../../domain/run.js";
import type { SettingMark } from "../../domain/settings-catalog.js";
import type { SettingsSection } from "../../domain/settings-section.js";
import type { ShortcutOverrides } from "../../domain/shortcuts.js";
import { OPEN_SIDEBAR_SECTIONS, type SidebarSections } from "../../domain/sidebar.js";
import { DEFAULT_THEME, DEFAULT_THEME_MODE, type ThemeMode } from "../../domain/theme.js";
import { DEFAULT_MONO_FONT, DEFAULT_UI_FONT, READING_SIZE, TERMINAL_SIZE } from "../../domain/typography.js";

/** How the user set the window up, and the settings sheet itself. */
export type SettingsState = {
  /** Which of the sidebar's lists are unfolded. */
  sections: SidebarSections;
  /** Which subagent groups are unfolded: the sidebar's list, and each status heading in the panel. */
  subagentGroups: SubagentGroups;
  theme: string;
  /** The ground the user asked for, which "auto" leaves to the system's own appearance. */
  themeMode: ThemeMode;
  /** The two families the window sets type in, and the two sizes in px that follow the user. */
  uiFont: string;
  monoFont: string;
  readingSize: number;
  terminalSize: number;
  /** The one project the sidebar's lists are narrowed to, or null for every project. */
  activityProject: string | null;
  sidebarOpen: boolean;
  sessionPanelOpen: boolean;
  /** Whether grabbing a window plays the shutter, and whether it brings the window forward. */
  captureSound: boolean;
  captureFocus: boolean;
  /** Whether a run reaches the user's own Chrome through the Claude in Chrome extension. */
  chromeBrowser: boolean;
  /** Whether a run may see and operate other applications. */
  computerUse: boolean;
  /** Whether a run may drive the browser panel. The user's own tabs stay usable either way. */
  browserTools: boolean;
  /** Whether excessive engine memory stops its owning thread. */
  memoryProtection: boolean;
  /** Whether a thread that needs the user is announced on the desktop. Off leaves it to the sidebar alone. */
  notifications: boolean;
  settingsOpen: boolean;
  /** The page settings opens on, when something opened it on one. Null lets it open where it opens. */
  settingsSection: SettingsSection | null;
  /** The control on that page to scroll to and mark, when something named one. */
  settingsFocus: SettingMark | null;
  /** The paired computer the Usage page shows. Null shows this one. */
  usageComputer: string | null;
  /** Pinned models, each on its engine, since two engines may name the same id. */
  favoriteModels: EngineModel[];
  /** The projects last picked in the new-thread picker, newest first. Kept between launches. */
  recentProjects: string[];
  /** The bindings the user changed, and the action waiting for a keystroke while settings are open. */
  shortcuts: ShortcutOverrides;
  capturingShortcut: string | null;
  /** A capability refusal belongs beside its affected setting, not in the workspace error banner. */
  desktopShortcutUnavailable: DesktopShortcutUnavailable | null;
};

export function initialSettingsState(): SettingsState {
  return {
    sections: OPEN_SIDEBAR_SECTIONS,
    subagentGroups: OPEN_SUBAGENT_GROUPS,
    theme: DEFAULT_THEME,
    themeMode: DEFAULT_THEME_MODE,
    uiFont: DEFAULT_UI_FONT,
    monoFont: DEFAULT_MONO_FONT,
    readingSize: READING_SIZE.default,
    terminalSize: TERMINAL_SIZE.default,
    activityProject: null,
    sidebarOpen: true,
    sessionPanelOpen: false,
    captureSound: true,
    captureFocus: true,
    chromeBrowser: false,
    computerUse: true,
    browserTools: true,
    memoryProtection: true,
    notifications: true,
    settingsOpen: false,
    settingsSection: null,
    settingsFocus: null,
    usageComputer: null,
    favoriteModels: [],
    recentProjects: [],
    shortcuts: {},
    capturingShortcut: null,
    desktopShortcutUnavailable: null,
  };
}
