import assert from "node:assert/strict";
import { test } from "vitest";
import { z } from "zod";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentProvider } from "../../../src/main/agent/claude-agent-provider.mts";
import { codexConfig } from "../../../src/main/codex/codex-config.mts";
import { codexPolicy } from "../../../src/main/codex/codex-policy.mts";
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
  const coordination = { report: async () => ({ recorded: true, note: "" }), decide: async () => ({ recorded: true, note: "" }), remember: async () => ({ note: "" }), propose: async () => ({ note: "" }) };
  const coordinator: QueryCapture = {};
  await new ClaudeAgentProvider(queryFactory([], coordinator)).execute(input({ coordinationRole: "coordinator", coordination }));
  const member: QueryCapture = {};
  await new ClaudeAgentProvider(queryFactory([], member)).execute(input({ coordinationRole: "member", coordination }));

  assert.deepEqual(optionsOf(coordinator).disallowedTools, ["AskUserQuestion", "EnterWorktree", "ExitWorktree", "Edit", "MultiEdit", "Write", "NotebookEdit", "Bash", "Task", "Agent"]);
  assert.deepEqual(optionsOf(member).disallowedTools, ["AskUserQuestion", "EnterWorktree", "ExitWorktree"], "a thread under a coordinator does the work, so it keeps every tool");
  assert.match(systemAppend(optionsOf(coordinator)), /Never change anything yourself/);
  assert.match(systemAppend(optionsOf(member)), /call report_status as done, blocked, or failed: your closing message is not a report/);
  assert.match(systemAppend(optionsOf(member)), /say exactly what's missing and stop/);
  assert.doesNotMatch(systemAppend(optionsOf(coordinator)), /say exactly what's missing and stop/, "a coordinator delegates, so it is never told to stop at a wall");
  assert.ok(optionsOf(coordinator).mcpServers?.["aicodingtool-coordination"]);
});

test("a coordinator on Codex runs without Codex's own subagents, as it does on Claude, while its threads keep them", () => {
  const spawnedWith = (coordinationRole?: "coordinator" | "member") => codexConfig({ channel: "main", policy: "confirm", computerUse: { status: "unavailable", message: "off" }, ...(coordinationRole ? { coordinationRole } : {}) }, undefined);
  const disabled = (args: readonly string[]) => args.flatMap((arg, index) => args[index - 1] === "--disable" ? [arg] : []);
  assert.ok(disabled(spawnedWith("coordinator")).includes("multi_agent") && disabled(spawnedWith("coordinator")).includes("multi_agent_v2"));
  assert.ok(!disabled(spawnedWith("member")).some((feature) => feature.startsWith("multi_agent")), "a thread under a coordinator does the work, so it keeps its subagents");
});

test("under a coordinator, Codex asks the user only through raise_decision, as Claude does, so every question shows in its Needs you", () => {
  const spawnedWith = (coordinationRole?: "coordinator" | "member") => codexConfig({ channel: "main", policy: "confirm", computerUse: { status: "unavailable", message: "off" }, ...(coordinationRole ? { coordinationRole } : {}) }, undefined);
  const flagged = (flag: string, args: readonly string[]) => args.flatMap((arg, index) => args[index - 1] === flag ? [arg] : []);
  assert.ok(flagged("--enable", spawnedWith()).includes("default_mode_request_user_input"), "a thread outside a coordinator asks in chat");
  for (const coordinationRole of ["coordinator", "member"] as const) {
    assert.ok(!flagged("--enable", spawnedWith(coordinationRole)).includes("default_mode_request_user_input"), coordinationRole);
    assert.ok(flagged("--disable", spawnedWith(coordinationRole)).includes("default_mode_request_user_input"), `${coordinationRole} stays off when the user's own config turns it on`);
  }
  const coordination = { report: async () => ({ recorded: true, note: "" }), decide: async () => ({ recorded: true, note: "" }), remember: async () => ({ note: "" }), propose: async () => ({ note: "" }) };
  for (const coordinationRole of ["coordinator", "member"] as const) {
    const tools = runTools({ channel: "main", computerUse: { status: "unavailable", message: "off" }, emit: () => {}, coordinationRole, coordination } as Parameters<typeof runTools>[0]).flatMap((set) => set.tools.map((tool) => tool.name));
    assert.ok(tools.includes("raise_decision"), coordinationRole);
  }
});

test("only a coordinator keeps a memory and suggests threads, so a member is offered none of those tools", () => {
  const coordination = { report: async () => ({ recorded: true, note: "" }), decide: async () => ({ recorded: true, note: "" }), remember: async () => ({ note: "" }), propose: async () => ({ note: "" }) };
  const coordinationToolNames = (sources: Partial<Parameters<typeof runTools>[0]>) => runTools({ channel: "main", computerUse: { status: "unavailable" }, emit: () => {}, ...sources } as Parameters<typeof runTools>[0])
    .find((set) => set.server === "aicodingtool-coordination")!.tools.map((tool) => tool.name);
  assert.deepEqual(coordinationToolNames({ coordinationRole: "coordinator", coordination }), ["raise_decision", "remember", "forget", "set_purpose", "propose_threads"]);
  assert.deepEqual(coordinationToolNames({ coordinationRole: "member", coordination }), ["report_status", "raise_decision"]);
});

test("outside Auto, a coordinator's shell is read-only and its escalations come to the app", () => {
  for (const policy of ["confirm", "allow-edits", "bypass"] as const) {
    const held = codexPolicy(policy, "coordinator");
    assert.equal(held.sandbox, "read-only");
    assert.equal(held.approvalsReviewer, "user");
    assert.equal(held.approvalPolicy, codexPolicy(policy).approvalPolicy);
  }
  assert.deepEqual(codexPolicy("autonomous", "member"), codexPolicy("autonomous"));
});

test("an Auto coordinator on Codex has its app tools judged by the Auto reviewer, while every escalation is refused unasked", () => {
  assert.deepEqual(codexPolicy("autonomous", "coordinator"), {
    approvalPolicy: { granular: { sandbox_approval: false, rules: false, skill_approval: false, request_permissions: false, mcp_elicitations: true } },
    sandbox: "read-only",
    approvalsReviewer: codexPolicy("autonomous").approvalsReviewer,
  });
});

test("a coordinator never waits on a thread, while every other run still can", () => {
  const threads = { list: async () => [], read: async () => { throw new Error("unused"); }, wait: async () => { throw new Error("unused"); }, command: async () => ({ thread: null }) };
  const coordination = { report: async () => ({ recorded: true, note: "" }), decide: async () => ({ recorded: true, note: "" }), remember: async () => ({ note: "" }), propose: async () => ({ note: "" }) };
  const threadToolNames = (sources: Partial<Parameters<typeof runTools>[0]>) => runTools({ channel: "main", computerUse: { status: "unavailable" }, threads, emit: () => {}, ...sources } as Parameters<typeof runTools>[0])
    .find((set) => set.server === "aicodingtool-threads")!.tools.map((tool) => tool.name);
  assert.equal(threadToolNames({ coordinationRole: "coordinator", coordination }).includes("wait_for_thread"), false);
  assert.ok(threadToolNames({ coordinationRole: "coordinator", coordination }).includes("start_thread"));
  assert.ok(threadToolNames({ coordinationRole: "member", coordination }).includes("wait_for_thread"));
  assert.ok(threadToolNames({}).includes("wait_for_thread"));
});

test("a coordinator and its threads are not offered Haiku for a thread they start", () => {
  const threads = { list: async () => [], read: async () => { throw new Error("unused"); }, wait: async () => { throw new Error("unused"); }, command: async () => ({ thread: null }) };
  const coordination = { report: async () => ({ recorded: true, note: "" }), decide: async () => ({ recorded: true, note: "" }), remember: async () => ({ note: "" }), propose: async () => ({ note: "" }) };
  const startModel = (sources: Partial<Parameters<typeof runTools>[0]>) => runTools({ channel: "main", computerUse: { status: "unavailable" }, threads, emit: () => {}, ...sources } as Parameters<typeof runTools>[0])
    .find((set) => set.server === "aicodingtool-threads")!.tools.find((tool) => tool.name === "start_thread")!.input.model!;
  const accepts = (sources: Partial<Parameters<typeof runTools>[0]>, model: string) => z.object({ model: startModel(sources) }).safeParse({ model }).success;
  assert.equal(accepts({ coordinationRole: "coordinator", coordination }, "haiku"), false);
  assert.equal(accepts({ coordinationRole: "coordinator", coordination }, "sonnet"), true);
  assert.equal(accepts({ coordinationRole: "member", coordination }, "haiku"), false, "a thread one of its threads starts works under the coordinator too");
  assert.equal(accepts({ coordinationRole: "member", coordination }, "sonnet"), true);
  assert.equal(accepts({}, "haiku"), true);
  const said = (sources: Partial<Parameters<typeof runTools>[0]>) => (startModel(sources) as z.ZodType).description ?? "";
  assert.match(said({ coordinationRole: "coordinator", coordination }), /Omit to run it on the model this coordinator's threads run on/);
  assert.match(said({ coordinationRole: "member", coordination }), /Omit to run it on the model your coordinator's threads run on/);
  assert.match(said({}), /Omit to inherit the calling thread's model/);
});

test("a coordinator's start_thread and propose_threads name a paired computer, which the user allows the thread on", async () => {
  const asked: Array<string | undefined> = [];
  const proposed: unknown[] = [];
  const threads = { list: async () => [], read: async () => { throw new Error("unused"); }, wait: async () => { throw new Error("unused"); }, command: async (_command: unknown, computer?: string) => { asked.push(computer); return { thread: null, notice: "Waiting for the user to allow it on Studio in /repo." }; } };
  const coordination = { report: async () => ({ recorded: true, note: "" }), decide: async () => ({ recorded: true, note: "" }), remember: async () => ({ note: "" }), propose: async (requests: unknown[]) => { proposed.push(...requests); return { note: "Suggested 1 thread." }; } };
  const sources: Partial<Parameters<typeof runTools>[0]> = { threads, coordination, coordinationRole: "coordinator" };
  const sets = runTools({ channel: "main", computerUse: { status: "unavailable" }, emit: () => {}, ...sources } as Parameters<typeof runTools>[0]);
  const start = sets.find((set) => set.server === "aicodingtool-threads")!.tools.find((tool) => tool.name === "start_thread")!;
  assert.match((start.input.computer as z.ZodType).description ?? "", /It starts there once the user allows it/);
  const memberStart = runTools({ channel: "main", computerUse: { status: "unavailable" }, emit: () => {}, ...sources, coordinationRole: "member" } as Parameters<typeof runTools>[0])
    .find((set) => set.server === "aicodingtool-threads")!.tools.find((tool) => tool.name === "start_thread")!;
  assert.match((memberStart.input.computer as z.ZodType).description ?? "", /A thread whose coordinator is on another computer starts its threads on this one/, "a member led from elsewhere is not promised a start it cannot get");
  const started = await start.handler({ prompt: "Run the GPU tests", intent: "gpu", doneWhen: "pass", delivers: "report", computer: "Studio" });
  assert.deepEqual(asked, ["Studio"]);
  assert.match(started.content[0]!.text, /^Waiting for the user to allow it on Studio/);
  const propose = sets.find((set) => set.server === "aicodingtool-coordination")!.tools.find((tool) => tool.name === "propose_threads")!;
  await propose.handler({ threads: [{ title: "GPU", prompt: "Run them", intent: "gpu", doneWhen: "pass", delivers: "report", computer: "Studio" }] });
  assert.deepEqual(proposed, [{ title: "GPU", prompt: "Run them", brief: { intent: "gpu", doneWhen: "pass", delivers: "report" }, computer: "Studio" }]);
});

test("a coordinator can read automations but not schedule, change, or stop one", async () => {
  const automations = { save: async () => { throw new Error("unused"); }, read: async () => null, update: async () => { throw new Error("unused"); }, remove: async () => false, list: async () => [] };
  const coordination = { report: async () => ({ recorded: true, note: "" }), decide: async () => ({ recorded: true, note: "" }), remember: async () => ({ note: "" }), propose: async () => ({ note: "" }) };
  const automationToolNames = (sources: Partial<Parameters<typeof runTools>[0]>) => runTools({ channel: "main", computerUse: { status: "unavailable" }, automations, emit: () => {}, ...sources } as Parameters<typeof runTools>[0])
    .find((set) => set.server === "aicodingtool-automation")!.tools.map((tool) => tool.name);
  assert.deepEqual(automationToolNames({ coordinationRole: "coordinator", coordination }), ["status", "list_all"]);
  assert.ok(automationToolNames({ coordinationRole: "member", coordination }).includes("schedule"));
  assert.ok(automationToolNames({}).includes("schedule"));

  const capture: QueryCapture = {};
  await new ClaudeAgentProvider(queryFactory([], capture)).execute(input({ coordinationRole: "coordinator", coordination, automations }));
  assert.doesNotMatch(systemAppend(optionsOf(capture)), /This task can schedule itself/);
  assert.match(systemAppend(optionsOf(capture)), /You cannot schedule automations/);
});
