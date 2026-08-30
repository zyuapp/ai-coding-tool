import { readViewPreferences, writeViewPreferences } from "../../application/view-preferences";
import type { ViewPreferences } from "../../contracts/preferences";
import { OPEN_SUBAGENT_GROUPS } from "../../domain/run";
import { OPEN_SIDEBAR_SECTIONS } from "../../domain/sidebar";
import { DEFAULT_THEME, DEFAULT_THEME_MODE } from "../../domain/theme";
import { DEFAULT_MONO_FONT, DEFAULT_UI_FONT, READING_SIZE, TERMINAL_SIZE } from "../../domain/typography";

/** Wide windows open the session panel, and windows with room for it show the sidebar. */
export function loadViewPreferences(): ViewPreferences {
  const stored = readViewPreferences(localStorage);
  return {
    theme: stored.theme ?? DEFAULT_THEME,
    themeMode: stored.themeMode ?? DEFAULT_THEME_MODE,
    uiFont: stored.uiFont ?? DEFAULT_UI_FONT,
    monoFont: stored.monoFont ?? DEFAULT_MONO_FONT,
    readingSize: stored.readingSize ?? READING_SIZE.default,
    terminalSize: stored.terminalSize ?? TERMINAL_SIZE.default,
    sessionPanelOpen: stored.sessionPanelOpen ?? window.innerWidth >= 1400,
    captureSound: stored.captureSound ?? true,
    captureFocus: stored.captureFocus ?? true,
    chromeBrowser: stored.chromeBrowser ?? false,
    conciseReplies: stored.conciseReplies ?? false,
    computerUse: stored.computerUse ?? true,
    browserTools: stored.browserTools ?? true,
    notifications: stored.notifications ?? true,
    sidebarOpen: stored.sidebarOpen ?? window.innerWidth >= 900,
    sidebarMode: stored.sidebarMode ?? "projects",
    sections: stored.sections ?? OPEN_SIDEBAR_SECTIONS,
    subagentGroups: stored.subagentGroups ?? OPEN_SUBAGENT_GROUPS,
    shortcuts: stored.shortcuts ?? {},
    browserTabs: stored.browserTabs ?? {},
    browserOrigins: stored.browserOrigins ?? [],
  };
}

export function saveViewPreferences(preferences: ViewPreferences): void {
  writeViewPreferences(localStorage, preferences);
}
