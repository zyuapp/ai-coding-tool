import type { RunChannel } from "../../contracts/ipc.js";
import type { ExecutionPolicy } from "../../domain/run.js";
import { AUTOMATION_SERVER_NAME } from "../tools/automation.mjs";
import { BROWSER_SERVER_NAME, BROWSER_TOOLS } from "../tools/browser.mjs";
import { COORDINATION_SERVER_NAME } from "../tools/coordination.mjs";
import { THREAD_SERVER_NAME, THREAD_TOOLS } from "../tools/threads.mjs";
import { readOnlyToolNames } from "./claude-mcp-host.mjs";

/** What a run may do, and where it is being read: together they decide what runs without asking. */
export type ApprovalScope = { policy: ExecutionPolicy; channel: RunChannel };

/**
 * What a tool reaches. An app tool reaches nothing but the app's own bridges, computer use reaches
 * the desktop the person is working at, and everything else reaches the workspace.
 */
export type ToolReach = "app" | "computer-use" | "workspace";

const setupToolName = "mcp__aicodingtool-computer-use__request_setup";
/** Scheduled runs have nobody to approve anything, and these tools only reach the run's own automation. */
const automationToolPrefix = `mcp__${AUTOMATION_SERVER_NAME}__`;
/** A thread speaking for itself to its coordinator and the user reaches nothing but the app. */
const coordinationToolPrefix = `mcp__${COORDINATION_SERVER_NAME}__`;
/** Reading the workspace changes nothing, so it needs no approval; starting or stopping a run does. */
const readOnlyThreadTools = readOnlyToolNames(THREAD_SERVER_NAME, THREAD_TOOLS);
/** Reading a page the panel already holds changes nothing; opening one and acting in it does. */
const readOnlyBrowserTools = readOnlyToolNames(BROWSER_SERVER_NAME, BROWSER_TOOLS);
const computerUseToolPrefix = "mcp__cua-driver__";

/** What a tool reaches, read from its `mcp__server__tool` name. Every engine grants app tools by this. */
export function toolReach(toolName: string): ToolReach {
  if (toolName === setupToolName || toolName.startsWith(automationToolPrefix) || toolName.startsWith(coordinationToolPrefix) || readOnlyThreadTools.has(toolName) || readOnlyBrowserTools.has(toolName)) return "app";
  return toolName.startsWith(computerUseToolPrefix) ? "computer-use" : "workspace";
}

/**
 * Whether a tool runs without anybody approving it. A call with no run in scope has nobody to grant
 * anything, so only a tool that needs no approval at all runs. Computer use is granted by an
 * autonomous run on the main channel, where the person is watching the same desktop it drives.
 */
export function grantsTool(reach: ToolReach, scope?: ApprovalScope): boolean {
  if (reach === "app") return true;
  if (!scope) return false;
  if (scope.policy === "bypass") return true;
  return reach === "computer-use" && scope.channel === "main" && scope.policy === "autonomous";
}
