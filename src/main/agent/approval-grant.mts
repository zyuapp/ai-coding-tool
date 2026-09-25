import type { RunChannel } from "../../contracts/ipc.js";
import type { ExecutionPolicy } from "../../domain/run.js";

/** What a run may do, and where it is being read: together they decide what runs without asking. */
export type ApprovalScope = { policy: ExecutionPolicy; channel: RunChannel };

/**
 * What a tool reaches. An app tool reaches nothing but the app's own bridges, computer use reaches
 * the desktop the person is working at, and everything else reaches the workspace.
 */
export type ToolReach = "app" | "computer-use" | "workspace";

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
