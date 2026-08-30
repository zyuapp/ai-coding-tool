/**
 * Every control Settings draws, as data. A row on a settings page is rendered from an entry here,
 * so a control the app grows is one the jump panel can already find.
 */
import { SETTINGS_SECTIONS, type SettingsSection } from "./settings-section.js";

/** The name a page goes by, in the sidebar and in the jump panel alike. */
export const SETTINGS_PAGE_LABELS: Record<SettingsSection, string> = {
  general: "General",
  appearance: "Appearance",
  usage: "Usage",
  engines: "Engines",
  worktrees: "Worktrees",
  shortcuts: "Shortcuts",
  "computer-use": "Computer use",
  browser: "Browser",
  phone: "Phone",
  archive: "Archived threads",
};

/** What a page answers to besides its own name. */
const PAGE_KEYWORDS: Record<SettingsSection, string> = {
  general: "cli terminal command notifications chrome",
  appearance: "theme colours colors dark light font text size",
  usage: "plan limits quota tokens spend",
  engines: "claude codex sign in account model provider",
  worktrees: "git branch checkout managed disk",
  shortcuts: "keyboard keys binding keystroke rebind",
  "computer-use": "accessibility screen recording permissions automation apps",
  browser: "session cookies sign out sites origins clear data",
  phone: "mobile remote pairing tailscale device qr",
  archive: "archived deleted restore threads trash",
};

/** One control on a settings page, and the words a search may reach it by. */
type SettingsControl = {
  readonly id: string;
  readonly section: SettingsSection;
  /** What the row calls itself. The page and the jump panel both draw this. */
  readonly label: string;
  readonly keywords: string;
};

export const SETTINGS_CONTROLS = [
  { id: "general.cli", section: "general", label: "aic", keywords: "cli terminal command install shell path open folder" },
  { id: "general.notifications", section: "general", label: "Desktop notifications", keywords: "alert banner notify sound away" },
  { id: "general.chrome-browser", section: "general", label: "Claude in Chrome", keywords: "extension browser chrome experimental" },
  { id: "general.concise-replies", section: "general", label: "Concise replies", keywords: "short brief terse length verbose waffle answers style" },
  { id: "appearance.theme", section: "appearance", label: "Colours", keywords: "theme colors palette dark light auto mode appearance" },
  { id: "appearance.ui-font", section: "appearance", label: "Interface", keywords: "font typeface family ui interface sans" },
  { id: "appearance.mono-font", section: "appearance", label: "Code and terminal", keywords: "font typeface family monospace code terminal shell diff" },
  { id: "appearance.reading-size", section: "appearance", label: "Conversation text", keywords: "text size font bigger smaller reading message" },
  { id: "appearance.terminal-size", section: "appearance", label: "Terminal text", keywords: "text size font bigger smaller terminal shell" },
  { id: "computer-use.availability", section: "computer-use", label: "Computer use", keywords: "automation control apps see operate switch" },
  { id: "computer-use.accessibility", section: "computer-use", label: "Accessibility", keywords: "permission macos click type navigate" },
  { id: "computer-use.screen-recording", section: "computer-use", label: "Screen & System Audio Recording", keywords: "permission macos screenshot capture window" },
  { id: "browser.availability", section: "browser", label: "Browser use", keywords: "panel pages agent switch web" },
  { id: "phone.availability", section: "phone", label: "Phone access", keywords: "mobile remote server pair device switch" },
] as const satisfies readonly SettingsControl[];

/** The id of a control the app draws, which is what a settings row and a jump row are keyed by. */
export type SettingId = (typeof SETTINGS_CONTROLS)[number]["id"];

const BY_ID = new Map(SETTINGS_CONTROLS.map((control) => [control.id as SettingId, control]));

/** The entry a row draws itself from. Every {@link SettingId} has one. */
export function settingControl(id: SettingId): SettingsControl {
  return BY_ID.get(id)!;
}

/** One thing the jump panel can offer: a settings page, or a control on one. */
export type SettingsJumpOption = {
  /** Unique against a thread id, so the panel can key its rows by it. */
  id: string;
  section: SettingsSection;
  /** The control to land on, or null when the row is the page itself. */
  settingId: SettingId | null;
  title: string;
  /** The page the control sits on, which a page's own row leaves out. */
  page: string | null;
  keywords: string;
};

/** Every page, then every control, which is the order two equal matches are offered in. */
export const SETTINGS_JUMP_OPTIONS: SettingsJumpOption[] = [
  ...SETTINGS_SECTIONS.map((section): SettingsJumpOption => ({
    id: `settings:${section}`,
    section,
    settingId: null,
    title: SETTINGS_PAGE_LABELS[section],
    page: null,
    keywords: PAGE_KEYWORDS[section],
  })),
  ...SETTINGS_CONTROLS.map((control): SettingsJumpOption => ({
    id: `settings:${control.id}`,
    section: control.section,
    settingId: control.id,
    title: control.label,
    page: SETTINGS_PAGE_LABELS[control.section],
    keywords: control.keywords,
  })),
];
