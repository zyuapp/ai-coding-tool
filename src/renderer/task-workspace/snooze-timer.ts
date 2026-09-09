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
