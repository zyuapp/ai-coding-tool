import type { CliStatus } from "../domain/cli.js";
import type { ComputerUsePermissions } from "../domain/computer-use.js";
import { reportedMessage } from "../contracts/errors.js";
import type { EffectHandlers, EffectHost } from "./effect-host.js";
import type { HostModule } from "./host-module.js";

/** Where the terminal command stands, after reading it or after changing it. */
async function readCli(ask: () => Promise<CliStatus>, { dispatch }: EffectHost) {
  try {
    await dispatch({ type: "cli.read-status", status: await ask() });
  } catch (error) {
    await dispatch({ type: "cli.failed", message: reportedMessage(error) });
  }
}

/** What the platform allows, whether it was asked outright or after the user was sent to grant one. */
async function readComputerUse(ask: () => Promise<ComputerUsePermissions>, { dispatch }: EffectHost, enabling?: true) {
  try {
    await dispatch({ type: "computer-use.permissions", permissions: await ask(), ...(enabling ? { enabling } : {}) });
  } catch (error) {
    await dispatch({ type: "computer-use.failed", message: reportedMessage(error), ...(enabling ? { enabling } : {}) });
  }
}

/** What the window itself, its schedules and its settings are told, none of which belongs to a thread. */
export const systemEffects = {
  "schedule-limit-reset": (effect, host) => {
    host.scheduleLimitReset(effect.at);
  },
  "schedule-snooze-expiry": (effect, host) => {
    host.scheduleSnoozeExpiry(effect.at);
  },
  "schedule-toast-dismissal": (effect, host) => {
    host.scheduleToastDismissal(effect.id, effect.at);
  },

  "focus-window": (_effect, { desktop }) => {
    desktop.focusWindow();
  },

  "close-window": (_effect, { desktop }) => {
    desktop.closeWindow();
  },

  "apply-shortcuts": (effect, { desktop }) => {
    desktop.setShortcuts(effect.overrides);
  },

  "apply-capture-options": (effect, { desktop }) => {
    desktop.setCaptureOptions(effect.options);
  },

  "capture-shortcut": (effect, { desktop }) => {
    desktop.setShortcutCapture(effect.capturing);
  },

  "announce-thread": (effect, { desktop }) => {
    desktop.announceThread(effect.notice);
  },

  "computer-use.read": (_effect, host) => readComputerUse(() => host.desktop.computerUsePermissions(), host),

  "computer-use.enable": (effect, host) => readComputerUse(() => host.desktop.enableComputerUse(effect.permission), host, true),

  "computer-use.restart": (_effect, { desktop }) => {
    desktop.restartForComputerUse();
  },

  "cli.read": (_effect, host) => readCli(() => host.desktop.cliStatus(), host),

  "cli.install": (_effect, host) => readCli(() => host.desktop.installCli(), host),

  "cli.uninstall": (_effect, host) => readCli(() => host.desktop.uninstallCli(), host),
} satisfies Partial<EffectHandlers>;

export const systemHost = { effects: systemEffects } satisfies HostModule;
