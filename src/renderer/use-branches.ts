import { useEffect, useState } from "react";
import type { BranchesResult } from "../contracts/ipc";

/** The checkout's local branches, read again whenever the checkout changes or reading is turned on. */
export function useBranches(workspaceId: string | undefined, enabled = true) {
  const [result, setResult] = useState<BranchesResult | null>(null);

  useEffect(() => {
    setResult(null);
    if (!workspaceId || !enabled) return;
    let cancelled = false;
    void window.desktop.branches(workspaceId)
      .then((branches) => { if (!cancelled) setResult(branches); })
      .catch((error) => { if (!cancelled) setResult({ status: "error", message: String(error) }); });
    return () => { cancelled = true; };
  }, [workspaceId, enabled]);

  return result;
}
