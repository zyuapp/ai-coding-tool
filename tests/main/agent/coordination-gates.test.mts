import assert from "node:assert/strict";
import { test } from "vitest";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentProvider } from "../../../src/main/agent/claude-agent-provider.mts";
import { codexPolicy } from "../../../src/main/codex/codex-session.mts";
import { runTools } from "../../../src/main/agent/run-tools.mts";
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

test("a coordinator runs without file edits, shell, or subagents, and with the coordination tools for its part", async () => {
  const coordination = { report: async () => ({ recorded: true, note: "" }), decide: async () => ({ recorded: true, note: "" }) };
  const coordinator: QueryCapture = {};
  await new ClaudeAgentProvider(queryFactory([], coordinator)).execute(input({ coordinationRole: "coordinator", coordination }));
  const member: QueryCapture = {};
  await new ClaudeAgentProvider(queryFactory([], member)).execute(input({ coordinationRole: "member", coordination }));

  assert.deepEqual(optionsOf(coordinator).disallowedTools, ["AskUserQuestion", "Edit", "MultiEdit", "Write", "NotebookEdit", "Bash", "Task", "Agent"]);
  assert.deepEqual(optionsOf(member).disallowedTools, ["AskUserQuestion"], "a thread under a coordinator does the work, so it keeps every tool");
  assert.match(systemAppend(optionsOf(coordinator)), /Never change anything yourself/);
  assert.match(systemAppend(optionsOf(member)), /Call report_status/);
  assert.ok(optionsOf(coordinator).mcpServers?.["aicodingtool-coordination"]);
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

test("a coordinator never waits on a thread, while every other run still can", () => {
  const threads = { list: async () => [], read: async () => { throw new Error("unused"); }, wait: async () => { throw new Error("unused"); }, command: async () => ({ thread: null }) };
  const coordination = { report: async () => ({ recorded: true, note: "" }), decide: async () => ({ recorded: true, note: "" }) };
  const threadToolNames = (sources: Partial<Parameters<typeof runTools>[0]>) => runTools({ channel: "main", computerUse: { status: "unavailable" }, threads, emit: () => {}, ...sources } as Parameters<typeof runTools>[0])
    .find((set) => set.server === "aicodingtool-threads")!.tools.map((tool) => tool.name);
  assert.equal(threadToolNames({ coordinationRole: "coordinator", coordination }).includes("wait_for_thread"), false);
  assert.ok(threadToolNames({ coordinationRole: "coordinator", coordination }).includes("start_thread"));
  assert.ok(threadToolNames({ coordinationRole: "member", coordination }).includes("wait_for_thread"));
  assert.ok(threadToolNames({}).includes("wait_for_thread"));
});
