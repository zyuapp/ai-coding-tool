import type { WorkspaceInput } from "../application/workspace-reducer/types.js";

/** A single timer follows wall time, including clock changes and time spent asleep. */
export function createSnoozeTimer(elapsed: (at: number) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  function schedule(at: number | null) {
    clearTimeout(timer);
    timer = undefined;
    if (at === null) return;
    const remaining = at - Date.now();
    timer = setTimeout(() => {
      timer = undefined;
      const now = Date.now();
      if (now >= at) elapsed(now);
      else schedule(at);
    }, Math.max(0, Math.min(remaining, 60_000)));
  }
  return { schedule, dispose: () => schedule(null) };
}

/** The reducer's deadlines, each timer dispatching the event its deadline names. */
export function createDeadlineTimers(dispatch: (input: WorkspaceInput) => Promise<void>) {
  const snooze = createSnoozeTimer((at) => { void dispatch({ type: "snoozes.elapsed", at }); });
  const limit = createSnoozeTimer((at) => { void dispatch({ type: "limits.elapsed", at }); });
  const idleCompaction = createSnoozeTimer((at) => { void dispatch({ type: "idle-compaction.due", at }); });
  return {
    scheduleSnoozeExpiry: snooze.schedule,
    scheduleLimitReset: limit.schedule,
    scheduleIdleCompaction: idleCompaction.schedule,
    dispose() { snooze.dispose(); limit.dispose(); idleCompaction.dispose(); },
  };
}
