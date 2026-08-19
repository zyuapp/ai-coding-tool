import type { KeyValueStorage } from "./task-store.js";
import type { ViewPreferences } from "../contracts/preferences.js";

export const VIEW_PREFERENCES_KEY = "claudex.view-preferences.v1";

const MAX_REMEMBERED = 50;

function urlList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 8_192).slice(0, MAX_REMEMBERED);
}

/** Anything unreadable reports no preference, so the caller's default decides. */
export function readViewPreferences(storage: KeyValueStorage): Partial<ViewPreferences> {
  try {
    const raw = storage.getItem(VIEW_PREFERENCES_KEY);
    if (raw === null) return {};
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const browserTabs = urlList(value.browserTabs);
    const browserOrigins = urlList(value.browserOrigins);
    return {
      ...(typeof value.sessionPanelOpen === "boolean" ? { sessionPanelOpen: value.sessionPanelOpen } : {}),
      ...(browserTabs ? { browserTabs } : {}),
      ...(browserOrigins ? { browserOrigins } : {}),
    };
  } catch {
    return {};
  }
}

/** A refused write costs the preference and nothing else. */
export function writeViewPreferences(storage: KeyValueStorage, preferences: ViewPreferences): void {
  try {
    storage.setItem(VIEW_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    return;
  }
}
