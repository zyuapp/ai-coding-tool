import assert from "node:assert/strict";
import { test } from "vitest";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentProvider } from "../../../src/main/agent/claude-agent-provider.mts";
import { codexPolicy } from "../../../src/main/codex/codex-session.mts";
import { input, queryFactory, type QueryCapture } from "../../support/claude-session.mjs";

function optionsOf(capture: QueryCapture): Options {
  const options = capture.options?.options;
  assert.ok(options);
  return options;
}

function systemAppend(options: Options): string {
  const prompt = options.systemPrompt;
  assert.ok(prompt && typeof prompt === "object" && !Array.isArray(prompt) && "append" in prompt);
  return prompt.append ?? "";
}

test("a coordinator runs without file edits, shell, or subagents, and with the crew tools for its part", async () => {
  const crew = { report: async () => ({ recorded: true, note: "" }), decide: async () => ({ recorded: true, note: "" }) };
  const coordinator: QueryCapture = {};
  await new ClaudeAgentProvider(queryFactory([], coordinator)).execute(input({ crewRole: "coordinator", crew }));
  const member: QueryCapture = {};
  await new ClaudeAgentProvider(queryFactory([], member)).execute(input({ crewRole: "member", crew }));

  assert.deepEqual(optionsOf(coordinator).disallowedTools, ["AskUserQuestion", "Edit", "MultiEdit", "Write", "NotebookEdit", "Bash", "Task", "Agent"]);
  assert.deepEqual(optionsOf(member).disallowedTools, ["AskUserQuestion"], "a thread under a coordinator does the work, so it keeps every tool");
  assert.match(systemAppend(optionsOf(coordinator)), /Never change anything yourself/);
  assert.match(systemAppend(optionsOf(member)), /Call report_status/);
  assert.ok(optionsOf(coordinator).mcpServers?.["aicodingtool-crew"]);
});

test("a coordinator's shell is read-only under every policy, and escalations come to the app", () => {
  for (const policy of ["confirm", "allow-edits", "autonomous", "bypass"] as const) {
    const held = codexPolicy(policy, "coordinator");
    assert.equal(held.sandbox, "read-only");
    assert.equal(held.approvalsReviewer, "user");
    assert.equal(held.approvalPolicy, codexPolicy(policy).approvalPolicy);
  }
  assert.deepEqual(codexPolicy("autonomous", "member"), codexPolicy("autonomous"));
});
