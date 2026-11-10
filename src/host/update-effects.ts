import type { EffectHandlers } from "./effect-host.js";
import type { HostModule } from "./host-module.js";

/** The app's own updates, and the build and update this launch reports on the way up. */
export const updateHost = {
  effects: {
    "app.check-for-updates": (effect, { desktop }) => desktop.checkForUpdates(effect.quiet),

    "app.download-update": (effect, { desktop }) => desktop.downloadUpdate(effect.unattended),

    "app.install-update": (effect, { desktop }) => desktop.installUpdate(effect.unattended),
  } satisfies Partial<EffectHandlers>,

  subscribe: (host) => {
    const { desktop } = host;
    void desktop.appUpdate().then((update) => host.dispatch({ type: "app.update-changed", update })).catch(() => undefined);
    void desktop.appBuild().then((build) => host.dispatch({ type: "app.build", build })).catch(() => undefined);
    void desktop.launchedUpdate().then((version) => version ? host.dispatch({ type: "app.launched", version }) : undefined).catch(() => undefined);
    return desktop.onAppUpdate((update) => void host.dispatch({ type: "app.update-changed", update }));
  },
} satisfies HostModule;
