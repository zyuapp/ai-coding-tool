import type { InstalledApp } from "../../contracts/ipc.js";

/** What the desktop around the window says, and the picture enlarged over it. */
export type DesktopState = {
  /** The applications this machine has, or null before any list has asked for them. */
  installedApps: InstalledApp[] | null;
  focused: boolean;
  viewingImage: string | null;
  /** The pictures shown beside the enlarged one, which the arrow keys step through. */
  viewingGallery: string[];
};

export function initialDesktopState(): DesktopState {
  return { installedApps: null, focused: true, viewingImage: null, viewingGallery: [] };
}
