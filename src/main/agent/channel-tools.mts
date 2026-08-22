import { AUTOMATION_SERVER_NAME } from "./automation-tools.mjs";
import type { RunChannel } from "../../contracts/ipc.js";

function mcpTool(server: string, name: string) {
  return `mcp__${server}__${name}`;
}

/** Asked through the UI instead, on every channel. */
const ALWAYS_WITHHELD = ["AskUserQuestion"];

/**
 * The one place a tool is granted or withheld by surface. A channel reaches every tool the agent has
 * except the names listed here, so moving a tool between surfaces is a single edit to this table.
 *
 * A side chat is discarded when it closes and is listed nowhere while it is open, so it must not
 * leave anything scheduled behind: it can read automations but not write them. Everything else —
 * files, Bash, computer use, project MCP servers, and the whole thread surface — it shares with the
 * main channel. Grant a write here only if closing the chat also undoes it (see `closeSideChats`).
 */
export const WITHHELD_BY_CHANNEL: Record<RunChannel, readonly string[]> = {
  main: [],
  side: [
    mcpTool(AUTOMATION_SERVER_NAME, "schedule"),
    mcpTool(AUTOMATION_SERVER_NAME, "update"),
    mcpTool(AUTOMATION_SERVER_NAME, "stop"),
    /** A side chat is in no list the user can reach, so a finding raised there could never be read. */
    mcpTool(AUTOMATION_SERVER_NAME, "notify"),
    mcpTool(AUTOMATION_SERVER_NAME, "nothing_to_report"),
  ],
};

export function withheldTools(channel: RunChannel) {
  return [...ALWAYS_WITHHELD, ...WITHHELD_BY_CHANNEL[channel]];
}
