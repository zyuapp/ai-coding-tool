import type { KeyValueStorage } from "./task-store.js";
import type { ViewPreferences } from "../contracts/preferences.js";
import { shortcutAction, shortcutOverrides, shortcutProblem, type ShortcutOverrides } from "../domain/shortcuts.js";
import { isSidebarMode } from "../domain/sidebar.js";
import { themeById } from "../domain/theme.js";
import { monoFontById, textSizeById, uiFontById } from "../domain/typography.js";

export const VIEW_PREFERENCES_KEY = "claudex.view-preferences.v1";

const MAX_REMEMBERED = 50;

function urlList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 8_192).slice(0, MAX_REMEMBERED);
}

/** The pages a thread's dock reopens. A thread whose entry is unreadable simply reopens none. */
function urlsByThread(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const threads: Record<string, string[]> = {};
  for (const [owner, urls] of Object.entries(value as Record<string, unknown>).slice(0, MAX_REMEMBERED)) {
    const list = urlList(urls);
    if (list?.length) threads[owner] = list;
  }
  return threads;
}

/** A binding the app no longer knows, or one it would refuse to record, is dropped rather than kept. */
function bindings(value: unknown): ShortcutOverrides | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const stored: ShortcutOverrides = {};
  for (const [action, binding] of Object.entries(value as Record<string, unknown>)) {
    if (!shortcutAction(action)) continue;
    if (binding === null) stored[action] = null;
    else if (typeof binding === "string" && !shortcutProblem(binding)) stored[action] = binding;
  }
  return shortcutOverrides(stored);
}

/** Anything unreadable reports no preference, so the caller's default decides. */
export function readViewPreferences(storage: KeyValueStorage): Partial<ViewPreferences> {
  try {
    const raw = storage.getItem(VIEW_PREFERENCES_KEY);
    if (raw === null) return {};
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const browserTabs = urlsByThread(value.browserTabs);
    const browserOrigins = urlList(value.browserOrigins);
    const shortcuts = bindings(value.shortcuts);
    return {
      ...(themeById(value.theme) ? { theme: value.theme as string } : {}),
      ...(uiFontById(value.uiFont) ? { uiFont: value.uiFont as string } : {}),
      ...(monoFontById(value.monoFont) ? { monoFont: value.monoFont as string } : {}),
      ...(textSizeById(value.readingSize) ? { readingSize: value.readingSize as string } : {}),
      ...(textSizeById(value.terminalSize) ? { terminalSize: value.terminalSize as string } : {}),
      ...(typeof value.sessionPanelOpen === "boolean" ? { sessionPanelOpen: value.sessionPanelOpen } : {}),
      ...(typeof value.captureSound === "boolean" ? { captureSound: value.captureSound } : {}),
      ...(typeof value.sidebarOpen === "boolean" ? { sidebarOpen: value.sidebarOpen } : {}),
      ...(isSidebarMode(value.sidebarMode) ? { sidebarMode: value.sidebarMode } : {}),
      ...(shortcuts ? { shortcuts } : {}),
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
