import { useEffect, useRef } from "react";
import { WINDOW_ACTIVITY_EVENT, windowInUse } from "../window-activity";

/** How often the composer's plan limits are read again while the window is in use. */
const PLAN_USAGE_POLL_MS = 15 * 60_000;
/** A run that just ended changed the numbers, but each read starts a session with every provider. */
const RUN_END_GAP_MS = 30_000;

/**
 * When the composer asks how much of the plan is left: as it appears, as the run on screen ends,
 * and on a slow poll. Each read starts an agent process, so a window nobody is using asks nothing on
 * the poll, and catches up when it is back in use.
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
    const timer = window.setInterval(() => { if (windowInUse()) ask(PLAN_USAGE_POLL_MS - 1_000); }, PLAN_USAGE_POLL_MS);
    const back = () => { if (windowInUse()) ask(PLAN_USAGE_POLL_MS); };
    document.addEventListener("visibilitychange", back);
    window.addEventListener(WINDOW_ACTIVITY_EVENT, back);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener(WINDOW_ACTIVITY_EVENT, back);
    };
  }, []);

  useEffect(() => {
    if (wasActive.current && !runActive) ask(RUN_END_GAP_MS);
    wasActive.current = runActive;
  }, [runActive]);
}
