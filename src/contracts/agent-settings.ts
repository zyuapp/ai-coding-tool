export type ReloadAgentSettingsCommand = { type: "reload-settings" };

/** Reload progress belongs to the agent worker, independently of any run or thread. */
export type AgentSettingsReloadEvent = { type: "engine.settings-reload-status"; status: "pending" | "reloaded" | "failed"; message?: string };

export function isAgentSettingsReloadEvent(value: unknown): value is AgentSettingsReloadEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return event.type === "engine.settings-reload-status"
    && (event.status === "pending" || event.status === "reloaded" || event.status === "failed")
    && (event.message === undefined || (typeof event.message === "string" && event.message.length > 0 && event.message.length <= 100_000));
}

