import type { AutomationFire } from "../contracts/ipc.js";
import type { Automation, AutomationRunStatus, TickKind } from "../domain/automation.js";

/** Far longer than any honest scheduled run, so only a run that never reports back reaches it. */
export const AUTOMATION_SETTLE_TIMEOUT = 6 * 60 * 60_000;

/** The tick as the window receives it. Whether it may be quiet is the scheduler's decision, not this one's. */
export function automationFire(automation: Automation, runId: string, tick: TickKind): AutomationFire {
  return {
    automationId: automation.id,
    taskId: automation.taskId,
    runId,
    prompt: automation.prompt,
    ...(automation.policy === undefined ? {} : { policy: automation.policy }),
    /** The sentence only travels with a tick that may act on it: a watched run is framed as any other. */
    ...(tick.quiet ? { quiet: true as const, surfaceWhen: automation.surfaceWhen } : {}),
    ...(tick.unattended ? { unattended: true as const } : {}),
    runNumber: automation.runCount + 1,
  };
}

/**
 * A scheduled run that never reaches a terminal status would hold its automation's turnstile shut for
 * good, skipping every later tick in silence. Past the bound the tick is called failed, which is a
 * verdict the schedule can carry on from.
 */
export function settledWithin(settled: Promise<AutomationRunStatus>, ms: number): Promise<AutomationRunStatus> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const bounded = new Promise<AutomationRunStatus>((resolve) => {
    deadline = setTimeout(() => resolve("failed"), ms);
    deadline.unref?.();
  });
  return Promise.race([settled, bounded]).finally(() => clearTimeout(deadline));
}
