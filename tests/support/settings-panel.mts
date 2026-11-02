import React, { act } from "react";
import { deriveView, emptyWorkspaceState, type WorkspaceState } from "../../src/application/workspace-state.ts";
import { reduce } from "../../src/application/workspace-reducer.ts";
import type { SettingsSection } from "../../src/domain/settings-section.ts";
import type { SettingsPanelProps } from "../../src/renderer/components/SettingsPanel.tsx";
import { mobileSettingsProps } from "./mobile-desktop.mts";
import { item, mount, query } from "./renderer-dom.mts";
import { settleUntil } from "./settle.mts";

const { SettingsPanel } = await import("../../src/renderer/components/SettingsPanel.tsx");

export type SettingsTestOverrides = Partial<SettingsPanelProps> & {
  /** The page and control the sheet opens on, landed through the workspace reducer. */
  initialSection?: SettingsSection;
  initialSetting?: string;
  captureSound?: boolean;
  captureFocus?: boolean;
  onSetTheme?: () => void;
  onSetCaptureOptions?: () => void;
};

const settingsOpened = (state: WorkspaceState, section: SettingsSection, settingId?: string | null) =>
  reduce(state, { type: "view.set-settings-open", open: true, section, ...(settingId ? { settingId } : {}) }).state;

/** The sheet with its page and mark held by the workspace reducer, the way the app holds them. */
function ReducedSettings({ initialSection = "general", initialSetting, ...props }: SettingsTestOverrides & Omit<SettingsPanelProps, "section" | "settingMark" | "onLand">) {
  const [state, setState] = React.useState(() => settingsOpened(emptyWorkspaceState(), initialSection, initialSetting));
  return React.createElement(SettingsPanel, {
    ...props,
    section: state.settingsSection ?? "general",
    settingMark: state.settingsFocus,
    onLand: (section, settingId) => setState((current) => settingsOpened(current, section, settingId)),
  });
}

export function renderSettingsPanel(overrides: SettingsTestOverrides) {
  return React.createElement(ReducedSettings, {
    onClose() {},
    archivedThreads: [], worktreeSettings: deriveView(emptyWorkspaceState()).worktreeSettings, worktreeManagementError: null, worktreeManagementNotice: null,
    cli: deriveView(emptyWorkspaceState()).cli, onReadCli() {}, onSetCliInstalled() {},
    planUsage: deriveView(emptyWorkspaceState()).planUsage, onReadPlanUsage() {},
    computerUseAccess: deriveView(emptyWorkspaceState()).computerUsePermissions, onEnableComputerUse() {}, onRestartForComputerUse() {},
    theme: "aicodingtool-dark",
    themeMode: "auto",
    uiFont: "system",
    monoFont: "system",
    readingSize: 15,
    terminalSize: 13,
    allowedOrigins: [],
    chromeBrowser: false, computerUse: true, browserTools: true, notifications: true,
    agentSettingsReload: "idle", onReloadAgentSettings() {},
    engineAccess: { claude: { access: "ready" }, codex: { access: "ready" } }, engineChecking: false, engineUpdating: null,
    remoteChecking: false,
    shortcuts: [],
    capturingShortcut: null,
    desktopShortcutUnavailable: null,
    onSetThemeFamily() {},
    onSetThemeMode() {},
    onSetUiFont() {},
    onSetMonoFont() {},
    onSetReadingSize() {},
    onSetTerminalSize() {},
    onSetChromeBrowser() {}, onSetComputerUse() {}, onSetBrowserTools() {}, onSetNotifications() {},
    onCheckForUpdates() {}, onOpenSourceLicenses() {},
    onRestoreThread() {}, onClearArchive() {}, onRefreshEngines() {}, onSignInEngine() {}, onUpdateEngine() {}, onRefreshWorktrees() {}, onWorktreeCommand() {},
    onClearBrowserData() {},
    onCaptureShortcut() {},
    onSetShortcut() {},
    onResetShortcuts() {}, ...mobileSettingsProps,
    ...overrides,
  });
}

/** Opens settings on one of its pages, named the way its sidebar names it. */
export type MountView = Awaited<ReturnType<typeof mount>>;

export async function openSettingsPage(view: MountView, name: string) {
  await act(async () => { query<HTMLButtonElement>(view.container, ".sidebar-settings").click(); });
  await settleUntil(() => Boolean(view.container.querySelector(".settings-sidebar")), "settings never opened");
  await act(async () => { item([...view.container.querySelectorAll<HTMLButtonElement>(".settings-sidebar nav button")].find((button) => button.textContent === name)).click(); });
}
