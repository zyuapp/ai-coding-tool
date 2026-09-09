import assert from "node:assert/strict";
import { test } from "vitest";
import type { ProviderEvent } from "../../../src/main/agent/agent-provider.mts";
import { SteerChannel } from "../../../src/main/agent/steer-channel.mts";
import { DEVELOPER_INSTRUCTIONS } from "../../../src/main/codex/codex-instructions.mts";
import type { ThreadItem } from "../../../src/main/codex/protocol/v2/ThreadItem.ts";
import { completeTurn, defaultScript, harness, input, opened, sentBy, tick, turn } from "../../support/codex-client.mjs";

const threadId = "thread-1";
const turnId = "turn-1";
const at = { threadId, turnId };

function started(item: ThreadItem) {
  return { item, ...at, startedAtMs: 1 };
}

function completed(item: ThreadItem) {
  return { item, ...at, completedAtMs: 2 };
}

const command = (id: string, command: string): ThreadItem => ({
  type: "commandExecution", id, pluginId: null, scriptPath: null, command, cwd: "/tmp/project", processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null,
});

const agentMessage = (id: string, text: string): ThreadItem => ({ type: "agentMessage", id, text, phase: "final_answer", memoryCitation: null, delivery: null, questions: null });

test("native review runs inline on paginated history and emits its findings once", async () => {
  const emitted: ProviderEvent[] = [];
  const reports: ProviderEvent[] = [];
  const codex = harness({
    "thread/resume": (params: { threadId: string }) => ({ thread: { id: params.threadId, historyMode: "paginated" } }),
  });
  const warm = await turn(codex);
  const running = codex.provider.execute(input({
    prompt: "",
    continuation: { provider: "codex", value: threadId },
    model: "gpt-5.6-terra",
    effort: "low",
    policy: "allow-edits",
    operation: { type: "review", target: { type: "baseBranch", branch: "main" } },
    emit: (event) => emitted.push(event),
    reportSubagent: (event) => reports.push(event),
  }));
  for (let waited = 0; codex.clients.length < 2; waited += 1) {
    if (waited > 100) throw new Error("review session was never opened");
    await tick();
  }
  const client = codex.latest();
  await sentBy(client, "review/start");

  assert.notEqual(client, warm.client, "review reopens the thread because review/start has no setting overrides");
  assert.equal(warm.client.closed, true);
  assert.deepEqual(client.calls("thread/resume"), [{
    threadId,
    cwd: "/tmp/project",
    serviceTier: "default",
    model: "gpt-5.6-terra",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    approvalsReviewer: "user",
    config: { model_reasoning_effort: "low" },
    developerInstructions: DEVELOPER_INSTRUCTIONS,
  }]);
  assert.deepEqual(client.calls("review/start"), [{ threadId, target: { type: "baseBranch", branch: "main" }, delivery: "inline" }]);
  client.notify("item/started", started(command("review-command", "git diff main")));
  client.notify("item/completed", completed(command("review-command", "git diff main")));
  const result: ThreadItem = { type: "exitedReviewMode", id: "review-1", review: "No findings." };
  client.notify("item/completed", completed(result));
  client.notify("item/completed", completed(result));
  client.notify("item/agentMessage/delta", { ...at, itemId: "review-message", delta: "No findings." });
  client.notify("item/completed", completed(agentMessage("review-message", "No findings.")));
  completeTurn(client);

  assert.deepEqual(await running, { status: "succeeded" });
  assert.deepEqual(emitted.filter((event) => event.type !== "continuation"), [
    { type: "tool", intent: { toolId: "review-command", name: "command_execution", input: { command: "git diff main", cwd: "/tmp/project" } } },
    { type: "assistant", messageId: "review-1", text: "No findings." },
  ]);
  assert.equal(client.calls("thread/inject_items").length, 0, "Codex already persists inline findings");
  assert.deepEqual(reports, [], "inline activity belongs to the conversation");
  const followup: ProviderEvent[] = [];
  await turn(codex, { continuation: { provider: "codex", value: threadId }, emit: (event) => followup.push(event) }, (next) => {
    next.notify("item/completed", completed(agentMessage("followup", "I will fix the findings.")));
  });
  assert.ok(followup.some((event) => event.type === "assistant" && event.text === "I will fix the findings."));
  codex.provider.closeAll();
});

test("inline review handles findings and completion before review/start responds, even with an active goal", async () => {
  const emitted: ProviderEvent[] = [];
  let reply!: (value: unknown) => void;
  const codex = harness({ "review/start": () => new Promise((resolve) => { reply = resolve; }) });
  const running = codex.provider.execute(input({
    operation: { type: "review", target: { type: "uncommittedChanges" } },
    emit: (event) => emitted.push(event),
  }));
  const client = await opened(codex);
  await sentBy(client, "review/start");
  client.notify("thread/goal/updated", { threadId, turnId, goal: { threadId, objective: "Fix the app", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } });
  client.notify("item/completed", completed({ type: "exitedReviewMode", id: "early-review", review: "[P1] Fix the race." }));
  completeTurn(client);
  assert.deepEqual(await running, { status: "succeeded" });
  reply(defaultScript["review/start"]!({ threadId } as never));
  await tick();
  assert.deepEqual(emitted.filter((event) => event.type === "assistant"), [{ type: "assistant", messageId: "early-review", text: "[P1] Fix the race." }]);
  codex.provider.closeAll();
});

test("inline review reports startup and execution failures", async () => {
  const startup = harness({ "review/start": () => { throw new Error("Review target is missing"); } });
  assert.deepEqual(await startup.provider.execute(input({ operation: { type: "review", target: { type: "uncommittedChanges" } } })), {
    status: "failed", message: "Codex could not start the review: Review target is missing",
  });
  startup.provider.closeAll();

  const codex = harness();
  const running = codex.provider.execute(input({ operation: { type: "review", target: { type: "uncommittedChanges" } } }));
  const client = await opened(codex);
  await sentBy(client, "review/start");
  completeTurn(client, "failed", { message: "Reviewer failed" });
  assert.deepEqual(await running, { status: "failed", message: "Reviewer failed" });
  codex.provider.closeAll();
});

test("inline review steers and interrupts the parent turn, including cancellation during startup", async () => {
  for (const cancelBeforeReply of [false, true]) {
    let reply!: (value: unknown) => void;
    const codex = harness({ "review/start": () => new Promise((resolve) => { reply = resolve; }) });
    const controller = new AbortController();
    const steering = new SteerChannel();
    const running = codex.provider.execute(input({
      operation: { type: "review", target: { type: "uncommittedChanges" } },
      abortController: controller,
      steering,
    }));
    const client = await opened(codex);
    await sentBy(client, "review/start");
    if (cancelBeforeReply) controller.abort();
    reply(defaultScript["review/start"]!({ threadId } as never));
    if (!cancelBeforeReply) {
      steering.push({ messageId: "review-steer", prompt: "Focus on concurrency" });
      await sentBy(client, "turn/steer");
      assert.deepEqual(client.calls("turn/steer"), [{ threadId, expectedTurnId: turnId, input: [{ type: "text", text: "Focus on concurrency", text_elements: [] }] }]);
      controller.abort();
    }
    await sentBy(client, "turn/interrupt");
    assert.deepEqual(client.calls("turn/interrupt"), [{ threadId, turnId }]);
    completeTurn(client, "interrupted");
    assert.deepEqual(await running, { status: "cancelled" });
    codex.provider.closeAll();
  }
});
