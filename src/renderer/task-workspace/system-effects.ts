import { WORKSPACE_ERRORS, type WorkspaceEffect } from "../../application/workspace-reducer";
import { errorMessage } from "./errors";
import { runRemoteEffect } from "./mobile-bridge";
import { reportFailure, type EffectHost } from "./effect-host";

/** What the window itself, its schedules and its bridge are told, none of which belongs to a thread. */
export type SystemEffect = Extract<WorkspaceEffect, {
  type: `automation.${string}` | `remote.${string}` | `engine.${string}` | "focus-window" | "close-window" | "apply-shortcuts"
    | "apply-capture-options" | "capture-shortcut" | "announce-thread";
}>;

export async function runSystemEffect(effect: SystemEffect, host: EffectHost): Promise<void> {
  const { dispatch, desktop } = host;
  switch (effect.type) {
    case "automation.save":
      return reportFailure(host, desktop.saveAutomation(effect.draft));

    case "automation.update":
      return reportFailure(host, desktop.updateAutomation(effect.taskId, effect.patch));

    case "automation.delete":
      return reportFailure(host, desktop.deleteAutomation(effect.taskId));

    case "automation.run-now":
      return reportFailure(host, desktop.runAutomationNow(effect.taskId).then(async (status) => {
        if (status === "busy" || status === "skipped") await dispatch({ type: "action.failed", message: WORKSPACE_ERRORS.busyAutomation });
      }));

    case "automation.ack":
      desktop.acknowledgeAutomation(effect.ack);
      return;

    case "focus-window":
      desktop.focusWindow();
      return;

    case "close-window":
      desktop.closeWindow();
      return;

    case "apply-shortcuts":
      desktop.setShortcuts(effect.overrides);
      return;

    case "apply-capture-options":
      desktop.setCaptureOptions(effect.options);
      return;

    case "capture-shortcut":
      desktop.setShortcutCapture(effect.capturing);
      return;

    case "announce-thread":
      desktop.announceThread(effect.notice);
      return;

    /** The bridge's own settings, each of which answers with the whole of what the bridge is doing. */
    case "remote.set-enabled": case "remote.set-lan-exposed": case "remote.create-pairing-code":
    case "remote.revoke-device": case "remote.set-tailscale-serve": case "remote.refresh":
      try {
        await dispatch({ type: "remote.changed", remote: await runRemoteEffect(effect, desktop) });
      } catch (error) {
        await dispatch({ type: "action.failed", message: errorMessage(error) });
      }
      return;

    /** Where every engine stands: asked outright, or answered by an engine's own sign-in once it is over. */
    case "engine.read": case "engine.sign-in":
      try {
        await dispatch({ type: "engine.status", status: await (effect.type === "engine.read" ? desktop.engineStatus(effect.refresh) : desktop.signInEngine(effect.engine)) });
      } catch (error) {
        await dispatch({ type: "engine.failed", message: errorMessage(error) });
      }
      return;
  }
}
