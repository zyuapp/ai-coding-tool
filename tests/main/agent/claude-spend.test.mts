import assert from "node:assert/strict";
import { test } from "vitest";
import { ClaudeAgentProvider } from "../../../src/main/agent/claude-agent-provider.mts";
import type { ProviderEvent } from "../../../src/main/agent/agent-provider.mts";
import { input, liveQueryFactory, liveTurn, queryFactory, tick, turn, type LiveQueryCapture } from "../../support/claude-session.mjs";

test("each model response is counted once, subagents included", async () => {
  const emitted: ProviderEvent[] = [];
  const opened = { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3_000, output_tokens: 1 };
  const childOpened = { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 1_000, output_tokens: 1 };
  const start = (id: string, model: string, usage: typeof opened, parent: string | null = null) => ({
    type: "stream_event",
    uuid: crypto.randomUUID(),
    parent_tool_use_id: parent,
    event: { type: "message_start", message: { id, model, usage } },
  });
  const block = (id: string, model: string, usage: typeof opened, parent: string | null = null) => ({
    type: "assistant",
    uuid: crypto.randomUUID(),
    parent_tool_use_id: parent,
    message: { id, model, usage, content: [{ type: "text", text: `${id} says something` }] },
  });
  const delta = (output: number, parent: string | null = null, read: Partial<typeof opened> = {}) => ({
    type: "stream_event",
    uuid: crypto.randomUUID(),
    parent_tool_use_id: parent,
    event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, ...read, output_tokens: output } },
  });
  const provider = new ClaudeAgentProvider(queryFactory([
    start("response-1", "claude-sonnet", opened),
    start("child-response", "claude-haiku", childOpened, "launch"),
    block("response-1", "claude-sonnet", opened),
    block("response-1", "claude-sonnet", opened),
    block("child-response", "claude-haiku", childOpened, "launch"),
    delta(7, "launch", { input_tokens: 5, cache_read_input_tokens: 1_000 }),
    delta(40),
    block("response-2", "<synthetic>", { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }),
    { type: "result", subtype: "success", is_error: false, result: "done" },
  ]));

  assert.deepEqual(await provider.execute(input({ emit: (event) => emitted.push(event) })), { status: "succeeded" });
  assert.deepEqual(emitted.filter((event) => event.type === "spend"), [
    { type: "spend", tokens: 3_211 },
    { type: "spend", tokens: 1_006 },
    { type: "spend", tokens: 6 },
    { type: "spend", tokens: 39 },
  ], "a response counts what it read once, its closing delta adds all it wrote, and a synthetic reply spent nothing");
});

test("a workflow's spend is what its running total grew by while a run was attached", async () => {
  const emitted: ProviderEvent[] = [];
  const emit = (event: ProviderEvent) => { emitted.push(event); };
  const capture: LiveQueryCapture = { opens: 0, sent: [] };
  const provider = new ClaudeAgentProvider(liveQueryFactory(capture));
  const progress = (total: number) => ({ type: "system", subtype: "task_progress", task_id: "workflow-1", description: "Review", usage: { total_tokens: total, tool_uses: 0, duration_ms: 0 } });

  await turn(capture, provider.execute(input({ emit })),
    { type: "system", subtype: "init", session_id: "session-1" },
    { type: "system", subtype: "task_started", task_id: "workflow-1", task_type: "local_workflow", description: "Review" },
    progress(5_000),
    progress(12_000));
  capture.emit!(progress(20_000));
  await tick();
  const continuation = { provider: "claude", value: "session-1" } as const;
  await turn(capture, provider.execute(input({ continuation, emit, prompt: "and again" })),
    progress(21_000),
    { type: "system", subtype: "task_notification", task_id: "workflow-1", status: "completed", summary: "", usage: { total_tokens: 24_000, tool_uses: 0, duration_ms: 0 } });
  provider.closeAll();

  assert.deepEqual(emitted.filter((event) => event.type === "spend").map((event) => event.type === "spend" && event.tokens), [5_000, 7_000, 1_000, 3_000], "what it spent between runs moves the total without counting");
});

test("only what a model spends while a run is attached is counted", async () => {
  const emitted: ProviderEvent[] = [];
  const response = (id: string, parent: string | null) => ({
    type: "assistant",
    uuid: crypto.randomUUID(),
    parent_tool_use_id: parent,
    message: { id, model: "claude-sonnet", usage: { input_tokens: 100, output_tokens: 20 }, content: [] },
  });
  const live = await liveTurn({ emit: (event) => emitted.push(event) });
  live.capture.emit!(response("during", null));
  live.capture.emit!({ type: "result", subtype: "success", is_error: false, result: "Answer" });
  await tick();
  live.capture.emit!(response("background-child", "launch"));
  live.capture.emit!(response("between-runs", null));
  await tick();
  await live.end();

  assert.deepEqual(emitted.filter((event) => event.type === "spend"), [{ type: "spend", tokens: 120 }], "work going on between runs has no run to count it");
});
