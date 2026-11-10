import type { AppBuild, AppUpdate } from "../domain/app-update.js";

export type UpdatePort = {
  runtime: {
    /** `quiet` looks without a dialog for any answer, for a check nobody at this screen asked for. */
    checkForUpdates(quiet?: boolean): void;
    /** Where a newer build stands, and each change to it from then on. */
    appUpdate(): Promise<AppUpdate>;
    onAppUpdate(listener: (update: AppUpdate) => void): () => void;
    /** The version this launch updated the app to, answered once; null when it is not the first launch since an update. */
    launchedUpdate(): Promise<string | null>;
    /** The build this computer runs, or null for a host that cannot say. */
    appBuild(): Promise<AppBuild | null>;
    /** `unattended` keeps a failure off this screen, for a download asked from another computer. */
    downloadUpdate(unattended?: boolean): void;
    /** Asks to restart, then quits and installs the downloaded update. `unattended` installs without asking. */
    installUpdate(unattended?: boolean): void;
  };
};
