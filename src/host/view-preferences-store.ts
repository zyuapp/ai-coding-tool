import { readViewPreferences, writeViewPreferences } from "../application/view-preferences.js";
import type { KeyValueStorage } from "../application/task-store.js";
import type { ViewPreferences } from "../contracts/preferences.js";
import { OPEN_SUBAGENT_GROUPS } from "../domain/run.js";
import { OPEN_SIDEBAR_SECTIONS } from "../domain/sidebar.js";
import { DEFAULT_THEME, DEFAULT_THEME_MODE } from "../domain/theme.js";
import { DEFAULT_MONO_FONT, DEFAULT_UI_FONT, READING_SIZE, TERMINAL_SIZE } from "../domain/typography.js";

/** Wide windows open the session panel, and windows with room for it show the sidebar. A host without a window shows the sidebar and keeps the panel shut. */
export function loadViewPreferences(storage: KeyValueStorage, viewportWidth?: number): ViewPreferences {
  const stored = readViewPreferences(storage);
  return {
    theme: stored.theme ?? DEFAULT_THEME,
    themeMode: stored.themeMode ?? DEFAULT_THEME_MODE,
    uiFont: stored.uiFont ?? DEFAULT_UI_FONT,
    monoFont: stored.monoFont ?? DEFAULT_MONO_FONT,
    readingSize: stored.readingSize ?? READING_SIZE.default,
    terminalSize: stored.terminalSize ?? TERMINAL_SIZE.default,
    sessionPanelOpen: stored.sessionPanelOpen ?? (viewportWidth !== undefined && viewportWidth >= 1400),
    captureSound: stored.captureSound ?? true,
    captureFocus: stored.captureFocus ?? true,
    chromeBrowser: stored.chromeBrowser ?? false,
    conciseReplies: stored.conciseReplies ?? false,
    computerUse: stored.computerUse ?? true,
    browserTools: stored.browserTools ?? true,
    notifications: stored.notifications ?? true,
    sidebarOpen: stored.sidebarOpen ?? (viewportWidth === undefined || viewportWidth >= 900),
    sidebarMode: stored.sidebarMode ?? "projects",
    sections: stored.sections ?? OPEN_SIDEBAR_SECTIONS,
    subagentGroups: stored.subagentGroups ?? OPEN_SUBAGENT_GROUPS,
    favoriteModels: stored.favoriteModels ?? [],
    shortcuts: stored.shortcuts ?? {},
    browserTabs: stored.browserTabs ?? {},
    browserOrigins: stored.browserOrigins ?? [],
  };
}

export function saveViewPreferences(storage: KeyValueStorage, preferences: ViewPreferences): void {
  writeViewPreferences(storage, preferences);
}
