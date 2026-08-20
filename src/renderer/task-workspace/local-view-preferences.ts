import { readViewPreferences, writeViewPreferences } from "../../application/view-preferences";
import type { ViewPreferences } from "../../contracts/preferences";

/** Wide windows open the session panel, and windows with room for it show the sidebar. */
export function loadViewPreferences(): ViewPreferences {
  const stored = readViewPreferences(localStorage);
  return {
    sessionPanelOpen: stored.sessionPanelOpen ?? window.innerWidth >= 1400,
    sidebarOpen: stored.sidebarOpen ?? window.innerWidth >= 900,
    shortcuts: stored.shortcuts ?? {},
    browserTabs: stored.browserTabs ?? {},
    browserOrigins: stored.browserOrigins ?? [],
  };
}

export function saveViewPreferences(preferences: ViewPreferences): void {
  writeViewPreferences(localStorage, preferences);
}
