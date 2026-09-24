import assert from "node:assert/strict";
import { test } from "vitest";
import type { SubagentReport } from "../../../src/domain/run.ts";
import { isSubagentEvent } from "../../../src/contracts/ipc.ts";
import type { ProviderEvent } from "../../../src/main/agent/agent-provider.mts";
import type { NotificationParams } from "../../../src/main/codex/app-server-client.mts";
import { CodexSubagents } from "../../../src/main/codex/codex-subagents.mts";
import type { ThreadItem } from "../../../src/main/codex/protocol/v2/ThreadItem.ts";
import { completeTurn, harness, input, opened, sentBy, tick, turn as runTurn } from "../../support/codex-client.mjs";

const rootId = "thread-1";

function activity(id: string, childId: string, path: string, kind: "started" | "interacted" | "interrupted" | "completed" = "started"): ThreadItem {
  return { type: "subAgentActivity", id, kind, agentThreadId: childId, agentPath: path };
}

function itemStarted(threadId: string, turnId: string, item: ThreadItem): NotificationParams<"item/started"> {
  return { threadId, turnId, item, startedAtMs: 1 };
}

function itemCompleted(threadId: string, turnId: string, item: ThreadItem): NotificationParams<"item/completed"> {
  return { threadId, turnId, item, completedAtMs: 2 };
}

function turn(threadId: string, id: string, status: "inProgress" | "completed" | "interrupted" | "failed" = "inProgress"): NotificationParams<"turn/started"> {
  return {
    threadId,
    turn: { id, status, items: [], itemsView: "summary", error: null, startedAt: 1, completedAt: status === "inProgress" ? null : 2, durationMs: null },
  };
}

function spawnedThread(id: string, preview: string, nickname: string, role: string, path: string): NotificationParams<"thread/started"> {
  return {
    thread: {
      id,
      preview,
      source: { subAgent: { thread_spawn: { parent_thread_id: rootId, depth: 1, agent_path: path, agent_nickname: nickname, agent_role: role } } },
      agentNickname: nickname,
      agentRole: role,
      parentThreadId: rootId,
      status: { type: "idle" },
    },
  } as NotificationParams<"thread/started">;
}

function usage(threadId: string, turnId: string, totalTokens: number, lastTokens: number): NotificationParams<"thread/tokenUsage/updated"> {
  const breakdown = (total: number) => ({ totalTokens: total, inputTokens: total, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });
  return { threadId, turnId, tokenUsage: { total: breakdown(totalTokens), last: breakdown(lastTokens), modelContextWindow: 272_000 } };
}

const command = (id: string): ThreadItem => ({
  type: "commandExecution",
  id,
  pluginId: null,
  scriptPath: null,
  command: "rg TODO src",
  cwd: "/tmp/project",
  processId: null,
  source: "agent",
  status: "inProgress",
  commandActions: [],
  aggregatedOutput: null,
  exitCode: null,
  durationMs: null,
});

const message = (id: string, text: string): ThreadItem => ({ type: "agentMessage", id, text, phase: "final_answer", memoryCitation: null, delivery: null, questions: null });

test("Codex captures model and effort from the child and the full prompt from child input", () => {
  const reports: SubagentReport[] = [];
  const tracker = new CodexSubagents((report) => reports.push(report));
  tracker.setRootThreadId(rootId);
  const prompt = "  Inspect carefully.\n\n" + "Keep every instruction.\n".repeat(10_000);
  const input: ThreadItem = { type: "userMessage", id: "input", clientId: null, content: [{ type: "text", text: prompt, text_elements: [] }] };
  tracker.itemStarted(itemStarted("child", "turn", input));
  const child = spawnedThread("child", "Inspect carefully", "reviewer", "reviewer", "/root/reviewer");
  child.thread.model = "gpt-6-sol";
  child.thread.reasoningEffort = "xhigh";
  tracker.threadStarted(child);
  const started = reports.find((report) => report.type === "subagent.started");
  assert.equal(started?.prompt, prompt);
  assert.equal(started?.model, "gpt-6-sol");
  assert.equal(started?.effort, "xhigh");
  assert.equal(started?.description, prompt.trim().slice(0, 100_000));
  assert.equal(isSubagentEvent({ ...started, taskId: "task" }), true, "a long prompt must still pass the event boundary");
  tracker.itemCompleted(itemCompleted("child", "turn", input));
  tracker.itemStarted(itemStarted("child", "turn-2", { ...input, id: "followup", content: [{ type: "text", text: "Follow up", text_elements: [] }] }));
  assert.equal(reports.filter((report) => report.type === "subagent.metadata").length, 0, "follow-ups do not replace the original assignment");
});

test("Codex enriches a discovered child with collaboration input, then authoritative thread settings", () => {
  const reports: SubagentReport[] = [];
  const tracker = new CodexSubagents((report) => reports.push(report));
  tracker.setRootThreadId(rootId);
  tracker.itemStarted(itemStarted(rootId, "turn", activity("discover", "child", "/root/reviewer")));
  tracker.itemCompleted(itemCompleted(rootId, "turn", {
    type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", status: "completed", senderThreadId: rootId,
    receiverThreadIds: ["child"], prompt: "  Full\nassignment  ", model: "gpt-6-sol", reasoningEffort: "high", agentsStates: {},
  }));
  const child = spawnedThread("child", "Review", "reviewer", "reviewer", "/root/reviewer");
  child.thread.model = "gpt-6-astra";
  child.thread.reasoningEffort = "xhigh";
  tracker.threadStarted(child);
  const details = reports.filter((report) => report.type === "subagent.metadata");
  assert.deepEqual(details.at(-1), { type: "subagent.metadata", id: "child", prompt: "  Full\nassignment  ", model: "gpt-6-astra", effort: "xhigh" });
});

test("MultiAgentV2 discovery exposes child settings without treating its preview as a plaintext prompt", () => {
  const reports: SubagentReport[] = [];
  const tracker = new CodexSubagents((report) => reports.push(report));
  tracker.setRootThreadId(rootId);
  tracker.itemStarted(itemStarted(rootId, "turn", activity("discover", "child", "/root/reviewer")));
  const child = spawnedThread("child", "", "Mencius", "reviewer", "/root/reviewer");
  child.thread.model = "gpt-6-astra";
  child.thread.reasoningEffort = "high";
  tracker.threadStarted(child);
  const metadata = reports.filter((report) => report.type === "subagent.metadata");
  assert.deepEqual(metadata.at(-1), { type: "subagent.metadata", id: "child", model: "gpt-6-astra", effort: "high" });
  assert.equal(reports.some((report) => "prompt" in report), false, "encrypted NEW_TASK bodies are not available on the app-server event path");
});

test("child-first traffic is buffered, both discovery paths merge, and root self-activity is rejected", () => {
  const reports: SubagentReport[] = [];
  const tracker = new CodexSubagents((report) => reports.push(report));
  tracker.setRootThreadId(rootId);

  tracker.threadStatusChanged({ threadId: "child-a", status: { type: "idle" } });
  assert.equal(reports.length, 0);
  tracker.itemStarted(itemStarted(rootId, "root-turn", activity("activity-a", "child-a", "/root/reviewer", "interacted")));
  tracker.threadStarted(spawnedThread("child-a", "reviewer", "wire", "reviewer", "/root/reviewer"));
  tracker.threadStarted(spawnedThread("child-b", "Check performance", "perf", "reviewer", "/root/perf"));
  tracker.itemCompleted(itemCompleted(rootId, "root-turn", activity("activity-b", "child-b", "/root/perf")));
  tracker.itemStarted(itemStarted("child-a", "child-turn", activity("root-self", rootId, "/root", "interacted")));

  assert.deepEqual(reports.filter((report) => report.type === "subagent.started").map((report) => report.id), ["child-a", "child-b"]);
  assert.deepEqual(reports.filter((report) => report.type === "subagent.status"), [
    { type: "subagent.status", id: "child-a", status: "idle" },
  ]);
  const metadata = reports.filter((report): report is Extract<SubagentReport, { type: "subagent.progress" }> => report.type === "subagent.progress" && report.id === "child-a").at(-1);
  assert.equal(metadata?.agentType, "reviewer");
  assert.equal(reports.some((report) => report.id === rootId), false);
});

test("internal housekeeping threads neither appear nor keep the session busy", () => {
  const reports: SubagentReport[] = [];
  const tracker = new CodexSubagents((report) => reports.push(report));
  tracker.setRootThreadId(rootId);
  tracker.turnStarted(turn("memory-thread", "memory-turn"));
  assert.equal(tracker.busy, true);
  tracker.threadStarted({
    thread: { ...spawnedThread("memory-thread", "", "", "", "").thread, source: { subAgent: "memory_consolidation" }, threadSource: "memory_consolidation" },
  } as NotificationParams<"thread/started">);
  tracker.turnStarted(turn("memory-thread", "memory-turn-2"));

  assert.equal(tracker.busy, false);
  assert.deepEqual(reports, []);
});

test("child messages, tools, cumulative usage, resume, and terminal errors become subagent reports", () => {
  const reports: SubagentReport[] = [];
  const tracker = new CodexSubagents((report) => reports.push(report));
  tracker.setRootThreadId(rootId);
  tracker.itemStarted(itemStarted(rootId, "root-turn", activity("discover", "child-a", "/root/reviewer")));
  tracker.turnStarted(turn("child-a", "child-turn"));
  tracker.itemStarted(itemStarted("child-a", "child-turn", command("command-1")));
  tracker.itemCompleted(itemCompleted("child-a", "child-turn", message("message-1", "Found the issue.")));
  tracker.tokenUsageUpdated(usage("child-a", "child-turn", 120, 7));
  tracker.turnCompleted(turn("child-a", "child-turn", "completed"));
  assert.equal(tracker.pendingItem("child-a", "command-1"), undefined);
  tracker.threadStatusChanged({ threadId: "child-a", status: { type: "idle" } });
  tracker.turnStarted(turn("child-a", "child-turn-2"));
  tracker.tokenUsageUpdated(usage("child-a", "child-turn-2", 120, 0));
  tracker.error({ threadId: "child-a", turnId: "child-turn", willRetry: false, error: { message: "stale failure", codexErrorInfo: null, additionalDetails: null, misalignment: null } });
  assert.deepEqual(tracker.liveTurns, [{ threadId: "child-a", turnId: "child-turn-2" }]);
  assert.deepEqual(tracker.stop("child-a"), { threadId: "child-a", turnId: "child-turn-2" });
  assert.equal(tracker.stop("stranger"), undefined, "an id no child has is left for a terminal");
  tracker.error({ threadId: "child-a", turnId: "child-turn-2", willRetry: true, error: { message: "retry", codexErrorInfo: null, additionalDetails: null, misalignment: null } });
  tracker.error({ threadId: "child-a", turnId: "child-turn-2", willRetry: false, error: { message: "failed", codexErrorInfo: null, additionalDetails: null, misalignment: null } });

  assert.deepEqual(reports.filter((report) => report.type === "subagent.activity").map((report) => [report.kind, report.title, report.text]), [
    ["tool", "command_execution", JSON.stringify({ command: "rg TODO src", cwd: "/tmp/project" }, null, 2)],
    ["text", undefined, "Found the issue."],
  ]);
  const progress = reports.filter((report): report is Extract<SubagentReport, { type: "subagent.progress" }> => report.type === "subagent.progress").at(-1);
  assert.equal(progress?.totalTokens, 120, "cumulative total is used instead of the last-turn count");
  assert.equal(progress?.lastToolName, undefined, "a resumed turn does not revive the previous turn's tool");
  assert.deepEqual(reports.filter((report) => report.type === "subagent.status").map((report) => report.status), ["idle", "working"]);
  assert.deepEqual(reports.at(-1), { type: "subagent.finished", id: "child-a", status: "failed", summary: "failed" });
  assert.deepEqual(tracker.liveTurns, []);
  assert.equal(tracker.stop("child-a"), "held");
  tracker.turnStarted(turn("child-a", "child-turn-3"));
  assert.equal(tracker.takeHeldStop("child-a"), undefined, "a child that was not working holds no stop for its next turn");
});

test("V2 discovery fetches child settings through the session without a thread/started notification", async () => {
  const reports: SubagentReport[] = [];
  const codex = harness({ "thread/read": (params: { threadId: string }) => ({ thread: { id: params.threadId, model: "gpt-6-sol", reasoningEffort: "medium" } }) });
  const running = codex.provider.execute(input({ model: "gpt-6-astra", effort: "high", reportSubagent: (report) => reports.push(report) }));
  const client = await opened(codex);
  await sentBy(client, "turn/start");
  client.notify("item/started", itemStarted(rootId, "turn-1", activity("discover", "ui-smoke", "/root/ui_smoke")));
  await tick();
  assert.deepEqual(client.calls("thread/read"), [{ threadId: "ui-smoke", includeTurns: false }]);
  assert.deepEqual(reports.find((report) => report.type === "subagent.metadata"), { type: "subagent.metadata", id: "ui-smoke", model: "gpt-6-sol", effort: "medium" });
  client.notify("item/completed", itemCompleted(rootId, "turn-1", activity("discover", "ui-smoke", "/root/ui_smoke", "completed")));
  client.notify("item/started", itemStarted("ui-smoke", "child-turn", command("command")));
  await tick();
  assert.equal(client.calls("thread/read").length, 1, "known settings are not fetched for each activity item");
  completeTurn(client);
  await running;
  codex.provider.closeAll();
});

test("metadata reads retry after early persistence failures and never change lifecycle", async () => {
  const reports: SubagentReport[] = [];
  let reads = 0;
  const tracker = new CodexSubagents((report) => reports.push(report), undefined, async (id) => {
    reads += 1;
    if (reads === 1) throw new Error("thread not persisted yet");
    return { id, model: "gpt-6-sol", reasoningEffort: "medium" };
  });
  tracker.setRootThreadId(rootId);
  tracker.itemStarted(itemStarted(rootId, "turn", activity("discover", "child", "/root/child")));
  await tick();
  assert.equal(reports.some((report) => report.type === "subagent.finished"), false);
  tracker.itemCompleted(itemCompleted(rootId, "turn", activity("completed", "child", "/root/child", "completed")));
  await tick();
  assert.equal(reads, 2);
  assert.equal(reports.at(-1)?.type, "subagent.metadata");
  assert.equal(tracker.busy, false);
});

test("metadata reads are bounded, do not overwrite newer notifications, and stop when the session closes", async () => {
  const reports: SubagentReport[] = [];
  const pending: Array<{ id: string; resolve: (value: { id: string; model: string; reasoningEffort: "medium" }) => void }> = [];
  const tracker = new CodexSubagents((report) => reports.push(report), undefined, (id) => new Promise((resolve) => pending.push({ id, resolve })));
  tracker.setRootThreadId(rootId);
  for (let index = 0; index < 12; index += 1) tracker.itemStarted(itemStarted(rootId, "turn", activity(`discover-${index}`, `child-${index}`, `/root/child-${index}`)));
  assert.equal(pending.length, 4);
  const newer = spawnedThread("child-0", "", "", "", "/root/child-0");
  newer.thread.model = "gpt-6-astra";
  newer.thread.reasoningEffort = "high";
  tracker.threadStarted(newer);
  pending[0].resolve({ id: pending[0].id, model: "gpt-6-sol", reasoningEffort: "medium" });
  await tick();
  assert.equal(pending.length, 5);
  assert.deepEqual(reports.filter((report) => report.type === "subagent.metadata" && report.id === "child-0").at(-1), { type: "subagent.metadata", id: "child-0", model: "gpt-6-astra", effort: "high" });
  tracker.close();
  const count = reports.length;
  for (const item of pending.slice(1)) item.resolve({ id: item.id, model: "gpt-6-sol", reasoningEffort: "medium" });
  await tick();
  assert.equal(reports.length, count);
  assert.equal(pending.length, 5, "closing drops queued reads");
});

test("metadata reads stop retrying unsupported settings after three attempts", async () => {
  let reads = 0;
  const tracker = new CodexSubagents(() => {}, undefined, async (id) => { reads += 1; return { id, model: null, reasoningEffort: null }; });
  tracker.setRootThreadId(rootId);
  for (let index = 0; index < 8; index += 1) {
    tracker.itemStarted(itemStarted(rootId, "turn", activity(`discover-${index}`, "child", "/root/child")));
    await tick();
  }
  assert.equal(reads, 3);
});

test("the session isolates child traffic from the parent and cancellation interrupts child and root turns independently", async () => {
  const providerEvents: ProviderEvent[] = [];
  const reports: SubagentReport[] = [];
  const controller = new AbortController();
  const codex = harness({
    "turn/interrupt": (params: { threadId: string }) => {
      if (params.threadId === "child-a") throw new Error("child already moved");
      return {};
    },
  });
  const running = codex.provider.execute(input({
    abortController: controller,
    emit: (event) => providerEvents.push(event),
    reportSubagent: (report) => reports.push(report),
  }));
  const client = await opened(codex);
  await sentBy(client, "turn/start");

  client.notify("turn/started", turn("child-a", "child-turn"));
  client.notify("item/started", itemStarted(rootId, "turn-1", activity("discover", "child-a", "/root/reviewer")));
  client.notify("item/agentMessage/delta", { threadId: "child-a", turnId: "child-turn", itemId: "message-child", delta: "hidden child text" });
  client.notify("item/started", itemStarted("child-a", "child-turn", command("command-child")));
  client.notify("thread/tokenUsage/updated", usage("child-a", "child-turn", 80, 5));
  client.notify("thread/tokenUsage/updated", usage(rootId, "turn-1", 900, 9));
  controller.abort();
  await sentBy(client, "turn/interrupt", 2);

  assert.deepEqual(client.calls("turn/interrupt"), [
    { threadId: "child-a", turnId: "child-turn" },
    { threadId: rootId, turnId: "turn-1" },
  ]);
  assert.equal(providerEvents.some((event) => event.type === "assistant" || event.type === "assistant-tail" || event.type === "tool"), false);
  assert.deepEqual(providerEvents.filter((event) => event.type === "usage"), [{ type: "usage", tokens: 9, limit: 272_000, model: "gpt-6-sol" }]);
  assert.equal(reports.some((report) => report.type === "subagent.activity" && report.kind === "tool"), true);

  completeTurn(client, "interrupted");
  assert.deepEqual(await running, { status: "cancelled" });
  codex.provider.closeAll();
});

test("stopping a Codex subagent interrupts its live turn after the parent turn has ended", async () => {
  const codex = harness();
  const { client } = await runTurn(codex, {}, (client) => {
    client.notify("item/started", itemStarted(rootId, "turn-1", activity("discover", "child-a", "/root/reviewer")));
    client.notify("turn/started", turn("child-a", "child-turn"));
  });

  assert.equal(codex.provider.stopProcess("task-1", "child-a"), true);
  await sentBy(client, "turn/interrupt");
  assert.deepEqual(client.calls("turn/interrupt"), [{ threadId: "child-a", turnId: "child-turn" }]);
  assert.equal(client.calls("thread/backgroundTerminals/terminate").length, 0);
  codex.provider.closeAll();
});

test("a Codex subagent stopped before its first turn is interrupted as soon as that turn starts", async () => {
  const codex = harness();
  const { client } = await runTurn(codex, {}, (client) => {
    client.notify("item/started", itemStarted(rootId, "turn-1", activity("discover", "child-a", "/root/reviewer")));
  });

  assert.equal(codex.provider.stopProcess("task-1", "child-a"), true);
  await tick();
  assert.equal(client.calls("turn/interrupt").length, 0);
  assert.equal(client.calls("thread/backgroundTerminals/terminate").length, 0, "a child's stop never reaches the terminals");
  client.notify("turn/started", turn("child-a", "child-turn"));
  await sentBy(client, "turn/interrupt");
  assert.deepEqual(client.calls("turn/interrupt"), [{ threadId: "child-a", turnId: "child-turn" }]);
  client.notify("turn/started", turn("child-a", "child-turn-2"));
  await tick();
  assert.equal(client.calls("turn/interrupt").length, 1, "a held stop is spent once");
  codex.provider.closeAll();
});
