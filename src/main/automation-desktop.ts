import type { AutomationPort } from "../contracts/automation-port.js";
import type { AutomationScheduler } from "./automation/automation-scheduler.mjs" with { "resolution-mode": "import" };
import type { DesktopEvents } from "./desktop-events.js";
import type { RunBridge } from "./run-host.js";

/** Scheduled runs, kept by the scheduler wherever the runtime runs. */
export function automationDesktop(host: { events: DesktopEvents; scheduler: () => AutomationScheduler; runs: RunBridge }): AutomationPort["runtime"] {
  const { events } = host;
  return {
    listAutomations: async () => host.scheduler().list(),
    saveAutomation: (draft) => host.scheduler().save(draft),
    updateAutomation: (taskId, patch) => host.scheduler().update(taskId, patch),
    deleteAutomation: (taskId) => host.scheduler().remove(taskId),
    runAutomationNow: (taskId) => host.scheduler().runNow(taskId),
    onAutomationsChanged: (listener) => events.on("automation:changed", listener),
    onAutomationFire: (listener) => events.on("automation:fire", listener),
    acknowledgeAutomation: (ack) => host.runs.acknowledgeAutomation(ack.runId, ack.started),
  };
}
