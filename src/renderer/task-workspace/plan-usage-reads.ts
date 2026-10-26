import { useEffect, useRef } from "react";

/** How often the composer's plan limits are read again while the window is on screen. */
const PLAN_USAGE_POLL_MS = 5 * 60_000;
/** A run that just ended changed the numbers, but each read starts a session with every provider. */
const RUN_END_GAP_MS = 30_000;

/**
 * When the composer asks how much of the plan is left: as it appears, as the run on screen ends,
 * and on a slow poll. A hidden window asks nothing, and catches up on the way back.
 */
export function usePlanUsageReads(runActive: boolean, read: () => void) {
  const latest = useRef(read);
  latest.current = read;
  const askedAt = useRef(Number.NEGATIVE_INFINITY);
  const wasActive = useRef(runActive);
  const ask = (gap: number) => {
    if (document.visibilityState === "hidden" || Date.now() - askedAt.current < gap) return;
    askedAt.current = Date.now();
    latest.current();
  };

  useEffect(() => {
    ask(0);
    const timer = window.setInterval(() => ask(PLAN_USAGE_POLL_MS - 1_000), PLAN_USAGE_POLL_MS);
    const back = () => ask(PLAN_USAGE_POLL_MS);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", back);
    };
  }, []);

  useEffect(() => {
    if (wasActive.current && !runActive) ask(RUN_END_GAP_MS);
    wasActive.current = runActive;
  }, [runActive]);
}
