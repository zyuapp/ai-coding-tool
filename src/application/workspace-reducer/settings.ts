/** Settings: appearance, keystrokes, and the switches that change what a run may do. */
import { computerUseOf, setupShownIn } from "./computer-use.js";
import { TAKE_KEYS, docksOf, editDock, persistView } from "./dock-tabs.js";
import { runsOf, subagentActivityIn } from "./run-edits.js";
import { afterward, ownFields, type OwnPatch, type SliceTransition, type Step } from "./slice.js";
import type { SettingsState } from "../state/settings.js";
import { targetId } from "./shared.js";
import type { WorkspaceEffect, WorkspaceInput } from "./types.js";
import { managementShownIn, worktreesOf } from "./worktree-claims.js";
import { composerOf, focusComposerIn } from "../composer-drafts.js";
import { pairedId } from "../state/computers.js";
import { dockOwner, type WorkspaceState } from "../workspace-state.js";
import { shortcutAction, shortcutProblem, withShortcut } from "../../domain/shortcuts.js";
import { capabilitiesFor, isAgentEngine, isFavorite, isModelId } from "../../domain/agent-engine.js";
import { isSubagentGroup } from "../../domain/run.js";
import { isSettingsSection, type SettingsSection } from "../../domain/settings-section.js";
import { isSidebarSection } from "../../domain/sidebar.js";
import { rememberProject } from "../../domain/project.js";
import { isThemeMode, themeById, themeFor, themeOrDefault, variantFor } from "../../domain/theme.js";
import { READING_SIZE, TERMINAL_SIZE, monoFontById, sizeById, uiFontById } from "../../domain/typography.js";
import type { CaptureOptions } from "../../domain/capture.js";
import type { ShortcutOverrides } from "../../domain/shortcuts.js";

export const SETTINGS_INPUTS = [
  "view.set-theme", "view.set-theme-family", "view.set-theme-mode", "view.system-scheme", "view.set-ui-font", "view.set-mono-font",
  "view.set-reading-size", "view.set-terminal-size", "view.set-activity-project", "view.set-sidebar-open",
  "view.focus-composer", "view.set-shortcut", "view.reset-shortcuts", "view.capture-shortcut", "shortcut.captured", "shortcut.unavailable",
  "view.inspect-subagent", "subagent.activity.loaded", "view.set-capture-options", "view.set-chrome-browser", "view.set-computer-use",
  "view.set-memory-protection", "view.set-browser-tools", "view.set-notifications", "view.set-session-panel-open", "view.set-settings-open", "view.set-usage-computer", "view.set-subagent-group",
  "view.set-section-open"
] as const;
type SettingsInput = Extract<WorkspaceInput, { type: (typeof SETTINGS_INPUTS)[number] }>;

export type ShortcutEffect =
  /** The keystrokes the window matches. Only main sees the ones a page in the panel swallows. */
  | { type: "apply-shortcuts"; overrides: ShortcutOverrides }
  | { type: "apply-capture-options"; options: CaptureOptions }
  /** While settings wait for a keystroke, main hands every one of them over instead of acting. */
  | { type: "capture-shortcut"; capturing: boolean };

export function reduceModelFavorite(state: SettingsState, input: Extract<WorkspaceInput, { type: "view.set-model-favorite" }>): SliceTransition<SettingsState> {
  if (!isAgentEngine(input.engine) || !isModelId(input.model) || typeof input.favorite !== "boolean" || isFavorite(state.favoriteModels, input.engine, input.model) === input.favorite) return {};
  const favoriteModels = state.favoriteModels.filter((pinned) => pinned.engine !== input.engine || pinned.model !== input.model);
  if (input.favorite) favoriteModels.push({ engine: input.engine, model: input.model });
  return { patch: { favoriteModels }, persists: true };
}

export function reduceRememberProject(state: SettingsState, input: Extract<WorkspaceInput, { type: "view.remember-project" }>): SliceTransition<SettingsState> {
  if (state.recentProjects[0] === input.projectId) return {};
  return { patch: { recentProjects: rememberProject(state.recentProjects, input.projectId) }, persists: true };
}

/** Settings as one input leaves them. Only the functions here make one. */
class SettingsChange {
  private declare readonly owned: never;
  constructor(readonly view: SettingsState) {}
}

export type SettingsEdit = SettingsChange;

export function settingsOf(state: SettingsState): SettingsEdit {
  return new SettingsChange(ownFields<SettingsState>(state, {
    sections: true, subagentGroups: true, theme: true, themeMode: true, uiFont: true, monoFont: true, readingSize: true, terminalSize: true,
    activityProject: true, sidebarOpen: true, sessionPanelOpen: true, captureSound: true, captureFocus: true, chromeBrowser: true, computerUse: true,
    memoryProtection: true, browserTools: true, notifications: true, settingsOpen: true, settingsSection: true, settingsFocus: true, usageComputer: true, favoriteModels: true,
    recentProjects: true, shortcuts: true, capturingShortcut: true, desktopShortcutUnavailable: true,
  }));
}

/** Settings no longer waiting for a keystroke, which they stop the moment they are not the thing in front. */
export function captureStoppedIn(edit: SettingsEdit): SettingsEdit {
  return new SettingsChange({ ...edit.view, capturingShortcut: null });
}

/**
 * Settings shown on a page and the control on it something named, or put away, which stops a wait for
 * a keystroke. Usage opens on the computer whose thread is on screen.
 */
function sheetIn(edit: SettingsEdit, open: boolean, section: SettingsSection | null, settingId: string | undefined, usageComputer: string | null | undefined): SettingsEdit {
  const { view } = edit;
  return new SettingsChange({
    ...view,
    settingsOpen: open,
    settingsSection: open ? section : null,
    settingsFocus: open && section && settingId ? { id: settingId, visit: (view.settingsFocus?.visit ?? 0) + 1 } : null,
    ...(usageComputer === undefined ? {} : { usageComputer }),
    ...(open ? {} : { capturingShortcut: null }),
  });
}

/**
 * Settings shown or put away. Naming a page takes over from the computer-use setup that held settings
 * open on its own. Settings are drawn in the window, so a page that was in front cannot be left
 * holding the keys, and the dock in front makes way.
 */
export function settingsShown(state: WorkspaceState, open: boolean, asked?: string, settingId?: string): Step {
  const section = asked && isSettingsSection(asked) ? asked : null;
  const usage = open && section === "usage" ? pairedId(state.computers, state.computers.active) : undefined;
  const effects = open ? [...TAKE_KEYS] : stopCapture(state);
  if (open && section === "worktrees" && !state.worktreeManagementLoading) effects.push({ type: "list-worktrees" });
  return {
    edits: [
      sheetIn(settingsOf(state), open, section, settingId, usage),
      managementShownIn(worktreesOf(state), open, section === "worktrees"),
      ...(open && !section ? [] : [setupShownIn(computerUseOf(state), false)]),
      ...(open ? [editDock(docksOf(state), dockOwner(state), { open: false, expanded: false })] : []),
    ],
    effects,
  };
}

/** Opening a child loads its log and fills settings that older app versions did not capture. */
function inspectSubagent(state: WorkspaceState, taskId: string | null, subagentId: string): WorkspaceEffect[] {
  const subagent = taskId ? state.subagents[taskId]?.find((candidate) => candidate.id === subagentId) : undefined;
  if (!subagent || !taskId) return [];
  const effects: WorkspaceEffect[] = [];
  if (!subagent.activity.length) effects.push({ type: "load-subagent-activity", taskId, subagentId });
  const thread = state.threads.find((thread) => thread.id === taskId);
  const engine = thread?.engine;
  if (engine && capabilitiesFor(engine).subagentMetadata && (!subagent.model || !subagent.effort)) {
    effects.push({ type: "load-subagent-metadata", taskId, subagentId, engine, sessionId: thread?.continuation?.value });
  }
  return effects;
}

/** Keeps one remembered choice, and writes nothing when it already holds. */
function setPreference<Key extends "activityProject" | "sidebarOpen">(state: SettingsState, key: Key, value: SettingsState[Key]): SliceTransition<SettingsState> {
  if (state[key] === value) return {};
  return { patch: { [key]: value } as OwnPatch<SettingsState>, persists: true };
}

/** The preferences as `patch` leaves them, saved ahead of what else the change asks. */
function savedWith(state: WorkspaceState, patch: OwnPatch<SettingsState>): WorkspaceEffect[] {
  return persistView(afterward(state, { patch }));
}

export function reduceSettings(state: WorkspaceState, input: SettingsInput): SliceTransition<SettingsState> {
  switch (input.type) {
    case "view.set-theme": {
      const chosen = themeById(input.theme);
      if (!chosen) return {};
      /** Naming a theme outright also names the ground it paints on, so the picker stays honest. */
      if (state.theme === chosen.id && state.themeMode === chosen.variant) return {};
      return { patch: { theme: chosen.id, themeMode: chosen.variant }, persists: true };
    }

    case "view.set-theme-family": {
      const chosen = themeFor(input.family, variantFor(state.themeMode, input.systemDark));
      if (chosen.family !== input.family || state.theme === chosen.id) return {};
      return { patch: { theme: chosen.id }, persists: true };
    }

    case "view.set-theme-mode": {
      if (!isThemeMode(input.mode)) return {};
      const chosen = themeFor(themeOrDefault(state.theme).family, variantFor(input.mode, input.systemDark));
      if (state.themeMode === input.mode && state.theme === chosen.id) return {};
      return { patch: { themeMode: input.mode, theme: chosen.id }, persists: true };
    }

    case "view.system-scheme": {
      if (state.themeMode !== "auto") return {};
      const chosen = themeFor(themeOrDefault(state.theme).family, variantFor("auto", input.dark));
      if (state.theme === chosen.id) return {};
      /** The system's own choice is not the user's, so it repaints the window without being written down. */
      return { patch: { theme: chosen.id } };
    }

    case "view.set-ui-font":
      if (!uiFontById(input.font) || state.uiFont === input.font) return {};
      return { patch: { uiFont: input.font }, persists: true };

    case "view.set-mono-font":
      if (!monoFontById(input.font) || state.monoFont === input.font) return {};
      return { patch: { monoFont: input.font }, persists: true };

    case "view.set-reading-size": {
      const size = sizeById(READING_SIZE, input.size);
      if (size === undefined || state.readingSize === size) return {};
      return { patch: { readingSize: size }, persists: true };
    }

    case "view.set-terminal-size": {
      const size = sizeById(TERMINAL_SIZE, input.size);
      if (size === undefined || state.terminalSize === size) return {};
      return { patch: { terminalSize: size }, persists: true };
    }

    case "view.set-activity-project":
      return setPreference(state, "activityProject", input.projectId);

    case "view.set-sidebar-open":
      return setPreference(state, "sidebarOpen", input.open);

    case "view.set-usage-computer": {
      const usageComputer = pairedId(state.computers, input.computerId);
      if (usageComputer !== input.computerId || usageComputer === state.usageComputer) return {};
      return { patch: { usageComputer } };
    }

    case "view.set-section-open":
      if (!isSidebarSection(input.section) || state.sections[input.section] === input.open) return {};
      return { patch: { sections: { ...state.sections, [input.section]: input.open } }, persists: true };

    case "view.set-subagent-group":
      if (!isSubagentGroup(input.group) || state.subagentGroups[input.group] === input.open) return {};
      return { patch: { subagentGroups: { ...state.subagentGroups, [input.group]: input.open } }, persists: true };

    /** A caret recovered while the window is away waits there, rather than calling the window back. */
    case "view.focus-composer":
      return { edits: [focusComposerIn(composerOf(state))], effects: input.recover && !state.focused ? [] : TAKE_KEYS };

    case "view.set-shortcut": {
      if (!shortcutAction(input.action)) return {};
      const problem = input.binding === null ? null : shortcutProblem(input.binding);
      if (problem) return { patch: { capturingShortcut: null }, refusal: problem, effects: stopCapture(state) };
      const shortcuts = withShortcut(state.shortcuts, input.action, input.binding);
      const patch = { shortcuts, capturingShortcut: null };
      return { patch, clearsError: true, effects: [...savedWith(state, patch), { type: "apply-shortcuts", overrides: shortcuts }, ...stopCapture(state)] };
    }

    case "view.reset-shortcuts": {
      const patch = { shortcuts: {}, capturingShortcut: null };
      return { patch, clearsError: true, effects: [...savedWith(state, patch), { type: "apply-shortcuts", overrides: patch.shortcuts }, ...stopCapture(state)] };
    }

    case "view.capture-shortcut":
      if (input.action !== null && !shortcutAction(input.action)) return {};
      if (state.capturingShortcut === input.action) return {};
      return { patch: { capturingShortcut: input.action }, clearsError: true, effects: [{ type: "capture-shortcut", capturing: input.action !== null }] };

    case "shortcut.captured": {
      const action = state.capturingShortcut;
      if (!action) return {};
      if (input.binding === null) return { patch: { capturingShortcut: null }, effects: stopCapture(state) };
      return reduceSettings(state, { type: "view.set-shortcut", action, binding: input.binding });
    }

    case "shortcut.unavailable": {
      const current = state.desktopShortcutUnavailable;
      if (current?.binding === input.refusal.binding && current.message === input.refusal.message) return {};
      return { patch: { desktopShortcutUnavailable: input.refusal } };
    }

    case "view.inspect-subagent":
      return { effects: inspectSubagent(state, targetId(state, input.taskId), input.subagentId) };

    case "subagent.activity.loaded": {
      const held = state.subagents[input.taskId];
      if (!held?.some((subagent) => subagent.id === input.subagentId)) return {};
      return { edits: [subagentActivityIn(runsOf(state), input.taskId, input.subagentId, input.activity)] };
    }

    case "view.set-capture-options": {
      if (input.options.sound === state.captureSound && input.options.focus === state.captureFocus) return {};
      const patch = { captureSound: input.options.sound, captureFocus: input.options.focus };
      return { patch, effects: [...savedWith(state, patch), { type: "apply-capture-options", options: input.options }] };
    }

    case "view.set-memory-protection":
      return { patch: { memoryProtection: input.enabled }, persists: true, effects: [{ type: "send-run-command", command: { type: "memory-protection", enabled: input.enabled } }] };

    case "view.set-chrome-browser":
    case "view.set-computer-use": case "view.set-browser-tools": case "view.set-notifications": {
      const field = { "view.set-chrome-browser": "chromeBrowser", "view.set-computer-use": "computerUse", "view.set-browser-tools": "browserTools", "view.set-notifications": "notifications" }[input.type] as "chromeBrowser" | "computerUse" | "browserTools" | "notifications";
      if (state[field] === input.enabled) return {};
      return { patch: { [field]: input.enabled } as OwnPatch<SettingsState>, persists: true };
    }

    case "view.set-session-panel-open":
      if (state.sessionPanelOpen === input.open) return {};
      return { patch: { sessionPanelOpen: input.open }, persists: true };

    case "view.set-settings-open":
      return settingsShown(state, input.open, input.section, input.settingId);
  }
}

/** Settings stop waiting for a keystroke the moment they are no longer the thing in front. */
export function stopCapture(state: WorkspaceState): WorkspaceEffect[] {
  return state.capturingShortcut === null ? [] : [{ type: "capture-shortcut", capturing: false }];
}
