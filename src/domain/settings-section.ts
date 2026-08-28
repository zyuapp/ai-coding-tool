/** Every page Settings draws, in the order its sidebar lists them. */
export const SETTINGS_SECTIONS = ["general", "appearance", "usage", "engines", "worktrees", "shortcuts", "computer-use", "browser", "phone", "archive"] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function isSettingsSection(value: unknown): value is SettingsSection {
  return SETTINGS_SECTIONS.includes(value as SettingsSection);
}
