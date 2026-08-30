import type { KeyValueStorage } from "./task-store.js";
import { DRAFT_DOCK, type WorkspaceState } from "./workspace-state.js";
import type { ViewPreferences } from "../contracts/preferences.js";
import { shortcutAction, shortcutOverrides, shortcutProblem, type ShortcutOverrides } from "../domain/shortcuts.js";
import { OPEN_SUBAGENT_GROUPS, SUBAGENT_GROUPS, type SubagentGroups } from "../domain/run.js";
import { OPEN_SIDEBAR_SECTIONS, SIDEBAR_SECTIONS, isSidebarMode, type SidebarSections } from "../domain/sidebar.js";
import { isThemeMode, themeById, themeModeOrDefault, themeOrDefault } from "../domain/theme.js";
import { READING_SIZE, TERMINAL_SIZE, monoFontById, monoFontOrDefault, sizeById, sizeOrDefault, uiFontById, uiFontOrDefault } from "../domain/typography.js";

export const VIEW_PREFERENCES_KEY = "aicodingtool.view-preferences.v1";

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

/** A group the app no longer draws is dropped, and one that is missing takes its default of unfolded. */
function subagentGroups(value: unknown): SubagentGroups | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const stored = value as Record<string, unknown>;
  const groups = { ...OPEN_SUBAGENT_GROUPS };
  for (const group of SUBAGENT_GROUPS) {
    const open = stored[group];
    if (typeof open === "boolean") groups[group] = open;
  }
  return groups;
}

/** A list the app no longer draws is dropped, and one that is missing takes its default of unfolded. */
function sidebarSections(value: unknown): SidebarSections | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const stored = value as Record<string, unknown>;
  const sections = { ...OPEN_SIDEBAR_SECTIONS };
  for (const section of SIDEBAR_SECTIONS) {
    const open = stored[section];
    if (typeof open === "boolean") sections[section] = open;
  }
  return sections;
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
    const groups = subagentGroups(value.subagentGroups);
    const folds = sidebarSections(value.sections);
    const reading = sizeById(READING_SIZE, value.readingSize);
    const terminal = sizeById(TERMINAL_SIZE, value.terminalSize);
    return {
      ...(themeById(value.theme) ? { theme: value.theme as string } : {}),
      ...(isThemeMode(value.themeMode) ? { themeMode: value.themeMode } : {}),
      ...(uiFontById(value.uiFont) ? { uiFont: value.uiFont as string } : {}),
      ...(monoFontById(value.monoFont) ? { monoFont: value.monoFont as string } : {}),
      ...(reading !== undefined ? { readingSize: reading } : {}),
      ...(terminal !== undefined ? { terminalSize: terminal } : {}),
      ...(typeof value.sessionPanelOpen === "boolean" ? { sessionPanelOpen: value.sessionPanelOpen } : {}),
      ...(typeof value.captureSound === "boolean" ? { captureSound: value.captureSound } : {}),
      ...(typeof value.chromeBrowser === "boolean" ? { chromeBrowser: value.chromeBrowser } : {}),
      ...(typeof value.conciseReplies === "boolean" ? { conciseReplies: value.conciseReplies } : {}),
      ...(typeof value.computerUse === "boolean" ? { computerUse: value.computerUse } : {}),
      ...(typeof value.browserTools === "boolean" ? { browserTools: value.browserTools } : {}),
      ...(typeof value.notifications === "boolean" ? { notifications: value.notifications } : {}),
      ...(typeof value.captureFocus === "boolean" ? { captureFocus: value.captureFocus } : {}),
      ...(typeof value.sidebarOpen === "boolean" ? { sidebarOpen: value.sidebarOpen } : {}),
      ...(isSidebarMode(value.sidebarMode) ? { sidebarMode: value.sidebarMode } : {}),
      ...(folds ? { sections: folds } : {}),
      ...(groups ? { subagentGroups: groups } : {}),
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

/** The slice of state that survives a restart, gathered here so persisting it stays one decision. */
export function viewPreferences(state: WorkspaceState): ViewPreferences {
  /** Only a thread that will still be there reopens its pages, so a dock nothing owns stops being written. */
  const browserTabs: Record<string, string[]> = {}, threadIds = new Set(state.threads.map((thread) => thread.id));
  for (const [owner, dock] of Object.entries(state.docks)) {
    if (owner !== DRAFT_DOCK && !threadIds.has(owner)) continue;
    const urls = dock.browserTabs.map((tab) => tab.url).filter(Boolean);
    if (urls.length) browserTabs[owner] = urls;
  }
  return {
    theme: state.theme,
    themeMode: state.themeMode,
    uiFont: state.uiFont,
    monoFont: state.monoFont,
    readingSize: state.readingSize,
    terminalSize: state.terminalSize,
    sessionPanelOpen: state.sessionPanelOpen,
    captureSound: state.captureSound,
    captureFocus: state.captureFocus,
    chromeBrowser: state.chromeBrowser,
    conciseReplies: state.conciseReplies,
    computerUse: state.computerUse,
    browserTools: state.browserTools,
    notifications: state.notifications,
    sidebarOpen: state.sidebarOpen,
    sidebarMode: state.sidebarMode,
    sections: state.sections,
    subagentGroups: state.subagentGroups,
    shortcuts: state.shortcuts,
    browserTabs,
    browserOrigins: state.browserOrigins,
  };
}

/** The same slice on the way back in. A preference the stored set lacks takes the app's own default. */
export function viewPreferenceState(preferences: ViewPreferences) {
  return {
    theme: themeOrDefault(preferences.theme).id,
    themeMode: themeModeOrDefault(preferences.themeMode),
    uiFont: uiFontOrDefault(preferences.uiFont).id,
    monoFont: monoFontOrDefault(preferences.monoFont).id,
    readingSize: sizeOrDefault(READING_SIZE, preferences.readingSize),
    terminalSize: sizeOrDefault(TERMINAL_SIZE, preferences.terminalSize),
    sessionPanelOpen: preferences.sessionPanelOpen,
    captureSound: preferences.captureSound ?? true,
    captureFocus: preferences.captureFocus ?? true,
    chromeBrowser: preferences.chromeBrowser ?? false,
    conciseReplies: preferences.conciseReplies ?? false,
    computerUse: preferences.computerUse ?? true,
    browserTools: preferences.browserTools ?? true,
    notifications: preferences.notifications ?? true,
    sidebarOpen: preferences.sidebarOpen,
    sidebarMode: preferences.sidebarMode,
    sections: preferences.sections ?? OPEN_SIDEBAR_SECTIONS,
    subagentGroups: preferences.subagentGroups ?? OPEN_SUBAGENT_GROUPS,
    shortcuts: preferences.shortcuts ?? {},
    browserOrigins: preferences.browserOrigins ?? [],
  };
}
