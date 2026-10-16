/** Where a newer build of the app stands, from found through downloaded. `idle` covers up to date, unchecked, and copies that cannot update themselves. */
export type AppUpdate =
  | { status: "idle" }
  | { status: "available"; version: string }
  /** `percent` is a whole number from 0 to 100. */
  | { status: "downloading"; version: string; percent: number }
  | { status: "ready"; version: string };

export const NO_APP_UPDATE: AppUpdate = { status: "idle" };

/** The build a computer runs, and whether it can move itself to a newer one. */
export type AppBuild = { version: string; selfUpdating: boolean };

/**
 * A standing ask, usually from another computer, to move to the newest build: it downloads, then
 * installs once nothing is running there. `failed` says why the last one stopped.
 */
export type AppUpdateRequest =
  | { status: "waiting" }
  | { status: "installing"; version: string }
  | { status: "failed"; message: string };
