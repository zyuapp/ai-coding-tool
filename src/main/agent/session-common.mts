import type { ServedTools, ToolHost } from "../tools/mcp-http-host.mjs";
import type { ServedToolSet } from "./run-tools.mjs";

/** How long an interrupted turn has to come back with a result before the session is given up on. */
export const INTERRUPT_GRACE_MS = 10_000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function firstLine(message: string) {
  return message.split("\n", 1)[0] ?? message;
}

/** What went wrong, in one line. */
export function reasonOf(error: unknown) {
  return firstLine(error instanceof Error ? error.message : String(error));
}

/** Why the session could not open, worded for the run that asked. `lost` says the continuation itself is gone. */
export class OpenFailure extends Error {
  constructor(message: string, readonly lost = false) {
    super(message);
  }
}

/**
 * Serves the app's tools to a session that is opening, and nothing when the run is offered none.
 * A session that ended while they were being served gives them back and opens no further.
 */
export async function serveTools(host: ToolHost, sets: ServedToolSet[], ended: () => boolean, endedMessage: string): Promise<ServedTools | null> {
  const tools = sets.flatMap((set) => set.tools);
  if (!tools.length) return null;
  const served = await host.serve(tools);
  if (ended()) {
    served.release();
    throw new OpenFailure(endedMessage);
  }
  return served;
}
