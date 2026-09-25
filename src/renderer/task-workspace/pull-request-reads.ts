import { useEffect, useRef } from "react";
import { PULL_REQUEST_POLL_MS, pullRequestSettled, type PullRequestAnswer } from "../../domain/pull-request";

/**
 * When the panel on screen asks about its pull request: as it appears, whenever the checkout, the
 * branch it is on, or the thread reading it changes, whenever the window comes back, and on a slow
 * poll until the answer settles.
 *
 * Only the panel on screen has a row to draw, so only it asks: the poll lives and dies with the
 * mount rather than in the main process, and a hidden window asks nothing at all.
 */
export function usePullRequestReads(
  workspaceId: string | undefined,
  branch: string | null,
  threadId: string | undefined,
  answer: PullRequestAnswer,
  read: () => void,
) {
  /** Held still, so only the checkout, the branch, the thread and the answer decide when to ask. */
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
  }, [workspaceId, branch, threadId]);

  /** A hidden window has nothing to show for an answer, and gets one on the way back instead. */
  const settled = pullRequestSettled(answer);
  useEffect(() => {
    if (settled) return;
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") ask(); }, PULL_REQUEST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [workspaceId, branch, threadId, settled]);
}
