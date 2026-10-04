/** Where a newer build of the app stands, from found through downloaded. `idle` covers up to date, unchecked, and copies that cannot update themselves. */
export type AppUpdate =
  | { status: "idle" }
  | { status: "available"; version: string }
  /** `percent` is a whole number from 0 to 100. */
  | { status: "downloading"; version: string; percent: number }
  | { status: "ready"; version: string };

export const NO_APP_UPDATE: AppUpdate = { status: "idle" };
