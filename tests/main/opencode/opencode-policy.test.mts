import assert from "node:assert/strict";
import { test } from "vitest";
import { z } from "zod";
import { agentFor, permissionRules, type PermissionRule } from "../../../src/main/opencode/opencode-policy.mts";
import type { ServedToolSet } from "../../../src/main/agent/run-tools.mts";

const tool = (name: string) => ({ name, description: name, input: { value: z.string() }, handler: async () => ({ content: [] }) });
const sets: ServedToolSet[] = [
  { server: "aicodingtool-threads", tools: [tool("list_threads"), tool("start_thread")] },
  { server: "aicodingtool-coordination", tools: [tool("report_finding")] },
];

/** What the rules decide for one call, read as OpenCode reads them: the last rule that matches. */
function decide(rules: PermissionRule[], action: string) {
  const match = (pattern: string) => pattern === "*" || pattern === action || (pattern.endsWith("*") && action.startsWith(pattern.slice(0, -1)));
  return rules.filter((rule) => match(rule.action)).at(-1)?.effect;
}

test("each mode lets OpenCode's own tools do what that mode promises", () => {
  const rules = (policy: Parameters<typeof permissionRules>[0]["policy"]) => permissionRules({ policy, channel: "main" }, [], false);
  for (const policy of ["confirm", "allow-edits", "plan"] as const) {
    assert.equal(decide(rules(policy), "read"), "allow", `${policy} reads`);
    assert.equal(decide(rules(policy), "grep"), "allow");
    assert.equal(decide(rules(policy), "shell"), "ask", `${policy} asks before a command`);
    assert.equal(decide(rules(policy), "webfetch"), "ask");
  }
  assert.equal(decide(rules("confirm"), "edit"), "ask");
  assert.equal(decide(rules("allow-edits"), "edit"), "allow");
  assert.equal(decide(rules("allow-edits"), "external_directory"), "ask", "edits outside the checkout still ask");
  assert.equal(decide(rules("plan"), "edit"), "deny");
  assert.equal(decide(rules("autonomous"), "edit"), "allow", "Auto, which OpenCode is never offered, is held to Edits");
  assert.equal(decide(rules("autonomous"), "shell"), "ask");
  for (const action of ["shell", "edit", "external_directory", "webfetch"]) assert.equal(decide(rules("bypass"), action), "allow");
  assert.equal(agentFor("plan"), "plan");
  assert.equal(agentFor("confirm"), "build");
});

test("the app's own tools are granted tool by tool, as every engine grants them", () => {
  const rules = permissionRules({ policy: "confirm", channel: "main" }, sets, false);
  assert.equal(decide(rules, "aicodingtool_list_threads"), "allow", "reading threads changes nothing");
  assert.equal(decide(rules, "aicodingtool_start_thread"), "ask", "starting one does");
  assert.equal(decide(rules, "aicodingtool_report_finding"), "allow");
  assert.equal(decide(permissionRules({ policy: "bypass", channel: "main" }, sets, false), "aicodingtool_start_thread"), "allow");
});

test("computer use is asked about unless an attended Auto or Bypass run grants it", () => {
  assert.equal(decide(permissionRules({ policy: "confirm", channel: "main" }, [], true), "cua-driver_click"), "ask");
  assert.equal(decide(permissionRules({ policy: "bypass", channel: "main" }, [], true), "cua-driver_click"), "allow");
  assert.equal(permissionRules({ policy: "confirm", channel: "main" }, [], false).some((rule) => rule.action.startsWith("cua-driver")), false);
});

test("a coordinator changes nothing and hands no work to OpenCode's own agents, whatever its mode", () => {
  const rules = permissionRules({ policy: "bypass", channel: "main", coordinationRole: "coordinator" }, sets, false);
  for (const action of ["edit", "shell", "subagent"]) assert.equal(decide(rules, action), "deny", action);
  assert.equal(decide(rules, "read"), "allow");
  assert.equal(decide(rules, "aicodingtool_start_thread"), "allow");
});
