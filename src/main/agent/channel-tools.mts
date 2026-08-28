import { AUTOMATION_SERVER_NAME } from "../tools/automation.mjs";
import type { RunChannel } from "../../contracts/ipc.js";
import { mcpToolName } from "./claude-mcp-host.mjs";

/** Asked through the UI instead, on every channel. */
const ALWAYS_WITHHELD = ["AskUserQuestion"];

/** One of the app's own tools, by the server it is filed under. */
export type WithheldTool = { server: string; tool: string };

/**
 * The one place a tool is granted or withheld by surface. A channel reaches every tool the agent has
 * except the names listed here, so moving a tool between surfaces is a single edit to this table.
 *
 * A side chat is discarded when it closes and is listed nowhere while it is open, so it must not
 * leave anything scheduled behind: it can read automations but not write them. Everything else —
 * files, Bash, computer use, project MCP servers, and the whole thread surface — it shares with the
 * main channel. Grant a write here only if closing the chat also undoes it (see `closeSideChats`).
 */
export const WITHHELD_BY_CHANNEL: Record<RunChannel, readonly WithheldTool[]> = {
  main: [],
  side: [
    { server: AUTOMATION_SERVER_NAME, tool: "schedule" },
    { server: AUTOMATION_SERVER_NAME, tool: "update" },
    { server: AUTOMATION_SERVER_NAME, tool: "stop" },
    /** A side chat is in no list the user can reach, so a finding raised there could never be read. */
    { server: AUTOMATION_SERVER_NAME, tool: "notify" },
    { server: AUTOMATION_SERVER_NAME, tool: "nothing_to_report" },
  ],
};

/** The names Claude is told not to use on a channel. */
export function withheldTools(channel: RunChannel) {
  return [...ALWAYS_WITHHELD, ...WITHHELD_BY_CHANNEL[channel].map(({ server, tool }) => mcpToolName(server, tool))];
}

/** A server's tools short of what the channel withholds, for a host that serves only what it lists. */
export function offeredOn<Tool extends { name: string }>(channel: RunChannel, server: string, tools: readonly Tool[]): Tool[] {
  const withheld = WITHHELD_BY_CHANNEL[channel];
  return tools.filter((tool) => !withheld.some((entry) => entry.server === server && entry.tool === tool.name));
}
