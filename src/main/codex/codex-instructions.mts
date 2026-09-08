import type { RunChannel } from "../../contracts/ipc.js";
import { SIDE_CHAT_INSTRUCTIONS } from "../agent/side-chat-instructions.mjs";

/** What the thread is told beyond its prompt. */
export const DEVELOPER_INSTRUCTIONS = "For ordinary AICodingTool operations, prefer the aicodingtool tools: start_thread to create threads, list_threads and read_thread to inspect them, browser_open, browser_read and browser_screenshot for the browser panel, terminal_read for terminals, and schedule for recurring work. AICodingTool threads are distinct from Codex sessions and subagents. These are defaults, not restrictions on the user's workflow. Follow the user's explicitly requested target and method, including computer use for UI interaction or testing. Verify the result in the requested target before reporting success.";

export function codexInstructions(channel: RunChannel) {
  return [DEVELOPER_INSTRUCTIONS, ...(channel === "side" ? [SIDE_CHAT_INSTRUCTIONS] : [])].join("\n\n");
}
