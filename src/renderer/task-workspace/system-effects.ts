import { WORKSPACE_ERRORS } from "../../application/workspace-reducer";
import type { RemoteEffect } from "../../application/remote-commands";
import type { EngineStatus } from "../../domain/agent-engine";
import type { CliStatus } from "../../domain/cli";
import type { ComputerUsePermissions } from "../../domain/computer-use";
import type { PlanUsage } from "../../domain/plan-usage";
import { errorMessage, reportedMessage } from "./errors";
import { runRemoteEffect } from "./mobile-bridge";
import { reportFailure, type EffectHandlers, type EffectHost } from "./effect-host";

/** The bridge's own settings, each of which answers with the whole of what the bridge is doing. */
const changeBridge = async (effect: RemoteEffect, { dispatch, desktop }: EffectHost) => {
  try {
    await dispatch({ type: "remote.changed", remote: await runRemoteEffect(effect, desktop) });
  } catch (error) {
    await dispatch({ type: "action.failed", message: errorMessage(error) });
  }
};

/** Where every engine stands: asked outright, or answered by an engine's own sign-in once it is over. */
async function readEngines(ask: () => Promise<EngineStatus>, { dispatch }: EffectHost) {
  try {
    await dispatch({ type: "engine.status", status: await ask() });
  } catch (error) {
    await dispatch({ type: "engine.failed", message: errorMessage(error) });
  }
}

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

/** What the window itself, its schedules and its bridge are told, none of which belongs to a thread. */
export const systemEffects = {
  "schedule-snooze-expiry": (effect, host) => {
    host.scheduleSnoozeExpiry(effect.at);
  },

  "automation.save": (effect, host) => reportFailure(host, host.desktop.saveAutomation(effect.draft)),

  "automation.update": (effect, host) => reportFailure(host, host.desktop.updateAutomation(effect.taskId, effect.patch)),

  "automation.delete": (effect, host) => reportFailure(host, host.desktop.deleteAutomation(effect.taskId)),

  "automation.run-now": (effect, host) => reportFailure(host, host.desktop.runAutomationNow(effect.taskId).then(async (status) => {
    if (status === "busy" || status === "skipped") await host.dispatch({ type: "action.failed", message: WORKSPACE_ERRORS.busyAutomation });
  })),

  "automation.ack": (effect, { desktop }) => {
    desktop.acknowledgeAutomation(effect.ack);
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

  "remote.set-enabled": changeBridge,
  "remote.create-pairing-code": changeBridge,
  "remote.revoke-device": changeBridge,
  "remote.refresh": changeBridge,

  "engine.reload-settings": async (_effect, { dispatch, desktop }) => {
    try { desktop.send({ type: "reload-settings" }); }
    catch (error) { await dispatch({ type: "engine.settings-reload-status", status: "failed", message: errorMessage(error) }); }
  },

  "computer-use.read": (_effect, host) => readComputerUse(() => host.desktop.computerUsePermissions(), host),

  "computer-use.enable": (effect, host) => readComputerUse(() => host.desktop.enableComputerUse(effect.permission), host, true),

  "computer-use.restart": (_effect, { desktop }) => {
    desktop.restartForComputerUse();
  },

  "read-plan-usage": async (effect, { dispatch, desktop }) => {
    const usage = await desktop.planUsage(effect.engine).catch((cause): PlanUsage => ({ status: "unavailable", message: reportedMessage(cause) }));
    await dispatch({ type: "usage.reported", engine: effect.engine, read: effect.read, usage });
  },

  "cli.read": (_effect, host) => readCli(() => host.desktop.cliStatus(), host),

  "cli.install": (_effect, host) => readCli(() => host.desktop.installCli(), host),

  "cli.uninstall": (_effect, host) => readCli(() => host.desktop.uninstallCli(), host),

  "engine.read": (effect, host) => readEngines(() => host.desktop.engineStatus(effect.refresh), host),

  "engine.sign-in": (effect, host) => readEngines(() => host.desktop.signInEngine(effect.engine), host),
} satisfies Partial<EffectHandlers>;
