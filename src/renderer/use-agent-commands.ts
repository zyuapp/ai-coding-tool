import { useEffect, useState } from "react";
import type { AvailableCommand } from "../contracts/ipc";
import type { AgentEngine } from "../domain/agent-engine";

/**
 * The commands an engine offers in a checkout, read as the checkout or engine changes and again
 * whenever the window comes back. Without a checkout they are read for the projectless one.
 */
export function useAgentCommands(workspaceId: string | undefined, engine: AgentEngine) {
  const [commands, setCommands] = useState<AvailableCommand[]>([]);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const id = workspaceId ?? (await window.desktop.projectlessWorkspace()).id;
        const result = await window.desktop.commands(id, engine);
        if (!cancelled) setCommands(result.status === "available" ? result.commands : []);
      } catch {
        if (!cancelled) setCommands([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, engine, token]);

  useEffect(() => {
    const reload = () => setToken((current) => current + 1);
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, []);

  return { commands, loading };
}
