/**
 * The sidebar's two shapes. `projects` groups threads under the folder they belong to; `activity`
 * ranks them by what wants the user, and folders play no part in it.
 */
export type SidebarMode = "projects" | "activity";

/** Every foldable list in the sidebar, across both modes. */
export const SIDEBAR_SECTIONS = ["projects", "recents", "priority", "running", "threads"] as const;

export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];

export type SidebarSections = Record<SidebarSection, boolean>;

/** Every list unfolded, which is how the app starts before the user folds anything. */
export const OPEN_SIDEBAR_SECTIONS: SidebarSections = { projects: true, recents: true, priority: true, running: true, threads: true };

export function isSidebarMode(value: unknown): value is SidebarMode {
  return value === "projects" || value === "activity";
}

export function isSidebarSection(value: unknown): value is SidebarSection {
  return SIDEBAR_SECTIONS.includes(value as SidebarSection);
}
