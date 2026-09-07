import type { RunChannel } from "../../contracts/ipc.js";
import { SIDE_CHAT_INSTRUCTIONS } from "../agent/side-chat-instructions.mjs";

/** What the thread is told beyond its prompt. */
export const DEVELOPER_INSTRUCTIONS = "In AICodingTool, \"thread\" always means an AICodingTool thread, never a Codex session or subagent. Use the aicodingtool thread tools for every thread operation. When the user asks to open, start, or spin up a thread, use start_thread. This app's own surfaces are reached only through the aicodingtool tools: its browser panel with browser_open, browser_read and browser_screenshot, its terminal with terminal_read, its other threads with list_threads and read_thread, and repeating or scheduled work with schedule.";

export function codexInstructions(channel: RunChannel) {
  return [DEVELOPER_INSTRUCTIONS, ...(channel === "side" ? [SIDE_CHAT_INSTRUCTIONS] : [])].join("\n\n");
}
