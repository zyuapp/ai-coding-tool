import { reportFailure, type EffectHandlers } from "./effect-host.js";
import type { HostModule } from "./host-module.js";

/** Files and folders opened out of the window, and the images saved from it. */
export const surfaceEffects = {
  "image.download": (effect, host) => reportFailure(host, host.desktop.downloadImage(effect.source)),

  "file.open": (effect, host) => reportFailure(host, host.desktop.openFile(effect.roots, effect.path, effect.line)),

  /** An application scan that fails leaves the menu with nothing to offer rather than an error. */
  "app.list": async (_effect, { dispatch, desktop }) => {
    await dispatch({ type: "apps.listed", apps: await desktop.listApps().catch(() => []) });
  },

  "app.open-folder": (effect, host) => reportFailure(host, host.desktop.openFolderInApp(effect.appId, effect.root)),

  "app.open-source-licenses": (_effect, host) => reportFailure(host, host.desktop.openSourceLicenses()),
} satisfies Partial<EffectHandlers>;

export const surfaceHost = { effects: surfaceEffects } satisfies HostModule;
