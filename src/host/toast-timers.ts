/** One timer per toast. Scheduling a toast again restarts its time, null stops it, and stopping drops every one. */
export function createToastTimers(elapsed: (id: number) => void) {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  function schedule(id: number, at: number | null) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    if (at === null) return;
    timers.set(id, setTimeout(() => {
      timers.delete(id);
      elapsed(id);
    }, Math.max(0, at - Date.now())));
  }
  function dispose() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }
  return { schedule, dispose };
}
