import assert from "node:assert/strict";
import { test } from "vitest";
import type { SubagentReport } from "../../../src/domain/run.ts";
import type { ProviderEvent } from "../../../src/main/agent/agent-provider.mts";
import type { NotificationParams } from "../../../src/main/codex/app-server-client.mts";
import { CodexSubagents } from "../../../src/main/codex/codex-subagents.mts";
import type { ThreadItem } from "../../../src/main/codex/protocol/v2/ThreadItem.ts";
import { completeTurn, harness, input, opened, sentBy } from "../../support/codex-client.mjs";

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

const message = (id: string, text: string): ThreadItem => ({ type: "agentMessage", id, text, phase: "final_answer", memoryCitation: null, delivery: null });

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
  tracker.error({ threadId: "child-a", turnId: "child-turn", willRetry: false, error: { message: "stale failure", codexErrorInfo: null, additionalDetails: null } });
  assert.deepEqual(tracker.liveTurns, [{ threadId: "child-a", turnId: "child-turn-2" }]);
  tracker.error({ threadId: "child-a", turnId: "child-turn-2", willRetry: true, error: { message: "retry", codexErrorInfo: null, additionalDetails: null } });
  tracker.error({ threadId: "child-a", turnId: "child-turn-2", willRetry: false, error: { message: "failed", codexErrorInfo: null, additionalDetails: null } });

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
});

test("a detached review is registered as a session subagent even when its events arrive first", () => {
  const reports: SubagentReport[] = [];
  const tracker = new CodexSubagents((report) => reports.push(report));
  tracker.setRootThreadId(rootId);
  tracker.turnStarted(turn("review-thread", "review-turn"));
  tracker.itemCompleted(itemCompleted("review-thread", "review-turn", { type: "exitedReviewMode", id: "review-result", review: "[P1] Fix the race." }));
  tracker.turnCompleted(turn("review-thread", "review-turn", "completed"));

  assert.equal(reports.length, 0, "foreign traffic stays buffered until review/start identifies it");
  tracker.registerReview("review-thread", "Review uncommitted changes");

  assert.deepEqual(tracker.reviewState("review-thread"), {
    output: "[P1] Fix the race.",
    completed: { id: "review-turn", status: "completed" },
  });
  assert.deepEqual(reports[0], {
    type: "subagent.started", id: "review-thread", description: "Review uncommitted changes", agentType: "reviewer", sessionScoped: true,
  });
  assert.equal(reports.some((report) => report.type === "subagent.activity" && report.text === "[P1] Fix the race."), true);
  assert.deepEqual(reports.at(-1), { type: "subagent.activity", id: "review-thread", activityId: "review-result:review", kind: "text", text: "[P1] Fix the race." });
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
  assert.deepEqual(providerEvents.filter((event) => event.type === "usage"), [{ type: "usage", tokens: 9, limit: 272_000, model: "gpt-5.6-sol" }]);
  assert.equal(reports.some((report) => report.type === "subagent.activity" && report.kind === "tool"), true);

  completeTurn(client, "interrupted");
  assert.deepEqual(await running, { status: "cancelled" });
  codex.provider.closeAll();
});
