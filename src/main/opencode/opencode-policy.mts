import type { ExecutionPolicy } from "../../domain/run.js";
import type { CoordinationRole } from "../../domain/coordination.js";
import type { RunChannel } from "../../contracts/ipc.js";
import { grantsTool, toolReach } from "../agent/approval-grant.mjs";
import { mcpToolName } from "../agent/claude-mcp-host.mjs";
import type { ServedToolSet } from "../agent/run-tools.mjs";

/** One OpenCode permission rule. Rules are read in order and the last that matches decides. */
export type PermissionRule = { action: string; resource: string; effect: "allow" | "deny" | "ask" };

/** The name OpenCode files the app's own tools under. */
export const APP_SERVER_NAME = "aicodingtool";
export const COMPUTER_USE_SERVER_NAME = "cua-driver";

/** How OpenCode names a tool an MCP server offers. */
export function openCodeToolName(server: string, tool: string) {
  return `${server}_${tool}`;
}

/** Tools that only look, which every mode but a coordinator's lets run unasked, as Claude's default mode does. */
const LOOKS = ["read", "glob", "grep", "list", "skill", "question", "todowrite", "todoread", "lsp"];

const rule = (action: string, effect: PermissionRule["effect"]): PermissionRule => ({ action, resource: "*", effect });

/** What a mode lets OpenCode's own tools do. Auto has no reviewer to stand on here, so it is held to Edits. */
function modeRules(policy: ExecutionPolicy): PermissionRule[] {
  switch (policy) {
    case "bypass":
      return [rule("*", "allow")];
    case "plan":
      return [rule("*", "ask"), ...LOOKS.map((action) => rule(action, "allow")), rule("edit", "deny")];
    case "confirm":
      return [rule("*", "ask"), ...LOOKS.map((action) => rule(action, "allow"))];
    case "allow-edits":
    case "autonomous":
      return [rule("*", "ask"), ...LOOKS.map((action) => rule(action, "allow")), rule("edit", "allow"), rule("external_directory", "ask")];
  }
}

export type PolicySources = { policy: ExecutionPolicy; channel: RunChannel; coordinationRole?: CoordinationRole };

/**
 * The rules a session runs under: the mode's, then the app's tools each granted as Claude grants them,
 * then what a coordinator may never do, which changes nothing itself whatever the mode.
 */
export function permissionRules(input: PolicySources, sets: readonly ServedToolSet[], computerUse: boolean): PermissionRule[] {
  const rules = modeRules(input.policy);
  for (const { server, tools } of sets) {
    for (const tool of tools) {
      const unasked = grantsTool(toolReach(mcpToolName(server, tool.name)), input);
      rules.push(rule(openCodeToolName(APP_SERVER_NAME, tool.name), unasked ? "allow" : "ask"));
    }
  }
  if (computerUse) rules.push(rule(`${COMPUTER_USE_SERVER_NAME}_*`, grantsTool("computer-use", input) ? "allow" : "ask"));
  if (input.coordinationRole === "coordinator") rules.push(rule("edit", "deny"), rule("shell", "deny"), rule("subagent", "deny"));
  return rules;
}

/** The agent a mode runs as: OpenCode's own planner for Plan, its builder otherwise. */
export function agentFor(policy: ExecutionPolicy) {
  return policy === "plan" ? "plan" : "build";
}
