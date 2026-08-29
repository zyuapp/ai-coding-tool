/** Settings: appearance, keystrokes, and the switches that change what a run may do. */
import { TAKE_KEYS, persistView, settled, stopCapture, targetId } from "./shared.js";
import type { WorkspaceInput, WorkspaceTransition } from "./types.js";
import { focusComposer } from "../composer-drafts.js";
import { withSubagents } from "../thread-run-state.js";
import { viewPreferences } from "../view-preferences.js";
import { dockOwner, withDock, type WorkspaceState } from "../workspace-state.js";
import { shortcutAction, shortcutProblem, withShortcut } from "../../domain/shortcuts.js";
import { isSubagentGroup } from "../../domain/run.js";
import { isSettingsSection } from "../../domain/settings-section.js";
import { isSidebarSection } from "../../domain/sidebar.js";
import { isThemeMode, themeById, themeFor, themeOrDefault, variantFor } from "../../domain/theme.js";
import { READING_SIZE, TERMINAL_SIZE, monoFontById, sizeById, uiFontById } from "../../domain/typography.js";

type SettingsInput = Extract<WorkspaceInput, {
  type: "view.set-theme" | "view.set-theme-family" | "view.set-theme-mode" | "view.system-scheme" | "view.set-ui-font"
    | "view.set-mono-font" | "view.set-reading-size" | "view.set-terminal-size" | "view.set-sidebar-mode" | "view.set-sidebar-open"
    | "view.focus-composer" | "view.set-shortcut" | "view.reset-shortcuts" | "view.capture-shortcut" | "shortcut.captured"
    | "view.inspect-subagent" | "subagent.activity.loaded" | "view.set-capture-options" | "view.set-chrome-browser"
    | "view.set-computer-use" | "view.set-browser-tools" | "view.set-notifications" | "view.set-session-panel-open" | "view.set-settings-open"
    | "view.set-subagent-group" | "view.set-section-open";
}>;

export function reduceSettings(state: WorkspaceState, input: SettingsInput): WorkspaceTransition {
  switch (input.type) {
    case "view.set-theme": {
      const chosen = themeById(input.theme);
      if (!chosen) return settled(state);
      /** Naming a theme outright also names the ground it paints on, so the picker stays honest. */
      if (state.theme === chosen.id && state.themeMode === chosen.variant) return settled(state);
      const next = { ...state, theme: chosen.id, themeMode: chosen.variant };
      return settled(next, persistView(next));
    }

    case "view.set-theme-family": {
      const chosen = themeFor(input.family, variantFor(state.themeMode, input.systemDark));
      if (chosen.family !== input.family || state.theme === chosen.id) return settled(state);
      const next = { ...state, theme: chosen.id };
      return settled(next, persistView(next));
    }

    case "view.set-theme-mode": {
      if (!isThemeMode(input.mode)) return settled(state);
      const chosen = themeFor(themeOrDefault(state.theme).family, variantFor(input.mode, input.systemDark));
      if (state.themeMode === input.mode && state.theme === chosen.id) return settled(state);
      const next = { ...state, themeMode: input.mode, theme: chosen.id };
      return settled(next, persistView(next));
    }

    case "view.system-scheme": {
      if (state.themeMode !== "auto") return settled(state);
      const chosen = themeFor(themeOrDefault(state.theme).family, variantFor("auto", input.dark));
      if (state.theme === chosen.id) return settled(state);
      /** The system's own choice is not the user's, so it repaints the window without being written down. */
      return settled({ ...state, theme: chosen.id });
    }

    case "view.set-ui-font": {
      if (!uiFontById(input.font) || state.uiFont === input.font) return settled(state);
      const next = { ...state, uiFont: input.font };
      return settled(next, persistView(next));
    }

    case "view.set-mono-font": {
      if (!monoFontById(input.font) || state.monoFont === input.font) return settled(state);
      const next = { ...state, monoFont: input.font };
      return settled(next, persistView(next));
    }

    case "view.set-reading-size": {
      const size = sizeById(READING_SIZE, input.size);
      if (size === undefined || state.readingSize === size) return settled(state);
      const next = { ...state, readingSize: size };
      return settled(next, persistView(next));
    }

    case "view.set-terminal-size": {
      const size = sizeById(TERMINAL_SIZE, input.size);
      if (size === undefined || state.terminalSize === size) return settled(state);
      const next = { ...state, terminalSize: size };
      return settled(next, persistView(next));
    }

    case "view.set-sidebar-mode": {
      if (state.sidebarMode === input.mode) return settled(state);
      const next = { ...state, sidebarMode: input.mode };
      return settled(next, persistView(next));
    }

    case "view.set-sidebar-open": {
      if (state.sidebarOpen === input.open) return settled(state);
      const next = { ...state, sidebarOpen: input.open };
      return settled(next, persistView(next));
    }

    case "view.set-section-open": {
      if (!isSidebarSection(input.section) || state.sections[input.section] === input.open) return settled(state);
      const next = { ...state, sections: { ...state.sections, [input.section]: input.open } };
      return settled(next, persistView(next));
    }

    case "view.set-subagent-group": {
      if (!isSubagentGroup(input.group) || state.subagentGroups[input.group] === input.open) return settled(state);
      const next = { ...state, subagentGroups: { ...state.subagentGroups, [input.group]: input.open } };
      return settled(next, persistView(next));
    }

    case "view.focus-composer":
      return settled(focusComposer(state), TAKE_KEYS);

    case "view.set-shortcut": {
      if (!shortcutAction(input.action)) return settled(state);
      const problem = input.binding === null ? null : shortcutProblem(input.binding);
      if (problem) return settled({ ...state, actionError: problem, capturingShortcut: null }, stopCapture(state));
      const shortcuts = withShortcut(state.shortcuts, input.action, input.binding);
      const next = { ...state, shortcuts, capturingShortcut: null, actionError: null };
      return settled(next, [...persistView(next), { type: "apply-shortcuts", overrides: shortcuts }, ...stopCapture(state)]);
    }

    case "view.reset-shortcuts": {
      const next = { ...state, shortcuts: {}, capturingShortcut: null, actionError: null };
      return settled(next, [...persistView(next), { type: "apply-shortcuts", overrides: next.shortcuts }, ...stopCapture(state)]);
    }

    case "view.capture-shortcut": {
      if (input.action !== null && !shortcutAction(input.action)) return settled(state);
      if (state.capturingShortcut === input.action) return settled(state);
      return settled({ ...state, capturingShortcut: input.action, actionError: null }, [{ type: "capture-shortcut", capturing: input.action !== null }]);
    }

    case "shortcut.captured": {
      const action = state.capturingShortcut;
      if (!action) return settled(state);
      if (input.binding === null) return settled({ ...state, capturingShortcut: null }, stopCapture(state));
      return reduceSettings(state, { type: "view.set-shortcut", action, binding: input.binding });
    }

    case "view.inspect-subagent": {
      const taskId = targetId(state, input.taskId);
      const subagent = taskId ? state.subagents[taskId]?.find((candidate) => candidate.id === input.subagentId) : undefined;
      return subagent && !subagent.activity.length
        ? settled(state, [{ type: "load-subagent-activity", taskId: taskId!, subagentId: subagent.id }])
        : settled(state);
    }

    case "subagent.activity.loaded": {
      const held = state.subagents[input.taskId];
      if (!held?.some((subagent) => subagent.id === input.subagentId)) return settled(state);
      const stored = new Set(input.activity.map((item) => item.id));
      return settled(withSubagents(state, input.taskId, held.map((subagent) => subagent.id === input.subagentId
        ? { ...subagent, activity: [...input.activity, ...subagent.activity.filter((item) => !stored.has(item.id))] }
        : subagent)));
    }

    case "view.set-capture-options": {
      const next = { ...state, captureSound: input.options.sound, captureFocus: input.options.focus };
      if (next.captureSound === state.captureSound && next.captureFocus === state.captureFocus) return settled(state);
      return settled(next, [...persistView(next), { type: "apply-capture-options", options: input.options }]);
    }

    case "view.set-chrome-browser":
    case "view.set-computer-use": case "view.set-browser-tools": case "view.set-notifications": {
      const field = { "view.set-chrome-browser": "chromeBrowser", "view.set-computer-use": "computerUse", "view.set-browser-tools": "browserTools", "view.set-notifications": "notifications" }[input.type] as "chromeBrowser" | "computerUse" | "browserTools" | "notifications";
      if (state[field] === input.enabled) return settled(state);
      const next = { ...state, [field]: input.enabled };
      return settled(next, persistView(next));
    }

    case "view.set-session-panel-open": {
      if (state.sessionPanelOpen === input.open) return settled(state);
      const next = { ...state, sessionPanelOpen: input.open };
      return settled(next, [{ type: "persist-preferences", preferences: viewPreferences(next) }]);
    }

    case "view.set-settings-open": {
      const owner = dockOwner(state);
      const section = input.section && isSettingsSection(input.section) ? input.section : null;
      const settings = {
        ...state,
        settingsOpen: input.open,
        settingsSection: input.open ? section : null,
        settingsFocus: input.open && section ? input.settingId ?? null : null,
        ...(input.open ? {} : { computerUseSetup: false, capturingShortcut: null }),
      };
      /** Settings are drawn in the window, so a page that was in front cannot be left holding the keys. */
      return settled(input.open ? withDock(settings, owner, { open: false, expanded: false }) : settings, input.open ? TAKE_KEYS : stopCapture(state));
    }
  }
}
