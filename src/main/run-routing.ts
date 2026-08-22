import type { AutomationFire, RunEvent } from "../contracts/ipc.js";
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

export type RunEventGateState = {
  lastSequence: number;
  terminal: boolean;
};

export type CorrelatedRunState = RunEventGateState & {
  taskId: string;
  runId: string;
};

export function acceptRunEvent(state: RunEventGateState, event: { sequence: number; type: string; status?: string }) {
  if (state.terminal || event.sequence <= state.lastSequence) return false;
  state.lastSequence = event.sequence;
  if (event.type === "run.status" && (event.status === "succeeded" || event.status === "failed" || event.status === "cancelled")) state.terminal = true;
  return true;
}

export function supersedePendingStarts<T>(pending: Map<string, T>, keepKey: string, matches: (value: T) => boolean = () => true) {
  const superseded: Array<[string, T]> = [];
  for (const [key, value] of pending) {
    if (key === keepKey || !matches(value)) continue;
    pending.delete(key);
    superseded.push([key, value]);
  }
  return superseded;
}

export function failedEventsForTransportLoss(states: Iterable<CorrelatedRunState>, message: string): RunEvent[] {
  return [...states]
    .filter((state) => !state.terminal)
    .map((state) => ({
      type: "run.status" as const,
      taskId: state.taskId,
      runId: state.runId,
      sequence: state.lastSequence + 1,
      status: "failed" as const,
      message,
    }));
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
