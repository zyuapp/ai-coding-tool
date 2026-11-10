import { NO_APP_UPDATE, type AppBuild, type AppUpdate, type AppUpdateRequest } from "../../domain/app-update.js";

export type AppUpdatesState = {
  /** A newer build of the app, as the updater in main last reported it. */
  appUpdate: AppUpdate;
  /** The build this computer runs, which paired computers show. Null until main says, and on hosts that cannot. */
  appBuild: AppBuild | null;
  /** An update asked of this computer that waits to install, or why the last one stopped. Session-only. */
  appUpdateRequest: AppUpdateRequest | null;
  /** True from the first launch after an app update until every engine it needs has been upgraded. */
  engineUpgradesOwed: boolean;
};

export function initialAppUpdatesState(): AppUpdatesState {
  return { appUpdate: NO_APP_UPDATE, appBuild: null, appUpdateRequest: null, engineUpgradesOwed: false };
}
