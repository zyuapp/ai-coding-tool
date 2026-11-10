import type { UpdatePort } from "../contracts/update-port.js";
import { NO_APP_UPDATE, type AppBuild } from "../domain/app-update.js";
import type { DesktopEvents } from "./desktop-events.js";
import { answeredOnce } from "./headless.js";
import type { ServeUpdater } from "./serve-updates.js";
import type * as Updates from "./updates.js";

/** The app's own updates, asked and answered with dialogs on this screen. */
export function updateDesktop(updater: typeof Updates, host: { events: DesktopEvents; updates: Updates.UpdateHost; launchedUpdate: string | null }): UpdatePort["runtime"] {
  return {
    checkForUpdates: (quiet) => {
      const stage = updater.appUpdate().status;
      if (quiet && (stage === "downloading" || stage === "ready")) return;
      void updater.checkForUpdates(host.updates, { userRequested: !quiet }).catch((error) => console.error("Update check failed:", error));
    },
    appUpdate: async () => updater.appUpdate(),
    launchedUpdate: answeredOnce(host.launchedUpdate),
    onAppUpdate: (listener) => host.events.on("update:changed", listener),
    appBuild: async () => updater.appBuild(),
    downloadUpdate: (unattended) => { void updater.downloadUpdate(host.updates, { unattended }); },
    installUpdate: (unattended) => { if (unattended) updater.installUpdate(host.updates, { unattended }); else void updater.confirmInstall(host.updates); },
  };
}

/** A server replaces its own app when it can, with nobody at a screen to ask. */
export function headlessUpdateDesktop(host: { events: DesktopEvents; updates: ServeUpdater | null; build: AppBuild | null; launchedUpdate: string | null }): UpdatePort["runtime"] {
  const { updates } = host;
  return {
    checkForUpdates: () => { void updates?.check(); },
    appUpdate: async () => updates?.state() ?? NO_APP_UPDATE,
    appBuild: async () => host.build,
    launchedUpdate: answeredOnce(host.launchedUpdate),
    onAppUpdate: (listener) => host.events.on("update:changed", listener),
    downloadUpdate: () => { void updates?.download(); },
    installUpdate: () => { void updates?.install(); },
  };
}
