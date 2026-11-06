/** Every foldable list in the sidebar, which ranks threads by what wants the user. */
export const SIDEBAR_SECTIONS = ["priority", "running", "threads", "snoozed"] as const;

export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];

export type SidebarSections = Record<SidebarSection, boolean>;

/** Every list unfolded, which is how the app starts before the user folds anything. */
export const OPEN_SIDEBAR_SECTIONS: SidebarSections = { priority: true, running: true, threads: true, snoozed: true };

export function isSidebarSection(value: unknown): value is SidebarSection {
  return SIDEBAR_SECTIONS.includes(value as SidebarSection);
}
