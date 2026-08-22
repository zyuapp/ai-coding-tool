import { readViewPreferences, writeViewPreferences } from "../../application/view-preferences";
import type { ViewPreferences } from "../../contracts/preferences";
import { DEFAULT_THEME } from "../../domain/theme";
import { DEFAULT_MONO_FONT, DEFAULT_TEXT_SIZE, DEFAULT_UI_FONT } from "../../domain/typography";

/** Wide windows open the session panel, and windows with room for it show the sidebar. */
export function loadViewPreferences(): ViewPreferences {
  const stored = readViewPreferences(localStorage);
  return {
    theme: stored.theme ?? DEFAULT_THEME,
    uiFont: stored.uiFont ?? DEFAULT_UI_FONT,
    monoFont: stored.monoFont ?? DEFAULT_MONO_FONT,
    readingSize: stored.readingSize ?? DEFAULT_TEXT_SIZE,
    terminalSize: stored.terminalSize ?? DEFAULT_TEXT_SIZE,
    sessionPanelOpen: stored.sessionPanelOpen ?? window.innerWidth >= 1400,
    captureSound: stored.captureSound ?? true,
    sidebarOpen: stored.sidebarOpen ?? window.innerWidth >= 900,
    sidebarMode: stored.sidebarMode ?? "projects",
    shortcuts: stored.shortcuts ?? {},
    browserTabs: stored.browserTabs ?? {},
    browserOrigins: stored.browserOrigins ?? [],
  };
}

export function saveViewPreferences(preferences: ViewPreferences): void {
  writeViewPreferences(localStorage, preferences);
}
