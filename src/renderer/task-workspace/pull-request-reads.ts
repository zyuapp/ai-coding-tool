import { useEffect, useRef } from "react";
import { PULL_REQUEST_POLL_MS } from "../../domain/pull-request";

/**
 * When the panel on screen asks about its pull requests: as it appears, whenever `asking` changes
 * (the checkout, the branch it is on, or the thread reading it), whenever the window comes back, and
 * on a slow poll until the answers settle.
 *
 * Only the panel on screen has a row to draw, so only it asks: the poll lives and dies with the
 * mount rather than in the main process, and a hidden window asks nothing at all.
 */
export function usePullRequestReads(asking: string, settled: boolean, read: () => void) {
  /** Held still, so only what is asked and whether it has settled decide when to ask. */
  const latest = useRef(read);
  latest.current = read;
  const ask = () => latest.current();

  useEffect(() => {
    ask();
    const back = () => { if (document.visibilityState !== "hidden") ask(); };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, [asking]);

  /** A hidden window has nothing to show for an answer, and gets one on the way back instead. */
  useEffect(() => {
    if (settled) return;
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") ask(); }, PULL_REQUEST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [asking, settled]);
}
