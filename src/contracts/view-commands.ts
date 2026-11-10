import type { AutomationFields } from "../domain/automation.js";
import { isOverviewSection, type OverviewSection } from "../domain/coordination.js";
import type { ShortcutSurface } from "../domain/shortcuts.js";
import { isCaptureOptions, type CaptureOptions } from "../domain/capture.js";
import type { FindTarget } from "../domain/find.js";
import { isSettingsSection, type SettingsSection } from "../domain/settings-section.js";
import { isSidebarSection, type SidebarSection } from "../domain/sidebar.js";
import { isThemeMode, type ThemeMode } from "../domain/theme.js";
import { isAgentEngine, isModelId, type AgentEngine, type AgentModel } from "../domain/agent-engine.js";
import { isSubagentGroup, type SubagentGroup } from "../domain/run.js";
import { boolean, literals, nullable, nullableText, number, object, optional, optionalBoolean, optionalText, record, step, text, type Declarations } from "./command-declaration.js";
import * as phone from "./phone-commands.js";
import { startTitle } from "./task-commands.js";

/**
 * Where a thread was left reading: the message held at the top of the view and how far into it the
 * view sat, or null for its foot. A session's memory only, so it is never persisted.
 */
export type ReadingPoint = { anchor: string; depth: number } | null;

/** Presentation state. Nothing here reaches the agent process; only `view.set-session-panel-open` outlives the window. */
export type ViewCommand =
  /** A restored desktop view has installed the listeners needed by its input preferences. */
  | { type: "view.mounted" }
  | { type: "view.set-prompt"; taskId?: string; prompt: string }
  /**
   * Where a thread was left reading: the message held at the top of its view and how far into it,
   * or null for its foot. Reported by the transcript as its reader settles, and put back when the
   * thread is opened again.
   */
  | { type: "view.reading-point"; taskId: string; point: ReadingPoint }
  | { type: "view.dismiss-action-error" }
  /** Closes the notice about threads this build cannot read. It returns on the next launch. */
  | { type: "view.dismiss-hidden-tasks" }
  /** Takes a toast down, whether the user closed it or its time ran out. */
  | { type: "view.dismiss-toast"; id: number }
  /** Holds a thread's unsaved automation edits, with the saved fields they began from; edits equal to those drop it. */
  | { type: "view.edit-automation"; taskId: string; base: AutomationFields; fields: AutomationFields }
  /** Stops the toasts' time while the pointer or the caret is on them; letting go gives each its time again. */
  | { type: "view.hold-toasts"; held: boolean }
  /** Opens the folder editor on one project, or closes whichever it was on with a null. */
  | { type: "view.edit-project"; projectId: string | null }
  /**
   * Asks the current thread to move, which opens the confirmation. A null closes it. The move only
   * happens when `task.set-worktree` follows, which the confirmation sends.
   */
  | { type: "view.move-worktree"; worktree: boolean | null }
  /** Opens the naming dialog for a fork of a thread, or closes it with a null. */
  | { type: "view.fork-name"; sourceId: string | null; worktree?: boolean }
  /** Forks the thread the naming dialog is open on, under the name typed there. */
  | { type: "view.fork-confirm"; title: string }
  /** Asks before archiving a thread, or closes the question with a null. Only `view.archive-confirm` archives it. */
  | { type: "view.archive-prompt"; threadId: string | null }
  /** Archives the thread the archive confirmation is open on. */
  | { type: "view.archive-confirm" }
  /** Folds one of the sidebar's lists, whichever mode draws it. */
  | { type: "view.set-section-open"; section: SidebarSection; open: boolean }
  /** Folds the sidebar's subagent list, or one status heading in the Subagents panel. */
  | { type: "view.set-subagent-group"; group: SubagentGroup; open: boolean }
  /** Folds or unfolds one group of a coordinator's Overview, or shows every thread in it. */
  | { type: "view.set-overview-group"; taskId: string; group: OverviewSection; open?: boolean; all?: boolean }
  | { type: "view.set-model-favorite"; engine: AgentEngine; model: AgentModel; favorite: boolean }
  /** Puts a project picked to start a thread at the front of the new-thread picker's Recent list. */
  | { type: "view.remember-project"; projectId: string }
  /** The theme the window paints in. An id the app does not ship is ignored. */
  | { type: "view.set-theme"; theme: string }
  /** The family to paint, on whichever ground the mode in effect asks for. */
  | { type: "view.set-theme-family"; family: string; systemDark: boolean }
  /** The ground to paint on, which "auto" hands back to the system's own appearance. */
  | { type: "view.set-theme-mode"; mode: ThemeMode; systemDark: boolean }
  /** The system changed its appearance, which only a window set to "auto" repaints for. */
  | { type: "view.system-scheme"; dark: boolean }
  /** The families the window sets type in. An id the app neither ships nor can name is ignored. */
  | { type: "view.set-ui-font"; font: string }
  | { type: "view.set-mono-font"; font: string }
  /** The two sizes that follow the user, in px, clamped to the range each one offers. */
  | { type: "view.set-reading-size"; size: number }
  | { type: "view.set-terminal-size"; size: number }
  /** Narrows the activity lists to one project, or null for every project. */
  | { type: "view.set-activity-project"; projectId: string | null }
  | { type: "view.set-sidebar-open"; open: boolean }
  | { type: "view.set-session-panel-open"; open: boolean }
  /** Zen mode: the thread on screen and its composer, with the rest of the window hidden. Only a thread with messages can enter it. */
  | { type: "view.set-zen"; zen: boolean }
  | { type: "view.set-capture-options"; options: CaptureOptions }
  | { type: "view.set-chrome-browser"; enabled: boolean }
  | { type: "view.set-computer-use"; enabled: boolean }
  | { type: "view.set-browser-tools"; enabled: boolean }
  | { type: "view.set-notifications"; enabled: boolean }
  /** Opening a subagent's detail, which is when its activity is read out of the store. */
  | { type: "view.inspect-subagent"; taskId?: string; subagentId: string }
  /**
   * `section` opens settings on one page; without it the sheet opens where it opens. `settingId`
   * names a control on that page for the sheet to scroll to and mark.
   */
  | { type: "view.set-settings-open"; open: boolean; section?: SettingsSection; settingId?: string }
  | { type: "view.set-usage-computer"; computerId: string | null }
  /**
   * Closes whatever is in front, the way ⌘W does everywhere else on the desktop: settings, then the
   * page the browser panel is showing, then the dock tab, then the dock. Only with nothing left in
   * front of it does the window itself go.
   */
  | { type: "view.close-tab" }
  /**
   * ⌘W's inverse: another page while the panel shows one, another shell while it shows one, and a
   * shell when it shows neither.
   */
  | { type: "view.new-tab" }
  /** The right dock: which panels are open as tabs, and which of them is showing. */
  | { type: "view.set-dock-open"; open: boolean }
  /** Whether the dock takes the whole workspace. Expanding it also shows it. */
  | { type: "view.set-dock-expanded"; expanded: boolean }
  /** `taskId` names a thread tab in the dock the panel is about, rather than the dock's own thread. */
  | { type: "view.open-dock-panel"; panel: string; taskId?: string }
  | { type: "view.close-dock-panel"; panel: string }
  /** Closes a thread's tab in the coordinator's dock. The thread itself goes on working. */
  | { type: "view.close-thread-tab"; taskId: string }
  /** Opens the workflow panel on one workflow. The dock remembers which, so leaving and coming back lands back on it. */
  | { type: "view.open-workflow"; workflowId: string }
  | { type: "view.select-dock-tab"; tab: string }
  /** The tab in that position, counting from zero, with -1 for the last one. */
  | { type: "view.select-dock-index"; index: number }
  | { type: "view.set-menu"; menu: string | null }
  /** Moves the visit cursor without recording a visit, so the trail behind and ahead survives. */
  | { type: "view.go-back" }
  | { type: "view.go-forward" }
  | { type: "view.set-focused"; focused: boolean }
  /**
   * Puts the caret in the composer. Components watch the token rather than being told to focus. A
   * recovered caret is the app tidying up after a view went, not the user asking for the keys.
   */
  | { type: "view.focus-composer"; recover?: boolean }
  /**
   * What a keystroke asked for. The action is routed here rather than in the window, because only
   * state knows whether ⌘[ means the thread you came from or the page before this one.
   */
  | { type: "view.shortcut"; action: string; surface: ShortcutSurface }
  /** Esc. What it dismisses depends on which layer is open and which surface holds the caret. */
  | { type: "view.escape" }
  /** Binds an action, or unbinds it with a null. Whoever else held the keystroke loses it. */
  | { type: "view.set-shortcut"; action: string; binding: string | null }
  | { type: "view.reset-shortcuts" }
  /** Waits for the next keystroke to bind to `action`, or stops waiting with a null. */
  | { type: "view.capture-shortcut"; action: string | null }
  | { type: "view.dismiss-computer-use-setup" }
  | { type: "view.refresh-environment" }
  /** Which dock tab the keyboard is in, with a null when it has gone back to the thread. Only find reads it. */
  | { type: "view.dock-keys"; tab: string | null }
  /**
   * Find. What is searched is whatever the keyboard is on: the page while one has the keys, else the
   * dock view holding them, else the thread being read. `target` names it outright for a caller that
   * already knows.
   */
  | { type: "view.find-open"; target?: FindTarget }
  | { type: "view.find-query"; query: string }
  /** The match after this one, or the one before it, wrapping at both ends. */
  | { type: "view.find-step"; delta: -1 | 1 }
  | { type: "view.find-close" }
  /**
   * The jump panel: the threads and settings a name matches, and the one the user lands on. It opens
   * empty, so nothing of the last search survives being closed.
   */
  | { type: "view.jump-open" }
  | { type: "view.jump-query"; query: string }
  /** The row after this one, or the one before it, wrapping at both ends. */
  | { type: "view.jump-step"; delta: -1 | 1 }
  /** Opens the thread the row names and closes the panel. */
  | { type: "view.jump-choose"; taskId: string }
  /** Opens the settings page the row names, on the control it names, and closes the panel. */
  | { type: "view.jump-choose-setting"; section: SettingsSection; settingId?: string }
  | { type: "view.jump-close" };

const readingPoint = nullable(object({ anchor: text, depth: number }));
const automationFields = object<AutomationFields>({ schedule: text, prompt: text, surfaceWhen: text, endsWhen: text });

export function isFindTarget(value: unknown): value is FindTarget {
  if (!record(value)) return false;
  switch (value.kind) {
    case "thread": return nullableText(value.taskId);
    case "browser": return text(value.tabId);
    case "terminal": return text(value.terminalId);
    case "review": return text(value.owner);
    case "panel": return text(value.owner) && text(value.panel);
    default: return false;
  }
}

const setsPrompt: phone.PhoneRule = (command) => phone.named(command) && phone.isBlankable(command.prompt, phone.MAX_PROMPT_LENGTH);

export const viewCommands = {
  "view.mounted": { fields: {}, at: "local" },
  "view.set-prompt": { fields: { taskId: optionalText, prompt: text }, at: "local", phone: setsPrompt },
  "view.reading-point": { fields: { taskId: text, point: readingPoint }, at: "local" },
  "view.dismiss-action-error": { fields: {}, at: "local" },
  "view.dismiss-hidden-tasks": { fields: {}, at: "local" },
  "view.dismiss-toast": { fields: { id: number }, at: "local" },
  "view.edit-automation": { fields: { taskId: text, base: automationFields, fields: automationFields }, at: "local" },
  "view.hold-toasts": { fields: { held: boolean }, at: "local" },
  "view.edit-project": { fields: { projectId: nullableText }, at: "local" },
  "view.move-worktree": { fields: { worktree: nullable(boolean) }, at: "local" },
  "view.fork-name": { fields: { sourceId: nullableText, worktree: optionalBoolean }, at: "local" },
  "view.fork-confirm": { fields: { title: startTitle }, at: "local" },
  "view.archive-prompt": { fields: { threadId: nullableText }, at: "local" },
  "view.archive-confirm": { fields: {}, at: "local" },
  "view.set-section-open": { fields: { section: isSidebarSection, open: boolean }, at: "local" },
  "view.set-subagent-group": { fields: { group: isSubagentGroup, open: boolean }, at: "local" },
  "view.set-overview-group": { fields: { taskId: text, group: isOverviewSection, open: optionalBoolean, all: optionalBoolean }, at: "local" },
  "view.set-model-favorite": { fields: { engine: isAgentEngine, model: isModelId, favorite: boolean }, at: "local" },
  "view.remember-project": { fields: { projectId: text }, at: "local" },
  "view.set-theme": { fields: { theme: text }, at: "local" },
  "view.set-theme-family": { fields: { family: text, systemDark: boolean }, at: "local" },
  "view.set-theme-mode": { fields: { mode: isThemeMode, systemDark: boolean }, at: "local" },
  "view.system-scheme": { fields: { dark: boolean }, at: "local" },
  "view.set-ui-font": { fields: { font: text }, at: "local" },
  "view.set-mono-font": { fields: { font: text }, at: "local" },
  "view.set-reading-size": { fields: { size: number }, at: "local" },
  "view.set-terminal-size": { fields: { size: number }, at: "local" },
  "view.set-activity-project": { fields: { projectId: nullableText }, at: "local" },
  "view.set-sidebar-open": { fields: { open: boolean }, at: "local" },
  "view.set-session-panel-open": { fields: { open: boolean }, at: "local" },
  "view.set-zen": { fields: { zen: boolean }, at: "local" },
  "view.set-capture-options": { fields: { options: isCaptureOptions }, at: "local" },
  "view.set-chrome-browser": { fields: { enabled: boolean }, at: "local" },
  "view.set-computer-use": { fields: { enabled: boolean }, at: "local" },
  "view.set-browser-tools": { fields: { enabled: boolean }, at: "local" },
  "view.set-notifications": { fields: { enabled: boolean }, at: "local" },
  "view.inspect-subagent": { fields: { taskId: optionalText, subagentId: text }, at: "thread" },
  "view.set-settings-open": { fields: { open: boolean, section: optional(isSettingsSection), settingId: optionalText }, at: "local" },
  "view.set-usage-computer": { fields: { computerId: nullableText }, at: "local" },
  "view.close-tab": { fields: {}, at: "thread" },
  "view.new-tab": { fields: {}, at: "thread" },
  "view.set-dock-open": { fields: { open: boolean }, at: "thread" },
  "view.set-dock-expanded": { fields: { expanded: boolean }, at: "thread" },
  "view.open-dock-panel": { fields: { panel: text, taskId: optionalText }, at: "thread" },
  "view.close-dock-panel": { fields: { panel: text }, at: "thread" },
  "view.close-thread-tab": { fields: { taskId: text }, at: "thread" },
  "view.open-workflow": { fields: { workflowId: text }, at: "thread" },
  "view.select-dock-tab": { fields: { tab: text }, at: "thread" },
  "view.select-dock-index": { fields: { index: number }, at: "thread" },
  "view.set-menu": { fields: { menu: nullableText }, at: "local" },
  "view.go-back": { fields: {}, at: "local", leaves: true },
  "view.go-forward": { fields: {}, at: "local", leaves: true },
  "view.set-focused": { fields: { focused: boolean }, at: "own" },
  "view.focus-composer": { fields: { recover: optionalBoolean }, at: "local" },
  "view.shortcut": { fields: { action: text, surface: literals("any", "browser", "desktop") }, at: "thread" },
  "view.escape": { fields: {}, at: "thread" },
  "view.set-shortcut": { fields: { action: text, binding: nullableText }, at: "local" },
  "view.reset-shortcuts": { fields: {}, at: "local" },
  "view.capture-shortcut": { fields: { action: nullableText }, at: "local" },
  "view.dismiss-computer-use-setup": { fields: {}, at: "local" },
  "view.refresh-environment": { fields: {}, at: "local" },
  "view.dock-keys": { fields: { tab: nullableText }, at: "thread" },
  "view.find-open": { fields: { target: optional(isFindTarget) }, at: "local" },
  "view.find-query": { fields: { query: text }, at: "local" },
  "view.find-step": { fields: { delta: step }, at: "local" },
  "view.find-close": { fields: {}, at: "local" },
  "view.jump-open": { fields: {}, at: "local" },
  "view.jump-query": { fields: { query: text }, at: "local" },
  "view.jump-step": { fields: { delta: step }, at: "local" },
  "view.jump-choose": { fields: { taskId: text }, at: "select", leaves: true },
  "view.jump-choose-setting": { fields: { section: isSettingsSection, settingId: optionalText }, at: "local" },
  "view.jump-close": { fields: {}, at: "local" },
} satisfies Declarations<ViewCommand>;
