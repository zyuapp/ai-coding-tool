import { readViewPreferences, writeViewPreferences } from "../../application/view-preferences";
import type { ViewPreferences } from "../../contracts/preferences";

/** Wide windows open the session panel until the user says otherwise. */
export function loadViewPreferences(): ViewPreferences {
  const stored = readViewPreferences(localStorage);
  return { sessionPanelOpen: stored.sessionPanelOpen ?? window.innerWidth >= 1400 };
}

export function saveViewPreferences(preferences: ViewPreferences): void {
  writeViewPreferences(localStorage, preferences);
}
