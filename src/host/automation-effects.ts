import { WORKSPACE_ERRORS } from "../application/workspace-reducer.js";
import { reportFailure, type EffectHandlers } from "./effect-host.js";
import { errorMessage } from "../contracts/errors.js";
import type { HostModule } from "./host-module.js";

/** Scheduled runs: changing them, and the ticks that fire them. */
export const automationHost = {
  effects: {
    "automation.save": (effect, host) => reportFailure(host, host.desktop.saveAutomation(effect.draft)),

    "automation.update": (effect, host) => reportFailure(host, host.desktop.updateAutomation(effect.taskId, effect.patch)),

    "automation.delete": (effect, host) => reportFailure(host, host.desktop.deleteAutomation(effect.taskId)),

    "automation.run-now": (effect, host) => reportFailure(host, host.desktop.runAutomationNow(effect.taskId).then(async (status) => {
      if (status === "busy" || status === "skipped") await host.dispatch({ type: "action.failed", message: WORKSPACE_ERRORS.busyAutomation });
    })),

    "automation.ack": (effect, { desktop }) => {
      desktop.acknowledgeAutomation(effect.ack);
    },
  } satisfies Partial<EffectHandlers>,

  /** A tick folds in what runs have reported first, since the run it starts may land in one of their threads. */
  subscribe: (host, runs) => {
    const { desktop } = host;
    void desktop.listAutomations()
      .then((automations) => host.dispatch({ type: "automations.changed", automations }))
      .catch((error) => host.dispatch({ type: "action.failed", message: errorMessage(error) }));
    const stopWatching = desktop.onAutomationsChanged((automations) => void host.dispatch({ type: "automations.changed", automations }));
    const stopFiring = desktop.onAutomationFire((fire) => {
      runs.flushAll();
      void host.dispatch({ type: "automation.fired", fire });
    });
    return () => {
      stopWatching();
      stopFiring();
    };
  },
} satisfies HostModule;
