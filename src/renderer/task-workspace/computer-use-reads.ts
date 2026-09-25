import { useEffect, useRef } from "react";
import type { ComputerUseAccessState } from "../../application/computer-use-access";

/** How often the platform is asked again while its answer can still change in another application. */
const COMPUTER_USE_POLL_MS = 1_000;

/**
 * When settings asks the platform what it allows: as it opens, whenever the window comes back, and
 * on a fast poll while a grant made in another application would otherwise go unnoticed. A platform
 * that answers with its own runtime says all it will, so that answer ends the poll.
 */
export function useComputerUseReads(access: ComputerUseAccessState, read: () => void) {
  const latest = useRef(read);
  latest.current = read;
  const ask = () => latest.current();
  const polling = access.permissions?.linuxRuntime === undefined;

  useEffect(() => {
    ask();
    window.addEventListener("focus", ask);
    return () => window.removeEventListener("focus", ask);
  }, []);

  useEffect(() => {
    if (!polling) return;
    const timer = window.setInterval(ask, COMPUTER_USE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [polling]);
}
