import { useSyncExternalStore } from "react";

/**
 * One timer for every count that moves once a second, aligned to the wall clock's second, so they
 * redraw together in one frame rather than each on its own. It runs only while something counts.
 */
const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setTimeout> | undefined;

function tick() {
  now = Date.now();
  timer = setTimeout(tick, 1_000 - (now % 1_000));
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  if (!listeners.size) {
    now = Date.now();
    timer = setTimeout(tick, 1_000 - (now % 1_000));
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    clearTimeout(timer);
    timer = undefined;
  };
}

const still = () => () => undefined;
const current = () => now;

/** The time, moving once a second while `live`; otherwise read once, when the caller renders. */
export function useSecondClock(live: boolean) {
  const clock = useSyncExternalStore(live ? subscribe : still, current);
  return live ? clock : Date.now();
}
